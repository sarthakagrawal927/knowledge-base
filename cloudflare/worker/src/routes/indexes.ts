import type { Hono } from 'hono';
import {
  type BenchmarkQueryBody,
  type ConfiguredVectorizeProfile,
  type IngestBody,
  type IngestVectorsBody,
  MAX_BENCHMARK_QUERIES,
  MAX_BENCHMARK_REPEAT,
  MAX_BENCHMARK_WARMUP,
  MAX_DOC_SIZE,
  type QueryBody,
  type RagTiming,
} from '../app-types';
import {
  buildCacheKey,
  configuredVectorizeProfiles,
  deleteVectorsForIndex,
  deleteVectorsFromAllProfiles,
  deterministicId,
  elapsedMs,
  embeddingModel,
  embeddingOptionsForProfile,
  embeddingProfileForIndex,
  jsonRecord,
  vectorDimensionError,
  vectorizeProfileForDimensions,
  vectorizeProfileForIndex,
  vectorMetadata,
  vectorNamespace,
} from '../app-utils';
import type { Variables } from '../auth';
import { percentile, summarizeLatencies } from '../bench-utils';
import { parseCacheOptions } from '../cache';
import { chunkText } from '../chunk';
import { clampTopK, withTimingHeaders } from '../query';
import type { CreateChunkInput } from '../repository';
import type { AppRuntime } from '../runtime';
import type { Env, JsonRecord, VectorizeVector } from '../types';

type App = Hono<{ Bindings: Env; Variables: Variables }>;

export function registerIndexRoutes(app: App, rt: AppRuntime): void {
  const {
    makeRepository,
    genericOwnershipConflict,
    ownedIndexHasFiles,
    embed,
    queryCache,
    indexCache,
    indexRecordCache,
    kbDomainIndexCache,
    clearAnswerAndQueryCaches,
    getIndexRecord,
    clearSharedQueryCache,
    clearLexicalChunkCache,
    primeLexicalChunkCache,
    runTextQuery,
    upsertChunkVectors,
    queryByVector,
  } = rt;

  app.delete('/v1/indexes/:id', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const repo = makeRepository(c.env);
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return c.json({ error: 'Not found' }, 404);
    if (await ownedIndexHasFiles(c.env, tenant, index.external_id))
      return c.json({ error: 'Delete owned files through the KB file or source-set deletion route before removing this index.' }, 409);
    const chunkIds = await repo.getChunkIdsForIndex(tenant, indexId);
    await deleteVectorsForIndex(c.env, index, chunkIds);
    await repo.deleteIndex(tenant, indexId);
    clearAnswerAndQueryCaches();
    indexCache.clear();
    indexRecordCache.clear();
    kbDomainIndexCache.clear();
    clearLexicalChunkCache(tenant, indexId);
    await clearSharedQueryCache(c.env, tenant, indexId);
    return c.json({ ok: true });
  });

  app.post('/v1/indexes/:id/ingest', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as IngestBody;
    const documents = body.documents ?? [];
    if (!Array.isArray(documents) || documents.length === 0) {
      return c.json({ error: 'documents array is required' }, 400);
    }
    const repo = makeRepository(c.env);
    const index = await getIndexRecord(c.env, repo, tenant, indexId);
    if (!index) return c.json({ error: 'Index not found' }, 404);
    let vectorizeProfile: ConfiguredVectorizeProfile;
    try {
      vectorizeProfile = vectorizeProfileForIndex(c.env, index);
    } catch (error) {
      if (error instanceof Error && error.message.includes('embedding profile is not configured')) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
    const embeddingProfile = embeddingProfileForIndex(c.env, index, vectorizeProfile);
    const smallProfile =
      embeddingProfile.vectorizeProfile === 'base' ? configuredVectorizeProfiles(c.env).find((profile) => profile.key === 'small') : undefined;

    const out: Array<{ document_id: string; chunks_created: number }> = [];
    for (const input of documents) {
      if (await genericOwnershipConflict(c.env, tenant, jsonRecord(input.metadata)))
        return c.json({ error: 'Owned file metadata must be written through KB ingestion.' }, 409);
      const content = input.content?.trim();
      if (!content) return c.json({ error: 'document content is required' }, 400);
      if (content.length > MAX_DOC_SIZE) return c.json({ error: 'document content too large' }, 413);

      const document = await repo.createDocument({
        id: crypto.randomUUID(),
        tenant,
        indexId,
        externalId: input.external_id ?? null,
        content,
        metadata: jsonRecord(input.metadata),
      });
      const chunkContents = chunkText(content, body.chunking);
      const vectors = await embed(c.env, chunkContents, embeddingOptionsForProfile(embeddingProfile));
      const smallVectors = smallProfile ? await embed(c.env, chunkContents, { model: embeddingModel(c.env, 'small') }) : [];
      const chunkRows: CreateChunkInput[] = chunkContents.map((chunk, i) => ({
        id: crypto.randomUUID(),
        tenant,
        indexId,
        documentId: document.id,
        content: chunk,
        chunkIndex: i,
        metadata: jsonRecord(input.metadata),
      }));
      await repo.insertChunks(chunkRows);
      await upsertChunkVectors(c.env, tenant, indexId, chunkRows, vectors, vectorizeProfile);
      if (smallProfile && smallVectors.length > 0) {
        await upsertChunkVectors(c.env, tenant, indexId, chunkRows, smallVectors, smallProfile);
      }
      clearAnswerAndQueryCaches();
      clearLexicalChunkCache(tenant, indexId);
      await clearSharedQueryCache(c.env, tenant, indexId);
      out.push({ document_id: document.id, chunks_created: chunkRows.length });
    }
    return c.json({ documents: out }, 201);
  });

  app.get('/v1/indexes/:id/documents', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const repo = makeRepository(c.env);
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return c.json({ error: 'Index not found' }, 404);
    const page = Math.max(Number(c.req.query('page') ?? 1), 1);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 100);
    const data = await repo.listDocuments(tenant, indexId, limit, (page - 1) * limit);
    return c.json({ data, page, limit });
  });

  app.post('/v1/indexes/:id/ingest-vectors', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as IngestVectorsBody;
    const chunks = body.chunks ?? [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return c.json({ error: 'chunks array is required' }, 400);
    }
    const repo = makeRepository(c.env);
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return c.json({ error: 'Index not found' }, 404);
    const vectorizeProfile = vectorizeProfileForDimensions(c.env, index.dimensions);
    if (!vectorizeProfile) {
      return c.json({ error: `embedding dimensions ${index.dimensions} do not match a configured Vectorize binding` }, 400);
    }

    const docsToCreate = new Map<string, { content: string; externalId: string | null }>();
    const chunkRows: CreateChunkInput[] = [];
    const vectorRows: VectorizeVector[] = [];
    for (const input of chunks) {
      if (await genericOwnershipConflict(c.env, tenant, jsonRecord(input.metadata), [input.id ?? '', input.document_id ?? '']))
        return c.json({ error: 'Owned file resources must be written through KB ingestion.' }, 409);
      if (!input.id?.trim()) return c.json({ error: 'chunk id is required' }, 400);
      if (!input.document_id?.trim()) return c.json({ error: 'document_id is required' }, 400);
      if (!input.content?.trim()) return c.json({ error: 'chunk content is required' }, 400);
      if (!Array.isArray(input.embedding) || input.embedding.length === 0) {
        return c.json({ error: 'embedding is required' }, 400);
      }
      const dimensionError = vectorDimensionError('embedding', input.embedding, vectorizeProfile.dimensions);
      if (dimensionError) return c.json({ error: dimensionError }, 400);
      const chunkId = input.id;
      const documentId = input.document_id;
      const content = input.content;
      const embedding = input.embedding;
      const chunkIndex = Number.isInteger(input.chunk_index) ? (input.chunk_index as number) : chunkRows.length;
      const existingDoc = await repo.getDocument(tenant, documentId);
      if (!existingDoc && !docsToCreate.has(documentId)) {
        docsToCreate.set(documentId, {
          content: input.document_content ?? content,
          externalId: input.document_external_id ?? null,
        });
      }
      const metadata = jsonRecord(input.metadata);
      chunkRows.push({
        id: chunkId,
        tenant,
        indexId,
        documentId,
        content,
        chunkIndex,
        metadata,
      });
      vectorRows.push({
        id: chunkId,
        values: embedding,
        namespace: vectorNamespace(tenant, indexId),
        metadata: vectorMetadata(tenant, indexId, documentId, chunkIndex, content, metadata),
      });
    }

    for (const [documentId, doc] of docsToCreate) {
      await repo.createDocument({
        id: documentId,
        tenant,
        indexId,
        externalId: doc.externalId,
        content: doc.content,
        metadata: {},
      });
    }
    await repo.insertChunks(chunkRows);
    await vectorizeProfile.binding.upsert(vectorRows);
    clearAnswerAndQueryCaches();
    clearLexicalChunkCache(tenant, indexId);
    await primeLexicalChunkCache(c.env, repo, tenant, indexId);
    await clearSharedQueryCache(c.env, tenant, indexId);
    return c.json({ upserted: vectorRows.length }, 201);
  });

  app.delete('/v1/documents/:id', async (c) => {
    const tenant = c.get('tenant');
    const docId = c.req.param('id');
    const repo = makeRepository(c.env);
    if (await genericOwnershipConflict(c.env, tenant, {}, [docId]))
      return c.json({ error: 'Delete this owned document through its KB file deletion route.' }, 409);
    const doc = await repo.getDocument(tenant, docId);
    if (!doc) return c.json({ error: 'Not found' }, 404);
    const index = await getIndexRecord(c.env, repo, tenant, doc.index_id);
    const chunkIds = await repo.getChunkIdsForDocument(tenant, docId);
    if (index) await deleteVectorsForIndex(c.env, index, chunkIds);
    else await deleteVectorsFromAllProfiles(c.env, chunkIds);
    await repo.deleteDocument(tenant, docId);
    clearAnswerAndQueryCaches();
    indexCache.clear();
    kbDomainIndexCache.clear();
    clearLexicalChunkCache(tenant, doc.index_id);
    await clearSharedQueryCache(c.env, tenant, doc.index_id);
    return c.json({ ok: true });
  });

  app.post('/v1/indexes/:id/query', async (c) => {
    const started = performance.now();
    const body = (await c.req.json().catch(() => ({}))) as QueryBody;
    const query = body.query?.trim();
    if (!query) return c.json({ error: 'query is required' }, 400);
    try {
      const result = await runTextQuery(c, query, body);
      return c.json(result.payload, 200, withTimingHeaders(result.timing, result.cache, started));
    } catch (error) {
      if (error instanceof Error && error.message === 'Index not found') {
        return c.json({ error: 'Index not found' }, 404);
      }
      if (error instanceof Error && error.message === 'small embedding profile is not configured') {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.post('/v1/indexes/:id/benchmark-query', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as BenchmarkQueryBody;
    const queries = (Array.isArray(body.queries) ? body.queries : [])
      .map((query) => String(query || '').trim())
      .filter(Boolean)
      .slice(0, MAX_BENCHMARK_QUERIES);
    if (queries.length === 0) return c.json({ error: 'queries array is required' }, 400);
    const repeat = Math.min(Math.max(Math.trunc(Number(body.repeat ?? 10)), 1), MAX_BENCHMARK_REPEAT);
    const warmup = Math.min(Math.max(Math.trunc(Number(body.warmup ?? 1)), 0), MAX_BENCHMARK_WARMUP);
    const queryBody: QueryBody = {};
    if (body.top_k !== undefined) queryBody.top_k = body.top_k;
    if (body.filter !== undefined) queryBody.filter = body.filter;
    if (body.min_score !== undefined) queryBody.min_score = body.min_score;
    if (body.mode !== undefined) queryBody.mode = body.mode;
    if (body.semantic_model !== undefined) queryBody.semantic_model = body.semantic_model;
    if (body.rerank !== undefined) queryBody.rerank = body.rerank;
    if (body.rerank_model !== undefined) queryBody.rerank_model = body.rerank_model;
    if (body.mmr !== undefined) queryBody.mmr = body.mmr;
    if (body.query_rewrite !== undefined) queryBody.query_rewrite = body.query_rewrite;
    if (body.query_decompose !== undefined) queryBody.query_decompose = body.query_decompose;
    try {
      for (let pass = 0; pass < warmup; pass += 1) {
        for (const query of queries) {
          await runTextQuery(c, query, queryBody);
        }
      }

      const samples: number[] = [];
      const serverSamples: number[] = [];
      const measured: Array<{
        query: string;
        pass: number;
        ms: number;
        server_ms: number | null;
        cache: 'hit' | 'miss';
        result_count: number;
        top_score: number | null;
      }> = [];
      let cacheHits = 0;
      for (let pass = 0; pass < repeat; pass += 1) {
        for (const query of queries) {
          const started = performance.now();
          const result = await runTextQuery(c, query, queryBody);
          const elapsed = elapsedMs(started);
          const serverMs = typeof result.timing.total_ms === 'number' ? result.timing.total_ms : null;
          samples.push(elapsed);
          if (serverMs !== null) serverSamples.push(serverMs);
          if (result.cache === 'hit') cacheHits += 1;
          measured.push({
            query,
            pass,
            ms: elapsed,
            server_ms: serverMs,
            cache: result.cache,
            result_count: result.payload.data.length,
            top_score: result.payload.data[0]?.score ?? null,
          });
        }
      }
      return c.json({
        index_id: c.req.param('id'),
        queries: queries.length,
        repeat,
        warmup,
        samples: samples.length,
        latency: summarizeLatencies(samples),
        server_latency: summarizeLatencies(serverSamples),
        cache_hits: cacheHits,
        cache_hit_rate: samples.length ? cacheHits / samples.length : 0,
        measurements: measured,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Index not found') {
        return c.json({ error: 'Index not found' }, 404);
      }
      throw error;
    }
  });

  app.post('/v1/indexes/:id/query-vector', async (c) => {
    const started = performance.now();
    const timing: RagTiming = { route: 'query-vector' };
    const body = (await c.req.json().catch(() => ({}))) as QueryBody;
    if (!Array.isArray(body.vector) || body.vector.length === 0) {
      return c.json({ error: 'vector is required' }, 400);
    }
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const repo = makeRepository(c.env);
    let vectorizeProfile: ConfiguredVectorizeProfile;
    try {
      const index = await getIndexRecord(c.env, repo, tenant, indexId);
      if (!index) return c.json({ error: 'Index not found' }, 404);
      vectorizeProfile = vectorizeProfileForIndex(c.env, index, body);
    } catch (error) {
      if (error instanceof Error && error.message.includes('embedding profile is not configured')) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
    const dimensionError = vectorDimensionError('vector', body.vector, vectorizeProfile.dimensions);
    if (dimensionError) return c.json({ error: dimensionError }, 400);
    const cacheKey = buildCacheKey({
      tenant,
      indexId,
      vector: body.vector,
      topK: clampTopK(body.top_k),
      filter: jsonRecord(body.filter),
      minScore: typeof body.min_score === 'number' ? body.min_score : null,
      semanticModel: vectorizeProfile.semanticModel,
      vectorizeProfile: vectorizeProfile.key,
      vectorizeBinding: vectorizeProfile.bindingName,
    });
    queryCache.configure(parseCacheOptions(c.env));
    const cached = queryCache.get(cacheKey);
    if (cached) return c.json(cached, 200, withTimingHeaders(timing, 'hit', started));
    try {
      const payload = await queryByVector(c, body.vector, body, timing, vectorizeProfile);
      if (payload.data.length > 0) queryCache.set(cacheKey, payload);
      return c.json(payload, 200, withTimingHeaders(timing, 'miss', started));
    } catch (error) {
      if (error instanceof Error && error.message === 'Index not found') {
        return c.json({ error: 'Index not found' }, 404);
      }
      if (error instanceof Error && error.message.includes('embedding profile is not configured')) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });
}
