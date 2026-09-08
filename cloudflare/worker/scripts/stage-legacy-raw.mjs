#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inventorySnapshot } from './inventory-legacy-ownership.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Expected a regular file');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

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

function immutableWrite(path, bytes) {
  const temporary = join(dirname(path), `.stage-${randomUUID()}`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!readRegular(path).equals(bytes)) throw new Error('Existing staging output conflicts with verified input');
    }
    if (!readRegular(path).equals(bytes)) throw new Error('Staging readback verification failed');
  } finally {
    unlinkSync(temporary);
  }
}

function stagingDirectory(sourceRoot, requestedOutput) {
  const parent = realpathSync(dirname(resolve(requestedOutput)));
  const output = join(parent, basename(resolve(requestedOutput)));
  if (output === sourceRoot || inside(sourceRoot, output) || inside(output, sourceRoot)) throw new Error('Source and staging directories must not overlap');
  try {
    mkdirSync(output, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) throw new Error('Staging destination must be a real directory');
  return output;
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
      sourceRawKey: file.sourceRawKey,
      ownedRawKey: file.proposedOwnedRawKey,
      stagedFile,
      sha256: hash(bytes),
      bytes: bytes.byteLength,
    };
  });
  const manifest = {
    schemaVersion: 1,
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 8 || args[0] !== '--database' || args[2] !== '--project' || args[4] !== '--object-root' || args[6] !== '--output-root')
      throw new Error('Usage: node scripts/stage-legacy-raw.mjs --database SNAPSHOT --project PROJECT --object-root EXPORT --output-root STAGING');
    console.log(JSON.stringify(stageLegacyRaw(args[1], args[3], args[5], args[7]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
