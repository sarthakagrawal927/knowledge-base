#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { inventorySnapshot } from './inventory-legacy-ownership.mjs';
import { hash, readRegular, immutableWrite, stagingDirectory, runStagingCli } from './lib/offline-stage-files.mjs';
import { parseOfflinePdf } from './lib/offline-pdf.mjs';
import { loadLocalParser } from './lib/load-local-parser.mjs';

function verifyRecords(inventory, manifest, root) {
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mode !== 'verified-offline-raw-stage' ||
    manifest.project !== inventory.project ||
    manifest.readyForPublication !== false ||
    !Array.isArray(manifest.records)
  )
    throw new Error('Expected a version 2 raw staging manifest for this project');
  const files = inventory.files.filter((file) => file.disposition !== 'already-managed');
  if (manifest.records.length !== files.length) throw new Error('Snapshot and manifest file sets differ');
  let totalBytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.recordedBytes) || file.recordedBytes < 0 || file.recordedBytes > 64 * 1024 * 1024)
      throw new Error('Raw artifact exceeds offline staging size limit');
    totalBytes += file.recordedBytes;
    if (totalBytes > 256 * 1024 * 1024) throw new Error('Raw batch exceeds offline staging aggregate size limit');
  }

  return files.map((file) => {
    if (file.reasons.some((reason) => reason !== 'ownership-schema-absent')) throw new Error('Snapshot contains unresolved ownership or writer state');
    const matches = manifest.records.filter((record) => record.fileId === file.fileId);
    const record = matches[0];
    if (
      matches.length !== 1 ||
      !record ||
      record.project !== file.project ||
      record.domain !== file.domain ||
      record.filename !== file.filename ||
      record.mime !== file.mime ||
      record.sourceRawKey !== file.sourceRawKey ||
      record.ownedRawKey !== file.proposedOwnedRawKey ||
      record.sha256 !== file.contentHash ||
      record.bytes !== file.recordedBytes
    )
      throw new Error('Snapshot and manifest identity mismatch');
    if (record.stagedFile !== `${hash(record.ownedRawKey)}.bin`) throw new Error('Invalid staged filename');
    const bytes = readRegular(join(root, record.stagedFile), record.bytes);
    if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw new Error('Staged raw hash or size mismatch');
    return { file, record, bytes };
  });
}

async function parseCandidate(input, parser) {
  const { file, bytes } = input;
  const extension = file.filename.toLowerCase().split('.').at(-1);
  if (!['txt', 'md', 'csv', 'json', 'jsonl', 'ndjson', 'html', 'htm', 'docx', 'xlsx', 'pptx', 'pdf'].includes(extension))
    return { reason: 'unsupported-local-format' };
  if (file.mime?.startsWith('image/')) return { reason: 'provider-or-ocr-required' };
  try {
    const isPdf = extension === 'pdf' || file.mime === 'application/pdf';
    if (!isPdf && !['docx', 'xlsx', 'pptx'].includes(extension)) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) return { reason: 'unsupported-binary-text' };
    }
    const pdfResult = isPdf ? await parseOfflinePdf(file.filename, bytes) : null;
    if (pdfResult?.reason) return { reason: pdfResult.reason };
    const parsed =
      pdfResult?.parsed ?? parser.parseUploadBytes(file.filename, file.mime, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!parsed.text.trim() || parsed.documents.length === 0) return { reason: 'no-local-text-or-ocr-required' };
    if (parsed.record_count > parsed.documents.length) return { reason: 'local-record-limit-exceeded' };
    return {
      artifact: parser.buildParseArtifact(parsed, {
        project: file.project,
        domain: file.domain,
        id: file.fileId,
        filename: file.filename,
        content_hash: file.contentHash,
      }),
    };
  } catch {
    return { reason: 'local-parse-failed' };
  }
}

/** @param {Awaited<ReturnType<typeof loadLocalParser>> | null} parser */
export async function stageLegacyParse(databasePath, project, rawStageRoot, outputRoot, parser = null) {
  const inventory = inventorySnapshot(databasePath, project);
  const sourceRoot = realpathSync(rawStageRoot);
  const manifestBytes = readRegular(join(sourceRoot, 'manifest.json'));
  const inputs = verifyRecords(inventory, JSON.parse(manifestBytes), sourceRoot);
  const localParser = parser ?? (await loadLocalParser());
  const candidates = [];
  for (const input of inputs) candidates.push({ ...input, parsed: await parseCandidate(input, localParser) });
  const output = stagingDirectory(sourceRoot, outputRoot);
  const records = candidates.map(({ file, record, parsed }) => {
    const identity = { project, fileId: file.fileId, domain: file.domain, rawSha256: record.sha256 };
    if (!parsed.artifact) return { ...identity, status: 'blocked', reason: parsed.reason };
    const bytes = Buffer.from(`${JSON.stringify(parsed.artifact, null, 2)}\n`);
    const artifactHash = hash(bytes);
    const operationId = `offline-${hash(JSON.stringify([identity, artifactHash]))}`;
    const candidateKey = `parse/v2/${encodeURIComponent(project)}/${encodeURIComponent(file.fileId)}/1/${operationId}.json`;
    const stagedFile = `${hash(candidateKey)}.json`;
    immutableWrite(join(output, stagedFile), bytes);
    return {
      ...identity,
      status: 'staged',
      candidateKey,
      candidateGeneration: 1,
      candidateOperationId: operationId,
      stagedFile,
      sha256: artifactHash,
      bytes: bytes.length,
    };
  });
  const manifest = {
    schemaVersion: 1,
    mode: 'verified-offline-parse-stage',
    project,
    rawManifestSha256: hash(manifestBytes),
    snapshotInventorySha256: hash(JSON.stringify(inventory)),
    readyForPublication: false,
    records,
    limitations: [
      'Local parser only; no provider or indexed/structured backfill performed.',
      'Candidate identities are not ledger reservations; revalidate writer drain and allocate identities before publication.',
      'Raw export and snapshot are unchanged. Legacy artifacts are retained.',
    ],
  };
  immutableWrite(join(output, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return manifest;
}

await runStagingCli(import.meta.url, ['--database', '--project', '--raw-stage-root', '--output-root'], stageLegacyParse);
