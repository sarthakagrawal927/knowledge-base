import { HTTPException } from 'hono/http-exception';
import { D1FileOwnership, ownedRawKey, ownedParseKey, type FileOperation } from './file-ownership';
import { D1MetadataRepository, type FileRecord, type MetadataRepository, type RegisterFileInput, type ParseArtifactRecord } from './kb-metadata-repository';
import type { Env, VectorizeBinding } from './types';
import { D1Repository } from './d1-repository';
import { sha256Hex } from './app-utils';

export async function storeFileBytes(
  env: Env,
  metadata: MetadataRepository,
  enabled: boolean,
  input: RegisterFileInput,
  bytes: ArrayBuffer | Uint8Array,
  options: R2PutOptions,
): Promise<FileRecord> {
  if (!env.RAW_DOCS) throw new Error('RAW_DOCS R2 bucket is not configured');
  if (!enabled) {
    await env.RAW_DOCS.put(input.objectKey, bytes, options);
    return await metadata.registerFile(input);
  }
  await metadata.upsertDomain(input.project, input.domain);
  const ledger = new D1FileOwnership(env.DB);
  const operationId = crypto.randomUUID();
  const lifecycle = await ledger.reserve(input, operationId);
  if (!lifecycle) throw new HTTPException(409, { message: 'Legacy file requires verified ownership migration before it can be rewritten.' });
  if (lifecycle.file_id !== input.id) {
    const existing = await metadata.getFile(input.project, lifecycle.file_id);
    if (existing && lifecycle.state === 'active') return existing;
    throw new HTTPException(409, { message: 'File upload or deletion is pending.' });
  }
  const operation = await ledger.operation(input.project, operationId);
  if (!operation) throw new HTTPException(409, { message: 'File operation is no longer active.' });
  const artifactId = crypto.randomUUID();
  const resourceId = ownedRawKey(input.project, input.id, input.contentHash);
  if (!(await ledger.recordIntent(operation, { artifact_id: artifactId, kind: 'raw', resource_id: resourceId, provider: 'r2' }))) {
    await ledger.settle(operation, false);
    throw new HTTPException(409, { message: 'File deletion is pending.' });
  }
  if (!(await ledger.startWrite(operation, artifactId))) throw new HTTPException(409, { message: 'File operation was cancelled before dispatch.' });
  // A rejected/uncertain external write deliberately leaves the operation running.
  // Recovery must establish settlement; a timer is not evidence of termination.
  try {
    await env.RAW_DOCS.put(resourceId, bytes, options);
  } catch {
    throw new UnsettledFileWrite('Raw object write settlement is unknown.');
  }
  await ledger.recordWrite(input.project, operationId, artifactId, 'confirmed');
  if (!(await ledger.settle(operation, true))) throw new HTTPException(409, { message: 'File was removed while uploading.' });
  const file = await metadata.getFile(input.project, input.id);
  if (!file) throw new HTTPException(409, { message: 'File was removed while uploading.' });
  return file;
}

export class UnsettledFileWrite extends Error {}

export async function registerOwnedObject(env: Env, metadata: MetadataRepository, enabled: boolean, input: RegisterFileInput): Promise<FileRecord> {
  if (!enabled) return await metadata.registerFile(input);
  const owned = await env.DB.prepare(`SELECT 1 AS found FROM kb_file_artifacts a JOIN kb_file_lifecycle l
    ON l.project = a.project AND l.file_id = a.file_id
    WHERE a.project = ? AND a.resource_id = ? AND a.kind = 'raw' AND a.provider = 'r2'
    AND a.write_state = 'confirmed' AND l.state = 'active' LIMIT 1`)
    .bind(input.project, input.objectKey)
    .first();
  if (!owned) throw new HTTPException(404, { message: 'Owned source object not found.' });
  const object = await env.RAW_DOCS?.get(input.objectKey);
  if (!object) throw new HTTPException(404, { message: 'Owned source object not found.' });
  const bytes = await object.arrayBuffer();
  if ((await sha256Hex(bytes)) !== input.contentHash || bytes.byteLength !== input.bytes)
    throw new HTTPException(400, { message: 'Source object hash or size does not match.' });
  return await storeFileBytes(env, metadata, true, input, bytes, { httpMetadata: { contentType: input.mime ?? 'application/octet-stream' } });
}

export async function persistParseArtifact(
  env: Env,
  metadata: MetadataRepository,
  operation: FileOperation | undefined,
  input: { contentHash: string; parser: string; parserVersion?: string | null; objectKey: string; pageCount?: number | null },
  content: string,
  options: R2PutOptions,
): Promise<ParseArtifactRecord> {
  if (!env.RAW_DOCS) throw new Error('RAW_DOCS is required');
  if (!operation) {
    await env.RAW_DOCS.put(input.objectKey, content, options);
    return await metadata.upsertParseArtifact(input);
  }
  const ledger = new D1FileOwnership(env.DB);
  const artifactId = crypto.randomUUID();
  const key = ownedParseKey(operation);
  if (!(await ledger.recordIntent(operation, { artifact_id: artifactId, kind: 'parse', resource_id: key, provider: 'r2' })))
    throw new HTTPException(409, { message: 'File deletion is pending.' });
  if (!(await ledger.startWrite(operation, artifactId))) throw new HTTPException(409, { message: 'File operation was cancelled before dispatch.' });
  try {
    await env.RAW_DOCS.put(key, content, options);
  } catch {
    throw new UnsettledFileWrite('Parse object write settlement is unknown.');
  }
  await ledger.recordWrite(operation.project, operation.operation_id, artifactId, 'confirmed');
  await env.DB.prepare(`INSERT INTO kb_file_parse_artifacts(project,file_id,generation,artifact_id,content_hash,parser,parser_version,page_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      operation.project,
      operation.file_id,
      operation.generation,
      artifactId,
      input.contentHash,
      input.parser,
      input.parserVersion ?? null,
      input.pageCount ?? null,
    )
    .run();
  return {
    content_hash: input.contentHash,
    parser: input.parser,
    parser_version: input.parserVersion ?? null,
    object_key: key,
    page_count: input.pageCount ?? null,
    created_at: new Date().toISOString(),
  };
}

export async function deleteOwnedFile(
  env: Env,
  project: string,
  fileId: string,
  profiles: Array<{ key: string; binding: VectorizeBinding }>,
): Promise<'pending' | 'complete' | null> {
  const ledger = new D1FileOwnership(env.DB);
  const state = await ledger.requestDelete(project, fileId, crypto.randomUUID());
  if (!state) return null;
  if (state.state === 'deleted') return 'complete';
  const candidates = await ledger.cleanupCandidates(project, fileId);
  for (const artifact of candidates) {
    try {
      // Candidates have no running producer. A prepared intent never won
      // dispatch, and a settled operation cannot start it later.
      if (artifact.dispatch_state === 'prepared' && artifact.write_state === 'intent') {
        await ledger.confirmCleanup(project, fileId, artifact.artifact_id);
        continue;
      }
      if (artifact.provider === 'r2') {
        if (!env.RAW_DOCS) continue;
        await env.RAW_DOCS.delete(artifact.resource_id);
      } else if (artifact.provider === 'd1') {
        await new D1Repository(env.DB).deleteDocument(project, artifact.resource_id);
      } else if (artifact.kind === 'vector') {
        const binding = profiles.find((profile) => `vector:${profile.key}` === artifact.provider)?.binding;
        if (!binding?.getByIds) continue;
        if (artifact.write_state !== 'confirmed') {
          // Empty before an asynchronous upsert becomes visible is not erasure.
          if (!(await binding.getByIds([artifact.resource_id])).some((row) => row.id === artifact.resource_id)) continue;
          await ledger.confirmVectorVisible(project, artifact.artifact_id);
        }
        await binding.deleteByIds([artifact.resource_id]);
        if ((await binding.getByIds([artifact.resource_id])).some((row) => row.id === artifact.resource_id)) continue;
      } else continue;
      await ledger.confirmCleanup(project, fileId, artifact.artifact_id);
    } catch {
      console.warn('owned file cleanup remains pending', { file_id: fileId, artifact_kind: artifact.kind });
    }
  }
  const remaining = await env.DB.prepare(`SELECT 1 AS pending FROM kb_file_artifacts WHERE project = ? AND file_id = ? AND cleanup_state != 'confirmed'
    UNION ALL SELECT 1 FROM kb_file_operations WHERE project = ? AND file_id = ? AND state = 'running' LIMIT 1`)
    .bind(project, fileId, project, fileId)
    .first();
  if (remaining) return 'pending';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM kb_owned_provenance_spans WHERE project = ? AND file_id = ?').bind(project, fileId),
    env.DB.prepare('DELETE FROM kb_owned_entity_facts WHERE project = ? AND file_id = ?').bind(project, fileId),
    env.DB.prepare('DELETE FROM kb_owned_relationship_facts WHERE project = ? AND file_id = ?').bind(project, fileId),
    env.DB.prepare('DELETE FROM kb_file_parse_artifacts WHERE project = ? AND file_id = ?').bind(project, fileId),
  ]);
  await new D1MetadataRepository(env.DB).deleteFiles(project, [fileId]);
  await ledger.finishDelete(project, fileId);
  return (await ledger.get(project, fileId))?.state === 'deleted' ? 'complete' : 'pending';
}
