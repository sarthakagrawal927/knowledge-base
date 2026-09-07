import type { Hono } from 'hono';
import type {
  CreateIndexBody,
  EdgarFilingCandidate,
  EmbeddingModelCatalogRow,
  InferSchemaBody,
  IngestBody,
  ResolvedEmbeddingProfile,
  SourceImportBody,
  UpsertDomainBody,
} from '../app-types';
import {
  buildCacheKey,
  configuredVectorizeProfiles,
  embeddingDimensions,
  embeddingModel,
  embeddingOptionsForProfile,
  embeddingProfileForIndex,
  isEmbeddingReadinessError,
  jsonRecord,
  resolveCreateEmbeddingProfile,
  sha256Hex,
  vectorizeProfileForIndex,
} from '../app-utils';
import type { Variables } from '../auth';
import { parseCacheOptions } from '../cache';
import { parseUploadBytesWithCloudflare } from '../document-parser';
import { fetchFreeAiEmbeddingCatalog, freeAiEmbeddingCatalog } from '../free-ai';
import {
  classifyIngestFailure,
  edgarCandidatesForCompany,
  filenameForImportedUrl,
  filesForSourceSetAction,
  normalizeCik,
  normalizeTicker,
  recordFromDocumentMetadata,
  secHeaders,
  secTickerLookup,
  secUserAgent,
  sourceSetDomain,
  sourceSetId,
  summarizeSourceSets,
  virtualInputFilename,
} from '../ingest';
import { type FileRecord, type IngestJobRecord, parseFileRegistrationBody, safeObjectKeySegment } from '../kb-metadata-repository';
import type { AppRuntime } from '../runtime';
import { type DomainSchema, inferSchema, recordsFromUnknown } from '../schema-inference';
import type { Env, JsonRecord } from '../types';

type App = Hono<{ Bindings: Env; Variables: Variables }>;

function fileDeletionPayload(deleted: Awaited<ReturnType<AppRuntime['deleteKbFiles']>>) {
  return {
    affected_files: deleted.deletedFiles.length,
    deleted_files: deleted.deletedFiles,
    deleted_vectors: deleted.deletedVectors,
    ...(deleted.pending
      ? {
          pending_files: deleted.pending,
          logical_removed: true,
          physical_scope: 'indexed_file_artifacts',
          history_retained: true,
          message: deleted.pending.length
            ? 'Files hidden from search; artifact cleanup is pending. Saved conversations and query traces remain.'
            : 'Indexed file artifacts removed. Saved conversations and query traces remain.',
        }
      : {}),
  };
}

export function registerCatalogRoutes(app: App, rt: AppRuntime): void {
  const {
    makeRepository,
    makeMetadataRepository,
    storeRawFile,
    registerStoredFile,
    ownedDeletion,
    listDeletionFiles,
    rememberIndexRecord,
    deleteKbFiles,
    resolveKbDomainEmbeddingSelection,
    applyKbDomainEmbeddingSelection,
    formEmbeddingSelection,
    validateKbSchedulingReadiness,
  } = rt;

  app.get('/v1/kb/operator/projects', async (c) => {
    if (c.get('credentialKind') !== 'dashboard') {
      return c.json({ error: 'Dashboard credential required' }, 403);
    }
    const repo = makeMetadataRepository(c.env);
    const projects = await repo.listProjects();
    return c.json({
      data: projects.map((project) => ({
        ...project,
        project: project.name,
      })),
    });
  });

  app.get('/v1/kb/projects', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const [projects, domains, status] = await Promise.all([repo.listProjects(tenant), repo.listDomains(tenant), repo.corpusStatus(tenant)]);
    const project = projects[0] ?? (await repo.upsertProject(tenant));
    return c.json({
      data: [
        {
          ...project,
          name: tenant,
          project: tenant,
          domain_count: domains.length,
          domains,
          status,
        },
      ],
    });
  });

  app.post('/v1/kb/projects', async (c) => {
    const tenant = c.get('tenant');
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
    const name = body.name?.trim() || tenant;
    if (name !== tenant) {
      return c.json({ error: 'Cloudflare Worker project is bound to the authenticated tenant', project: tenant }, 400);
    }
    const repo = makeMetadataRepository(c.env);
    const project = await repo.upsertProject(tenant, body.description?.trim() ?? '');
    return c.json({ ...project, project: tenant }, 201);
  });

  app.get('/v1/kb/projects/:project/status', async (c) => {
    const tenant = c.get('tenant');
    const project = c.req.param('project').trim();
    if (project && project !== tenant) {
      return c.json({ error: 'project does not match authenticated tenant', project: tenant }, 404);
    }
    const repo = makeMetadataRepository(c.env);
    return c.json({ project: tenant, data: await repo.corpusStatus(tenant) });
  });

  app.post('/v1/indexes', async (c) => {
    const tenant = c.get('tenant');
    const body = (await c.req.json().catch(() => ({}))) as CreateIndexBody;
    const name = body.name?.trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    let profile: ResolvedEmbeddingProfile;
    try {
      profile = await resolveCreateEmbeddingProfile(c.env, body);
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, 400);
      throw error;
    }
    const repo = makeRepository(c.env);
    const index = await repo.createIndex({
      id: crypto.randomUUID(),
      tenant,
      name,
      externalId: body.external_id ?? null,
      dimensions: profile.dimensions,
      embeddingModel: profile.model,
      embeddingProvider: profile.provider ?? null,
    });
    rememberIndexRecord(c.env, index);
    return c.json(index, 201);
  });

  app.get('/v1/indexes', async (c) => {
    const repo = makeRepository(c.env);
    return c.json({ data: await repo.listIndexes(c.get('tenant')) });
  });

  app.get('/v1/embedding-models', async (c) => {
    const provider = c.env.RAG_EMBED_PROVIDER === 'free_ai' ? 'free_ai' : 'workers_ai';
    const vectorizeProfiles = configuredVectorizeProfiles(c.env);
    let freeAiModels: EmbeddingModelCatalogRow[] =
      provider === 'free_ai' ? freeAiEmbeddingCatalog(c.env).map((item) => ({ ...item, vectorize_binding: null, selectable: false })) : [];
    let catalogSource: 'free_ai' | 'static' | 'none' = provider === 'free_ai' ? 'static' : 'none';
    let catalogError: string | null = null;
    if (provider === 'free_ai') {
      try {
        freeAiModels = (await fetchFreeAiEmbeddingCatalog(c.env)).map((item) => {
          const compatibleProfile = vectorizeProfiles.find((profile) => profile.dimensions === item.dimensions) ?? null;
          return {
            ...item,
            configured_profile:
              item.id === embeddingModel(c.env, 'base') ? ('base' as const) : item.id === embeddingModel(c.env, 'small') ? ('small' as const) : null,
            compatible_profile: compatibleProfile?.key ?? null,
            vectorize_binding: compatibleProfile?.bindingName ?? null,
            selectable: item.enabled !== false && Boolean(compatibleProfile?.bindingName),
          };
        });
        catalogSource = 'free_ai';
      } catch (error) {
        catalogError = error instanceof Error ? error.message : 'free-ai model catalog failed';
      }
    }
    return c.json({
      provider,
      catalog_source: catalogSource,
      catalog_error: catalogError,
      profiles: {
        base: {
          semantic_model: 'base',
          model: embeddingModel(c.env, 'base'),
          dimensions: embeddingDimensions(c.env, 'base'),
          vectorize_binding: 'VECTORIZE',
        },
        small: {
          semantic_model: 'small',
          model: embeddingModel(c.env, 'small'),
          dimensions: embeddingDimensions(c.env, 'small'),
          vectorize_binding: c.env.VECTORIZE_SMALL ? 'VECTORIZE_SMALL' : null,
          available: Boolean(c.env.VECTORIZE_SMALL),
        },
      },
      vectorize_profiles: vectorizeProfiles.map((profile) => ({
        key: profile.key,
        semantic_model: profile.semanticModel,
        dimensions: profile.dimensions,
        vectorize_binding: profile.bindingName,
        model: profile.model ?? null,
      })),
      free_ai_models: freeAiModels,
    });
  });

  app.get('/v1/kb/domains', async (c) => {
    const repo = makeMetadataRepository(c.env);
    return c.json({ data: await repo.listDomains(c.get('tenant')) });
  });

  app.post('/v1/kb/domains', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as UpsertDomainBody;
    const name = body.name?.trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    const requestedModel = body.embedding_model?.trim();
    const requestedProvider = body.embedding_provider?.trim();
    let embedding: { model?: string | null; provider?: string | null } = {};
    try {
      const selected = await resolveKbDomainEmbeddingSelection(c.env, c.get('tenant'), name, {
        ...(requestedModel ? { embedding_model: requestedModel } : {}),
        ...(requestedProvider ? { embedding_provider: requestedProvider } : {}),
      });
      if (selected) embedding = selected;
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, 400);
      throw error;
    }
    const repo = makeMetadataRepository(c.env);
    const domain = await repo.upsertDomain(c.get('tenant'), name, body.description?.trim() ?? '', embedding);
    return c.json(domain, 201);
  });

  app.get('/v1/kb/schemas', async (c) => {
    const repo = makeMetadataRepository(c.env);
    return c.json({ data: await repo.listSchemas(c.get('tenant')) });
  });

  app.get('/v1/kb/schemas/:domain/active', async (c) => {
    const domain = c.req.param('domain').trim();
    const repo = makeMetadataRepository(c.env);
    const schema = (await repo.listSchemas(c.get('tenant'))).find((row) => row.domain === domain && row.is_active === 1);
    if (!schema) return c.json({ error: 'active schema not found' }, 404);
    return c.json(schema);
  });

  app.post('/v1/kb/schemas/:domain/reprocess', async (c) => {
    const tenant = c.get('tenant');
    const domain = c.req.param('domain').trim();
    const body = (await c.req.json().catch(() => ({}))) as { file_ids?: string[] };
    const repo = makeMetadataRepository(c.env);
    const activeSchema = (await repo.listSchemas(tenant)).find((schema) => schema.domain === domain && schema.is_active === 1);
    if (!activeSchema) return c.json({ error: 'active schema not found' }, 404);
    const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
    if (readiness) return readiness;
    const selectedIds = new Set((body.file_ids ?? []).filter(Boolean));
    const files =
      selectedIds.size > 0
        ? (await Promise.all([...selectedIds].map((id) => repo.getFile(tenant, id)))).filter((file): file is FileRecord =>
            Boolean(file && file.domain === domain),
          )
        : await repo.listFiles(tenant, domain);
    const jobs = [];
    for (const file of files) {
      await repo.setFileStatus(tenant, file.id, 'pending');
      jobs.push(
        await repo.upsertIngestJob({
          project: tenant,
          domain,
          fileId: file.id,
          schemaId: activeSchema.id,
          status: 'queued',
          stage: 'parse',
        }),
      );
    }
    return c.json({
      project: tenant,
      domain,
      schema_id: activeSchema.id,
      schema_version: activeSchema.version,
      enqueued: jobs.length,
      stage: 'parse',
      jobs,
    });
  });

  app.post('/v1/kb/schemas', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<DomainSchema>;
    const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'default';
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!Array.isArray(body.entities) || body.entities.length === 0) {
      return c.json({ error: 'entities array is required' }, 400);
    }
    const spec = {
      domain,
      name,
      version: Number.isFinite(Number(body.version)) ? Number(body.version) : 1,
      description: typeof body.description === 'string' ? body.description : '',
      vocabulary: jsonRecord(body.vocabulary) as Record<string, string>,
      entities: body.entities,
      relationships: Array.isArray(body.relationships) ? body.relationships : [],
    } as DomainSchema;
    const repo = makeMetadataRepository(c.env);
    const schema = await repo.insertSchema(c.get('tenant'), domain, name, spec);
    return c.json(schema, 201);
  });

  app.post('/v1/kb/schemas/infer', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as InferSchemaBody;
    const domain = body.domain?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    const embeddingSelection = await applyKbDomainEmbeddingSelection(c, c.get('tenant'), domain, body);
    if (embeddingSelection) return embeddingSelection;
    const records = [...(Array.isArray(body.records) ? body.records : []), ...recordsFromUnknown(body.input)];
    const sampleTexts = Array.isArray(body.sample_texts) ? body.sample_texts.map((sample) => String(sample || '')).filter(Boolean) : [];
    if (records.length === 0 && sampleTexts.length === 0) {
      return c.json({ error: 'records, sample_texts, or input is required' }, 400);
    }
    const inferenceInput = {
      domain,
      records,
      sample_texts: sampleTexts,
      ...(body.name ? { name: body.name } : {}),
    };
    const spec = inferSchema(inferenceInput);
    let draft = null;
    if (body.save_draft !== false) {
      const repo = makeMetadataRepository(c.env);
      draft = await repo.saveSchemaDraft({
        project: c.get('tenant'),
        domain: spec.domain,
        name: spec.name,
        spec,
        source: records.length > 0 ? 'structured_records' : 'sample_text',
        sampleCount: records.length || sampleTexts.length,
      });
    }
    return c.json({
      project: c.get('tenant'),
      domain: spec.domain,
      name: spec.name,
      spec,
      sample_count: records.length || sampleTexts.length,
      draft_id: draft?.id ?? null,
    });
  });

  app.post('/v1/kb/schemas/infer-upload', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = await c.req.parseBody();
    const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
    const uploaded = body.file instanceof File ? body.file : body.files;
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!(uploaded instanceof File)) return c.json({ error: 'file is required' }, 400);
    if (uploaded.size === 0) return c.json({ error: 'empty file' }, 400);
    const tenant = c.get('tenant');
    const embeddingSelection = await applyKbDomainEmbeddingSelection(c, tenant, domain, formEmbeddingSelection(body));
    if (embeddingSelection) return embeddingSelection;
    const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
    if (readiness) return readiness;

    const bytes = await uploaded.arrayBuffer();
    const contentHash = await sha256Hex(bytes);
    const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
    const rawOptions = {
      httpMetadata: { contentType: uploaded.type || 'application/octet-stream' },
      customMetadata: {
        filename: uploaded.name || 'file',
        project: tenant,
        domain,
        content_hash: contentHash,
      },
    };
    const repo = makeMetadataRepository(c.env);
    const file = await storeRawFile(
      c.env,
      {
        id: crypto.randomUUID(),
        project: tenant,
        domain,
        filename: uploaded.name || 'file',
        mime: uploaded.type || null,
        bytes: uploaded.size,
        contentHash,
        objectKey,
      },
      bytes,
      rawOptions,
    );
    await repo.upsertIngestJob({
      project: tenant,
      domain,
      fileId: file.id,
      status: 'queued',
      stage: 'parse',
    });
    const parsed = await parseUploadBytesWithCloudflare(
      uploaded.name || 'file',
      uploaded.type || null,
      bytes,
      c.env.AI,
      typeof body.markdown_conversion === 'string' ? body.markdown_conversion : (c.env.RAG_MARKDOWN_CONVERSION ?? 'auto'),
      typeof body.vision_ocr_model === 'string' ? body.vision_ocr_model : (c.env.RAG_VISION_OCR_MODEL ?? ''),
    );
    if (parsed.documents.length === 0 || !parsed.text) {
      return c.json({ error: 'uploaded file has no parseable text content', file, parser: parsed.parser }, 400);
    }
    const records = parsed.documents.map((doc) => recordFromDocumentMetadata(doc.metadata)).filter((record): record is JsonRecord => Boolean(record));
    const spec = inferSchema({
      domain,
      records,
      sample_texts: records.length > 0 ? [] : [parsed.text.slice(0, 24_000)],
    });
    const draft = await repo.saveSchemaDraft({
      project: c.get('tenant'),
      domain: spec.domain,
      name: spec.name,
      spec,
      source: parsed.parser,
      sampleCount: records.length || 1,
      stagedFileIds: [file.id],
    });
    return c.json({
      project: tenant,
      domain: spec.domain,
      name: spec.name,
      spec,
      sample_count: records.length || 1,
      draft_id: draft.id,
      parser: parsed.parser,
      staged_files: [file],
    });
  });

  app.get('/v1/kb/schemas/drafts', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain') || undefined;
    const status = c.req.query('status') || 'pending';
    return c.json({ data: await repo.listSchemaDrafts(c.get('tenant'), domain, status) });
  });

  app.get('/v1/kb/schemas/drafts/:draft_id', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const draft = await repo.getSchemaDraft(c.get('tenant'), c.req.param('draft_id'));
    if (!draft) return c.json({ error: 'schema draft not found' }, 404);
    return c.json(draft);
  });

  app.post('/v1/kb/schemas/drafts/:draft_id/apply', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const draft = await repo.getSchemaDraft(tenant, c.req.param('draft_id'));
    if (!draft) return c.json({ error: 'schema draft not found' }, 404);
    if (draft.status === 'discarded') return c.json({ error: 'schema draft was discarded' }, 409);
    const schema = await repo.insertSchema(tenant, draft.domain, draft.name, draft.spec);
    const updatedDraft = await repo.updateSchemaDraftStatus(tenant, draft.id, 'applied');
    return c.json({ draft: updatedDraft ?? draft, schema });
  });

  app.post('/v1/kb/schemas/drafts/:draft_id/discard', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const draft = await repo.updateSchemaDraftStatus(c.get('tenant'), c.req.param('draft_id'), 'discarded');
    if (!draft) return c.json({ error: 'schema draft not found' }, 404);
    return c.json(draft);
  });

  app.get('/v1/kb/files', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const statuses = c.req
      .query('status')
      ?.split(',')
      .map((status) => status.trim())
      .filter(Boolean);
    return c.json({ data: await repo.listFiles(c.get('tenant'), domain, statuses) });
  });

  app.post('/v1/kb/files', async (c) => {
    const rawBody = await c.req.json().catch(() => ({}));
    const body = parseFileRegistrationBody(rawBody);
    if (!body.domain) return c.json({ error: 'domain is required' }, 400);
    if (!body.filename) return c.json({ error: 'filename is required' }, 400);
    if (!body.contentHash) return c.json({ error: 'content_hash is required' }, 400);
    if (!body.objectKey) return c.json({ error: 'object_key is required' }, 400);
    if (!Number.isFinite(body.bytes) || body.bytes < 0) return c.json({ error: 'bytes must be non-negative' }, 400);
    const embeddingSelection = await applyKbDomainEmbeddingSelection(
      c,
      c.get('tenant'),
      body.domain,
      rawBody as { embedding_model?: string; embedding_provider?: string },
    );
    if (embeddingSelection) return embeddingSelection;
    const readiness = await validateKbSchedulingReadiness(c, c.get('tenant'), body.domain);
    if (readiness) return readiness;
    const repo = makeMetadataRepository(c.env);
    const file = await registerStoredFile(c.env, {
      id: crypto.randomUUID(),
      project: c.get('tenant'),
      ...body,
    });
    await repo.upsertIngestJob({
      project: c.get('tenant'),
      domain: body.domain,
      fileId: file.id,
      status: 'queued',
      stage: 'parse',
    });
    return c.json(file, 201);
  });

  app.get('/v1/kb/files/:file_id', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const file = await repo.getFile(c.get('tenant'), c.req.param('file_id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    return c.json(file);
  });

  app.get('/v1/kb/chunks', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const fileId = c.req.query('file_id')?.trim() || undefined;
    const requestedLimit = Number(c.req.query('limit') ?? 100);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    const chunks = await repo.listKbChunks(c.get('tenant'), domain, fileId, limit);
    return c.json({
      project: c.get('tenant'),
      domain: domain ?? null,
      file_id: fileId ?? null,
      chunks,
    });
  });

  app.post('/v1/kb/files/:file_id/reprocess', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const file = await repo.getFile(tenant, c.req.param('file_id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    const readiness = await validateKbSchedulingReadiness(c, tenant, file.domain);
    if (readiness) return readiness;
    const activeSchema = (await repo.listSchemas(tenant)).find((schema) => schema.domain === file.domain && schema.is_active === 1);
    await repo.setFileStatus(tenant, file.id, 'pending');
    const job = await repo.upsertIngestJob({
      project: tenant,
      domain: file.domain,
      fileId: file.id,
      schemaId: activeSchema?.id ?? null,
      status: 'queued',
      stage: 'parse',
    });
    return c.json({ project: tenant, file_id: file.id, job });
  });

  app.delete('/v1/kb/files/:file_id', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const owned = await ownedDeletion(c.env, tenant, c.req.param('file_id'));
    if (owned)
      return c.json(
        {
          project: tenant,
          file_id: c.req.param('file_id'),
          logical_removed: true,
          physical_state: owned,
          physical_scope: 'indexed_file_artifacts',
          history_retained: true,
          message:
            owned === 'pending'
              ? 'File hidden from search; artifact cleanup is pending. Saved conversations and query traces remain.'
              : 'Indexed file artifacts removed. Saved conversations and query traces remain.',
        },
        owned === 'pending' ? 202 : 200,
      );
    const file = await repo.getFile(tenant, c.req.param('file_id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    const deleted = await deleteKbFiles(c.env, tenant, [file]);
    if (deleted.blocked) return c.json({ error: deleted.blocked, message: 'Deletion is blocked because storage is shared. No file was removed.' }, 409);
    return c.json(
      {
        project: tenant,
        ...fileDeletionPayload(deleted),
      },
      deleted.pending?.length ? 202 : 200,
    );
  });

  app.post('/v1/kb/files/upload', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = await c.req.parseBody();
    const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
    const uploaded = body.file;
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!(uploaded instanceof File)) return c.json({ error: 'file is required' }, 400);
    if (uploaded.size === 0) return c.json({ error: 'empty file' }, 400);
    const tenant = c.get('tenant');
    const embeddingSelection = await applyKbDomainEmbeddingSelection(c, tenant, domain, formEmbeddingSelection(body));
    if (embeddingSelection) return embeddingSelection;
    const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
    if (readiness) return readiness;

    const bytes = await uploaded.arrayBuffer();
    const contentHash = await sha256Hex(bytes);
    const safeDomain = safeObjectKeySegment(domain);
    const filename = uploaded.name || 'file';
    const objectKey = `raw/${safeDomain}/${contentHash}`;
    const rawOptions = {
      httpMetadata: { contentType: uploaded.type || 'application/octet-stream' },
      customMetadata: {
        filename,
        project: tenant,
        domain,
        content_hash: contentHash,
      },
    };

    const repo = makeMetadataRepository(c.env);
    const file = await storeRawFile(
      c.env,
      {
        id: crypto.randomUUID(),
        project: tenant,
        domain,
        filename,
        mime: uploaded.type || null,
        bytes: uploaded.size,
        contentHash,
        objectKey,
      },
      bytes,
      rawOptions,
    );
    await repo.upsertIngestJob({
      project: tenant,
      domain,
      fileId: file.id,
      status: 'queued',
      stage: 'parse',
    });
    return c.json(file, 201);
  });

  app.get('/v1/kb/status', async (c) => {
    const repo = makeMetadataRepository(c.env);
    return c.json({ data: await repo.corpusStatus(c.get('tenant')) });
  });

  app.get('/v1/kb/jobs', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const statuses = c.req
      .query('status')
      ?.split(',')
      .map((status) => status.trim())
      .filter(Boolean);
    const limit = Number(c.req.query('limit') ?? 100);
    const jobs = await repo.listIngestJobs(c.get('tenant'), domain, statuses, limit);
    return c.json({ project: c.get('tenant'), domain: domain ?? null, jobs });
  });

  app.get('/v1/kb/ingest/jobs/:job_id', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const job = await repo.getIngestJob(c.get('tenant'), c.req.param('job_id'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    return c.json({
      ...job,
      failure_classification: job.last_error ? classifyIngestFailure(job.last_error) : null,
      replay: {
        supported: true,
        route: `/v1/kb/files/${job.file_id}/reprocess`,
      },
    });
  });

  app.get('/v1/kb/sources', (c) =>
    c.json({
      sources: ['upload', 'url', 'edgar'],
    }),
  );

  app.post('/v1/kb/sources/import', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = (await c.req.json().catch(() => ({}))) as SourceImportBody;
    const tenant = c.get('tenant');
    const domain = body.domain?.trim();
    const source = body.source?.trim() || '';
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (source !== 'url' && source !== 'edgar') {
      return c.json(
        {
          error: 'unsupported Cloudflare source',
          source,
          supported_sources: ['url', 'edgar'],
          upload_route: '/v1/kb/files/upload',
        },
        400,
      );
    }
    const embeddingSelection = await applyKbDomainEmbeddingSelection(c, tenant, domain, body);
    if (embeddingSelection) return embeddingSelection;
    if (body.auto_ingest !== false) {
      const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
      if (readiness) return readiness;
    }
    const metadataRepo = makeMetadataRepository(c.env);
    const activeSchema = (await metadataRepo.listSchemas(tenant)).find((schema) => schema.domain === domain && schema.is_active === 1);
    const files: FileRecord[] = [];
    const jobs: IngestJobRecord[] = [];
    const errors: Array<{ url?: string; ticker?: string; cik?: string; error: string }> = [];

    const registerImported = async (input: { source: string; filename: string; mime: string | null; bytes: ArrayBuffer; metadata: Record<string, string> }) => {
      if (input.bytes.byteLength === 0) throw new Error('empty response');
      if (input.bytes.byteLength > 10_000_000) throw new Error('response exceeds 10 MB source import limit');
      const contentHash = await sha256Hex(input.bytes);
      const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
      const rawOptions = {
        httpMetadata: { contentType: input.mime ?? 'application/octet-stream' },
        customMetadata: {
          filename: input.filename,
          project: tenant,
          domain,
          content_hash: contentHash,
          source: input.source,
          ...input.metadata,
        },
      };
      const file = await storeRawFile(
        c.env,
        {
          id: crypto.randomUUID(),
          project: tenant,
          domain,
          filename: input.filename,
          mime: input.mime,
          bytes: input.bytes.byteLength,
          contentHash,
          objectKey,
        },
        input.bytes,
        rawOptions,
      );
      files.push(file);
      if (body.auto_ingest !== false) {
        jobs.push(
          await metadataRepo.upsertIngestJob({
            project: tenant,
            domain,
            fileId: file.id,
            schemaId: activeSchema?.id ?? null,
            status: 'queued',
            stage: 'parse',
          }),
        );
      }
    };

    if (source === 'url') {
      const urls = (body.config?.urls ?? [])
        .map((url) => url.trim())
        .filter(Boolean)
        .slice(0, 20);
      if (urls.length === 0) return c.json({ error: 'config.urls must contain at least one URL' }, 400);
      for (const url of urls) {
        try {
          const response = await fetch(url, { redirect: 'follow' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const mime = response.headers.get('content-type')?.split(';', 1)[0] || null;
          await registerImported({
            source: 'url',
            filename: filenameForImportedUrl(response.url || url, mime),
            mime,
            bytes: await response.arrayBuffer(),
            metadata: { url: response.url || url },
          });
        } catch (error) {
          errors.push({ url, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
        }
      }
    }

    if (source === 'edgar') {
      const config = body.config ?? {};
      const userAgent = secUserAgent(c.env, config);
      const forms = new Set((config.forms ?? ['10-K', '10-Q', '8-K']).map((form) => form.trim()).filter(Boolean));
      if (forms.size === 0) return c.json({ error: 'config.forms must contain at least one form' }, 400);
      const days = Math.min(Math.max(Math.trunc(Number(config.days ?? 540)), 0), 3650);
      const perTickerPerForm = Math.min(Math.max(Math.trunc(Number(config.per_ticker_per_form ?? 2)), 1), 10);
      const limitTotal = Math.min(Math.max(Math.trunc(Number(config.limit_total ?? 12)), 1), 50);
      const tickers = (config.tickers ?? ['NVDA', 'AAPL', 'MSFT']).map(normalizeTicker).filter(Boolean).slice(0, 20);
      const ciks = (config.ciks ?? []).map(normalizeCik).filter(Boolean).slice(0, 20);
      const targets: Array<{ ticker: string | null; cik: string }> = [];
      if (tickers.length > 0) {
        try {
          const lookup = await secTickerLookup(userAgent);
          for (const ticker of tickers) {
            const row = lookup.get(ticker);
            if (!row?.cik_str) {
              errors.push({ ticker, error: 'ticker not found in SEC company_tickers.json' });
              continue;
            }
            targets.push({ ticker, cik: normalizeCik(row.cik_str) });
          }
        } catch (error) {
          errors.push({ error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
        }
      }
      for (const cik of ciks) targets.push({ ticker: null, cik });
      const dedupedTargets = [...new Map(targets.map((target) => [`${target.ticker ?? ''}:${target.cik}`, target])).values()];
      if (dedupedTargets.length === 0 && errors.length === 0) return c.json({ error: 'config.tickers or config.ciks must identify at least one company' }, 400);
      const candidates: EdgarFilingCandidate[] = [];
      for (const target of dedupedTargets) {
        if (candidates.length >= limitTotal) break;
        try {
          candidates.push(
            ...(await edgarCandidatesForCompany({
              ticker: target.ticker,
              cik: target.cik,
              userAgent,
              forms,
              days,
              perTickerPerForm,
              remaining: limitTotal - candidates.length,
            })),
          );
        } catch (error) {
          errors.push({
            ...(target.ticker ? { ticker: target.ticker } : {}),
            cik: target.cik,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          });
        }
      }
      for (const filing of candidates.slice(0, limitTotal)) {
        try {
          const response = await fetch(filing.url, { headers: secHeaders(userAgent) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const mime = response.headers.get('content-type')?.split(';', 1)[0] || 'text/html';
          await registerImported({
            source: 'edgar',
            filename: filing.filename,
            mime,
            bytes: await response.arrayBuffer(),
            metadata: {
              url: filing.url,
              ...(filing.ticker ? { ticker: filing.ticker } : {}),
              cik: filing.cik,
              accession: filing.accession,
              form: filing.form,
              filed_date: filing.filingDate,
              primary_document: filing.primaryDocument,
              ...(filing.companyName ? { company_name: filing.companyName } : {}),
            },
          });
        } catch (error) {
          errors.push({
            url: filing.url,
            ...(filing.ticker ? { ticker: filing.ticker } : {}),
            cik: filing.cik,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          });
        }
      }
    }
    return c.json({
      project: tenant,
      domain,
      source,
      files,
      file_count: files.length,
      enqueued: jobs.length,
      jobs,
      errors,
    });
  });

  app.get('/v1/kb/source-sets', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const files = await repo.listFiles(c.get('tenant'), domain);
    return c.json({
      project: c.get('tenant'),
      domain: domain ?? null,
      source_sets: summarizeSourceSets(files),
    });
  });

  app.post('/v1/kb/source-sets/:id/actions', async (c) => {
    const id = c.req.param('id');
    const domain = sourceSetDomain(id);
    if (!domain) return c.json({ error: 'source set id must be domain:<domain>' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; dry_run?: boolean };
    const action = body.action?.trim() || '';
    const allowed = new Set([
      'requeue_all',
      'requeue_failed',
      'requeue_pending',
      'archive_all',
      'archive_failed',
      'archive_ready',
      'delete_all',
      'delete_failed',
      'delete_pending',
      'delete_ready',
    ]);
    if (!allowed.has(action)) return c.json({ error: 'unsupported source-set action' }, 400);
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const files = filesForSourceSetAction(
      await (action.startsWith('delete_') ? listDeletionFiles(c.env, tenant, domain) : metadataRepo.listFiles(tenant, domain)),
      action,
    );
    if (body.dry_run) {
      return c.json({
        project: tenant,
        source_set_id: id,
        action,
        dry_run: true,
        affected_files: files.length,
        files,
      });
    }
    if (action.startsWith('requeue_')) {
      const readiness = await validateKbSchedulingReadiness(c, tenant, domain);
      if (readiness) return readiness;
      const activeSchema = (await metadataRepo.listSchemas(tenant)).find((schema) => schema.domain === domain && schema.is_active === 1);
      const jobs = [];
      for (const file of files) {
        await metadataRepo.setFileStatus(tenant, file.id, 'pending');
        jobs.push(
          await metadataRepo.upsertIngestJob({
            project: tenant,
            domain,
            fileId: file.id,
            schemaId: activeSchema?.id ?? null,
            status: 'queued',
            stage: 'parse',
          }),
        );
      }
      return c.json({ project: tenant, source_set_id: id, action, affected_files: files.length, jobs });
    }
    if (action.startsWith('archive_')) {
      for (const file of files) {
        await metadataRepo.setFileStatus(tenant, file.id, 'archived');
      }
      return c.json({ project: tenant, source_set_id: id, action, affected_files: files.length });
    }
    const deleted = await deleteKbFiles(c.env, tenant, files);
    if (deleted.blocked) return c.json({ error: deleted.blocked, message: 'Deletion is blocked because storage is shared. No file was removed.' }, 409);
    return c.json(
      {
        project: tenant,
        source_set_id: id,
        action,
        ...fileDeletionPayload(deleted),
      },
      deleted.pending?.length ? 202 : 200,
    );
  });
}
