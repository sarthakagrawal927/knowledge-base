#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { inventorySnapshot } from './inventory-legacy-ownership.mjs';
import { hash, inside, readRegular, immutableWrite, stagingDirectory, runStagingCli } from './lib/offline-stage-files.mjs';

function verifiedSource(root, file) {
  if (!/^[a-f0-9]{64}$/.test(file.contentHash) || !Number.isSafeInteger(file.recordedBytes) || file.recordedBytes < 0)
    throw new Error('Invalid recorded hash or byte count');
  if (isAbsolute(file.sourceRawKey) || file.sourceRawKey.split('/').some((part) => part === '.' || part === '..'))
    throw new Error('Source key escapes object export');
  const path = resolve(root, file.sourceRawKey);
  if (!inside(root, path) || !inside(root, realpathSync(path))) throw new Error('Source key escapes object export');
  const bytes = readRegular(path);
  if (bytes.byteLength !== file.recordedBytes || hash(bytes) !== file.contentHash) throw new Error('Source hash or size mismatch');
  return bytes;
}

export function stageLegacyRaw(databasePath, project, objectRoot, outputRoot) {
  const inventory = inventorySnapshot(databasePath, project);
  const sourceRoot = realpathSync(objectRoot);
  const files = inventory.files.filter((file) => file.disposition !== 'already-managed');
  for (const file of files) {
    // Missing ownership schema does not prevent an offline copy. It still
    // prevents activation; every other inventory blocker requires resolution.
    if (file.reasons.some((reason) => reason !== 'ownership-schema-absent')) throw new Error('Inventory contains unresolved ownership or writer state');
    verifiedSource(sourceRoot, file);
  }
  const output = stagingDirectory(sourceRoot, outputRoot);
  const records = files.map((file) => {
    const bytes = verifiedSource(sourceRoot, file);
    const stagedFile = `${hash(file.proposedOwnedRawKey)}.bin`;
    immutableWrite(join(output, stagedFile), bytes);
    return {
      project: file.project,
      fileId: file.fileId,
      domain: file.domain,
      filename: file.filename,
      mime: file.mime,
      sourceRawKey: file.sourceRawKey,
      ownedRawKey: file.proposedOwnedRawKey,
      stagedFile,
      sha256: hash(bytes),
      bytes: bytes.byteLength,
    };
  });
  const manifest = {
    schemaVersion: 2,
    mode: 'verified-offline-raw-stage',
    project,
    readyForPublication: false,
    records,
    limitations: [
      'Local exported bytes only; provider state and writer drain are unverified.',
      'No database records, parse provenance, indexes or legacy objects were changed.',
      'Rebuild and verify provenance and complete atomic publication before activation.',
    ],
  };
  immutableWrite(join(output, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return manifest;
}

await runStagingCli(import.meta.url, ['--database', '--project', '--object-root', '--output-root'], stageLegacyRaw);
