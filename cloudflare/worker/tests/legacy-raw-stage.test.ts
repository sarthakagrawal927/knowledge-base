import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stageLegacyRaw } from '../scripts/stage-legacy-raw.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-raw-stage-test-'));
  directories.push(root);
  const database = join(root, 'snapshot.sqlite');
  const source = join(root, 'source');
  const output = join(root, 'output');
  mkdirSync(source);
  const bytes = Buffer.from('a private synthetic manual');
  writeFileSync(join(source, 'shared'), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const db = new DatabaseSync(database);
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
    db.exec("INSERT INTO kb_projects(name) VALUES ('a'),('b'); INSERT INTO kb_domains(project,name) VALUES ('a','one'),('a','two'),('b','one');");
    const insert = db.prepare('INSERT INTO kb_files(id,project,domain,filename,mime,bytes,content_hash,object_key) VALUES (?,?,?,?,?,?,?,?)');
    insert.run('one', 'a', 'one', 'one', 'text/plain', bytes.length, digest, 'shared');
    insert.run('..', 'a', 'two', 'two', 'text/plain', bytes.length, digest, 'shared');
    insert.run('other', 'b', 'one', 'other', 'text/plain', bytes.length, digest, 'shared');
  } finally {
    db.close();
  }
  return { root, database, source, output, bytes };
}
function update(database: string, sql: string) {
  const db = new DatabaseSync(database);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

it('stages distinct owned keys with verified bytes, preserves inputs and retries idempotently', () => {
  const f = fixture();
  const before = readFileSync(f.database);
  const first = stageLegacyRaw(f.database, 'a', f.source, f.output);
  expect(first.readyForPublication).toBe(false);
  expect(first.records).toHaveLength(2);
  expect(new Set(first.records.map((r: { stagedFile: string }) => r.stagedFile)).size).toBe(2);
  for (const record of first.records) {
    expect(record.stagedFile).toMatch(/^[a-f0-9]{64}\.bin$/);
    expect(readFileSync(join(f.output, record.stagedFile))).toEqual(f.bytes);
  }
  expect(stageLegacyRaw(f.database, 'a', f.source, f.output)).toEqual(first);
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/stage-legacy-raw.mjs', import.meta.url)),
      '--database',
      f.database,
      '--project',
      'a',
      '--object-root',
      f.source,
      '--output-root',
      f.output,
    ],
    { encoding: 'utf8' },
  );
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(first);
  const other = stageLegacyRaw(f.database, 'b', f.source, join(f.root, 'other-output'));
  expect(other.records).toHaveLength(1);
  expect(first.records.some((r: { stagedFile: string }) => r.stagedFile === other.records[0].stagedFile)).toBe(false);
  expect(readFileSync(f.database)).toEqual(before);
  expect(readFileSync(join(f.source, 'shared'))).toEqual(f.bytes);
  expect(readdirSync(f.output)).toHaveLength(3);
});

it('rejects source corruption and byte-count mismatch before creating output', () => {
  const f = fixture();
  writeFileSync(join(f.source, 'shared'), 'corrupted');
  expect(() => stageLegacyRaw(f.database, 'a', f.source, f.output)).toThrow('hash or size mismatch');
  expect(readdirSync(f.root)).not.toContain('output');
  writeFileSync(join(f.source, 'shared'), f.bytes);
  update(f.database, "UPDATE kb_files SET bytes=1 WHERE project='a'");
  expect(() => stageLegacyRaw(f.database, 'a', f.source, f.output)).toThrow('hash or size mismatch');
});

it('rejects escaping sources, overlapping directories and symlink destinations', () => {
  const f = fixture();
  update(f.database, "UPDATE kb_files SET object_key='../snapshot.sqlite' WHERE project='a'");
  expect(() => stageLegacyRaw(f.database, 'a', f.source, f.output)).toThrow('escapes');
  update(f.database, "UPDATE kb_files SET object_key='shared' WHERE project='a'");
  expect(() => stageLegacyRaw(f.database, 'a', f.source, join(f.source, 'output'))).toThrow('overlap');
  symlinkSync(f.source, f.output);
  expect(() => stageLegacyRaw(f.database, 'a', f.source, f.output)).toThrow('real directory');
});

it('retains conflicting output and refuses unresolved legacy writers', () => {
  const f = fixture();
  const report = stageLegacyRaw(f.database, 'a', f.source, f.output);
  const target = join(f.output, report.records[0].stagedFile);
  writeFileSync(target, 'retain conflicting bytes');
  expect(() => stageLegacyRaw(f.database, 'a', f.source, f.output)).toThrow('conflicts');
  expect(readFileSync(target, 'utf8')).toBe('retain conflicting bytes');
  expect(readdirSync(f.output).some((name) => name.startsWith('.stage-'))).toBe(false);
  update(f.database, "INSERT INTO kb_ingest_jobs(id,project,domain,file_id,status) VALUES ('pending','a','one','one','running')");
  expect(() => stageLegacyRaw(f.database, 'a', f.source, f.output)).toThrow('unresolved');
});
