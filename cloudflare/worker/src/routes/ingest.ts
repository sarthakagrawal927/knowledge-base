import type { Hono } from 'hono';
import type { KbIngestRunBody, KbRecordIngestBody, KbTextIngestBody } from '../app-types';
import {
  deterministicId,
  embeddingOptionsForProfile,
  embeddingProfileForIndex,
  isEmbeddingReadinessError,
  jsonRecord,
  sha256Hex,
  structuredRecordIndexText,
  vectorizeProfileForIndex,
} from '../app-utils';
import type { Variables } from '../auth';
import { parseUploadBytesWithCloudflare } from '../document-parser';
import {
  chunkPreviewFromChunks,
  chunkPreviewFromFileResults,
  classifyIngestFailure,
  ingestSafetyEvidence,
  parseArtifactKey,
  summarizeIngestRun,
  virtualInputFilename,
} from '../ingest';
import { type RecordStructuredEntitiesResult, safeObjectKeySegment } from '../kb-metadata-repository';
import type { CreateChunkInput } from '../repository';
import type { AppRuntime } from '../runtime';
import { inferSchema, recordsFromUnknown } from '../schema-inference';
import type { Env, JsonRecord, KbIngestQueueMessage } from '../types';

type App = Hono<{ Bindings: Env; Variables: Variables }>;

function embeddingReadinessErrorJson(
  error: unknown,
  extra: {
    idempotencyKey?: string | undefined;
    contentHash: string;
    replayRoute: string;
  },
) {
  if (!isEmbeddingReadinessError(error)) return null;
  return {
    error: error.message,
    failure_classification: classifyIngestFailure(error),
    ingest_safety: ingestSafetyEvidence({
      idempotencyKey: extra.idempotencyKey,
      contentHash: extra.contentHash,
      replayRoute: extra.replayRoute,
      failure: error,
    }),
  };
}

export function registerIngestRoutes(app: App, rt: AppRuntime): void {
  const {
    makeRepository,
    makeMetadataRepository,
    storeRawFile,
    persistParse,
    beginOwnedOperation,
    completeOwnedOperation,
    abortOwnedOperation,
    ownedParseLookup,
    clearKbDomainCaches,
    applyKbDomainEmbeddingSelection,
    ensureKbIndex,
    validateKbIndexReadiness,
    validateKbSchedulingReadiness,
    ingestDocumentsToIndex,
    runKbIngest,
  } = rt;

  app.post('/v1/kb/ingest/record', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = (await c.req.json().catch(() => ({}))) as KbRecordIngestBody;
    const tenant = c.get('tenant');
    const domain = (body.domain ?? body.kind)?.trim();
    const requestedEntityType = body.type?.trim();
    if (!domain) {
      return c.json(
        {
          error: 'domain is required',
          failure_classification: classifyIngestFailure('domain is required'),
        },
        400,
      );
    }
    const records = (Array.isArray(body.data) ? body.data : [body.data]).map(jsonRecord).filter((record) => Object.keys(record).length > 0);
    if (records.length === 0) {
      return c.json(
        {
          error: 'data must contain at least one record',
          failure_classification: classifyIngestFailure('data must contain at least one record'),
        },
        400,
      );
    }
    const embeddingSelection = await applyKbDomainEmbeddingSelection(c, tenant, domain, body);
    if (embeddingSelection) return embeddingSelection;
    const metadataRepo = makeMetadataRepository(c.env);
    let activeSchema = (await metadataRepo.listSchemas(tenant)).find((schema) => schema.domain === domain && schema.is_active === 1);
    let schemaAutoCreated = false;
    let readinessValidated = false;
    if (!activeSchema) {
      const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
      if (readiness) return readiness;
      readinessValidated = true;
      const inferred = inferSchema({ domain, records, name: 'auto-direct-record' });
      const inferredPrimary = inferred.entities[0]?.name;
      const spec =
        requestedEntityType && inferredPrimary
          ? {
              ...inferred,
              entities: inferred.entities.map((entity, index) =>
                index === 0 ? { ...entity, name: requestedEntityType, aliases: Array.from(new Set([...entity.aliases, inferredPrimary])) } : entity,
              ),
              relationships: inferred.relationships.map((relationship) => ({
                ...relationship,
                from_type: relationship.from_type === inferredPrimary ? requestedEntityType : relationship.from_type,
                to_type: relationship.to_type === inferredPrimary ? requestedEntityType : relationship.to_type,
              })),
            }
          : inferred;
      activeSchema = await metadataRepo.insertSchema(tenant, domain, spec.name, spec);
      schemaAutoCreated = true;
    }
    const entityType = requestedEntityType || activeSchema.spec.entities[0]?.name;
    if (!entityType) return c.json({ error: 'schema has no entity types' }, 422);
    if (!activeSchema.spec.entities.some((entity) => entity.name === entityType)) {
      return c.json({ error: `schema does not declare entity type '${entityType}'` }, 422);
    }
    if (!readinessValidated) {
      const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
      if (readiness) return readiness;
    }
    const payload = JSON.stringify({ project: tenant, domain, type: entityType, data: records }, null, 2);
    const bytes = new TextEncoder().encode(payload);
    const contentHash = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const filename = virtualInputFilename('records', entityType.toLowerCase(), 'json', contentHash);
    const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
    const rawOptions = {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        filename,
        project: tenant,
        domain,
        content_hash: contentHash,
        source: 'record',
      },
    };
    const file = await storeRawFile(
      c.env,
      {
        id: crypto.randomUUID(),
        project: tenant,
        domain,
        filename,
        mime: 'application/json',
        bytes: bytes.byteLength,
        contentHash,
        objectKey,
      },
      bytes,
      rawOptions,
    );
    const replayRoute = `/v1/kb/files/${file.id}/reprocess`;
    if (file.status === 'ready') {
      return c.json(
        {
          project: tenant,
          kind: domain,
          domain,
          type: entityType,
          file_id: file.id,
          schema_id: activeSchema.id,
          schema_auto_created: schemaAutoCreated,
          idempotent: true,
          idempotent_replay: true,
          chunks_indexed: 0,
          ingest_safety: ingestSafetyEvidence({
            idempotencyKey: body.idempotency_key,
            contentHash,
            replayRoute,
            idempotentReplay: true,
          }),
        },
        200,
      );
    }
    const operation = await beginOwnedOperation(c.env, tenant, file.id);
    await metadataRepo.setFileStatus(tenant, file.id, 'indexing');
    const artifactKey = parseArtifactKey(domain, contentHash);
    const docs = records.map((record, i) => ({
      external_id: `${file.id}:record:${i}`,
      content: structuredRecordIndexText(record),
      metadata: {
        project: tenant,
        domain,
        file_id: file.id,
        filename,
        record,
        record_index: i,
        entity_type: entityType,
        source: 'record',
      } as JsonRecord,
    }));
    const parseContent = JSON.stringify({
      parser: 'worker-direct-record-v1',
      parser_version: '1',
      project: tenant,
      domain,
      file_id: file.id,
      filename,
      content_hash: contentHash,
      record_count: records.length,
      document_count: docs.length,
      documents: docs,
    });
    const parseOptions = {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        project: tenant,
        domain,
        file_id: file.id,
        content_hash: contentHash,
        parser: 'worker-direct-record-v1',
      },
    };
    await persistParse(
      c.env,
      operation,
      {
        contentHash,
        parser: 'worker-direct-record-v1',
        parserVersion: '1',
        objectKey: artifactKey,
        pageCount: 1,
      },
      parseContent,
      parseOptions,
    );
    const ragRepo = makeRepository(c.env);
    let indexId: string;
    let ingested: { document_id: string; chunks: CreateChunkInput[] }[];
    try {
      indexId = await ensureKbIndex(c.env, ragRepo, tenant, domain);
      ingested = await ingestDocumentsToIndex(c.env, ragRepo, tenant, indexId, docs, undefined, operation);
    } catch (error) {
      const payload = embeddingReadinessErrorJson(error, {
        idempotencyKey: body.idempotency_key,
        contentHash,
        replayRoute,
      });
      if (payload) {
        await abortOwnedOperation(c.env, operation);
        return c.json(payload, 400);
      }
      throw error;
    }
    const chunkPreview = chunkPreviewFromChunks(ingested.flatMap((entry) => entry.chunks));
    let chunkMetadataFailure: JsonRecord | null = null;
    try {
      await metadataRepo.insertKbChunks(
        await Promise.all(
          ingested.flatMap((entry) =>
            entry.chunks.map(async (chunk) => ({
              id: await deterministicId('kbchk', `${file.id}:${chunk.id}`),
              project: tenant,
              domain,
              fileId: file.id,
              vectorId: chunk.id,
              pageStart: 0,
              pageEnd: 0,
              text: chunk.content,
              contentHash,
              metadata: chunk.metadata,
            })),
          ),
        ),
      );
    } catch (error) {
      chunkMetadataFailure = classifyIngestFailure(error);
    }
    let structured: RecordStructuredEntitiesResult = {
      entities: 0,
      mentions: 0,
      relationships: 0,
      provenance_spans: 0,
      chunks_linked: 0,
    };
    let structuredFailure: JsonRecord | null = null;
    try {
      const structuredInput = {
        project: tenant,
        domain,
        fileId: file.id,
        schema: activeSchema,
        records: records.map((record, i) => ({
          documentId: ingested[i]?.document_id ?? `${file.id}:record:${i}`,
          recordIndex: i,
          record,
          chunks: ingested[i]?.chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })) ?? [],
        })),
      };
      structured =
        operation && metadataRepo.stageOwnedStructuredEntities
          ? await metadataRepo.stageOwnedStructuredEntities(structuredInput, operation)
          : await metadataRepo.recordStructuredEntities(structuredInput);
    } catch (error) {
      structuredFailure = classifyIngestFailure(error);
    }
    if (operation) {
      if (structuredFailure || chunkMetadataFailure) {
        await abortOwnedOperation(c.env, operation);
        return c.json({ error: 'Owned metadata publication failed; retry or delete this file.' }, 500);
      }
      if (!(await completeOwnedOperation(c.env, operation))) return c.json({ error: 'File removed during ingestion.' }, 409);
    } else await metadataRepo.setFileStatus(tenant, file.id, 'ready');
    let cacheClearFailure: JsonRecord | null = null;
    try {
      await clearKbDomainCaches(c.env, tenant, domain);
    } catch (error) {
      cacheClearFailure = classifyIngestFailure(error);
    }
    return c.json(
      {
        project: tenant,
        kind: domain,
        domain,
        type: entityType,
        file_id: file.id,
        schema_id: activeSchema.id,
        schema_auto_created: schemaAutoCreated,
        entities_upserted: structured.entities,
        chunks_indexed: ingested.reduce((sum, entry) => sum + entry.chunks.length, 0),
        structured,
        chunk_metadata_failure_classification: chunkMetadataFailure,
        structured_failure_classification: structuredFailure,
        cache_clear_failure_classification: cacheClearFailure,
        idempotency_key: body.idempotency_key ?? contentHash,
        ingest_safety: ingestSafetyEvidence({
          idempotencyKey: body.idempotency_key,
          contentHash,
          chunkPreview,
          replayRoute,
        }),
      },
      201,
    );
  });

  app.post('/v1/kb/ingest/text', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = (await c.req.json().catch(() => ({}))) as KbTextIngestBody;
    const tenant = c.get('tenant');
    const domain = (body.domain ?? body.kind)?.trim();
    const text = body.text?.trim();
    if (!domain) {
      return c.json(
        {
          error: 'domain is required',
          failure_classification: classifyIngestFailure('domain is required'),
        },
        400,
      );
    }
    if (!text) {
      return c.json(
        {
          error: 'text must be non-empty',
          failure_classification: classifyIngestFailure('text must be non-empty'),
        },
        400,
      );
    }
    const embeddingSelection = await applyKbDomainEmbeddingSelection(c, tenant, domain, body);
    if (embeddingSelection) return embeddingSelection;
    const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
    if (readiness) return readiness;
    const metadataRepo = makeMetadataRepository(c.env);
    const activeSchema = (await metadataRepo.listSchemas(tenant)).find((schema) => schema.domain === domain && schema.is_active === 1);
    const bytes = new TextEncoder().encode(text);
    const contentHash = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const filename = virtualInputFilename('text', body.title?.trim() || 'untitled', 'txt', contentHash);
    const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
    const rawOptions = {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: {
        filename,
        project: tenant,
        domain,
        content_hash: contentHash,
        ...(body.type ? { entity_type_hint: body.type } : {}),
      },
    };
    const file = await storeRawFile(
      c.env,
      {
        id: crypto.randomUUID(),
        project: tenant,
        domain,
        filename,
        mime: 'text/plain',
        bytes: bytes.byteLength,
        contentHash,
        objectKey,
      },
      bytes,
      rawOptions,
    );
    const replayRoute = `/v1/kb/files/${file.id}/reprocess`;
    if (file.status === 'ready') {
      return c.json(
        {
          project: tenant,
          kind: domain,
          domain,
          file_id: file.id,
          ingestion_mode: body.async === true ? 'queued' : 'inline',
          idempotent: true,
          idempotent_replay: true,
          files: [
            {
              file_id: file.id,
              filename: file.filename,
              status: 'ready',
              chunks_created: 0,
              chunk_preview: [],
              ingest_safety: ingestSafetyEvidence({
                idempotencyKey: body.idempotency_key,
                contentHash,
                replayRoute,
                idempotentReplay: true,
              }),
            },
          ],
          ingest_safety: ingestSafetyEvidence({
            idempotencyKey: body.idempotency_key,
            contentHash,
            replayRoute,
            idempotentReplay: true,
          }),
        },
        200,
      );
    }
    await metadataRepo.setFileStatus(tenant, file.id, 'pending');
    if (body.async !== true) {
      const ingestBody: KbIngestRunBody = {
        domain,
        file_ids: [file.id],
        async: false,
      };
      if (body.chunking) ingestBody.chunking = body.chunking;
      let ingested: Awaited<ReturnType<typeof runKbIngest>>;
      try {
        ingested = await runKbIngest(c.env, tenant, ingestBody, 'direct-text');
      } catch (error) {
        const payload = embeddingReadinessErrorJson(error, {
          idempotencyKey: body.idempotency_key,
          contentHash,
          replayRoute,
        });
        if (payload) return c.json(payload, 400);
        throw error;
      }
      const chunkPreview = chunkPreviewFromFileResults(ingested.files);
      return c.json(
        {
          ...ingested,
          kind: domain,
          file_id: file.id,
          ingestion_mode: 'inline',
          idempotency_key: body.idempotency_key ?? contentHash,
          ingest_safety: ingestSafetyEvidence({
            idempotencyKey: body.idempotency_key,
            contentHash,
            chunkPreview,
            replayRoute,
          }),
        },
        201,
      );
    }
    const job = await metadataRepo.upsertIngestJob({
      project: tenant,
      domain,
      fileId: file.id,
      schemaId: activeSchema?.id ?? null,
      status: 'queued',
      stage: 'parse',
    });
    return c.json(
      {
        project: tenant,
        kind: domain,
        domain,
        file_id: file.id,
        ingestion_mode: 'queued',
        job_id: job.id,
        job: {
          ...job,
          failure_classification: null,
          replay: {
            supported: true,
            route: replayRoute,
          },
        },
        idempotency_key: body.idempotency_key ?? contentHash,
        ingest_safety: ingestSafetyEvidence({
          idempotencyKey: body.idempotency_key,
          contentHash,
          replayRoute,
        }),
      },
      201,
    );
  });

  app.get('/v1/kb/ingest/runs/:run_id', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const runId = c.req.param('run_id').trim();
    const domain = c.req.query('domain')?.trim() || undefined;
    const jobs = (await repo.listIngestJobs(c.get('tenant'), domain, undefined, 500)).filter((job) => job.workflow_id === runId);
    if (jobs.length === 0) return c.json({ error: 'ingest run not found' }, 404);
    let workflow: JsonRecord | null = null;
    if (c.env.KB_INGEST_WORKFLOW) {
      try {
        const instance = await c.env.KB_INGEST_WORKFLOW.get(runId);
        const status = await instance.status();
        workflow = {
          id: instance.id,
          status: status.status,
          ...(status.error ? { error: status.error } : {}),
        };
      } catch {
        workflow = null;
      }
    }
    return c.json({
      project: c.get('tenant'),
      domain: domain ?? null,
      run_id: runId,
      ...(workflow ? { workflow } : {}),
      summary: summarizeIngestRun(runId, jobs),
      replay_routes: jobs.map((job) => `/v1/kb/files/${job.file_id}/reprocess`),
      jobs,
    });
  });

  app.get('/v1/kb/parse-artifacts/:hash', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const hash = c.req.param('hash');
    const scoped = await ownedParseLookup(c.env, c.get('tenant'), hash, c.req.query('file_id'));
    if (scoped) {
      if (scoped.ambiguous) return c.json({ error: 'Multiple files match; specify file_id.' }, 409);
      if (!scoped.artifact) return c.json({ error: 'parse artifact not found' }, 404);
      return c.json(scoped.artifact);
    }
    const owned = await repo.hasFileWithContentHash(c.get('tenant'), hash);
    if (!owned) return c.json({ error: 'parse artifact not found' }, 404);
    const artifact = await repo.getParseArtifact(hash);
    if (!artifact) return c.json({ error: 'parse artifact not found' }, 404);
    return c.json(artifact);
  });

  app.post('/v1/kb/ingest/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as KbIngestRunBody;
    const queueIsPrimary = body.async !== false;
    if (queueIsPrimary && c.env.INGEST_QUEUE) {
      const domain = body.domain?.trim();
      if (!domain) return c.json({ error: 'domain is required' }, 400);
      const tenant = c.get('tenant');
      const embeddingSelection = await applyKbDomainEmbeddingSelection(c, tenant, domain, body);
      if (embeddingSelection) return embeddingSelection;
      try {
        await validateKbIndexReadiness(c.env, makeRepository(c.env), tenant, domain);
      } catch (error) {
        if (isEmbeddingReadinessError(error)) return c.json({ error: error.message }, 400);
        throw error;
      }
      const runId = body.run_id?.trim() || crypto.randomUUID();
      const message: KbIngestQueueMessage = {
        kind: 'kb_ingest',
        project: tenant,
        domain,
        run_id: runId,
      };
      if (body.file_ids !== undefined) message.file_ids = body.file_ids;
      if (body.markdown_conversion !== undefined) message.markdown_conversion = body.markdown_conversion;
      if (body.vision_ocr_model !== undefined) message.vision_ocr_model = body.vision_ocr_model;
      if (body.chunking !== undefined) message.chunking = body.chunking;
      let queueMetrics: { backlog_count: number; backlog_bytes: number } | null = null;
      let workflowInstanceId: string | null = null;
      if (c.env.KB_INGEST_WORKFLOW) {
        const instance = await c.env.KB_INGEST_WORKFLOW.create({
          id: runId,
          params: message,
          retention: {
            successRetention: '1 day',
            errorRetention: '1 week',
          },
        });
        workflowInstanceId = instance.id;
      } else {
        const response = await c.env.INGEST_QUEUE.send(message);
        queueMetrics = {
          backlog_count: response.metadata.metrics.backlogCount,
          backlog_bytes: response.metadata.metrics.backlogBytes,
        };
      }
      const metadataRepo = makeMetadataRepository(c.env);
      const activeSchema = (await metadataRepo.listSchemas(tenant)).find((schema) => schema.domain === domain && schema.is_active === 1);
      const files = body.file_ids?.length
        ? (await Promise.all(body.file_ids.map((id) => metadataRepo.getFile(tenant, id)))).filter((file): file is NonNullable<typeof file> => Boolean(file))
        : await metadataRepo.listFiles(tenant, domain, ['pending']);
      const jobs = [];
      for (const file of files) {
        jobs.push(
          await metadataRepo.upsertIngestJob({
            project: tenant,
            domain,
            fileId: file.id,
            schemaId: activeSchema?.id ?? null,
            status: 'queued',
            stage: 'parse',
            queueMessageId: workflowInstanceId ? 'cloudflare-workflow' : 'cloudflare-queue',
            workflowId: runId,
          }),
        );
      }
      return c.json(
        {
          project: tenant,
          domain,
          run_id: runId,
          ingestion_mode: 'queued',
          orchestration: workflowInstanceId ? 'workflow' : 'queue',
          queued: true,
          jobs,
          ...(workflowInstanceId ? { workflow: { id: workflowInstanceId } } : {}),
          ...(queueMetrics ? { queue: queueMetrics } : {}),
        },
        202,
      );
    }
    if (body.async === true && !c.env.INGEST_QUEUE) return c.json({ error: 'INGEST_QUEUE is not configured' }, 500);
    const inlineDomain = body.domain?.trim();
    if (inlineDomain) {
      const embeddingSelection = await applyKbDomainEmbeddingSelection(c, c.get('tenant'), inlineDomain, body);
      if (embeddingSelection) return embeddingSelection;
    }
    try {
      const runBody = {
        ...body,
        run_id: body.run_id?.trim() || crypto.randomUUID(),
      };
      return c.json({
        ...(await runKbIngest(c.env, c.get('tenant'), runBody, 'worker-inline')),
        ingestion_mode: 'inline',
        queued: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'RAW_DOCS R2 bucket is not configured') return c.json({ error: message }, 500);
      if (message === 'domain is required') return c.json({ error: message }, 400);
      if (isEmbeddingReadinessError(error)) return c.json({ error: message }, 400);
      throw error;
    }
  });
}
