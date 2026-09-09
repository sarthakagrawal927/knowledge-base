import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { stageLegacyRaw } from '../scripts/stage-legacy-raw.mjs';
import { stageLegacyParse } from '../scripts/stage-legacy-parse.mjs';
import { parseUploadBytes } from '../src/document-parser';
import { buildParseArtifact } from '../src/parse-artifact';
const parser = { parseUploadBytes, buildParseArtifact };
type ParseRecord = Awaited<ReturnType<typeof stageLegacyParse>>['records'][number];
function staged(record: ParseRecord | undefined) {
  if (!record || !('stagedFile' in record)) throw new Error('Expected staged artifact');
  return record;
}
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function fixture(filename = 'manual.txt', content: Uint8Array = Buffer.from('Synthetic manual: retain original evidence.'), mime = 'text/plain') {
  const root = mkdtempSync(join(tmpdir(), 'kb-parse-stage-'));
  directories.push(root);
  const database = join(root, 'snapshot.sqlite');
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'shared'), content);
  const db = new DatabaseSync(database);
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), 'utf8'));
    db.exec("INSERT INTO kb_projects(name) VALUES ('a'),('b'); INSERT INTO kb_domains(project,name) VALUES ('a','one'),('a','two'),('b','one');");
    const insert = db.prepare('INSERT INTO kb_files(id,project,domain,filename,mime,bytes,content_hash,object_key) VALUES (?,?,?,?,?,?,?,?)');
    for (const [id, project, domain] of [
      ['first', 'a', 'one'],
      ['second', 'a', 'two'],
      ['third', 'b', 'one'],
    ] as const)
      insert.run(id, project, domain, filename, mime, content.length, createHash('sha256').update(content).digest('hex'), 'shared');
  } finally {
    db.close();
  }
  const raw = join(root, 'raw');
  stageLegacyRaw(database, 'a', source, raw);
  return { root, database, source, raw, output: join(root, 'parse') };
}
it('uses actual parser in the CLI, preserves inputs, separates identical cross-tenant bytes and retries identically', async () => {
  const f = fixture();
  const before = readFileSync(f.database);
  const first = await stageLegacyParse(f.database, 'a', f.raw, f.output, parser);
  expect(first.readyForPublication).toBe(false);
  expect(first.records.map((r: { status: string }) => r.status)).toEqual(['staged', 'staged']);
  const artifacts = first.records.map((r) => JSON.parse(readFileSync(join(f.output, staged(r).stagedFile), 'utf8')));
  expect(artifacts.map((a) => a.documents[0].metadata.file_id)).toEqual(['first', 'second']);
  expect(artifacts.map((a) => a.documents[0].metadata.domain)).toEqual(['one', 'two']);
  expect(await stageLegacyParse(f.database, 'a', f.raw, f.output, parser)).toEqual(first);
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/stage-legacy-parse.mjs', import.meta.url)),
      '--database',
      f.database,
      '--project',
      'a',
      '--raw-stage-root',
      f.raw,
      '--output-root',
      f.output,
    ],
    { encoding: 'utf8' },
  );
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(first);
  const rawB = join(f.root, 'raw-b');
  stageLegacyRaw(f.database, 'b', f.source, rawB);
  const other = await stageLegacyParse(f.database, 'b', rawB, join(f.root, 'parse-b'), parser);
  expect(first.records.some((r) => staged(r).candidateKey === staged(other.records[0]).candidateKey)).toBe(false);
  expect(readFileSync(f.database)).toEqual(before);
});
it.each([
  ['rows.csv', Buffer.from('name,value\nAlpha,7\nBeta,9'), 'text/csv'],
  ['rows.json', Buffer.from('[{"name":"Alpha","value":7}]'), 'application/json'],
  [
    'note.docx',
    zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Document evidence</w:t></w:r></w:p></w:body></w:document>') }),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  [
    'slides.pptx',
    zipSync({ 'ppt/slides/slide1.xml': strToU8('<a:t>Slide evidence</a:t>') }),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  [
    'sheet.xlsx',
    zipSync({
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Alpha</t></is></c></row></sheetData></worksheet>',
      ),
    }),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
])('stages real %s format with owned document provenance', async (filename, content, mime) => {
  const f = fixture(filename, content, mime);
  const result = await stageLegacyParse(f.database, 'a', f.raw, f.output, parser);
  expect(result.records[0]?.status).toBe('staged');
  const artifact = JSON.parse(readFileSync(join(f.output, staged(result.records[0]).stagedFile), 'utf8'));
  expect(artifact.documents.length).toBeGreaterThan(0);
  for (const doc of artifact.documents) expect(doc.metadata).toMatchObject({ project: 'a', domain: 'one', file_id: 'first', filename });
});
it('rejects raw corruption, changed snapshot identity and immutable output conflicts', async () => {
  const f = fixture();
  const first = await stageLegacyParse(f.database, 'a', f.raw, f.output, parser);
  const target = join(f.output, staged(first.records[0]).stagedFile);
  writeFileSync(target, 'retain conflict');
  await expect(stageLegacyParse(f.database, 'a', f.raw, f.output, parser)).rejects.toThrow('conflicts');
  expect(readFileSync(target, 'utf8')).toBe('retain conflict');
  const db = new DatabaseSync(f.database);
  db.exec("UPDATE kb_files SET filename='changed.txt' WHERE id='first'");
  db.close();
  await expect(stageLegacyParse(f.database, 'a', f.raw, join(f.root, 'new'), parser)).rejects.toThrow('identity mismatch');
  const other = fixture();
  const manifest = JSON.parse(readFileSync(join(other.raw, 'manifest.json'), 'utf8'));
  writeFileSync(join(other.raw, manifest.records[0].stagedFile), 'corrupt');
  await expect(stageLegacyParse(other.database, 'a', other.raw, other.output, parser)).rejects.toThrow('hash or size mismatch');
});
it.each([
  ['unknown.bin', 'unsupported-local-format'],
  ['scan.pdf', 'pdf-invalid-or-unsupported'],
])('retains blocked %s without creating parse artifacts', async (filename, reason) => {
  const f = fixture(filename, Buffer.from('%PDF-1.4\n%%EOF'));
  const result = await stageLegacyParse(f.database, 'a', f.raw, f.output, parser);
  expect(result.records[0]).toMatchObject({ status: 'blocked', reason });
  expect(readdirSync(f.output)).toEqual(['manifest.json']);
});

function pdfFixture(options: { blank?: boolean; encrypted?: boolean; pages?: number; image?: boolean } = {}) {
  // Physical object order deliberately differs from page-tree order (page 4 before page 3).
  const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count ${options.pages ?? 2} >>`],
    [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>'],
    [6, stream(options.blank ? '' : options.image ? 'q 100 0 0 100 0 0 cm /Im1 Do Q' : 'BT /F1 12 Tf 50 700 Td (Second page evidence) Tj ET')],
    [5, stream('BT /F1 12 Tf 50 700 Td (First page evidence) Tj ET')],
    [7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ];
  if (options.image) {
    objects[2] = [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 6 0 R >>'];
    objects.push([
      8,
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFFFFFF>\nendstream',
    ]);
  }
  if (options.pages && options.pages > 2) {
    const extra = Array.from({ length: options.pages - 2 }, (_, index) => index + 8);
    objects[1] = [2, `<< /Type /Pages /Kids [3 0 R 4 0 R ${extra.map((id) => `${id} 0 R`).join(' ')}] /Count ${options.pages} >>`];
    for (const id of extra)
      objects.push([id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>']);
  }
  if (options.encrypted) objects.push([8, `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`]);
  let text = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (const [id, body] of objects) {
    offsets.set(id, Buffer.byteLength(text));
    text += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objects.length; id++) text += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${options.encrypted ? '/Encrypt 8 0 R /ID [<00000000000000000000000000000000><00000000000000000000000000000000>]' : ''} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
it('extracts actual PDF pages in page-tree order with exact excerpts and stable owned provenance', async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden in offline reconstruction');
  });
  const f = fixture('manual.pdf', pdfFixture(), 'application/pdf');
  const result = await stageLegacyParse(f.database, 'a', f.raw, f.output, parser);
  expect(result.records[0]?.status).toBe('staged');
  const artifact = JSON.parse(readFileSync(join(f.output, staged(result.records[0]).stagedFile), 'utf8'));
  expect(artifact.parser).toBe('offline-pdfjs');
  expect(artifact.documents.map((doc: { content: string }) => doc.content)).toEqual(['First page evidence', 'Second page evidence']);
  expect(artifact.documents.map((doc: { metadata: unknown }) => doc.metadata)).toEqual([
    expect.objectContaining({ page: 1, excerpt: 'First page evidence', file_id: 'first', project: 'a' }),
    expect.objectContaining({ page: 2, excerpt: 'Second page evidence', file_id: 'first', project: 'a' }),
  ]);
  expect(await stageLegacyParse(f.database, 'a', f.raw, f.output, parser)).toEqual(result);
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/stage-legacy-parse.mjs', import.meta.url)),
      '--database',
      f.database,
      '--project',
      'a',
      '--raw-stage-root',
      f.raw,
      '--output-root',
      f.output,
    ],
    { encoding: 'utf8' },
  );
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(result);
});
it.each([
  [{ blank: true }, 'pdf-page-without-text-needs-review-or-ocr'],
  [{ image: true }, 'pdf-page-without-text-needs-review-or-ocr'],
  [{ encrypted: true }, 'pdf-password-required'],
])('blocks unsupported PDF completion %s', async (options, reason) => {
  const f = fixture('manual.pdf', pdfFixture(options), 'application/pdf');
  const result = await stageLegacyParse(f.database, 'a', f.raw, f.output, parser);
  expect(result.records[0]).toMatchObject({ status: 'blocked', reason });
  expect(readdirSync(f.output)).toEqual(['manifest.json']);
});

it('rejects oversized raw metadata before reading or creating output', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.database);
  db.exec('UPDATE kb_files SET bytes=67108865');
  db.close();
  const path = join(f.raw, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const record of manifest.records) record.bytes = 67108865;
  writeFileSync(path, JSON.stringify(manifest));
  await expect(stageLegacyParse(f.database, 'a', f.raw, f.output, parser)).rejects.toThrow('size limit');
  expect(readdirSync(f.root)).not.toContain('parse');
});
it('blocks a PDF beyond the page limit before page extraction', async () => {
  const f = fixture('large.pdf', pdfFixture({ pages: 501 }), 'application/pdf');
  const result = await stageLegacyParse(f.database, 'a', f.raw, f.output, parser);
  expect(result.records[0]).toMatchObject({ status: 'blocked', reason: 'pdf-page-limit-exceeded' });
});

it('rejects an oversized aggregate before reading raw files or creating a partial manifest', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.database);
  for (const id of ['extra1', 'extra2', 'extra3']) {
    db.prepare("INSERT INTO kb_domains(project,name) VALUES ('a',?)").run(id);
    db.prepare(
      "INSERT INTO kb_files(id,project,domain,filename,mime,bytes,content_hash,object_key) SELECT ?,project,?,filename,mime,bytes,content_hash,object_key FROM kb_files WHERE id='first'",
    ).run(id, id);
  }
  db.exec("UPDATE kb_files SET bytes=67108864 WHERE project='a'");
  db.close();
  const path = join(f.raw, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const id of ['extra1', 'extra2', 'extra3'])
    manifest.records.push({ ...manifest.records[0], fileId: id, domain: id, ownedRawKey: `raw/v2/a/${id}/${manifest.records[0].sha256}` });
  for (const record of manifest.records) record.bytes = 67108864;
  writeFileSync(path, JSON.stringify(manifest));
  // Raw files are only tiny fixture bytes. Aggregate rejection must precede their size checks.
  await expect(stageLegacyParse(f.database, 'a', f.raw, f.output, parser)).rejects.toThrow('aggregate size limit');
  expect(readdirSync(f.root)).not.toContain('parse');
});
