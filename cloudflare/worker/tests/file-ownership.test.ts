import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { D1FileOwnership, ownedParseKey, ownedRawKey, type FileOperation } from '../src/file-ownership';
import { D1MetadataRepository } from '../src/kb-metadata-repository';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(beforeOwnership?: (sqlite: DatabaseSync) => void) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).sort()) {
    if (name.startsWith('0008')) beforeOwnership?.(sqlite);
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  sqlite.exec(`INSERT OR IGNORE INTO kb_projects(name) VALUES ('tenant-a'), ('tenant-b');
    INSERT OR IGNORE INTO kb_domains(project, name) VALUES ('tenant-a', 'manual'), ('tenant-b', 'manual'), ('tenant-a', 'other');`);
  const prepared = (query: string, values: unknown[] = []): unknown => ({
    bind: (...params: unknown[]) => prepared(query, params),
    first: async () => sqlite.prepare(query).get(...(values as string[])) ?? null,
    all: async () => ({ results: sqlite.prepare(query).all(...(values as string[])), success: true }),
    run: async () => run(query, values),
    execute: () => run(query, values),
  });
  const run = (query: string, values: unknown[]) => {
    const result = sqlite.prepare(query).run(...(values as string[]));
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  };
  const db = {
    prepare: prepared,
    batch: async (statements: { execute(): unknown }[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, db, ledger: new D1FileOwnership(db) };
}

const input = (id: string, project = 'tenant-a', domain = 'manual') => ({
  id,
  project,
  domain,
  filename: 'manual.txt',
  mime: 'text/plain',
  bytes: 5,
  contentHash: 'same-hash',
});
async function uploaded(ledger: D1FileOwnership, id = 'a', project = 'tenant-a', domain = 'manual') {
  await ledger.reserve(input(id, project, domain), `upload-${id}`);
  const op = (await ledger.operation(project, `upload-${id}`)) as FileOperation;
  expect(await ledger.recordIntent(op, { artifact_id: `raw-${id}`, kind: 'raw', resource_id: ownedRawKey(project, id, 'same-hash'), provider: 'r2' })).toBe(
    true,
  );
  expect(await ledger.recordWrite(project, op.operation_id, `raw-${id}`, 'confirmed')).toBe(true);
  expect(await ledger.settle(op, true)).toBe(true);
  return op;
}

describe('inactive owned-file protocol with real migrated SQLite', () => {
  it('preserves pre-migration files and global parse records without claiming ownership', async () => {
    const { db, ledger, sqlite } = fixture((sql) =>
      sql.exec(`
      INSERT INTO kb_domains(project,name) VALUES ('default','legacy');
      INSERT INTO kb_files(id,project,domain,filename,mime,bytes,content_hash,object_key)
      VALUES ('old','default','legacy','old.txt','text/plain',5,'same-hash','raw/legacy/same-hash');
      INSERT INTO kb_parse_artifacts(content_hash,parser,object_key) VALUES ('same-hash','legacy','parse/legacy/same-hash');`),
    );
    const metadata = new D1MetadataRepository(db);
    expect((await metadata.getFile('default', 'old'))?.object_key).toBe('raw/legacy/same-hash');
    expect((await metadata.getParseArtifact('same-hash'))?.parser).toBe('legacy');
    expect(await ledger.reserve(input('new', 'default', 'legacy'), 'upload-new')).toBeNull();
    expect(await ledger.get('default', 'old')).toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM kb_file_operations').get()).toMatchObject({ n: 0 });
  });

  it('reserves a single immutable duplicate winner and separates tenants and domains', async () => {
    const { ledger, db } = fixture();
    const second = new D1FileOwnership(db);
    const [a, duplicate] = await Promise.all([ledger.reserve(input('a'), 'u-a'), second.reserve(input('duplicate'), 'u-duplicate')]);
    expect(a?.file_id).toBe('a');
    expect(duplicate?.file_id).toBe('a');
    expect(await ledger.operation('tenant-a', 'u-duplicate')).toBeNull();
    await ledger.reserve(input('b', 'tenant-b'), 'u-b');
    await ledger.reserve(input('c', 'tenant-a', 'other'), 'u-c');
    const metadata = new D1MetadataRepository(db);
    const keys = await Promise.all([metadata.getFile('tenant-a', 'a'), metadata.getFile('tenant-b', 'b'), metadata.getFile('tenant-a', 'c')]);
    expect(new Set(keys.map((file) => file?.object_key)).size).toBe(3);
    expect(await ledger.get('tenant-b', 'a')).toBeNull();
    expect(ownedRawKey('a/b', 'x', 'h')).not.toBe(ownedRawKey('a_b', 'x', 'h'));
  });

  it('atomically claims one writer without expiry or operation-token replay', async () => {
    const { ledger, db, sqlite } = fixture();
    await uploaded(ledger);
    const claims = await Promise.all([ledger.claim('tenant-a', 'a', 'one', 'ingest'), new D1FileOwnership(db).claim('tenant-a', 'a', 'two', 'reprocess')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    sqlite.exec(`UPDATE kb_file_operations SET created_at = '1900-01-01' WHERE operation_id = 'one'`);
    expect(await ledger.claim('tenant-a', 'a', 'three', 'ingest')).toBeNull();
    const op = claims.find(Boolean) as FileOperation;
    expect(await ledger.settle(op, true)).toBe(true);
    const generation = (await ledger.get('tenant-a', 'a'))?.generation;
    expect(await ledger.claim('tenant-a', 'a', op.operation_id, 'ingest')).toBeNull();
    expect((await ledger.get('tenant-a', 'a'))?.generation).toBe(generation);
  });

  it('keeps deletion pending while a pre-delete external write finishes and rejects late publication', async () => {
    const { ledger, db } = fixture();
    await uploaded(ledger);
    const writer = (await ledger.claim('tenant-a', 'a', 'parse-a', 'ingest')) as FileOperation;
    const key = ownedParseKey(writer);
    expect(await ledger.recordIntent(writer, { artifact_id: 'parse-a', kind: 'parse', resource_id: key, provider: 'r2' })).toBe(true);
    const objects = new Map<string, string>();
    let finishPut: (() => void) | undefined;
    const put = new Promise<void>((resolve) => {
      finishPut = resolve;
    }).then(async () => {
      objects.set(key, 'synthetic text');
      await ledger.recordWrite('tenant-a', writer.operation_id, 'parse-a', 'confirmed');
      return await ledger.settle(writer, true);
    });
    const deletion = new D1FileOwnership(db);
    const state = await deletion.requestDelete('tenant-a', 'a', 'delete-a');
    expect(state).toMatchObject({ state: 'deleting', published_generation: null, deletion_id: 'delete-a' });
    expect(await deletion.cleanupCandidates('tenant-a', 'a')).toEqual([]);
    expect(await deletion.finishDelete('tenant-a', 'a')).toBe(false);
    expect(await ledger.recordIntent(writer, { artifact_id: 'late', kind: 'parse', resource_id: 'late', provider: 'r2' })).toBe(false);
    finishPut?.();
    expect(await put).toBe(false);
    expect(objects.has(key)).toBe(true);
    const artifacts = await deletion.cleanupCandidates('tenant-a', 'a');
    expect(artifacts.map((artifact) => artifact.artifact_id).sort()).toEqual(['parse-a', 'raw-a']);
    for (const artifact of artifacts) {
      objects.delete(artifact.resource_id);
      expect(await deletion.confirmCleanup('tenant-a', 'a', artifact.artifact_id)).toBe(true);
    }
    expect(await deletion.finishDelete('tenant-a', 'a')).toBe(true);
    expect(objects.size).toBe(0);
    expect(await ledger.claim('tenant-a', 'a', 'revive', 'ingest')).toBeNull();
  });

  it('retains pending cleanup after partial failure and accepted vector mutations', async () => {
    const { ledger } = fixture();
    await uploaded(ledger);
    const op = (await ledger.claim('tenant-a', 'a', 'index-a', 'ingest')) as FileOperation;
    await ledger.recordIntent(op, { artifact_id: 'vector-a', kind: 'vector', resource_id: 'vec-a', provider: 'vector-base' });
    await ledger.recordWrite('tenant-a', op.operation_id, 'vector-a', 'accepted', 'mutation-upsert');
    await ledger.settle(op, true);
    await ledger.requestDelete('tenant-a', 'a', 'delete-a');
    await ledger.confirmCleanup('tenant-a', 'a', 'raw-a');
    expect(await ledger.finishDelete('tenant-a', 'a')).toBe(false);
    expect(await ledger.cleanupCandidates('tenant-a', 'a')).toMatchObject([{ artifact_id: 'vector-a', write_state: 'accepted' }]);
    expect((await ledger.requestDelete('tenant-a', 'a', 'different-delete-id'))?.deletion_id).toBe('delete-a');
    // The provider adapter must establish convergence before this transition.
    await ledger.confirmCleanup('tenant-a', 'a', 'vector-a');
    expect(await ledger.finishDelete('tenant-a', 'a')).toBe(true);
  });

  it('never erases another tenant and retains tombstones after legacy file-row cleanup', async () => {
    const { ledger, sqlite } = fixture();
    await uploaded(ledger, 'a');
    await uploaded(ledger, 'b', 'tenant-b');
    expect(await ledger.requestDelete('tenant-b', 'a', 'wrong')).toBeNull();
    await ledger.requestDelete('tenant-a', 'a', 'delete-a');
    expect(await ledger.confirmCleanup('tenant-b', 'a', 'raw-a')).toBe(false);
    for (const artifact of await ledger.cleanupCandidates('tenant-a', 'a')) await ledger.confirmCleanup('tenant-a', 'a', artifact.artifact_id);
    await ledger.finishDelete('tenant-a', 'a');
    sqlite.exec(`DELETE FROM kb_files WHERE id = 'a'`);
    expect((await ledger.get('tenant-a', 'a'))?.state).toBe('deleted');
    expect((await ledger.get('tenant-b', 'b'))?.state).toBe('active');
    expect((await ledger.reserve(input('new-a'), 'upload-new-a'))?.file_id).toBe('new-a');
    expect(await ledger.claim('tenant-a', 'a', 'old-retry', 'ingest')).toBeNull();
  });

  it('rejects a reused upload operation token without leaving an unowned file', async () => {
    const { ledger, sqlite } = fixture();
    await ledger.reserve(input('a'), 'shared-token');
    await expect(ledger.reserve(input('b', 'tenant-b'), 'shared-token')).rejects.toThrow('UNIQUE constraint');
    expect(await ledger.get('tenant-b', 'b')).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM kb_files WHERE id = 'b'").get()).toMatchObject({ n: 0 });
    expect((await ledger.reserve(input('a'), 'shared-token'))?.file_id).toBe('a');
  });

  it('rolls back a registration transaction when a constrained insert fails', async () => {
    const { ledger, sqlite } = fixture();
    sqlite.exec(`CREATE TRIGGER fail_operations BEFORE INSERT ON kb_file_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    await expect(ledger.reserve(input('a'), 'upload-a')).rejects.toThrow('fixture failure');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM kb_files').get()).toMatchObject({ n: 0 });
    expect(await ledger.get('tenant-a', 'a')).toBeNull();
  });
});
