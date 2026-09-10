import { DatabaseSync } from 'node:sqlite';
import { inventoryLegacyOwnership } from '../scripts/inventory-legacy-ownership.mjs';
import { URL } from 'node:url';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1FileOwnership, ownedParseKey, ownedRawKey, type FileOperation } from '../src/file-ownership';
import { createApp } from '../src/index';
import type { QueueCapableApp } from '../src/app-types';
import type { KbIngestQueueMessage } from '../src/types';
import type { Env, VectorizeVector } from '../src/types';
import { D1MetadataRepository } from '../src/kb-metadata-repository';
import { deleteOwnedFile } from '../src/owned-storage';

const databases: DatabaseSync[] = [];
it.each(['prepared', 'started', 'unknown'] as const)('settled cleanup distinguishes never-dispatched vectors from %s writes', async (dispatch) => {
  const { db, ledger, sqlite } = fixture();
  await uploaded(ledger);
  const operation = (await ledger.claim('tenant-a', 'a', 'index-a', 'ingest'))!;
  await ledger.recordIntent(operation, { artifact_id: 'vector-a', kind: 'vector', resource_id: 'vector-a', provider: 'vector:base' });
  if (dispatch === 'started') expect(await ledger.startWrite(operation, 'vector-a')).toBe(true);
  if (dispatch === 'unknown') sqlite.exec("UPDATE kb_file_artifacts SET dispatch_state='unknown' WHERE artifact_id='vector-a'");
  await ledger.settle(operation, false);
  const getByIds = vi.fn(async () => []);
  const deleteByIds = vi.fn(async () => ({}));
  const env = { DB: db, RAW_DOCS: { delete: vi.fn(async () => {}) } } as unknown as Env;
  const state = await deleteOwnedFile(env, 'tenant-a', 'a', [{ key: 'base', binding: { getByIds, deleteByIds } as never }]);
  expect(state).toBe(dispatch === 'prepared' ? 'complete' : 'pending');
  expect(getByIds).toHaveBeenCalledTimes(dispatch === 'prepared' ? 0 : 1);
  expect(deleteByIds).not.toHaveBeenCalled();
  expect(await ledger.startWrite(operation, 'vector-a')).toBe(false);
});
afterEach(() => vi.unstubAllGlobals());
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(beforeOwnership?: (sqlite: DatabaseSync) => void, beforeDispatchMigration?: (sqlite: DatabaseSync) => void) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).sort()) {
    if (name.startsWith('0008')) beforeOwnership?.(sqlite);
    if (name.startsWith('0010')) beforeDispatchMigration?.(sqlite);
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
  expect(await ledger.startWrite(op, `raw-${id}`)).toBe(true);
  expect(await ledger.recordWrite(project, op.operation_id, `raw-${id}`, 'confirmed')).toBe(true);
  expect(await ledger.settle(op, true)).toBe(true);
  return op;
}

function handlerFixture() {
  const { db, ledger, sqlite } = fixture();
  const hooks: {
    beforePut?: (key: string) => Promise<void>;
    beforeVectorUpsert?: () => Promise<void>;
    deferVectors?: boolean;
    beforeDelete?: (key: string) => Promise<void>;
  } = {};
  const deferredVectors: VectorizeVector[] = [];
  const objects = new Map<string, Uint8Array>();
  const vectors = new Map<string, VectorizeVector>();
  const env = {
    DB: db,
    RAG_SERVICE_KEYS: JSON.stringify({ 'key-a': 'tenant-a', 'key-b': 'tenant-b' }),
    EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5',
    RAW_DOCS: {
      put: async (key: string, value: string | ArrayBuffer | Uint8Array) => {
        await hooks.beforePut?.(key);
        objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
      },
      get: async (key: string) => {
        const value = objects.get(key);
        return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null;
      },
      delete: async (key: string) => {
        await hooks.beforeDelete?.(key);
        objects.delete(key);
      },
    },
    VECTORIZE: {
      upsert: async (rows: VectorizeVector[]) => {
        await hooks.beforeVectorUpsert?.();
        if (hooks.deferVectors) deferredVectors.push(...rows);
        else for (const row of rows) vectors.set(row.id, row);
        return { mutationId: 'synthetic-upsert' };
      },
      getByIds: async (ids: string[]) => ids.flatMap((id) => (vectors.has(id) ? [{ id }] : [])),
      deleteByIds: async (ids: string[]) => {
        for (const id of ids) vectors.delete(id);
        return { mutationId: 'synthetic-delete' };
      },
      query: async () => ({ matches: [] }),
    },
  } as unknown as Env;
  const appOptions = { ownedFileProtocol: true, embed: async (_env: Env, texts: string[]) => texts.map(() => Array(768).fill(0.1)) };
  const app = createApp(appOptions);
  const request = async (key: string, path: string, method = 'GET', body?: BodyInit, handler = app) => {
    const response = await handler.fetch(
      new Request(`https://local.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
      }),
      env,
    );
    const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, payload };
  };
  return { db, ledger, sqlite, env, app, appOptions, request, objects, vectors, hooks, deferredVectors };
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
    expect(await ledger.startWrite(writer, 'parse-a')).toBe(true);
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
    expect(await ledger.startWrite(op, 'vector-a')).toBe(true);
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

  it('rolls back stale publication metadata and increments a durable visibility revision', async () => {
    const { ledger, db, sqlite } = fixture();
    await uploaded(ledger);
    const before = await ledger.scopeRevision('tenant-a', 'manual');
    const op = (await ledger.claim('tenant-a', 'a', 'publish-a', 'ingest')) as FileOperation;
    await new D1FileOwnership(db).requestDelete('tenant-a', 'a', 'delete-a');
    expect(await ledger.publish(op, [db.prepare("INSERT INTO kb_projects(name) VALUES ('must-not-publish')")])).toBe(false);
    expect(sqlite.prepare("SELECT name FROM kb_projects WHERE name = 'must-not-publish'").get()).toBeUndefined();
    expect(await ledger.scopeRevision('tenant-a', 'manual')).toBeGreaterThan(before);
  });

  it('derives entity fields and relationship evidence from surviving published files', async () => {
    const { ledger, db, sqlite } = fixture();
    await uploaded(ledger, 'a');
    await uploaded(ledger, 'c', 'tenant-a', 'other');
    // Use another content hash to create the second file in the same domain.
    await ledger.reserve({ ...input('b'), contentHash: 'second-hash' }, 'upload-b');
    await ledger.settle((await ledger.operation('tenant-a', 'upload-b')) as FileOperation, true);
    sqlite.exec("INSERT INTO kb_owned_entity_identities VALUES ('entity','tenant-a','manual','company','ACME')");
    const publishFact = async (id: string, value: string) => {
      const op = (await ledger.claim('tenant-a', id, `fact-${id}`, 'ingest')) as FileOperation;
      const facts = [
        db
          .prepare(`INSERT INTO kb_owned_entity_facts(id,project,domain,file_id,generation,operation_id,entity_id,schema_id,display_name,fields)
          VALUES (?, 'tenant-a','manual',?,?,?,'entity','schema','ACME',?)`)
          .bind(`fact-${id}`, id, op.generation, op.operation_id, JSON.stringify({ value })),
        db
          .prepare(`INSERT INTO kb_owned_relationship_facts(id,project,domain,file_id,generation,operation_id,rel_type,src_id,dst_id)
          VALUES (?, 'tenant-a','manual',?,?,?,'parent','entity','parent')`)
          .bind(`edge-${id}`, id, op.generation, op.operation_id),
      ];
      expect(await ledger.publish(op, facts)).toBe(true);
    };
    await publishFact('a', 'original');
    await publishFact('b', 'newer');
    expect(sqlite.prepare('SELECT fields FROM kb_visible_entities').get()).toMatchObject({ fields: '{"value":"newer"}' });
    expect(sqlite.prepare('SELECT evidence_file FROM kb_visible_relationships').get()).toMatchObject({ evidence_file: 'b' });
    await ledger.requestDelete('tenant-a', 'b', 'delete-b');
    expect(sqlite.prepare('SELECT fields FROM kb_visible_entities').get()).toMatchObject({ fields: '{"value":"original"}' });
    expect(sqlite.prepare('SELECT evidence_file FROM kb_visible_relationships').get()).toMatchObject({ evidence_file: 'a' });
    await ledger.requestDelete('tenant-a', 'a', 'delete-a');
    expect(sqlite.prepare('SELECT * FROM kb_visible_entities').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM kb_visible_relationships').all()).toEqual([]);
  });

  it('invalidates actual handler caches across instances and rejects delayed semantic metadata', async () => {
    const { ledger, db, sqlite } = fixture();
    await uploaded(ledger);
    const op = (await ledger.claim('tenant-a', 'a', 'index-a', 'ingest')) as FileOperation;
    sqlite.exec("INSERT INTO indexes(id,tenant,name,external_id) VALUES ('idx','tenant-a','manual','kb:manual')");
    const metadata = JSON.stringify({ file_id: 'a', file_generation: op.generation, filename: 'manual.txt', page_start: 1, page_end: 1 });
    await ledger.publish(op, [
      db.prepare("INSERT INTO documents(id,index_id,tenant,content,metadata) VALUES ('doc','idx','tenant-a','heliotrope violet-lantern',?)").bind(metadata),
      db
        .prepare(
          "INSERT INTO chunks(id,document_id,index_id,tenant,content,chunk_index,metadata) VALUES ('chunk','doc','idx','tenant-a','heliotrope violet-lantern',0,?)",
        )
        .bind(metadata),
    ]);
    const env = {
      DB: db,
      RAG_SERVICE_KEYS: JSON.stringify({ 'key-a': 'tenant-a' }),
      EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5',
      VECTORIZE: {
        query: async () => ({
          matches: [{ id: 'chunk', score: 0.99, metadata: { ...JSON.parse(metadata), document_id: 'doc', chunk_content: 'heliotrope violet-lantern' } }],
        }),
      },
    } as unknown as Env;
    const first = createApp({ ownedFileProtocol: true, embed: async () => [[1, 0]] });
    const second = createApp({ ownedFileProtocol: true, embed: async () => [[1, 0]] });
    const request = async (app: typeof first, path = 'query', body: object = { query: 'heliotrope', mode: 'lexical' }) => {
      const response = await app.fetch(
        new Request(`https://local.test/v1/indexes/idx/${path}`, {
          method: 'POST',
          headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { data: Array<{ chunk_id: string }> };
    };
    expect((await request(first)).data).toHaveLength(1);
    expect((await request(first)).data).toHaveLength(1);
    expect((await request(second)).data).toHaveLength(1);
    await new D1FileOwnership(db).requestDelete('tenant-a', 'a', 'delete-a');
    expect((await request(first)).data).toEqual([]);
    expect((await request(second)).data).toEqual([]);
    expect((await request(first, 'query-vector', { vector: Array(768).fill(0.1) })).data).toEqual([]);
    // The provider and physical rows still contain the old data at this point.
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM chunks WHERE id = 'chunk'").get()).toMatchObject({ n: 1 });
  });

  it('runs actual owned multipart import, citation, scoped parse and independent deletion', async () => {
    const { request, objects } = handlerFixture();
    const text = 'Synthetic heliotrope manual: the recovery code is violet-lantern.';
    const upload = async (key: string) => {
      const form = new FormData();
      form.set('domain', 'manual');
      form.set('file', new File([text], 'manual.txt', { type: 'text/plain' }));
      const result = await request(key, '/v1/kb/files/upload', 'POST', form);
      expect(result.status).toBe(201);
      return result.payload as { id: string; object_key: string; content_hash: string };
    };
    const a = await upload('key-a');
    const b = await upload('key-b');
    expect(a.object_key).not.toBe(b.object_key);
    for (const [key, file] of [
      ['key-a', a],
      ['key-b', b],
    ] as const) {
      const result = await request(key, '/v1/kb/ingest/run', 'POST', JSON.stringify({ domain: 'manual', file_ids: [file.id], async: false }));
      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({ files: [{ status: 'ready' }] });
    }
    const query = await request('key-a', '/v1/kb/query', 'POST', JSON.stringify({ domain: 'manual', question: 'recovery code', mode: 'lexical' }));
    expect(query.status).toBe(200);
    const citations = (query.payload as { citations: Array<{ file_id: string; excerpt: string; page_start: number }> }).citations;
    expect(citations[0]).toMatchObject({ file_id: a.id, page_start: 1 });
    expect(text).toContain(citations[0]!.excerpt);
    const artifactA = await request('key-a', `/v1/kb/parse-artifacts/${a.content_hash}`);
    const artifactB = await request('key-b', `/v1/kb/parse-artifacts/${b.content_hash}`);
    expect(artifactA.status).toBe(200);
    expect(artifactB.status).toBe(200);
    expect((artifactA.payload as { object_key: string }).object_key).not.toBe((artifactB.payload as { object_key: string }).object_key);
    expect((await request('key-b', `/v1/kb/files/${a.id}`)).status).toBe(404);
    const deleted = await request('key-a', `/v1/kb/files/${a.id}`, 'DELETE');
    expect(deleted).toMatchObject({ status: 200, payload: { physical_state: 'complete' } });
    expect(objects.has(a.object_key)).toBe(false);
    expect(objects.has(b.object_key)).toBe(true);
    expect((await request('key-a', `/v1/kb/files/${a.id}`)).status).toBe(404);
    expect((await request('key-b', `/v1/kb/files/${b.id}`)).status).toBe(200);
    expect((await request('key-a', '/v1/kb/search', 'POST', JSON.stringify({ domain: 'manual', query: 'heliotrope', mode: 'lexical' }))).payload).toMatchObject(
      { data: [] },
    );
    expect((await request('key-b', '/v1/kb/search', 'POST', JSON.stringify({ domain: 'manual', query: 'heliotrope', mode: 'lexical' }))).payload).toMatchObject(
      { data: [{ metadata: { file_id: b.id } }] },
    );
    expect((await request('key-a', `/v1/kb/files/${a.id}`, 'DELETE')).status).toBe(200);
  });

  it.each(['raw', 'parse', 'vector'] as const)('keeps actual delete pending across an in-flight %s write', async (phase) => {
    const { request, hooks, sqlite, appOptions, objects, vectors } = handlerFixture();
    const second = createApp(appOptions);
    const form = () => {
      const body = new FormData();
      body.set('domain', 'manual');
      body.set('file', new File(['heliotrope violet-lantern'], 'manual.txt', { type: 'text/plain' }));
      return body;
    };
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = async () => {
      entered?.();
      await paused;
    };
    let fileId: string;
    let ongoing: ReturnType<typeof request>;
    if (phase === 'raw') {
      hooks.beforePut = async (key) => {
        if (key.startsWith('raw/')) await barrier();
      };
      ongoing = request('key-a', '/v1/kb/files/upload', 'POST', form());
      await started;
      fileId = (sqlite.prepare("SELECT file_id FROM kb_file_lifecycle WHERE project='tenant-a'").get() as { file_id: string }).file_id;
    } else {
      const uploaded = await request('key-a', '/v1/kb/files/upload', 'POST', form());
      expect(uploaded.status).toBe(201);
      fileId = (uploaded.payload as { id: string }).id;
      if (phase === 'parse')
        hooks.beforePut = async (key) => {
          if (key.startsWith('parse/')) await barrier();
        };
      else hooks.beforeVectorUpsert = barrier;
      ongoing = request('key-a', '/v1/kb/ingest/run', 'POST', JSON.stringify({ domain: 'manual', file_ids: [fileId], async: false }));
      await started;
    }
    expect(await request('key-a', `/v1/kb/files/${fileId}`, 'DELETE', undefined, second)).toMatchObject({
      status: 202,
      payload: { logical_removed: true, physical_state: 'pending' },
    });
    expect((await request('key-a', `/v1/kb/files/${fileId}`)).status).toBe(404);
    release?.();
    const result = await ongoing;
    if (phase === 'raw') expect(result.status).toBe(409);
    else expect(result.payload).toMatchObject({ files: [{ status: 'failed' }] });
    expect(await request('key-a', `/v1/kb/files/${fileId}`, 'DELETE', undefined, second)).toMatchObject({
      status: 200,
      payload: { physical_state: 'complete' },
    });
    expect(objects.size).toBe(0);
    expect(vectors.size).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM documents').get()).toMatchObject({ n: 0 });
  });

  it('does not mistake an accepted but invisible vector upsert for completed erasure', async () => {
    const { request, hooks, vectors, deferredVectors } = handlerFixture();
    hooks.deferVectors = true;
    const result = await request('key-a', '/v1/kb/ingest/text', 'POST', JSON.stringify({ domain: 'manual', text: 'heliotrope violet-lantern' }));
    expect(result.status).toBe(201);
    const fileId = (result.payload as { file_id: string }).file_id;
    expect(deferredVectors.length).toBeGreaterThan(0);
    expect(vectors.size).toBe(0);
    expect((await request('key-a', `/v1/kb/files/${fileId}`, 'DELETE')).status).toBe(202);
    expect((await request('key-a', '/v1/kb/search', 'POST', JSON.stringify({ domain: 'manual', query: 'heliotrope', mode: 'lexical' }))).payload).toMatchObject(
      { data: [] },
    );
    expect((await request('key-a', `/v1/kb/chunks?file_id=${fileId}`)).payload).toMatchObject({ chunks: [] });
    for (const row of deferredVectors) vectors.set(row.id, row);
    expect((await request('key-a', `/v1/kb/files/${fileId}`, 'DELETE')).status).toBe(200);
    expect(vectors.size).toBe(0);
  });

  it('preserves records intake and restores surviving entity evidence with real citations', async () => {
    const { request } = handlerFixture();
    const ingest = async (code: string) => {
      const response = await request(
        'key-a',
        '/v1/kb/ingest/record',
        'POST',
        JSON.stringify({ domain: 'manual', type: 'company', data: [{ id: 'acme', name: 'Acme', code }] }),
      );
      expect(response.status).toBe(201);
      return (response.payload as { file_id: string }).file_id;
    };
    const a = await ingest('violet-lantern');
    const b = await ingest('amber-lantern');
    const query = async () => await request('key-a', '/v1/kb/query', 'POST', JSON.stringify({ domain: 'manual', question: 'Acme code', mode: 'lexical' }));
    const latest = await query();
    expect(latest.status).toBe(200);
    expect(latest.payload).toMatchObject({ citations: [{ file_id: b }] });
    expect(JSON.stringify(latest.payload)).toContain('amber-lantern');
    expect((await request('key-a', `/v1/kb/files/${b}`, 'DELETE')).status).toBe(200);
    const previous = await query();
    expect(previous.payload).toMatchObject({ citations: [{ file_id: a }] });
    expect(JSON.stringify(previous.payload)).toContain('violet-lantern');
    expect(JSON.stringify(previous.payload)).not.toContain('amber-lantern');
  });

  it('supports queue ingestion, reprocess, ambiguous hashes, owned registration and source-set cleanup retries', async () => {
    const { request, app, env, hooks, objects, vectors, sqlite } = handlerFixture();
    const text = 'queued heliotrope evidence';
    const upload = async (domain: string) => {
      const body = new FormData();
      body.set('domain', domain);
      body.set('file', new File([text], 'manual.txt', { type: 'text/plain' }));
      const result = await request('key-a', '/v1/kb/files/upload', 'POST', body);
      expect(result.status).toBe(201);
      return result.payload as { id: string; content_hash: string; object_key: string; bytes: number };
    };
    const a = await upload('manual');
    const b = await upload('other');
    const body = { kind: 'kb_ingest', project: 'tenant-a', domain: 'manual', file_ids: [a.id] };
    let acknowledged = false;
    await (app as QueueCapableApp).processIngestQueue(
      {
        messages: [
          {
            body,
            attempts: 1,
            id: 'synthetic-queue',
            ack: () => {
              acknowledged = true;
            },
            retry: () => {
              throw new Error('unexpected retry');
            },
          },
        ],
      } as unknown as MessageBatch<KbIngestQueueMessage>,
      env,
    );
    expect(acknowledged).toBe(true);
    const reprocess = await request('key-a', `/v1/kb/files/${a.id}/reprocess`, 'POST');
    expect(reprocess.status).toBe(200);
    expect((await request('key-a', '/v1/kb/ingest/run', 'POST', JSON.stringify({ domain: 'manual', file_ids: [a.id], async: false }))).payload).toMatchObject({
      files: [{ status: 'ready' }],
    });
    expect((await request('key-a', '/v1/kb/ingest/run', 'POST', JSON.stringify({ domain: 'other', file_ids: [b.id], async: false }))).payload).toMatchObject({
      files: [{ status: 'ready' }],
    });
    expect((await request('key-a', `/v1/kb/parse-artifacts/${a.content_hash}`)).status).toBe(409);
    expect((await request('key-a', `/v1/kb/parse-artifacts/${a.content_hash}?file_id=${a.id}`)).status).toBe(200);
    const registered = await request(
      'key-a',
      '/v1/kb/files',
      'POST',
      JSON.stringify({ domain: 'copied', filename: 'copy.txt', content_hash: a.content_hash, object_key: a.object_key, bytes: a.bytes }),
    );
    expect(registered.status).toBe(201);
    const copy = registered.payload as { id: string; object_key: string };
    expect(copy.object_key).not.toBe(a.object_key);
    expect(
      (
        await request(
          'key-b',
          '/v1/kb/files',
          'POST',
          JSON.stringify({ domain: 'manual', filename: 'foreign.txt', content_hash: a.content_hash, object_key: a.object_key, bytes: a.bytes }),
        )
      ).status,
    ).toBe(404);
    let failedOnce = false;
    hooks.beforeDelete = async (key) => {
      if (!failedOnce && key === a.object_key) {
        failedOnce = true;
        throw new Error('synthetic storage failure');
      }
    };
    const action = '/v1/kb/source-sets/domain%3Amanual/actions';
    expect((await request('key-a', action, 'POST', JSON.stringify({ action: 'delete_all' }))).status).toBe(202);
    expect((await request('key-a', action, 'POST', JSON.stringify({ action: 'delete_all' }))).status).toBe(200);
    expect(objects.has(a.object_key)).toBe(false);
    expect(objects.has(b.object_key)).toBe(true);
    expect(objects.has(copy.object_key)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM documents WHERE json_extract(metadata, '$.file_id') = ?").get(a.id)).toMatchObject({ n: 0 });
    expect([...vectors.values()].every((vector) => vector.metadata?.file_id !== a.id)).toBe(true);
  });

  it('keeps an uncertain external write pending without lease expiry', async () => {
    const { request, hooks, sqlite } = handlerFixture();
    const body = new FormData();
    body.set('domain', 'manual');
    body.set('file', new File(['heliotrope'], 'manual.txt', { type: 'text/plain' }));
    const uploaded = await request('key-a', '/v1/kb/files/upload', 'POST', body);
    const id = (uploaded.payload as { id: string }).id;
    hooks.beforeVectorUpsert = async () => {
      throw new Error('synthetic uncertain provider response');
    };
    expect((await request('key-a', '/v1/kb/ingest/run', 'POST', JSON.stringify({ domain: 'manual', file_ids: [id], async: false }))).payload).toMatchObject({
      files: [{ status: 'failed' }],
    });
    expect((await request('key-a', `/v1/kb/files/${id}`, 'DELETE')).status).toBe(202);
    sqlite.exec("UPDATE kb_file_operations SET created_at='1900-01-01' WHERE state='running'");
    expect((await request('key-a', `/v1/kb/files/${id}`, 'DELETE')).status).toBe(202);
  });

  it('keeps inference staging and URL intake on owned immutable objects without external requests', async () => {
    const { request, objects } = handlerFixture();
    const body = new FormData();
    body.set('domain', 'manual');
    body.set('file', new File(['heliotrope inference sample'], 'sample.txt', { type: 'text/plain' }));
    const inferred = await request('key-a', '/v1/kb/schemas/infer-upload', 'POST', body);
    expect(inferred.status).toBe(200);
    const staged = (inferred.payload as { staged_files: Array<{ id: string; object_key: string }> }).staged_files[0]!;
    expect(staged.object_key).toMatch(/^raw\/v2\/tenant-a\//);
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://synthetic.example/manual.txt');
      return new Response('synthetic URL heliotrope evidence', { headers: { 'Content-Type': 'text/plain' } });
    });
    vi.stubGlobal('fetch', fetch);
    const imported = await request(
      'key-a',
      '/v1/kb/sources/import',
      'POST',
      JSON.stringify({ domain: 'manual', source: 'url', config: { urls: ['https://synthetic.example/manual.txt'] }, auto_ingest: false }),
    );
    expect(imported.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const file = (imported.payload as { files: Array<{ id: string; object_key: string }> }).files[0]!;
    expect(file.object_key).toMatch(/^raw\/v2\/tenant-a\//);
    expect(file.object_key).not.toBe(staged.object_key);
    expect((await request('key-a', `/v1/kb/files/${file.id}`, 'DELETE')).status).toBe(200);
    expect(objects.has(staged.object_key)).toBe(true);
  });

  it('retains graph lineage from surviving records and never backfills tombstoned evidence', async () => {
    const { request } = handlerFixture();
    const ingest = async (marker: string) => {
      const result = await request(
        'key-a',
        '/v1/kb/ingest/record',
        'POST',
        JSON.stringify({
          domain: 'manual',
          type: 'company',
          data: [
            { id: 'parent', name: 'Parent', marker },
            { id: 'child', name: 'Child', parent_id: 'parent', marker },
          ],
        }),
      );
      expect(result.status).toBe(201);
      return (result.payload as { file_id: string }).file_id;
    };
    const a = await ingest('original');
    const b = await ingest('updated');
    const relationships = async () =>
      (await request('key-a', '/v1/kb/relationships?domain=manual')).payload as { relationships: Array<{ evidence_file: string; src_id: string }> };
    expect((await relationships()).relationships).toEqual(expect.arrayContaining([expect.objectContaining({ evidence_file: b })]));
    expect((await request('key-a', `/v1/kb/files/${b}`, 'DELETE')).status).toBe(200);
    expect((await relationships()).relationships).toEqual(expect.arrayContaining([expect.objectContaining({ evidence_file: a })]));
    expect((await request('key-a', '/v1/kb/relationships/backfill', 'POST', JSON.stringify({ domain: 'manual' }))).status).toBe(200);
    expect((await relationships()).relationships.every((row) => row.evidence_file === a)).toBe(true);
    const childId = (await relationships()).relationships[0]!.src_id;
    const lineage = await request('key-a', `/v1/kb/entities/${childId}/lineage`);
    expect(lineage.status).toBe(200);
    expect(lineage.payload).toMatchObject({ mentions: [{ file_id: a }] });
    expect((await request('key-a', `/v1/kb/files/${a}`, 'DELETE')).status).toBe(200);
    await request('key-a', '/v1/kb/relationships/backfill', 'POST', JSON.stringify({ domain: 'manual' }));
    expect((await relationships()).relationships).toEqual([]);
  });

  it('retains saved history explicitly without republishing deleted sources or cached answers', async () => {
    const { request } = handlerFixture();
    const ingested = await request(
      'key-a',
      '/v1/kb/ingest/text',
      'POST',
      JSON.stringify({ domain: 'manual', text: 'heliotrope recovery code violet-lantern' }),
    );
    expect(ingested.status).toBe(201);
    const fileId = (ingested.payload as { file_id: string }).file_id;
    const file = (await request('key-a', `/v1/kb/files/${fileId}`)).payload as { content_hash: string };
    const query = async (session = false) =>
      await request(
        'key-a',
        '/v1/kb/query',
        'POST',
        JSON.stringify({ domain: 'manual', question: 'recovery code', mode: 'lexical', ...(session ? { session_id: 'saved-conversation' } : {}) }),
      );
    expect((await query()).payload).toMatchObject({ citations: [{ file_id: fileId }] });
    expect((await query()).payload).toMatchObject({ citations: [{ file_id: fileId }] });
    const saved = await query(true);
    const trace = (saved.payload as { trace_id: string }).trace_id;
    const deleted = await request('key-a', `/v1/kb/files/${fileId}`, 'DELETE');
    expect(deleted).toMatchObject({
      status: 200,
      payload: {
        physical_scope: 'indexed_file_artifacts',
        history_retained: true,
        message: 'Indexed file artifacts removed. Saved conversations and query traces remain.',
      },
    });
    expect((await request('key-a', `/v1/kb/query/trace/${trace}`)).payload).toMatchObject({ citations: [{ file_id: fileId }] });
    expect((await request('key-a', '/v1/kb/sessions/saved-conversation')).status).toBe(200);
    expect((await request('key-a', `/v1/kb/files/${fileId}`)).status).toBe(404);
    expect((await request('key-a', `/v1/kb/parse-artifacts/${file.content_hash}`)).status).toBe(404);
    expect((await query()).payload).toMatchObject({ citations: [], data: [] });
    expect((await query(true)).payload).toMatchObject({ citations: [], data: [] });
  });

  it('protects owned artifacts from generic mutation while preserving ordinary index ingestion', async () => {
    const { request, sqlite } = handlerFixture();
    const owned = await request('key-a', '/v1/kb/ingest/text', 'POST', JSON.stringify({ domain: 'manual', text: 'owned heliotrope' }));
    const fileId = (owned.payload as { file_id: string }).file_id;
    const document = sqlite.prepare('SELECT id,index_id FROM documents LIMIT 1').get() as { id: string; index_id: string };
    const chunk = sqlite.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: string };
    const genericPath = `/v1/indexes/${document.index_id}/ingest`;
    expect((await request('key-a', genericPath, 'POST', JSON.stringify({ documents: [{ content: 'spoofed', metadata: { file_id: fileId } }] }))).status).toBe(
      409,
    );
    expect(
      (
        await request(
          'key-a',
          `/v1/indexes/${document.index_id}/ingest-vectors`,
          'POST',
          JSON.stringify({ chunks: [{ id: chunk.id, document_id: document.id, content: 'overwrite', embedding: Array(768).fill(0.1) }] }),
        )
      ).status,
    ).toBe(409);
    expect((await request('key-a', `/v1/documents/${document.id}`, 'DELETE')).status).toBe(409);
    expect((await request('key-a', `/v1/indexes/${document.index_id}`, 'DELETE')).status).toBe(409);
    const generic = await request(
      'key-a',
      genericPath,
      'POST',
      JSON.stringify({ documents: [{ content: 'ordinary generic evidence', metadata: { source: 'synthetic' } }] }),
    );
    expect(generic.status).toBe(201);
    expect((await request('key-a', `/v1/kb/files/${fileId}`, 'DELETE')).status).toBe(200);
    const listed = await request('key-a', `/v1/indexes/${document.index_id}/documents`);
    expect(listed.payload).toMatchObject({ data: [{ content: 'ordinary generic evidence' }] });
    expect((await request('key-a', genericPath, 'POST', JSON.stringify({ documents: [{ content: 'revival', metadata: { file_id: fileId } }] }))).status).toBe(
      409,
    );
  });

  it('rolls back a registration transaction when a constrained insert fails', async () => {
    const { ledger, sqlite } = fixture();
    sqlite.exec(`CREATE TRIGGER fail_operations BEFORE INSERT ON kb_file_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    await expect(ledger.reserve(input('a'), 'upload-a')).rejects.toThrow('fixture failure');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM kb_files').get()).toMatchObject({ n: 0 });
    expect(await ledger.get('tenant-a', 'a')).toBeNull();
  });
});

describe('legacy ownership inventory', () => {
  it('keeps same-content tenants separate and reports cross-scope references without copying', () => {
    const { sqlite } = fixture();
    sqlite.exec(`INSERT INTO kb_files(id,project,domain,filename,mime,bytes,content_hash,object_key)
      VALUES ('a','tenant-a','manual','a','text/plain',5,'same','raw/shared'),
      ('b','tenant-b','manual','b','text/plain',5,'same','raw/shared'),
      ('c','tenant-a','other','c','text/plain',5,'same','raw/shared');`);
    const report = inventoryLegacyOwnership(sqlite, 'tenant-a');
    expect(report.readyForBackfill).toBe(false);
    expect(report.files).toHaveLength(2);
    expect(report.files.map((f: { fileId: string }) => f.fileId)).toEqual(['a', 'c']);
    expect(new Set(report.files.map((f: { proposedOwnedRawKey: string }) => f.proposedOwnedRawKey)).size).toBe(2);
    for (const file of report.files) expect(file).toMatchObject({ rawReferenceCount: 3, hashReferenceCount: 3, disposition: 'legacy-copy-required' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM kb_file_lifecycle').get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM kb_files WHERE object_key='raw/shared'").get()).toMatchObject({ n: 3 });
    expect(() => inventoryLegacyOwnership(sqlite, 'missing')).toThrow('Project not found');
    expect(() => inventoryLegacyOwnership(sqlite, '')).toThrow('explicit project');
  });

  it('does not infer ownership from keys or settlement from elapsed time', async () => {
    const { sqlite, ledger } = fixture();
    await uploaded(ledger);
    await ledger.claim('tenant-a', 'a', 'never-finished', 'ingest');
    sqlite.exec(`UPDATE kb_file_operations SET created_at='1900-01-01' WHERE operation_id='never-finished';
      INSERT INTO kb_files(id,project,domain,filename,mime,bytes,content_hash,object_key)
      VALUES ('fake','tenant-a','other','fake','text/plain',5,'fake','raw/v2/tenant-a/fake/fake');`);
    const report = inventoryLegacyOwnership(sqlite, 'tenant-a');
    expect(report.files[0]).toMatchObject({ disposition: 'blocked', runningOperations: 1, reasons: ['unsettled-writers'] });
    expect(report.files[1]).toMatchObject({ disposition: 'blocked', reasons: ['owned-looking-key-without-ledger'] });
    expect((await ledger.operation('tenant-a', 'never-finished'))?.state).toBe('running');
  });
});

it('runs inventory CLI against a read-only snapshot without altering bytes and rejects missing inputs', () => {
  const { sqlite } = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'kb-inventory-test-'));
  const database = join(directory, 'snapshot.sqlite');
  const command = fileURLToPath(new URL('../scripts/inventory-legacy-ownership.mjs', import.meta.url));
  try {
    sqlite.prepare('VACUUM INTO ?').run(database);
    const before = readFileSync(database);
    const run = spawnSync(process.execPath, [command, '--database', database, '--project', 'tenant-a'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ project: 'tenant-a', readyForBackfill: false, files: [] });
    expect(readFileSync(database)).toEqual(before);
    const missing = spawnSync(process.execPath, [command, '--database', join(directory, 'missing.sqlite'), '--project', 'tenant-a'], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(readdirSync(directory)).toEqual(['snapshot.sqlite']);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

it('reports pre-ownership schema and queued legacy jobs without creating a ledger', () => {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations)
    .sort()
    .filter((name) => name < '0008'))
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  sqlite.exec(`INSERT INTO kb_domains(project,name) VALUES ('default','legacy');
    INSERT INTO kb_files(id,project,domain,filename,mime,bytes,content_hash,object_key)
    VALUES ('old','default','legacy','old','text/plain',5,'same','raw/shared');
    INSERT INTO kb_ingest_jobs(id,project,domain,file_id,status) VALUES ('job','default','legacy','old','queued');`);
  const report = inventoryLegacyOwnership(sqlite, 'default');
  expect(report).toMatchObject({ ownershipSchema: false, readyForBackfill: false });
  expect(report.files[0]).toMatchObject({ unresolvedJobs: 1, disposition: 'blocked', reasons: ['unsettled-writers', 'ownership-schema-absent'] });
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='kb_file_lifecycle'").get()).toBeUndefined();
  sqlite.exec("UPDATE kb_ingest_jobs SET status='succeeded'");
  expect(inventoryLegacyOwnership(sqlite, 'default').files[0].unresolvedJobs).toBe(0);
  sqlite.exec("UPDATE kb_ingest_jobs SET locked_by='unsettled-worker'");
  expect(inventoryLegacyOwnership(sqlite, 'default').files[0].unresolvedJobs).toBe(1);
});

describe('never-dispatched recovery', () => {
  it('serializes cancellation before dispatch and blocks later intents including empty reservations', async () => {
    const { ledger, db } = fixture();
    await ledger.reserve(input('prepared'), 'op-prepared');
    const operation = (await ledger.operation('tenant-a', 'op-prepared'))!;
    await ledger.recordIntent(operation, { artifact_id: 'prepared-raw', kind: 'raw', resource_id: 'owned/prepared', provider: 'r2' });
    expect(await ledger.cancelPrepared('tenant-b', 'op-prepared')).toBe(false);
    expect(await ledger.cancelPrepared('tenant-a', 'op-prepared')).toBe(true);
    expect(await ledger.startWrite(operation, 'prepared-raw')).toBe(false);
    expect(await ledger.recordIntent(operation, { artifact_id: 'late', kind: 'parse', resource_id: 'owned/late', provider: 'r2' })).toBe(false);
    expect(await ledger.cancelPrepared('tenant-a', 'op-prepared')).toBe(true);
    expect(await new D1FileOwnership(db).cancelPrepared('tenant-a', 'op-prepared')).toBe(true);
    await ledger.requestDelete('tenant-a', 'prepared', 'delete');
    expect(await ledger.finishDelete('tenant-a', 'prepared')).toBe(true);
    await ledger.reserve(input('empty', 'tenant-b'), 'op-empty');
    const empty = (await ledger.operation('tenant-b', 'op-empty'))!;
    expect(await ledger.cancelPrepared('tenant-b', 'op-empty')).toBe(true);
    expect(await ledger.recordIntent(empty, { artifact_id: 'late-empty', kind: 'raw', resource_id: 'owned/empty', provider: 'r2' })).toBe(false);
  });
  it.each(['unknown', 'started', 'accepted', 'confirmed'])('refuses recovery after %s evidence without relying on age', async (state) => {
    const { ledger, sqlite } = fixture();
    await ledger.reserve(input('uncertain'), 'op-uncertain');
    const operation = (await ledger.operation('tenant-a', 'op-uncertain'))!;
    await ledger.recordIntent(operation, { artifact_id: 'uncertain', kind: 'raw', resource_id: 'owned/uncertain', provider: 'r2' });
    if (state === 'unknown') sqlite.exec("UPDATE kb_file_artifacts SET dispatch_state='unknown'");
    else {
      expect(await ledger.startWrite(operation, 'uncertain')).toBe(true);
      if (state !== 'started') expect(await ledger.recordWrite('tenant-a', 'op-uncertain', 'uncertain', state as 'accepted' | 'confirmed')).toBe(true);
    }
    sqlite.exec("UPDATE kb_file_operations SET created_at='2000-01-01'");
    expect(await ledger.cancelPrepared('tenant-a', 'op-uncertain')).toBe(false);
    expect((await ledger.operation('tenant-a', 'op-uncertain'))?.state).toBe('running');
    await ledger.requestDelete('tenant-a', 'uncertain', 'delete');
    expect(await ledger.finishDelete('tenant-a', 'uncertain')).toBe(false);
  });
  it('prevents an actual upload handler from writing after prepared cancellation wins', async () => {
    const f = handlerFixture();
    const prepare = f.db.prepare.bind(f.db);
    let intercepted = false;
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("SET dispatch_state = 'started'")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = ((...values: unknown[]) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = (async () => {
          if (!intercepted) {
            intercepted = true;
            const row = f.sqlite.prepare("SELECT project,operation_id FROM kb_file_operations WHERE state='running'").get() as {
              project: string;
              operation_id: string;
            };
            const operation = (await f.ledger.operation(row.project, row.operation_id))!;
            const cancelled = await f.request('key-a', `/v1/kb/files/${operation.file_id}/operations/${row.operation_id}/cancel-prepared`, 'POST');
            expect(cancelled).toMatchObject({ status: 200, payload: { state: 'cancelled', publication_changed: false, file_deleted: false } });
          }
          return await run();
        }) as typeof bound.run;
        return bound;
      }) as typeof statement.bind;
      return statement;
    }) as typeof f.db.prepare;
    const response = await f.request(
      'key-a',
      '/v1/kb/ingest/text',
      'POST',
      JSON.stringify({ domain: 'manual', text: 'Synthetic prepared cancellation evidence' }),
    );
    expect(intercepted).toBe(true);
    expect(response.status).toBe(409);
    expect(f.objects.size).toBe(0);
    const file = f.sqlite.prepare("SELECT id FROM kb_files WHERE project='tenant-a'").get() as { id: string };
    const deleted = await f.request('key-a', `/v1/kb/files/${file.id}`, 'DELETE');
    expect(deleted).toMatchObject({ status: 200, payload: { physical_state: 'complete' } });
    const retry = await f.request(
      'key-a',
      '/v1/kb/ingest/text',
      'POST',
      JSON.stringify({ domain: 'manual', text: 'Synthetic prepared cancellation evidence' }),
    );
    expect(retry.status).toBe(201);
    expect(f.objects.size).toBeGreaterThan(0);
  });
});

it.each([true, false])('serializes both dispatch/cancel orders across independent ledger instances: cancel first %s', async (cancelFirst) => {
  const { ledger, db } = fixture();
  const second = new D1FileOwnership(db);
  await ledger.reserve(input('race'), 'race');
  const operation = (await ledger.operation('tenant-a', 'race'))!;
  await ledger.recordIntent(operation, { artifact_id: 'race', kind: 'raw', resource_id: 'owned/race', provider: 'r2' });
  const cancel = () => ledger.cancelPrepared('tenant-a', 'race');
  const start = () => second.startWrite(operation, 'race');
  const [first, other] = await Promise.all(cancelFirst ? [cancel(), start()] : [start(), cancel()]);
  expect([first, other]).toEqual([true, false]);
  expect((await ledger.operation('tenant-a', 'race'))?.state).toBe(cancelFirst ? 'settled' : 'running');
});
it('retains the published generation when a later prepared reprocess is cancelled', async () => {
  const { ledger } = fixture();
  await uploaded(ledger);
  const before = await ledger.get('tenant-a', 'a');
  const op = (await ledger.claim('tenant-a', 'a', 'retry', 'reprocess'))!;
  await ledger.recordIntent(op, { artifact_id: 'retry', kind: 'parse', resource_id: ownedParseKey(op), provider: 'r2' });
  expect(await ledger.recordWrite('tenant-a', 'retry', 'retry', 'confirmed')).toBe(false);
  expect(await ledger.cancelPrepared('tenant-a', 'retry')).toBe(true);
  expect(await ledger.get('tenant-a', 'a')).toMatchObject({ state: 'active', published_generation: before?.published_generation, active_operation_id: null });
  expect(await ledger.claim('tenant-a', 'a', 'next', 'reprocess')).not.toBeNull();
});

it('migrates old intent records to unknown instead of falsely recoverable prepared state', async () => {
  const { ledger, sqlite } = fixture(undefined, (sql) => {
    sql.exec(
      "INSERT INTO kb_file_lifecycle(project,file_id,domain,content_hash,storage_version,state,generation,active_operation_id) VALUES ('tenant-a','legacy','manual','hash',2,'uploading',1,'legacy-op'); INSERT INTO kb_file_operations(operation_id,project,file_id,generation,kind,state) VALUES ('legacy-op','tenant-a','legacy',1,'upload','running'); INSERT INTO kb_file_artifacts(artifact_id,project,file_id,generation,operation_id,kind,resource_id,provider) VALUES ('legacy-artifact','tenant-a','legacy',1,'legacy-op','raw','legacy-key','r2');",
    );
  });
  expect(sqlite.prepare("SELECT dispatch_state FROM kb_file_artifacts WHERE artifact_id='legacy-artifact'").get()).toMatchObject({ dispatch_state: 'unknown' });
  expect(await ledger.cancelPrepared('tenant-a', 'legacy-op')).toBe(false);
});

it('rejects mismatched owner, file, generation and repeated dispatch', async () => {
  const { ledger } = fixture();
  await ledger.reserve(input('scoped'), 'scoped');
  const operation = (await ledger.operation('tenant-a', 'scoped'))!;
  await ledger.recordIntent(operation, { artifact_id: 'scoped', kind: 'raw', resource_id: 'owned/scoped', provider: 'r2' });
  expect(await ledger.startWrite({ ...operation, project: 'tenant-b' }, 'scoped')).toBe(false);
  expect(await ledger.startWrite({ ...operation, file_id: 'other' }, 'scoped')).toBe(false);
  expect(await ledger.startWrite({ ...operation, generation: operation.generation + 1 }, 'scoped')).toBe(false);
  expect(await ledger.startWrite(operation, 'scoped')).toBe(true);
  expect(await ledger.startWrite(operation, 'scoped')).toBe(false);
  expect(await ledger.cancelPrepared('tenant-a', 'scoped')).toBe(false);
});

it('rolls back cancellation completely if recording never-written cleanup fails', async () => {
  const { ledger, sqlite } = fixture();
  await ledger.reserve(input('atomic'), 'atomic');
  const operation = (await ledger.operation('tenant-a', 'atomic'))!;
  await ledger.recordIntent(operation, { artifact_id: 'atomic', kind: 'raw', resource_id: 'owned/atomic', provider: 'r2' });
  sqlite.exec("CREATE TRIGGER fail_cancel BEFORE UPDATE OF cleanup_state ON kb_file_artifacts BEGIN SELECT RAISE(ABORT,'synthetic cancellation failure'); END");
  await expect(ledger.cancelPrepared('tenant-a', 'atomic')).rejects.toThrow('synthetic cancellation failure');
  expect(await ledger.operation('tenant-a', 'atomic')).toMatchObject({ state: 'running' });
  expect(await ledger.get('tenant-a', 'atomic')).toMatchObject({ active_operation_id: 'atomic' });
  expect(sqlite.prepare("SELECT dispatch_state,cleanup_state FROM kb_file_artifacts WHERE artifact_id='atomic'").get()).toMatchObject({
    dispatch_state: 'prepared',
    cleanup_state: 'pending',
  });
  sqlite.exec('DROP TRIGGER fail_cancel');
  expect(await ledger.startWrite(operation, 'atomic')).toBe(true);
  expect(await ledger.cancelPrepared('tenant-a', 'atomic')).toBe(false);
});

it('authenticates and scopes prepared recovery behind the existing ownership activation gate', async () => {
  const f = handlerFixture();
  await f.ledger.reserve(input('route'), 'route-op');
  const operation = (await f.ledger.operation('tenant-a', 'route-op'))!;
  await f.ledger.recordIntent(operation, { artifact_id: 'route', kind: 'raw', resource_id: 'owned/route', provider: 'r2' });
  const route = '/v1/kb/files/route/operations/route-op/cancel-prepared';
  expect((await f.request('invalid', route, 'POST')).status).toBe(401);
  expect((await f.request('key-b', route, 'POST')).status).toBe(404);
  expect((await f.request('key-a', '/v1/kb/files/route/operations/unknown/cancel-prepared', 'POST')).status).toBe(404);
  expect((await f.request('key-a', '/v1/kb/files/other/operations/route-op/cancel-prepared', 'POST')).status).toBe(404);
  expect((await f.request('key-a', route, 'POST', undefined, createApp())).status).toBe(404);
  expect((await f.ledger.operation('tenant-a', 'route-op'))?.state).toBe('running');
  for (let retry = 0; retry < 2; retry++)
    expect(await f.request('key-a', route, 'POST')).toMatchObject({
      status: 200,
      payload: { state: 'cancelled', publication_changed: false, file_deleted: false },
    });
  await f.ledger.reserve(input('started', 'tenant-a', 'other'), 'started-op');
  const started = (await f.ledger.operation('tenant-a', 'started-op'))!;
  await f.ledger.recordIntent(started, { artifact_id: 'started', kind: 'raw', resource_id: 'owned/started', provider: 'r2' });
  expect(await f.ledger.startWrite(started, 'started')).toBe(true);
  expect((await f.request('key-a', '/v1/kb/files/started/operations/started-op/cancel-prepared', 'POST')).status).toBe(409);
  expect((await f.ledger.operation('tenant-a', 'started-op'))?.state).toBe('running');
  expect(f.objects.size).toBe(0);
});
