import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1MetadataRepository, type FileRecord } from '../src/kb-metadata-repository';

describe('shared file storage preflight SQL', () => {
  it('detects shared raw keys or hashes outside the entire deletion set', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(`CREATE TABLE kb_files (id TEXT PRIMARY KEY, object_key TEXT, content_hash TEXT, project TEXT);
        INSERT INTO kb_files VALUES ('a','raw/a','same','tenant-a'),('b','raw/b','same','tenant-b'),('c','raw/a','different','tenant-a'),('unique','raw/unique','unique','tenant-a');`);
      const db = {
        prepare: (query: string) => ({ bind: (...params: string[]) => ({ first: async () => sqlite.prepare(query).get(...params) ?? null }) }),
      } as unknown as D1Database;
      const repository = new D1MetadataRepository(db);
      const file = (id: string, object_key: string, content_hash: string) => ({ id, object_key, content_hash }) as FileRecord;
      const a = file('a', 'raw/a', 'same');
      const b = file('b', 'raw/b', 'same');
      const c = file('c', 'raw/a', 'different');
      expect(await repository.hasSharedFileStorage([a])).toBe(true);
      expect(await repository.hasSharedFileStorage([a, b])).toBe(true);
      expect(await repository.hasSharedFileStorage([a, b, c])).toBe(false);
      expect(await repository.hasSharedFileStorage([file('unique', 'raw/unique', 'unique')])).toBe(false);
      expect(await repository.hasSharedFileStorage([])).toBe(false);
      expect(await repository.hasFileWithContentHash('tenant-a', 'same')).toBe(true);
      expect(await repository.hasFileWithContentHash('tenant-b', 'same')).toBe(true);
      expect(await repository.hasFileWithContentHash('tenant-c', 'same')).toBe(false);
      expect(await repository.hasFileWithContentHash('tenant-b', 'unique')).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
