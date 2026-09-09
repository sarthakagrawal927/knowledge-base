import { buildParseArtifact } from './parse-artifact';
import { parseCacheOptions, TtlCache } from './cache';
import { chunkText } from './chunk';
import { D1Repository } from './d1-repository';
import { storeFileBytes, registerOwnedObject, persistParseArtifact, deleteOwnedFile, UnsettledFileWrite } from './owned-storage';
import { D1FileOwnership, type FileOperation } from './file-ownership';
import { HTTPException } from 'hono/http-exception';
import { parseUploadBytesWithCloudflare } from './document-parser';
import { D1MetadataRepository } from './kb-metadata-repository';
import {
  INGEST_JOB_LEASE_MS,
  INGEST_PARSE_TIMEOUT_MS,
  LEXICAL_SCORING_VERSION,
  MAX_DOC_SIZE,
  MAX_LEXICAL_CHUNKS,
  MAX_RERANK_CONTEXT_CHARS,
  MAX_TOP_K,
  DEFAULT_RERANKER_MODEL,
  type AppContext,
  type AppOptions,
  type CacheStatus,
  type ConfiguredVectorizeProfile,
  type CreateIndexBody,
  type EmbeddingCallOptions,
  type KbAnswerPayload,
  type KbIngestRunBody,
  type KbQueryBody,
  type QueryBody,
  type QueryPayload,
  type QueryPlan,
  type QueryPlanVariantKind,
  type RagTiming,
  type ResolvedEmbeddingProfile,
} from './app-types';
import {
  buildCacheKey,
  configuredVectorizeProfiles,
  deleteVectorsFromAllProfiles,
  deleteVectorsForIndex,
  deterministicId,
  elapsedMs,
  embeddingModel,
  embeddingOptionsForProfile,
  embeddingProfileForIndex,
  isEmbeddingReadinessError,
  jsonRecord,
  resolveCreateEmbeddingProfile,
  searchResultFromVectorMetadata,
  sharedEmbeddingCacheEnabled,
  sharedQueryCacheEnabled,
  vectorizeProfileForIndex,
  userVectorFilter,
  vectorMetadata,
  vectorNamespace,
} from './app-utils';
import {
  answerFromCitations,
  answerFromEvidence,
  answerFromStructuredEntities,
  answerModeFromBody,
  buildQueryPlan,
  citationsFromResults,
  clampTopK,
  confidenceFromResults,
  confidenceWithTiming,
  contextWithIndex,
  diversifyRankedResults,
  fuseHybridResults,
  fuseQueryPlanResults,
  graphResultsForEntities,
  isQueryPayload,
  kbIndexExternalId,
  normalizeSemanticQuery,
  rerankAndDiversifyResults,
  rerankModelFromBody,
  rerankResponseRows,
  searchResultFromEntity,
  sparseLexicalScore,
  strongLexicalFastPath,
  structuredFieldQueryResults,
  tokenizeLexicalQuery,
  weakSemanticReason,
  defaultEmbed,
  sortResultsByVectorOrder,
  writeTraceAnalytics,
} from './query';
import {
  chunkPreviewFromChunks,
  classifyIngestFailure,
  ingestSafetyEvidence,
  isIngestJobLeaseActive,
  parseArtifactKey,
  recordFromDocumentMetadata,
  withParseTimeout,
} from './ingest';
import type { FileRecord, MetadataRepository } from './kb-metadata-repository';
import type { CreateChunkInput, Repository } from './repository';
import type { ChunkRecord, Env, IndexRecord, JsonRecord, SearchResult, VectorizeVector } from './types';

export function createRuntime(options: AppOptions = {}) {
  const makeRepository = options.makeRepository ?? ((env: Env) => new D1Repository(env.DB, options.ownedFileProtocol === true));
  const makeMetadataRepository = options.makeMetadataRepository ?? ((env: Env) => new D1MetadataRepository(env.DB, options.ownedFileProtocol === true));
  const embed = options.embed ?? defaultEmbed;
  const queryCache = options.queryCache ?? new TtlCache<QueryPayload>(parseCacheOptions({}));
  const answerCache = options.answerCache ?? new TtlCache<KbAnswerPayload>(parseCacheOptions({}));
  const embeddingCache = options.embeddingCache ?? new TtlCache<number[]>(parseCacheOptions({}));
  const indexCache = options.indexCache ?? new TtlCache<boolean>(parseCacheOptions({}));
  const indexRecordCache = options.indexRecordCache ?? new TtlCache<IndexRecord>(parseCacheOptions({}));
  const kbDomainIndexCache = options.kbDomainIndexCache ?? new TtlCache<IndexRecord>(parseCacheOptions({}));
  const lexicalChunkCache = options.lexicalChunkCache ?? new TtlCache<ChunkRecord[]>(parseCacheOptions({}));

  const storeRawFile = (env: Env, input: Parameters<typeof storeFileBytes>[3], bytes: Parameters<typeof storeFileBytes>[4], putOptions: R2PutOptions) =>
    storeFileBytes(env, makeMetadataRepository(env), options.ownedFileProtocol === true, input, bytes, putOptions);

  const registerStoredFile = (env: Env, input: Parameters<typeof registerOwnedObject>[3]) =>
    registerOwnedObject(env, makeMetadataRepository(env), options.ownedFileProtocol === true, input);
  const persistParse = (
    env: Env,
    operation: FileOperation | undefined,
    input: Parameters<typeof persistParseArtifact>[3],
    content: string,
    putOptions: R2PutOptions,
  ) => persistParseArtifact(env, makeMetadataRepository(env), operation, input, content, putOptions);
  async function beginOwnedOperation(env: Env, tenant: string, fileId: string): Promise<FileOperation | undefined> {
    if (!options.ownedFileProtocol) return undefined;
    const operation = await new D1FileOwnership(env.DB).claim(tenant, fileId, crypto.randomUUID(), 'ingest');
    if (!operation) throw new HTTPException(409, { message: 'File operation is pending or requires verified legacy migration.' });
    return operation;
  }
  async function abortOwnedOperation(env: Env, operation: FileOperation | undefined): Promise<void> {
    if (!operation) return;
    await env.DB.prepare(`UPDATE kb_files SET status='failed', last_error='Owned ingestion did not publish', updated_at=datetime('now')
      WHERE project=? AND id=? AND EXISTS (SELECT 1 FROM kb_file_lifecycle l WHERE l.project=? AND l.file_id=? AND l.state='active' AND l.generation=?)`)
      .bind(operation.project, operation.file_id, operation.project, operation.file_id, operation.generation)
      .run();
    await new D1FileOwnership(env.DB).settle(operation, false);
  }

  async function completeOwnedOperation(env: Env, operation: FileOperation | undefined): Promise<boolean> {
    if (!operation) return true;
    return await new D1FileOwnership(env.DB).publish(operation, [
      env.DB.prepare("UPDATE kb_files SET status = 'ready', last_error = NULL, updated_at = datetime('now') WHERE project = ? AND id = ?").bind(
        operation.project,
        operation.file_id,
      ),
    ]);
  }
  const ownedDeletion = (env: Env, tenant: string, fileId: string) =>
    options.ownedFileProtocol ? deleteOwnedFile(env, tenant, fileId, configuredVectorizeProfiles(env)) : Promise.resolve(null);

  const listDeletionFiles = (env: Env, tenant: string, domain: string) =>
    options.ownedFileProtocol ? new D1MetadataRepository(env.DB).listFiles(tenant, domain) : makeMetadataRepository(env).listFiles(tenant, domain);
  async function ownedParseLookup(env: Env, tenant: string, hash: string, fileId?: string) {
    if (!options.ownedFileProtocol) return null;
    const known = await env.DB.prepare('SELECT 1 FROM kb_file_lifecycle WHERE project = ? AND content_hash = ? LIMIT 1').bind(tenant, hash).first();
    if (!known) return null;
    const rows = await env.DB.prepare(`SELECT p.content_hash,p.parser,p.parser_version,p.page_count,a.resource_id AS object_key,
      l.file_id, pub.created_at FROM kb_file_parse_artifacts p JOIN kb_file_lifecycle l ON l.project=p.project AND l.file_id=p.file_id
      JOIN kb_file_artifacts a ON a.artifact_id=p.artifact_id JOIN kb_file_publications pub ON pub.operation_id=a.operation_id
      WHERE l.project=? AND p.content_hash=? AND l.state='active' AND l.published_generation=p.generation
      AND (? IS NULL OR l.file_id=?) LIMIT 2`)
      .bind(tenant, hash, fileId ?? null, fileId ?? null)
      .all();
    return { ambiguous: rows.results.length > 1, artifact: rows.results.length === 1 ? rows.results[0] : null };
  }

  async function genericOwnershipConflict(env: Env, tenant: string, metadata: JsonRecord, resourceIds: string[] = []): Promise<boolean> {
    if (!options.ownedFileProtocol) return false;
    const fileId = typeof metadata.file_id === 'string' ? metadata.file_id : '';
    const row = await env.DB.prepare(`SELECT 1 AS found FROM kb_file_lifecycle WHERE project=? AND file_id=?
      UNION ALL SELECT 1 FROM kb_file_artifacts WHERE resource_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .bind(tenant, fileId, JSON.stringify(resourceIds))
      .first();
    return Boolean(row);
  }
  async function ownedIndexHasFiles(env: Env, tenant: string, externalId: string | null): Promise<boolean> {
    if (!options.ownedFileProtocol || !externalId?.startsWith('kb:')) return false;
    return Boolean(
      await env.DB.prepare("SELECT 1 FROM kb_file_lifecycle WHERE project=? AND domain=? AND state!='deleted' LIMIT 1")
        .bind(tenant, externalId.slice(3))
        .first(),
    );
  }

  async function durableRevision(env: Env, tenant: string): Promise<number> {
    if (!options.ownedFileProtocol) return 0;
    const row = await env.DB.prepare('SELECT COALESCE(SUM(revision), 0) AS revision FROM kb_scope_revisions WHERE project = ?')
      .bind(tenant)
      .first<{ revision: number }>();
    return row?.revision ?? 0;
  }

  function clearAnswerAndQueryCaches(): void {
    queryCache.clear();
    answerCache.clear();
  }

  function rememberIndex(env: Env, tenant: string, indexId: string): void {
    indexCache.configure(parseCacheOptions(env));
    indexCache.set(buildCacheKey({ tenant, indexId }), true);
  }

  function rememberIndexRecord(env: Env, index: IndexRecord): void {
    rememberIndex(env, index.tenant, index.id);
    indexRecordCache.configure(parseCacheOptions(env));
    indexRecordCache.set(buildCacheKey({ tenant: index.tenant, indexId: index.id }), index);
  }

  function rememberKbDomainIndexRecord(env: Env, domain: string, index: IndexRecord): void {
    rememberIndexRecord(env, index);
    kbDomainIndexCache.configure(parseCacheOptions(env));
    kbDomainIndexCache.set(buildCacheKey({ tenant: index.tenant, domain }), index);
  }

  async function getKbDomainIndex(env: Env, repo: Repository, tenant: string, domain: string): Promise<IndexRecord | null> {
    kbDomainIndexCache.configure(parseCacheOptions(env));
    const key = buildCacheKey({ tenant, domain });
    const cached = kbDomainIndexCache.get(key);
    if (cached) return cached;
    const index = await repo.getIndexByExternalId(tenant, kbIndexExternalId(domain));
    if (!index) return null;
    rememberKbDomainIndexRecord(env, domain, index);
    return index;
  }

  async function getIndexRecord(env: Env, repo: Repository, tenant: string, indexId: string): Promise<IndexRecord | null> {
    indexRecordCache.configure(parseCacheOptions(env));
    const key = buildCacheKey({ tenant, indexId });
    const cached = indexRecordCache.get(key);
    if (cached) return cached;
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return null;
    rememberIndexRecord(env, index);
    return index;
  }

  async function indexExists(env: Env, repo: Repository, tenant: string, indexId: string): Promise<boolean> {
    indexCache.configure(parseCacheOptions(env));
    const key = buildCacheKey({ tenant, indexId });
    if (indexCache.get(key)) return true;
    const index = await getIndexRecord(env, repo, tenant, indexId);
    if (!index) return false;
    indexCache.set(key, true);
    return true;
  }

  async function embedOne(env: Env, tenant: string, text: string, profile: ResolvedEmbeddingProfile, timing?: RagTiming): Promise<number[]> {
    const started = performance.now();
    embeddingCache.configure(parseCacheOptions(env));
    const key = buildCacheKey({ model: profile.model, provider: profile.provider ?? null, dimensions: profile.dimensions, tenant, text });
    const cached = embeddingCache.get(key);
    if (cached) {
      if (timing) {
        timing.embedding_cache = 'hit';
        timing.embedding_model = profile.semanticModel;
        timing.embed_ms = elapsedMs(started);
      }
      return cached;
    }
    const sharedCached = await getSharedEmbeddingCache(env, tenant, key, timing);
    if (sharedCached) {
      embeddingCache.set(key, sharedCached);
      if (timing) {
        timing.embedding_cache = 'd1';
        timing.embedding_model = profile.semanticModel;
        timing.embed_ms = elapsedMs(started);
      }
      return sharedCached;
    }
    const [vector] = await embed(env, [text], embeddingOptionsForProfile(profile));
    if (!vector) throw new Error('Embedding response was empty');
    embeddingCache.set(key, vector);
    await setSharedEmbeddingCache(env, tenant, key, profile, vector);
    if (timing) {
      timing.embedding_cache = 'miss';
      timing.embedding_model = profile.semanticModel;
      timing.embed_ms = elapsedMs(started);
    }
    return vector;
  }

  async function rerankWithWorkersAi(env: Env, payload: QueryPayload, query: string, body: QueryBody, timing: RagTiming): Promise<QueryPayload> {
    const topK = clampTopK(body.top_k);
    if (payload.data.length <= 1) return payload;
    const started = performance.now();
    const candidates = payload.data.slice(0, Math.min(MAX_TOP_K, Math.max(topK, payload.data.length)));
    try {
      const runAi = env.AI.run as unknown as (model: string, input: Record<string, unknown>) => Promise<unknown>;
      const response = await runAi(DEFAULT_RERANKER_MODEL, {
        query,
        top_k: Math.min(topK, candidates.length),
        contexts: candidates.map((result) => ({
          text: result.chunk_content.slice(0, MAX_RERANK_CONTEXT_CHARS),
        })),
      });
      const rows = rerankResponseRows(response);
      const scored = rows
        .filter((row) => row.id >= 0 && row.id < candidates.length)
        .sort((a, b) => b.score - a.score)
        .flatMap((row, i) => {
          const result = candidates[row.id];
          if (!result) return [];
          return [
            {
              ...result,
              score: row.score,
              metadata: {
                ...result.metadata,
                retrieval_score: result.score,
                neural_rerank_model: DEFAULT_RERANKER_MODEL,
                neural_rerank_score: row.score,
                neural_rerank_rank: i + 1,
              } as JsonRecord,
            },
          ];
        });
      if (scored.length === 0) throw new Error('Workers AI reranker response was empty');
      timing.rerank = body.mmr === false ? 'workers_ai' : 'workers_ai_mmr';
      timing.neural_rerank_model = DEFAULT_RERANKER_MODEL;
      timing.neural_rerank_candidates = candidates.length;
      timing.neural_rerank_ms = elapsedMs(started);
      return diversifyRankedResults(scored, topK, body.mmr !== false);
    } catch (error) {
      timing.rerank = body.mmr === false ? 'workers_ai_error_keyword' : 'workers_ai_error_keyword_mmr';
      timing.neural_rerank_error = error instanceof Error ? error.message : String(error);
      timing.neural_rerank_ms = elapsedMs(started);
      return rerankAndDiversifyResults(payload, query, topK, body.mmr !== false);
    }
  }

  async function rerankQueryPayload(
    env: Env,
    payload: QueryPayload,
    query: string,
    body: QueryBody,
    timing: RagTiming,
    defaultEnabled: boolean,
  ): Promise<QueryPayload> {
    if (body.rerank === false) {
      if (defaultEnabled || body.rerank_model) timing.rerank = 'off';
      return payload;
    }
    const useWorkersAi = rerankModelFromBody(body) === 'workers_ai';
    if (!defaultEnabled && !useWorkersAi) return payload;
    if (useWorkersAi) return rerankWithWorkersAi(env, payload, query, body, timing);
    timing.rerank = body.mmr === false ? 'keyword' : 'keyword_mmr';
    return rerankAndDiversifyResults(payload, query, clampTopK(body.top_k), body.mmr !== false);
  }

  async function getSharedQueryCache(env: Env, tenant: string, indexId: string, cacheKey: string, timing?: RagTiming): Promise<QueryPayload | null> {
    if (!sharedQueryCacheEnabled(env)) return null;
    if (!parseCacheOptions(env).enabled) return null;
    const started = performance.now();
    try {
      const row = await env.DB.prepare(
        `SELECT payload
             FROM query_cache
            WHERE cache_key = ? AND tenant = ? AND index_id = ? AND expires_at > ?`,
      )
        .bind(cacheKey, tenant, indexId, Date.now())
        .first<{ payload: string }>();
      if (!row?.payload) return null;
      const parsed = JSON.parse(row.payload) as unknown;
      return isQueryPayload(parsed) ? parsed : null;
    } catch {
      return null;
    } finally {
      if (timing) timing.shared_cache_ms = elapsedMs(started);
    }
  }

  async function setSharedQueryCache(env: Env, tenant: string, indexId: string, cacheKey: string, payload: QueryPayload): Promise<void> {
    if (!sharedQueryCacheEnabled(env)) return;
    const cacheOptions = parseCacheOptions(env);
    if (!cacheOptions.enabled) return;
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO query_cache (cache_key, tenant, index_id, payload, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(cacheKey, tenant, indexId, JSON.stringify(payload), Date.now() + cacheOptions.ttlMs)
        .run();
    } catch {
      // Query caching is an optimization. A missing migration or transient D1 write failure should not fail search.
    }
  }

  async function clearSharedQueryCache(env: Env, tenant: string, indexId: string): Promise<void> {
    try {
      await env.DB.prepare('DELETE FROM query_cache WHERE tenant = ? AND index_id = ?').bind(tenant, indexId).run();
    } catch {
      // Best effort cache invalidation; in-memory cache is cleared separately.
    }
  }

  async function getSharedEmbeddingCache(env: Env, tenant: string, cacheKey: string, timing?: RagTiming): Promise<number[] | null> {
    if (!sharedEmbeddingCacheEnabled(env)) return null;
    if (!parseCacheOptions(env).enabled) return null;
    const started = performance.now();
    try {
      const row = await env.DB.prepare(
        `SELECT vector
             FROM embedding_cache
            WHERE cache_key = ? AND tenant = ? AND expires_at > ?`,
      )
        .bind(cacheKey, tenant, Date.now())
        .first<{ vector: string }>();
      if (!row?.vector) return null;
      const parsed = JSON.parse(row.vector) as unknown;
      return Array.isArray(parsed) && parsed.every((value) => typeof value === 'number') ? parsed : null;
    } catch {
      return null;
    } finally {
      if (timing) timing.shared_embedding_cache_ms = elapsedMs(started);
    }
  }

  async function setSharedEmbeddingCache(env: Env, tenant: string, cacheKey: string, profile: ResolvedEmbeddingProfile, vector: number[]): Promise<void> {
    if (!sharedEmbeddingCacheEnabled(env)) return;
    const cacheOptions = parseCacheOptions(env);
    if (!cacheOptions.enabled) return;
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO embedding_cache
             (cache_key, tenant, model, provider, dimensions, vector, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(cacheKey, tenant, profile.model, profile.provider ?? null, profile.dimensions, JSON.stringify(vector), Date.now() + cacheOptions.ttlMs)
        .run();
    } catch {
      // Embedding caching is an optimization. A missing migration or transient D1 write failure should not fail retrieval.
    }
  }

  async function clearKbDomainCaches(env: Env, tenant: string, domain: string): Promise<void> {
    const ragRepo = makeRepository(env);
    const index = await ragRepo.getIndexByExternalId(tenant, kbIndexExternalId(domain));
    clearAnswerAndQueryCaches();
    kbDomainIndexCache.clear();
    if (index) {
      clearLexicalChunkCache(tenant, index.id);
      await clearSharedQueryCache(env, tenant, index.id);
    }
  }

  async function deleteKbFiles(
    env: Env,
    tenant: string,
    files: FileRecord[],
  ): Promise<{
    deletedFiles: FileRecord[];
    deletedVectors: number | null;
    blocked?: 'shared_file_storage';
    pending?: string[];
  }> {
    const metadataRepo = makeMetadataRepository(env);
    if (options.ownedFileProtocol) {
      const owned: FileRecord[] = [];
      const legacy: FileRecord[] = [];
      const ledger = new D1FileOwnership(env.DB);
      for (const file of files) ((await ledger.get(tenant, file.id)) ? owned : legacy).push(file);
      // Legacy references remain protected until a verified copy/backfill.
      if (legacy.length) return { deletedFiles: [], deletedVectors: 0, blocked: 'shared_file_storage' };
      const pending: string[] = [];
      const deletedFiles: FileRecord[] = [];
      for (const file of owned) {
        if ((await ownedDeletion(env, tenant, file.id)) === 'complete') deletedFiles.push(file);
        else pending.push(file.id);
      }
      return { deletedFiles, deletedVectors: null, pending };
    }
    // Fail before any vectors or metadata are removed. Legacy raw/parse objects
    // are content-addressed across scopes; deleting them can break other files.
    if (await metadataRepo.hasSharedFileStorage(files)) {
      return { deletedFiles: [], deletedVectors: 0, blocked: 'shared_file_storage' };
    }
    const ragRepo = makeRepository(env);
    const vectorIds = await metadataRepo.listKbChunkVectorIds(
      tenant,
      files.map((file) => file.id),
    );
    if (vectorIds.length > 0) {
      await deleteVectorsFromAllProfiles(env, vectorIds);
      await ragRepo.deleteChunksByIds(tenant, vectorIds);
    }
    if (env.RAW_DOCS) {
      for (const file of files) {
        await env.RAW_DOCS.delete(file.object_key);
        const artifact = await metadataRepo.getParseArtifact(file.content_hash);
        if (artifact) await env.RAW_DOCS.delete(artifact.object_key);
      }
    }
    const deletedFiles = await metadataRepo.deleteFiles(
      tenant,
      files.map((file) => file.id),
    );
    for (const domain of new Set(files.map((file) => file.domain))) {
      await clearKbDomainCaches(env, tenant, domain);
    }
    return { deletedFiles, deletedVectors: vectorIds.length };
  }

  async function relationshipsWithEntityNames(
    metadataRepo: MetadataRepository,
    tenant: string,
    relationships: Awaited<ReturnType<MetadataRepository['listRelationships']>>,
  ): Promise<typeof relationships> {
    return await Promise.all(
      relationships.map(async (relationship) => {
        const [src, dst] = await Promise.all([metadataRepo.getEntity(tenant, relationship.src_id), metadataRepo.getEntity(tenant, relationship.dst_id)]);
        return {
          ...relationship,
          src_name: src?.display_name ?? src?.identity_key ?? null,
          dst_name: dst?.display_name ?? dst?.identity_key ?? null,
        };
      }),
    );
  }

  function persistSharedQueryCache(c: AppContext, tenant: string, indexId: string, cacheKey: string, payload: QueryPayload): Promise<void> | undefined {
    const promise = setSharedQueryCache(c.env, tenant, indexId, cacheKey, payload);
    try {
      c.executionCtx.waitUntil(promise);
      return undefined;
    } catch {
      return promise;
    }
  }

  async function getCachedLexicalChunks(env: Env, repo: Repository, tenant: string, indexId: string, timing?: RagTiming): Promise<ChunkRecord[]> {
    const started = performance.now();
    lexicalChunkCache.configure(parseCacheOptions(env));
    const key = buildCacheKey({ tenant, indexId, revision: await durableRevision(env, tenant) });
    const cached = lexicalChunkCache.get(key);
    if (cached) {
      if (timing) {
        timing.lexical_chunk_cache = 'hit';
        timing.lexical_chunk_load_ms = elapsedMs(started);
      }
      return cached;
    }
    const chunks = await repo.listChunksForIndex(tenant, indexId, MAX_LEXICAL_CHUNKS);
    lexicalChunkCache.set(key, chunks);
    if (timing) {
      timing.lexical_chunk_cache = 'miss';
      timing.lexical_chunk_load_ms = elapsedMs(started);
    }
    return chunks;
  }

  function clearLexicalChunkCache(tenant: string, indexId: string): void {
    lexicalChunkCache.configure(parseCacheOptions({}));
    lexicalChunkCache.set(buildCacheKey({ tenant, indexId }), []);
    lexicalChunkCache.clear();
  }

  async function primeLexicalChunkCache(env: Env, repo: Repository, tenant: string, indexId: string): Promise<void> {
    try {
      lexicalChunkCache.configure(parseCacheOptions(env));
      const chunks = await repo.listChunksForIndex(tenant, indexId, MAX_LEXICAL_CHUNKS);
      lexicalChunkCache.set(buildCacheKey({ tenant, indexId, revision: await durableRevision(env, tenant) }), chunks);
    } catch {
      // Cache priming is only a latency optimization; retrieval can still load chunks on demand.
    }
  }

  async function runTextQuery(
    c: AppContext,
    query: string,
    body: QueryBody,
  ): Promise<{
    payload: QueryPayload;
    cache: CacheStatus;
    timing: RagTiming;
  }> {
    const started = performance.now();
    const timing: RagTiming = { route: 'query' };
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    if (!indexId) throw new Error('Index not found');
    const repo = makeRepository(c.env);
    const indexStarted = performance.now();
    const index = await getIndexRecord(c.env, repo, tenant, indexId);
    if (!index) throw new Error('Index not found');
    timing.index_ms = elapsedMs(indexStarted);
    const vectorizeProfile = vectorizeProfileForIndex(c.env, index, body);
    const embeddingProfile = embeddingProfileForIndex(c.env, index, vectorizeProfile);
    const normalizedQuery = normalizeSemanticQuery(query);
    const queryPlan = body.mode === 'lexical' && body.query_rewrite !== true && body.query_decompose !== true ? { variants: [] } : buildQueryPlan(query, body);
    const cacheKey = buildCacheKey({
      revision: await durableRevision(c.env, tenant),
      tenant,
      indexId,
      query: normalizedQuery,
      queryPlan: queryPlan.variants,
      topK: clampTopK(body.top_k),
      filter: jsonRecord(body.filter),
      minScore: typeof body.min_score === 'number' ? body.min_score : null,
      mode: body.mode ?? 'auto',
      semanticModel: embeddingProfile.semanticModel,
      vectorizeProfile: embeddingProfile.vectorizeProfile,
      vectorizeBinding: embeddingProfile.vectorizeBinding,
      embeddingModel: embeddingProfile.model,
      embeddingProvider: embeddingProfile.provider ?? null,
      embeddingDimensions: embeddingProfile.dimensions,
      rerank: body.rerank ?? null,
      rerankModel: body.rerank_model ?? null,
      mmr: body.mmr ?? null,
      queryRewrite: body.query_rewrite ?? null,
      queryDecompose: body.query_decompose ?? null,
      lexicalScoring: LEXICAL_SCORING_VERSION,
    });
    queryCache.configure(parseCacheOptions(c.env));
    const cached = queryCache.get(cacheKey);
    if (cached) {
      timing.cache_layer = 'memory';
      timing.cache = 'hit';
      timing.total_ms = elapsedMs(started);
      return { payload: cached, cache: 'hit', timing };
    }
    let lexical: QueryPayload | null = null;
    if (body.mode !== 'semantic') {
      const lexicalTopK = body.mode === 'hybrid' ? Math.min(MAX_TOP_K, clampTopK(body.top_k) * 2) : clampTopK(body.top_k);
      lexical = await queryByLexicalPlan(c, query, { ...body, top_k: lexicalTopK }, queryPlan, timing);
      if (body.mode !== 'hybrid' && lexical && lexical.data.length > 0) {
        const lexicalPayload = await rerankQueryPayload(c.env, lexical, query, body, timing, false);
        queryCache.set(cacheKey, lexicalPayload);
        timing.cache = 'miss';
        timing.total_ms = elapsedMs(started);
        return { payload: lexicalPayload, cache: 'miss', timing };
      }
      if (body.mode === 'lexical') {
        const empty = { data: [] };
        timing.cache = 'miss';
        timing.total_ms = elapsedMs(started);
        return { payload: empty, cache: 'miss', timing };
      }
    }
    const sharedCached = await getSharedQueryCache(c.env, tenant, indexId, cacheKey, timing);
    if (sharedCached) {
      timing.cache_layer = 'd1';
      queryCache.set(cacheKey, sharedCached);
      timing.cache = 'hit';
      timing.total_ms = elapsedMs(started);
      return { payload: sharedCached, cache: 'hit', timing };
    }
    if (body.mode === 'semantic' && body.min_score === undefined) {
      const lexicalFastPath = await queryByLexicalPlan(c, query, { ...body, top_k: clampTopK(body.top_k) }, queryPlan, timing);
      if (strongLexicalFastPath(lexicalFastPath)) {
        const payload = await rerankQueryPayload(c.env, lexicalFastPath!, query, body, timing, false);
        timing.retrieval = 'semantic_lexical_fast_path';
        timing.semantic_lexical_fast_path = true;
        queryCache.set(cacheKey, payload);
        if (payload.data.length > 0) await persistSharedQueryCache(c, tenant, indexId, cacheKey, payload);
        timing.cache = 'miss';
        timing.total_ms = elapsedMs(started);
        return { payload, cache: 'miss', timing };
      }
      timing.semantic_lexical_fast_path = false;
    }
    const vector = await embedOne(c.env, tenant, normalizedQuery, embeddingProfile, timing);
    const widenedTopK = Math.min(MAX_TOP_K, clampTopK(body.top_k) * 2);
    const semanticBody = body.mode === 'hybrid' ? { ...body, top_k: widenedTopK } : body;
    const semantic = await queryByVector(c, vector, semanticBody, timing, vectorizeProfile);
    const fused = body.mode === 'hybrid' ? fuseHybridResults(lexical, semantic, widenedTopK) : semantic;
    let payload = await rerankQueryPayload(c.env, fused, query, body, timing, body.mode === 'hybrid');
    if (body.mode === 'hybrid') {
      timing.retrieval = 'hybrid_rrf';
      timing.hybrid_lexical_results = lexical?.data.length ?? 0;
      timing.hybrid_semantic_results = semantic.data.length;
    }
    const correctiveReason = body.mode === 'semantic' ? weakSemanticReason(semantic) : null;
    if (correctiveReason) {
      const correctiveLexical = await queryByLexicalPlan(c, query, { ...body, top_k: widenedTopK }, queryPlan, timing);
      timing.corrective_reason = correctiveReason;
      timing.corrective_lexical_results = correctiveLexical?.data.length ?? 0;
      timing.corrective_semantic_results = semantic.data.length;
      if (correctiveLexical && correctiveLexical.data.length > 0) {
        const correctiveFused = fuseHybridResults(correctiveLexical, semantic, widenedTopK);
        payload = await rerankQueryPayload(c.env, correctiveFused, query, body, timing, true);
        timing.retrieval = 'corrective_hybrid';
      } else {
        timing.retrieval = 'vectorize';
      }
    }
    if (payload.data.length > 0) {
      queryCache.set(cacheKey, payload);
      await persistSharedQueryCache(c, tenant, indexId, cacheKey, payload);
    }
    timing.cache = 'miss';
    timing.total_ms = elapsedMs(started);
    return { payload, cache: 'miss', timing };
  }

  async function kbDomainCreateIndexBody(env: Env, tenant: string, domain: string): Promise<CreateIndexBody> {
    const metadataRepo = makeMetadataRepository(env);
    const domainRecord = (await metadataRepo.listDomains(tenant)).find((row) => row.name === domain);
    const storedModel = domainRecord?.embedding_model?.trim();
    if (storedModel) {
      return {
        embedding_model: storedModel,
        ...(domainRecord?.embedding_provider?.trim() ? { embedding_provider: domainRecord.embedding_provider.trim() } : {}),
      };
    }
    return { embedding_profile: 'base' };
  }

  async function resolveKbDomainEmbeddingSelection(
    env: Env,
    tenant: string,
    domain: string,
    input: { embedding_model?: string; embedding_provider?: string },
  ): Promise<{ model: string; provider: string | null } | null> {
    const requestedModel = input.embedding_model?.trim();
    const requestedProvider = input.embedding_provider?.trim();
    if (requestedProvider && !requestedModel) {
      throw new Error('embedding_provider requires embedding_model');
    }
    if (!requestedModel) return null;
    const profile = await resolveCreateEmbeddingProfile(env, {
      embedding_model: requestedModel,
      ...(requestedProvider ? { embedding_provider: requestedProvider } : {}),
    });
    const existingIndex = await makeRepository(env).getIndexByExternalId(tenant, kbIndexExternalId(domain));
    if (existingIndex) {
      if (!existingIndex.embedding_model) {
        throw new Error(`domain index ${existingIndex.id} is missing a stored embedding model; recreate the domain index before changing embedding_model`);
      }
      if (existingIndex.embedding_model !== profile.model) {
        throw new Error(
          `domain index already uses embedding model ${existingIndex.embedding_model}; delete and recreate the domain index before selecting ${profile.model}`,
        );
      }
      const existingProvider = existingIndex.embedding_provider ?? null;
      const selectedProvider = profile.provider ?? null;
      if (existingProvider !== selectedProvider) {
        throw new Error(
          `domain index already uses embedding provider ${existingProvider ?? 'unknown'}; delete and recreate the domain index before selecting ${selectedProvider ?? 'unknown'}`,
        );
      }
      if (existingIndex.dimensions !== profile.dimensions) {
        throw new Error(`domain index dimensions ${existingIndex.dimensions} do not match selected embedding dimensions ${profile.dimensions}`);
      }
    }
    return { model: profile.model, provider: profile.provider ?? null };
  }

  async function persistKbDomainEmbeddingSelection(
    env: Env,
    tenant: string,
    domain: string,
    input: { embedding_model?: string; embedding_provider?: string },
  ): Promise<void> {
    const embedding = await resolveKbDomainEmbeddingSelection(env, tenant, domain, input);
    if (!embedding) return;
    const metadataRepo = makeMetadataRepository(env);
    const existingDomain = (await metadataRepo.listDomains(tenant)).find((row) => row.name === domain);
    await metadataRepo.upsertDomain(tenant, domain, existingDomain?.description ?? '', embedding);
  }

  async function applyKbDomainEmbeddingSelection(
    c: AppContext,
    tenant: string,
    domain: string,
    input: { embedding_model?: string; embedding_provider?: string },
  ): Promise<Response | null> {
    try {
      await persistKbDomainEmbeddingSelection(c.env, tenant, domain, input);
      return null;
    } catch (error) {
      if (error instanceof Error) return c.json({ error: error.message }, 400);
      throw error;
    }
  }

  function formEmbeddingSelection(body: Record<string, unknown>): { embedding_model?: string; embedding_provider?: string } {
    return {
      ...(typeof body.embedding_model === 'string' ? { embedding_model: body.embedding_model } : {}),
      ...(typeof body.embedding_provider === 'string' ? { embedding_provider: body.embedding_provider } : {}),
    };
  }

  async function ensureKbIndex(env: Env, repo: Repository, tenant: string, domain: string): Promise<string> {
    const externalId = kbIndexExternalId(domain);
    const existing = await repo.getIndexByExternalId(tenant, externalId);
    if (existing) {
      rememberKbDomainIndexRecord(env, domain, existing);
      return existing.id;
    }
    const profile = await resolveCreateEmbeddingProfile(env, await kbDomainCreateIndexBody(env, tenant, domain));
    const created = await repo.createIndex({
      id: crypto.randomUUID(),
      tenant,
      name: `Knowledgebase ${domain}`,
      externalId,
      dimensions: profile.dimensions,
      embeddingModel: profile.model,
      embeddingProvider: profile.provider ?? null,
    });
    rememberKbDomainIndexRecord(env, domain, created);
    return created.id;
  }

  async function validateKbIndexReadiness(env: Env, repo: Repository, tenant: string, domain: string): Promise<void> {
    const existing = await repo.getIndexByExternalId(tenant, kbIndexExternalId(domain));
    if (existing) {
      const vectorizeProfile = vectorizeProfileForIndex(env, existing);
      const profile = embeddingProfileForIndex(env, existing, vectorizeProfile);
      if (env.RAG_EMBED_PROVIDER === 'free_ai') {
        const body: CreateIndexBody = {
          embedding_profile: profile.semanticModel,
          embedding_model: profile.model,
        };
        if (profile.provider) body.embedding_provider = profile.provider;
        const resolved = await resolveCreateEmbeddingProfile(env, body);
        if (resolved.dimensions !== existing.dimensions) {
          throw new Error(`embedding model dimensions ${resolved.dimensions} do not match existing index dimensions ${existing.dimensions}`);
        }
      }
      return;
    }
    await resolveCreateEmbeddingProfile(env, await kbDomainCreateIndexBody(env, tenant, domain));
  }

  async function validateKbSchedulingReadiness(c: AppContext, tenant: string, domain: string): Promise<Response | null> {
    try {
      if (c.env.RAG_EMBED_PROVIDER === 'free_ai') {
        await validateKbIndexReadiness(c.env, makeRepository(c.env), tenant, domain);
      } else {
        await resolveCreateEmbeddingProfile(c.env, { embedding_profile: 'base' });
      }
      return null;
    } catch (error) {
      if (isEmbeddingReadinessError(error)) return c.json({ error: error.message }, 400);
      throw error;
    }
  }

  async function upsertChunkVectors(
    env: Env,
    tenant: string,
    indexId: string,
    chunkRows: CreateChunkInput[],
    vectors: number[][],
    profile: ConfiguredVectorizeProfile,
    operation?: FileOperation,
  ): Promise<void> {
    const rows: VectorizeVector[] = chunkRows.map((chunk, i) => ({
      id: chunk.id,
      values: vectors[i] ?? [],
      namespace: vectorNamespace(tenant, indexId),
      metadata: vectorMetadata(tenant, indexId, chunk.documentId, chunk.chunkIndex, chunk.content, chunk.metadata),
    }));
    if (rows.length === 0) return;
    const ledger = operation ? new D1FileOwnership(env.DB) : undefined;
    const intents: Array<{ artifactId: string; rowId: string }> = [];
    if (operation && ledger) {
      for (const row of rows) {
        const artifactId = crypto.randomUUID();
        if (!(await ledger.recordIntent(operation, { artifact_id: artifactId, kind: 'vector', resource_id: row.id, provider: `vector:${profile.key}` })))
          throw new HTTPException(409, { message: 'File deletion is pending.' });
        intents.push({ artifactId, rowId: row.id });
      }
    }
    let receipt: unknown;
    try {
      receipt = await profile.binding.upsert(rows);
    } catch (error) {
      if (operation) throw new UnsettledFileWrite('Vector upsert settlement is unknown.');
      throw error;
    }
    for (const intent of intents)
      await ledger!.recordWrite(
        operation!.project,
        operation!.operation_id,
        intent.artifactId,
        'accepted',
        typeof jsonRecord(receipt).mutationId === 'string' ? String(jsonRecord(receipt).mutationId) : null,
      );
  }

  async function ingestDocumentsToIndex(
    env: Env,
    repo: Repository,
    tenant: string,
    indexId: string,
    documents: Array<{ external_id: string; content: string; metadata: JsonRecord }>,
    chunking?: KbIngestRunBody['chunking'],
    operation?: FileOperation,
  ): Promise<{ document_id: string; chunks: CreateChunkInput[] }[]> {
    const out: { document_id: string; chunks: CreateChunkInput[] }[] = [];
    const index = await getIndexRecord(env, repo, tenant, indexId);
    if (!index) throw new Error('Index not found');
    const vectorizeProfile = vectorizeProfileForIndex(env, index);
    const embeddingProfile = embeddingProfileForIndex(env, index, vectorizeProfile);
    const smallProfile = embeddingProfile.vectorizeProfile === 'base' ? configuredVectorizeProfiles(env).find((profile) => profile.key === 'small') : undefined;
    const pendingChunks: CreateChunkInput[] = [];
    const pendingChunkContents: string[] = [];
    for (const original of documents) {
      const input = operation
        ? {
            ...original,
            external_id: `${original.external_id}:owned:${operation.operation_id}`,
            metadata: { ...original.metadata, file_generation: operation.generation },
          }
        : original;
      const content = input.content.trim();
      if (!content) continue;
      if (content.length > MAX_DOC_SIZE) throw new Error('document content too large');
      const documentId = input.external_id ? await deterministicId('doc', `${tenant}:${indexId}:${input.external_id}`) : crypto.randomUUID();
      const ledger = operation ? new D1FileOwnership(env.DB) : undefined;
      const artifactId = crypto.randomUUID();
      if (
        operation &&
        ledger &&
        !(await ledger.recordIntent(operation, { artifact_id: artifactId, kind: 'document', resource_id: documentId, provider: 'd1' }))
      )
        throw new HTTPException(409, { message: 'File deletion is pending.' });
      const existingDocument = await repo.getDocument(tenant, documentId);
      const document =
        existingDocument ??
        (await repo.createDocument({
          id: documentId,
          tenant,
          indexId,
          externalId: input.external_id,
          content,
          metadata: input.metadata,
        }));
      if (operation && ledger) await ledger.recordWrite(tenant, operation.operation_id, artifactId, 'confirmed');
      const chunkContents = chunkText(content, chunking);
      const chunkRows: CreateChunkInput[] = [];
      for (let i = 0; i < chunkContents.length; i += 1) {
        const chunk = chunkContents[i] ?? '';
        chunkRows.push({
          id: input.external_id ? await deterministicId('chk', `${tenant}:${indexId}:${input.external_id}:${i}:${chunk}`) : crypto.randomUUID(),
          tenant,
          indexId,
          documentId: document.id,
          content: chunk,
          chunkIndex: i,
          metadata: input.metadata,
        });
      }
      pendingChunks.push(...chunkRows);
      pendingChunkContents.push(...chunkContents);
      out.push({ document_id: document.id, chunks: chunkRows });
    }
    if (pendingChunks.length === 0) return out;
    const vectors = await embed(env, pendingChunkContents, embeddingOptionsForProfile(embeddingProfile));
    const smallVectors = smallProfile ? await embed(env, pendingChunkContents, { model: embeddingModel(env, 'small') }) : [];
    await repo.insertChunks(pendingChunks);
    await upsertChunkVectors(env, tenant, indexId, pendingChunks, vectors, vectorizeProfile, operation);
    if (smallProfile && smallVectors.length > 0) {
      await upsertChunkVectors(env, tenant, indexId, pendingChunks, smallVectors, smallProfile, operation);
    }
    return out;
  }

  async function runKbIngest(
    env: Env,
    tenant: string,
    body: KbIngestRunBody,
    lockedBy: string,
  ): Promise<{ project: string; domain: string; run_id: string | null; index_id: string; files: JsonRecord[] }> {
    if (!env.RAW_DOCS) throw new Error('RAW_DOCS R2 bucket is not configured');
    const domain = body.domain?.trim();
    if (!domain) throw new Error('domain is required');
    const repo = makeRepository(env);
    const metadataRepo = makeMetadataRepository(env);
    const runId = body.run_id?.trim() || null;
    const indexId = await ensureKbIndex(env, repo, tenant, domain);
    const activeSchema = (await metadataRepo.listSchemas(tenant)).find((schema) => schema.domain === domain && schema.is_active === 1);
    const selectedIds = new Set((body.file_ids ?? []).filter(Boolean));
    const files =
      selectedIds.size > 0
        ? (await Promise.all([...selectedIds].map((id) => metadataRepo.getFile(tenant, id)))).filter((file): file is NonNullable<typeof file> =>
            Boolean(file && file.domain === domain),
          )
        : await metadataRepo.listFiles(tenant, domain, ['pending']);
    const results = [];
    for (const file of files) {
      let operation: FileOperation | undefined;
      try {
        operation = await beginOwnedOperation(env, tenant, file.id);
      } catch {
        results.push({ file_id: file.id, status: 'skipped', reason: 'owned_operation_pending_or_legacy' });
        continue;
      }
      const job = await metadataRepo.upsertIngestJob({
        project: tenant,
        domain,
        fileId: file.id,
        schemaId: activeSchema?.id ?? null,
        status: 'running',
        stage: 'parse',
        workflowId: runId,
      });
      if (!operation && isIngestJobLeaseActive(job, Date.now(), INGEST_JOB_LEASE_MS, lockedBy)) {
        results.push({
          job_id: job.id,
          file_id: file.id,
          filename: file.filename,
          status: 'skipped',
          reason: 'lease_active',
          locked_by: job.locked_by,
          ingest_safety: ingestSafetyEvidence({
            contentHash: file.content_hash,
            replayRoute: `/v1/kb/files/${file.id}/reprocess`,
            idempotentReplay: true,
          }),
        });
        continue;
      }
      const fileStarted = Date.now();
      try {
        await metadataRepo.updateIngestJob(job.id, { status: 'running', stage: 'parse', lockedBy });
        await metadataRepo.setFileStatus(tenant, file.id, 'indexing');
        const object = await env.RAW_DOCS.get(file.object_key);
        if (!object) throw new Error(`R2 object not found: ${file.object_key}`);
        const parsed = await withParseTimeout(
          parseUploadBytesWithCloudflare(
            file.filename,
            file.mime,
            await object.arrayBuffer(),
            env.AI,
            body.markdown_conversion ?? env.RAG_MARKDOWN_CONVERSION ?? 'auto',
            body.vision_ocr_model ?? env.RAG_VISION_OCR_MODEL ?? '',
          ),
          INGEST_PARSE_TIMEOUT_MS,
          file.filename,
        );
        if (parsed.documents.length === 0 || !parsed.text) throw new Error(`file has no parseable text content via ${parsed.parser}`);
        const parseArtifact = buildParseArtifact(parsed, { project: tenant, domain, id: file.id, filename: file.filename, content_hash: file.content_hash });
        const docs = parseArtifact.documents;
        const artifactKey = parseArtifactKey(domain, file.content_hash);
        const parseContent = JSON.stringify(parseArtifact);
        const parseOptions = {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: {
            project: tenant,
            domain,
            file_id: file.id,
            content_hash: file.content_hash,
            parser: parsed.parser,
          },
        };
        const artifact = await persistParse(
          env,
          operation,
          {
            contentHash: file.content_hash,
            parser: parsed.parser,
            parserVersion: parsed.parser_version,
            objectKey: artifactKey,
            pageCount: parsed.page_count,
          },
          parseContent,
          parseOptions,
        );
        await metadataRepo.updateIngestJob(job.id, { status: 'running', stage: 'index' });
        const ingested = await ingestDocumentsToIndex(env, repo, tenant, indexId, docs, body.chunking, operation);
        const chunkPreview = chunkPreviewFromChunks(ingested.flatMap((entry) => entry.chunks));
        await metadataRepo.insertKbChunks(
          ingested.flatMap((entry) =>
            entry.chunks.map((chunk) => ({
              id: crypto.randomUUID(),
              project: tenant,
              domain,
              fileId: file.id,
              vectorId: chunk.id,
              pageStart: 1,
              pageEnd: 1,
              text: chunk.content,
              metadata: chunk.metadata,
            })),
          ),
        );
        let structured = { entities: 0, mentions: 0, relationships: 0, provenance_spans: 0, chunks_linked: 0 };
        if (activeSchema) {
          await metadataRepo.updateIngestJob(job.id, { status: 'running', stage: 'extract' });
          const structuredInput = {
            project: tenant,
            domain,
            fileId: file.id,
            schema: activeSchema,
            records: ingested.flatMap((entry, i) => {
              const record = recordFromDocumentMetadata(docs[i]?.metadata ?? {});
              return record
                ? [
                    {
                      documentId: entry.document_id,
                      recordIndex: i,
                      record,
                      chunks: entry.chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
                    },
                  ]
                : [];
            }),
          };
          structured =
            operation && metadataRepo.stageOwnedStructuredEntities
              ? await metadataRepo.stageOwnedStructuredEntities(structuredInput, operation)
              : await metadataRepo.recordStructuredEntities(structuredInput);
        }
        if (operation) {
          if (!(await completeOwnedOperation(env, operation))) throw new HTTPException(409, { message: 'File removed during ingestion.' });
        } else await metadataRepo.setFileStatus(tenant, file.id, 'ready');
        await metadataRepo.updateIngestJob(job.id, { status: 'succeeded', stage: 'indexed', lockedBy: null });
        console.log('knowledgebase ingest file succeeded', {
          job_id: job.id,
          file_id: file.id,
          project: tenant,
          domain,
          locked_by: lockedBy,
          duration_ms: Date.now() - fileStarted,
          chunks_created: ingested.reduce((sum, entry) => sum + entry.chunks.length, 0),
        });
        results.push({
          job_id: job.id,
          file_id: file.id,
          filename: file.filename,
          status: 'ready',
          parse_artifact: artifact,
          documents_created: ingested.length,
          chunks_created: ingested.reduce((sum, entry) => sum + entry.chunks.length, 0),
          chunk_preview: chunkPreview,
          ingest_safety: ingestSafetyEvidence({
            contentHash: file.content_hash,
            chunkPreview,
            replayRoute: `/v1/kb/files/${file.id}/reprocess`,
          }),
          ...structured,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (operation) {
          if (!(error instanceof UnsettledFileWrite)) await abortOwnedOperation(env, operation);
        } else await metadataRepo.setFileStatus(tenant, file.id, 'failed', message);
        await metadataRepo.updateIngestJob(job.id, {
          status: 'failed',
          error: message,
          lockedBy: null,
          incrementAttempts: true,
        });
        console.error('knowledgebase ingest file failed', {
          job_id: job.id,
          file_id: file.id,
          project: tenant,
          domain,
          locked_by: lockedBy,
          duration_ms: Date.now() - fileStarted,
          error: message,
          failure_classification: classifyIngestFailure(message),
        });
        results.push({
          job_id: job.id,
          file_id: file.id,
          filename: file.filename,
          status: 'failed',
          error: message,
          failure_classification: classifyIngestFailure(message),
          ingest_safety: ingestSafetyEvidence({
            contentHash: file.content_hash,
            replayRoute: `/v1/kb/files/${file.id}/reprocess`,
            failure: message,
          }),
        });
      }
    }
    clearAnswerAndQueryCaches();
    clearLexicalChunkCache(tenant, indexId);
    await primeLexicalChunkCache(env, repo, tenant, indexId);
    await clearSharedQueryCache(env, tenant, indexId);
    return { project: tenant, domain, run_id: runId, index_id: indexId, files: results };
  }

  async function runKbAnswer(c: AppContext, body: KbQueryBody, started: number): Promise<{ payload: KbAnswerPayload; timing: RagTiming; cache: CacheStatus }> {
    const domain = body.domain?.trim();
    const question = (body.question ?? body.query)?.trim();
    if (!domain) throw new Error('domain is required');
    if (!question) throw new Error('question is required');
    const tenant = c.get('tenant');
    const repo = makeRepository(c.env);
    const metadataRepo = makeMetadataRepository(c.env);
    const requestedAnswerMode = answerModeFromBody(body);
    const requestedSessionId = body.session_id?.trim();
    const sessionId: string | null = requestedSessionId || null;
    if (requestedSessionId) {
      const existingSession = await metadataRepo.getSession(tenant, requestedSessionId);
      if (!existingSession) await metadataRepo.createSession(tenant, domain, requestedSessionId);
    }
    const queryBody: QueryBody = {};
    if (body.top_k !== undefined) queryBody.top_k = body.top_k;
    if (body.mode !== undefined) queryBody.mode = body.mode;
    if (body.min_score !== undefined) queryBody.min_score = body.min_score;
    if (body.semantic_model !== undefined) queryBody.semantic_model = body.semantic_model;
    if (body.rerank !== undefined) queryBody.rerank = body.rerank;
    if (body.rerank_model !== undefined) queryBody.rerank_model = body.rerank_model;
    if (body.mmr !== undefined) queryBody.mmr = body.mmr;
    if (body.query_rewrite !== undefined) queryBody.query_rewrite = body.query_rewrite;
    if (body.query_decompose !== undefined) queryBody.query_decompose = body.query_decompose;
    if (body.mode !== 'semantic') {
      const structuredStarted = performance.now();
      const topK = clampTopK(body.top_k ?? 5);
      const fieldQuery = await structuredFieldQueryResults(metadataRepo, tenant, domain, question, topK);
      const structuredEntities = fieldQuery.entities.length > 0 ? fieldQuery.entities : await metadataRepo.searchEntities(tenant, domain, question, topK);
      if (structuredEntities.length > 0) {
        const structuredRoute = fieldQuery.entities.length > 0 ? 'd1_structured_query' : 'd1_entities';
        const entityResults = structuredEntities.map((entity, i) =>
          searchResultFromEntity(
            entity,
            1 / (i + 1),
            structuredRoute,
            fieldQuery.filters.length > 0
              ? {
                  structured_filters: fieldQuery.filters,
                }
              : {},
          ),
        );
        const graphResults = await graphResultsForEntities(metadataRepo, tenant, domain, structuredEntities);
        const data = [...entityResults, ...graphResults].slice(0, topK + graphResults.length);
        const citations = citationsFromResults(data, question);
        const baseConfidence: JsonRecord = {
          level: 'high',
          route: graphResults.length > 0 ? 'd1_graph' : structuredRoute,
          result_count: data.length,
          entity_result_count: entityResults.length,
          graph_result_count: graphResults.length,
          structured_filters: fieldQuery.filters,
          calibration:
            fieldQuery.entities.length > 0
              ? 'exact_structured_field_match'
              : graphResults.length > 0
                ? 'exact_structured_entity_match_with_graph_edges'
                : 'exact_structured_entity_match',
        };
        const answerState = await answerFromEvidence({
          env: c.env,
          question,
          citations,
          retrieved: data,
          extractiveAnswer: answerFromStructuredEntities(question, citations),
          baseConfidence,
          requestedMode: requestedAnswerMode,
          requestedModel: body.answer_model,
        });
        const timing: RagTiming = {
          route: 'query',
          structured_route: graphResults.length > 0 ? 'd1_graph' : structuredRoute,
          structured_ms: elapsedMs(structuredStarted),
          ...answerState.timing,
          verification: 'deterministic',
          verification_status: String(answerState.confidence.verification_status ?? 'unknown'),
          cache: 'miss',
        };
        const structuredPayloadForTrace = {
          project: tenant,
          domain,
          index_id: null,
          route: 'd1_entities',
          ai_used: answerState.aiUsed,
          trace_id: '',
          session_id: sessionId,
          answer_mode: answerState.answerMode,
          answer_model: answerState.answerModel,
          question,
          answer: answerState.answer,
          citations,
          confidence: answerState.confidence,
          data,
        };
        const trace = await metadataRepo.insertQueryTrace({
          project: tenant,
          domain,
          question,
          scope: body.scope ?? null,
          filters: { route: graphResults.length > 0 ? 'd1_graph' : structuredRoute, structured_filters: fieldQuery.filters },
          retrieved: data,
          answer: answerState.answer,
          citations,
          confidence: confidenceWithTiming(answerState.confidence, timing, structuredPayloadForTrace),
          latencyMs: elapsedMs(started),
        });
        writeTraceAnalytics(c.env, trace);
        if (sessionId) {
          await metadataRepo.appendSessionHistory(tenant, sessionId, [
            { role: 'user', content: question, trace_id: trace.id, created_at: new Date().toISOString() },
            {
              role: 'assistant',
              content: answerState.answer,
              trace_id: trace.id,
              citations,
              route: 'd1_entities',
              answer_mode: answerState.answerMode,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        return {
          payload: {
            project: tenant,
            domain,
            index_id: null,
            route: 'd1_entities',
            ai_used: answerState.aiUsed,
            trace_id: trace.id,
            session_id: sessionId,
            answer_mode: answerState.answerMode,
            answer_model: answerState.answerModel,
            question,
            answer: answerState.answer,
            citations,
            confidence: answerState.confidence,
            data,
          },
          timing,
          cache: 'miss',
        };
      }
    }
    const index = await getKbDomainIndex(c.env, repo, tenant, domain);
    if (!index) throw new Error('domain index not found');
    const answerCacheKey = sessionId
      ? null
      : buildCacheKey({
          revision: await durableRevision(c.env, tenant),
          tenant,
          domain,
          indexId: index.id,
          question: normalizeSemanticQuery(question),
          queryBody,
          answerMode: requestedAnswerMode,
          answerModel: body.answer_model ?? null,
          scope: body.scope ?? null,
        });
    answerCache.configure(parseCacheOptions(c.env));
    if (answerCacheKey) {
      const cachedAnswer = answerCache.get(answerCacheKey);
      if (cachedAnswer) {
        return {
          payload: cachedAnswer,
          timing: {
            route: 'query',
            cache_layer: 'answer_memory',
            cache: 'hit',
            total_ms: elapsedMs(started),
          },
          cache: 'hit',
        };
      }
    }
    const result = await runTextQuery(contextWithIndex(c, index.id), question, queryBody);
    const citations = citationsFromResults(result.payload.data, question);
    const answerState = await answerFromEvidence({
      env: c.env,
      question,
      citations,
      retrieved: result.payload.data,
      extractiveAnswer: answerFromCitations(question, citations),
      baseConfidence: confidenceFromResults(result.payload.data),
      requestedMode: requestedAnswerMode,
      requestedModel: body.answer_model,
    });
    const route =
      result.timing.retrieval === 'lexical' || result.timing.retrieval === 'semantic_lexical_fast_path'
        ? 'd1_lexical'
        : result.timing.retrieval === 'hybrid_rrf'
          ? 'hybrid_rrf'
          : result.timing.retrieval === 'corrective_hybrid'
            ? 'corrective_hybrid'
            : 'vectorize';
    result.timing.verification = 'deterministic';
    Object.assign(result.timing, answerState.timing);
    result.timing.verification_status = String(answerState.confidence.verification_status ?? 'unknown');
    const payloadForTrace = {
      project: tenant,
      domain,
      index_id: index.id,
      route,
      ai_used: answerState.aiUsed || (route !== 'd1_lexical' && result.cache !== 'hit'),
      trace_id: '',
      session_id: sessionId,
      answer_mode: answerState.answerMode,
      answer_model: answerState.answerModel,
      question,
      answer: answerState.answer,
      citations,
      confidence: answerState.confidence,
      data: result.payload.data,
    };
    const trace = await metadataRepo.insertQueryTrace({
      project: tenant,
      domain,
      question,
      scope: body.scope ?? null,
      filters: queryBody.filter ?? null,
      retrieved: result.payload.data,
      answer: answerState.answer,
      citations,
      confidence: confidenceWithTiming(answerState.confidence, result.timing, payloadForTrace),
      latencyMs: elapsedMs(started),
    });
    writeTraceAnalytics(c.env, trace);
    if (sessionId) {
      await metadataRepo.appendSessionHistory(tenant, sessionId, [
        { role: 'user', content: question, trace_id: trace.id, created_at: new Date().toISOString() },
        {
          role: 'assistant',
          content: answerState.answer,
          trace_id: trace.id,
          citations,
          route,
          answer_mode: answerState.answerMode,
          created_at: new Date().toISOString(),
        },
      ]);
    }
    const payload = {
      project: tenant,
      domain,
      index_id: index.id,
      route,
      ai_used: answerState.aiUsed || (route !== 'd1_lexical' && result.cache !== 'hit'),
      trace_id: trace.id,
      session_id: sessionId,
      answer_mode: answerState.answerMode,
      answer_model: answerState.answerModel,
      question,
      answer: answerState.answer,
      citations,
      confidence: answerState.confidence,
      data: result.payload.data,
    };
    if (answerCacheKey && payload.data.length > 0) answerCache.set(answerCacheKey, payload);
    return {
      payload,
      timing: result.timing,
      cache: result.cache,
    };
  }

  async function queryByVector(
    c: AppContext,
    vector: number[],
    body: QueryBody,
    timing?: RagTiming,
    resolvedVectorizeProfile?: ConfiguredVectorizeProfile,
  ): Promise<QueryPayload> {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    if (!indexId) throw new Error('Index not found');
    const repo = makeRepository(c.env);
    const topK = clampTopK(body.top_k);
    let vectorizeProfile = resolvedVectorizeProfile;
    if (!vectorizeProfile) {
      const indexStarted = performance.now();
      const index = await getIndexRecord(c.env, repo, tenant, indexId);
      if (!index) throw new Error('Index not found');
      if (timing) timing.index_ms = elapsedMs(indexStarted);
      vectorizeProfile = vectorizeProfileForIndex(c.env, index, body);
    }
    const binding = vectorizeProfile.binding;
    const filter = userVectorFilter(body.filter);
    const vectorizeStarted = performance.now();
    let query = await binding.query(vector, {
      topK,
      ...(filter ? { filter } : {}),
      namespace: vectorNamespace(tenant, indexId),
      returnMetadata: 'all',
      returnValues: false,
    });
    let vectorizePath = 'namespace';
    if (query.matches.length === 0 && vectorizeProfile.key === 'base') {
      query = await binding.query(vector, {
        topK,
        filter: { ...jsonRecord(body.filter), tenant, index_id: indexId },
        returnMetadata: 'all',
        returnValues: false,
      });
      vectorizePath = 'metadata_filter_fallback';
    }
    if (timing) timing.vectorize_ms = elapsedMs(vectorizeStarted);
    if (timing) {
      timing.vectorize_path = vectorizePath;
      timing.semantic_model = vectorizeProfile.semanticModel;
      timing.vectorize_profile = vectorizeProfile.key;
      timing.vectorize_binding = vectorizeProfile.bindingName;
    }
    const minScore = typeof body.min_score === 'number' ? body.min_score : -Infinity;
    const matches = query.matches.filter((match) => match.score >= minScore);
    if (matches.length === 0) {
      const indexStarted = performance.now();
      if (!(await indexExists(c.env, repo, tenant, indexId))) throw new Error('Index not found');
      if (timing) timing.index_ms = elapsedMs(indexStarted);
      return { data: [] };
    }
    const metadataResults = matches.map(searchResultFromVectorMetadata);
    if (!options.ownedFileProtocol && metadataResults.every(Boolean)) {
      if (timing) timing.hydrate_ms = 0;
      return { data: metadataResults.filter((result): result is SearchResult => Boolean(result)) };
    }
    const hydrateStarted = performance.now();
    const chunkIds = matches.map((match) => match.id);
    const chunks = sortResultsByVectorOrder(chunkIds, await repo.getChunksByIds(tenant, chunkIds));
    const scoreById = new Map(matches.map((match) => [match.id, match.score]));
    const data: SearchResult[] = chunks.map((chunk) => ({
      document_id: chunk.document_id,
      chunk_id: chunk.id,
      chunk_content: chunk.content,
      score: scoreById.get(chunk.id) ?? 0,
      metadata: chunk.metadata,
    }));
    if (timing) timing.hydrate_ms = elapsedMs(hydrateStarted);
    return { data };
  }

  async function queryByLexical(c: AppContext, query: string, body: QueryBody, timing?: RagTiming): Promise<QueryPayload | null> {
    const tokens = tokenizeLexicalQuery(query);
    if (tokens.length === 0) return null;
    const started = performance.now();
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    if (!indexId) throw new Error('Index not found');
    const topK = clampTopK(body.top_k);
    const repo = makeRepository(c.env);
    const prefilterStarted = performance.now();
    const candidateChunks = await getCachedLexicalChunks(c.env, repo, tenant, indexId, timing);
    if (candidateChunks.length === 0) {
      const indexStarted = performance.now();
      if (!(await indexExists(c.env, repo, tenant, indexId))) throw new Error('Index not found');
      if (timing) timing.index_ms = elapsedMs(indexStarted);
    }
    const ranked = sparseLexicalScore(candidateChunks, tokens).slice(0, topK);
    if (timing) {
      timing.lexical_ms = elapsedMs(started);
      timing.lexical_prefilter_ms = elapsedMs(prefilterStarted);
      timing.lexical_prefilter = 'chunk_cache_full_scan';
      timing.lexical_tokens = tokens.length;
      timing.lexical_scoring = LEXICAL_SCORING_VERSION;
      timing.lexical_corpus_chunks = candidateChunks.length;
      timing.lexical_candidate_limit = MAX_LEXICAL_CHUNKS;
      timing.retrieval = ranked.length > 0 ? 'lexical' : 'semantic_fallback';
    }
    return {
      data: ranked.map((entry) => ({
        document_id: entry.chunk.document_id,
        chunk_id: entry.chunk.id,
        chunk_content: entry.chunk.content,
        score: entry.score,
        metadata: {
          ...entry.chunk.metadata,
          lexical_score: entry.score,
          lexical_overlap: entry.overlap,
          lexical_scoring: LEXICAL_SCORING_VERSION,
          lexical_matched_terms: entry.matchedTerms,
        },
      })),
    };
  }

  async function queryByLexicalPlan(c: AppContext, query: string, body: QueryBody, plan: QueryPlan, timing?: RagTiming): Promise<QueryPayload | null> {
    const started = performance.now();
    const primary = await queryByLexical(c, query, body, timing);
    if (plan.variants.length === 0) return primary;
    const entries: Array<{ query: string; kind: 'original' | QueryPlanVariantKind; payload: QueryPayload | null }> = [
      { query: normalizeSemanticQuery(query), kind: 'original', payload: primary },
    ];
    for (const variant of plan.variants) {
      entries.push({
        query: variant.query,
        kind: variant.kind,
        payload: await queryByLexical(c, variant.query, body),
      });
    }
    const fused = fuseQueryPlanResults(entries, clampTopK(body.top_k));
    if (timing) {
      timing.query_plan = 'rewrite_decompose';
      timing.query_plan_ms = elapsedMs(started);
      timing.query_plan_variants = plan.variants.length;
      timing.query_plan_original_results = primary?.data.length ?? 0;
      timing.query_plan_results = fused.data.length;
      if (fused.data.length > 0) timing.retrieval = 'lexical';
    }
    return fused;
  }

  return {
    makeRepository,
    makeMetadataRepository,
    embed,
    queryCache,
    answerCache,
    embeddingCache,
    indexCache,
    indexRecordCache,
    kbDomainIndexCache,
    lexicalChunkCache,
    clearAnswerAndQueryCaches,
    rememberIndex,
    rememberIndexRecord,
    rememberKbDomainIndexRecord,
    getKbDomainIndex,
    getIndexRecord,
    indexExists,
    embedOne,
    rerankWithWorkersAi,
    rerankQueryPayload,
    getSharedQueryCache,
    setSharedQueryCache,
    clearSharedQueryCache,
    getSharedEmbeddingCache,
    setSharedEmbeddingCache,
    clearKbDomainCaches,
    deleteKbFiles,
    storeRawFile,
    registerStoredFile,
    persistParse,
    beginOwnedOperation,
    completeOwnedOperation,
    abortOwnedOperation,
    ownedDeletion,
    listDeletionFiles,
    ownedParseLookup,
    genericOwnershipConflict,
    ownedIndexHasFiles,
    relationshipsWithEntityNames,
    persistSharedQueryCache,
    getCachedLexicalChunks,
    clearLexicalChunkCache,
    primeLexicalChunkCache,
    runTextQuery,
    kbDomainCreateIndexBody,
    resolveKbDomainEmbeddingSelection,
    persistKbDomainEmbeddingSelection,
    applyKbDomainEmbeddingSelection,
    formEmbeddingSelection,
    ensureKbIndex,
    validateKbIndexReadiness,
    validateKbSchedulingReadiness,
    upsertChunkVectors,
    ingestDocumentsToIndex,
    runKbIngest,
    runKbAnswer,
    queryByVector,
    queryByLexical,
    queryByLexicalPlan,
  };
}

export type AppRuntime = ReturnType<typeof createRuntime>;
