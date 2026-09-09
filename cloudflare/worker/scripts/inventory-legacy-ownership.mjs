#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function count(db, sql, ...bindings) {
  return Number(db.prepare(sql).get(...bindings).n);
}

function inventoryBlockers(file, lifecycle, target, ownershipSchema, unresolvedWriters) {
  const reasons = [];
  if (unresolvedWriters || lifecycle?.active_operation_id) reasons.push('unsettled-writers');
  if (!ownershipSchema) reasons.push('ownership-schema-absent');
  if (lifecycle && lifecycle.state !== 'active') reasons.push('lifecycle-not-active');
  if (!lifecycle && file.object_key.startsWith('raw/v2/')) reasons.push('owned-looking-key-without-ledger');
  if (
    lifecycle &&
    (lifecycle.storage_version !== 2 || file.object_key !== target || lifecycle.domain !== file.domain || lifecycle.content_hash !== file.content_hash)
  )
    reasons.push('ledger-file-mismatch');
  return reasons;
}

function inspectFile(db, file, ownershipSchema) {
  const lifecycle = ownershipSchema
    ? db
        .prepare(
          'SELECT storage_version,state,generation,published_generation,active_operation_id,domain,content_hash FROM kb_file_lifecycle WHERE project=? AND file_id=?',
        )
        .get(file.project, file.id)
    : null;
  const target = `raw/v2/${encodeURIComponent(file.project)}/${encodeURIComponent(file.id)}/${encodeURIComponent(file.content_hash)}`;
  const unresolvedJobs = count(
    db,
    "SELECT COUNT(*) AS n FROM kb_ingest_jobs WHERE project=? AND file_id=? AND (status NOT IN ('succeeded','failed') OR locked_by IS NOT NULL)",
    file.project,
    file.id,
  );
  const runningOperations = ownershipSchema
    ? count(db, "SELECT COUNT(*) AS n FROM kb_file_operations WHERE project=? AND file_id=? AND state='running'", file.project, file.id)
    : 0;
  const reasons = inventoryBlockers(file, lifecycle, target, ownershipSchema, unresolvedJobs + runningOperations);
  const parse = db.prepare('SELECT object_key FROM kb_parse_artifacts WHERE content_hash=?').get(file.content_hash);
  return {
    project: file.project,
    fileId: file.id,
    domain: file.domain,
    filename: file.filename,
    mime: file.mime,
    contentHash: file.content_hash,
    recordedBytes: file.bytes,
    sourceRawKey: file.object_key,
    proposedOwnedRawKey: target,
    legacyParseKey: parse?.object_key ?? null,
    rawReferenceCount: count(db, 'SELECT COUNT(*) AS n FROM kb_files WHERE object_key=?', file.object_key),
    hashReferenceCount: count(db, 'SELECT COUNT(*) AS n FROM kb_files WHERE content_hash=?', file.content_hash),
    unresolvedJobs,
    runningOperations,
    lifecycle: lifecycle ?? null,
    disposition: reasons.length ? 'blocked' : lifecycle ? 'already-managed' : 'legacy-copy-required',
    reasons,
  };
}

// The caller supplies an administrative snapshot containing all scopes. This
// inventory cannot establish its completeness or authorize a backfill.
export function inventoryLegacyOwnership(db, project) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('An explicit project is required');
  db.exec('BEGIN');
  try {
    if (!db.prepare('SELECT 1 FROM kb_projects WHERE name=?').get(project)) throw new Error('Project not found in snapshot');
    const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const ownershipSchema = hasTable('kb_file_lifecycle') && hasTable('kb_file_operations');
    if (hasTable('kb_file_lifecycle') !== hasTable('kb_file_operations')) throw new Error('Incomplete ownership schema');
    const files = db
      .prepare('SELECT id,project,domain,filename,mime,content_hash,bytes,object_key FROM kb_files WHERE project=? ORDER BY domain,id')
      .all(project)
      .map((file) => inspectFile(db, file, ownershipSchema));
    const orphanLifecycleCount = ownershipSchema
      ? count(
          db,
          'SELECT COUNT(*) AS n FROM kb_file_lifecycle l WHERE l.project=? AND NOT EXISTS (SELECT 1 FROM kb_files f WHERE f.project=l.project AND f.id=l.file_id)',
          project,
        )
      : 0;
    return {
      schemaVersion: 1,
      mode: 'read-only-snapshot-inventory',
      project,
      ownershipSchema,
      readyForBackfill: false,
      orphanLifecycleCount,
      files,
      limitations: [
        'Reference counts cover this snapshot only; completeness and writer drain are unverified.',
        'No raw bytes, parse provenance, indexed artifacts or provider convergence were verified.',
        'Already-managed describes ledger presence, not release or deletion readiness.',
        'Shared legacy objects must be retained until separately verified zero-reference cleanup.',
      ],
    };
  } finally {
    db.exec('ROLLBACK');
  }
}

export function inventorySnapshot(databasePath, project) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return inventoryLegacyOwnership(db, project);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--database' || args[2] !== '--project')
      throw new Error('Usage: node scripts/inventory-legacy-ownership.mjs --database <local-snapshot.sqlite> --project <project>');
    console.log(JSON.stringify(inventorySnapshot(args[1], args[3]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
