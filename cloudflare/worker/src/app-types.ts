import type { Context, Hono } from 'hono';
import type { Variables } from './auth';
import type { TtlCache } from './cache';
import type { FreeAiEmbeddingModel } from './free-ai';
import type { MetadataRepository } from './kb-metadata-repository';
import type { Repository } from './repository';
import type { ChunkRecord, CitationRecord, Env, IndexRecord, JsonRecord, KbIngestQueueMessage, SearchResult, VectorizeBinding } from './types';

export const MAX_DOC_SIZE = 1_000_000;
export const MAX_TOP_K = 50;
export const MAX_LEXICAL_CHUNKS = 5000;
export const MAX_BENCHMARK_QUERIES = 20;
export const MAX_BENCHMARK_REPEAT = 200;
export const MAX_BENCHMARK_WARMUP = 20;
export const MAX_EVAL_CASES = 100;
export const CORRECTIVE_SEMANTIC_MIN_SCORE = 0.55;
export const SEMANTIC_LEXICAL_FAST_PATH_MIN_SCORE = 2;
export const SEMANTIC_LEXICAL_FAST_PATH_MIN_OVERLAP = 2;
export const DEFAULT_BASE_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const DEFAULT_SMALL_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
export const DEFAULT_BASE_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_SMALL_EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_RERANKER_MODEL = '@cf/baai/bge-reranker-base';
export const DEFAULT_ANSWER_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const WORKER_VERSION = '0.1.0';
export const WORKER_DEPLOY_FINGERPRINT = 'knowledgebase-a-plus-evidence-2026-06-23';
export const LEXICAL_SCORING_VERSION = 'bm25_fuzzy_sparse_v3';
export const MAX_RERANK_CONTEXT_CHARS = 1200;
export const INGEST_JOB_LEASE_MS = 5 * 60 * 1000;
export const INGEST_PARSE_TIMEOUT_MS = 45 * 1000;
export const INGEST_QUEUE_MAX_ATTEMPTS = 5;
export const MAX_RECORD_INDEX_TEXT_CHARS = 1800;
export const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'for', 'from', 'how', 'the', 'this', 'that', 'what', 'when', 'where', 'which', 'with']);
export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
export type QueryPayload = { data: SearchResult[] };
type TimingValue = number | string | boolean;
export type RagTiming = Record<string, TimingValue>;
export type CacheStatus = 'hit' | 'miss';
export type SemanticModel = 'base' | 'small';
type VectorizeProfileKey = SemanticModel | `dim_${number}`;
export type RerankModel = 'keyword' | 'workers_ai';
export type AnswerMode = 'extractive' | 'workers_ai';
export type QueryPlanVariantKind = 'rewrite' | 'decompose';
export type QueryPlanVariant = { query: string; kind: QueryPlanVariantKind };
export type QueryPlan = { variants: QueryPlanVariant[] };
export type FetchLikeApp = {
  fetch(request: Request, env: Env): Response | Promise<Response>;
};
type WorkerBindings = { Bindings: Env; Variables: Variables };
type WorkerApp = Hono<WorkerBindings>;
export type QueueCapableApp = WorkerApp & {
  processIngestQueue(batch: MessageBatch<KbIngestQueueMessage>, env: Env): Promise<void>;
};

export interface AppOptions {
  /** Internal qualification gate. Production defaults to legacy until every writer is covered. */
  ownedFileProtocol?: boolean;
  makeRepository?: (env: Env) => Repository;
  makeMetadataRepository?: (env: Env) => MetadataRepository;
  embed?: (env: Env, texts: string[], options?: EmbeddingCallOptions) => Promise<number[][]>;
  queryCache?: TtlCache<QueryPayload>;
  answerCache?: TtlCache<KbAnswerPayload>;
  embeddingCache?: TtlCache<number[]>;
  indexCache?: TtlCache<boolean>;
  indexRecordCache?: TtlCache<IndexRecord>;
  kbDomainIndexCache?: TtlCache<IndexRecord>;
  lexicalChunkCache?: TtlCache<ChunkRecord[]>;
}

export interface EmbeddingCallOptions {
  model?: string;
  provider?: string | undefined;
  dimensions?: number;
}

export interface CreateIndexBody {
  name?: string;
  external_id?: string;
  semantic_model?: SemanticModel;
  embedding_profile?: SemanticModel;
  embedding_model?: string;
  embedding_provider?: string;
}

export interface UpsertDomainBody {
  name?: string;
  description?: string;
  embedding_model?: string;
  embedding_provider?: string;
}

export interface InferSchemaBody {
  domain?: string;
  name?: string;
  records?: JsonRecord[];
  sample_texts?: string[];
  input?: unknown;
  save_draft?: boolean;
  embedding_model?: string;
  embedding_provider?: string;
}

export interface IngestBody {
  documents?: Array<{
    external_id?: string;
    content?: string;
    metadata?: JsonRecord;
  }>;
  chunking?: {
    size?: number;
    overlap?: number;
  };
}

export interface QueryBody {
  query?: string;
  vector?: number[];
  top_k?: number;
  filter?: JsonRecord;
  min_score?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

export interface BenchmarkQueryBody {
  queries?: string[];
  repeat?: number;
  warmup?: number;
  top_k?: number;
  filter?: JsonRecord;
  min_score?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

export interface SearchEvalCase {
  id?: string;
  query?: string;
  expected_text?: string;
  expected_chunk_ids?: string[];
  expected_document_ids?: string[];
}

export interface SearchEvalBody {
  index_id?: string;
  cases?: SearchEvalCase[];
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

export interface QueryEvalCase extends SearchEvalCase {
  question?: string;
  expected_answer_text?: string;
  expected_citation_text?: string;
}

export interface QueryEvalBody {
  domain?: string;
  cases?: QueryEvalCase[];
  session_id_prefix?: string;
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  ai_judge?: boolean;
  judge_model?: string;
  rerank?: boolean;
  rerank_model?: RerankModel;
  answer_mode?: AnswerMode;
  answer_model?: string;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

export interface ParseEvalCase {
  id?: string;
  filename?: string;
  mime?: string;
  content?: string;
  content_base64?: string;
  expected_text?: string | string[];
  expected_parser?: string;
  markdown_conversion?: string;
  vision_ocr_model?: string;
  min_text_length?: number;
}

export interface ParseEvalBody {
  domain?: string;
  cases?: ParseEvalCase[];
  markdown_conversion?: string;
  vision_ocr_model?: string;
  include_text_preview?: boolean;
}

export interface KbIngestRunBody {
  domain?: string;
  file_ids?: string[];
  async?: boolean;
  run_id?: string;
  embedding_model?: string;
  embedding_provider?: string;
  markdown_conversion?: string;
  vision_ocr_model?: string;
  chunking?: {
    size?: number;
    overlap?: number;
  };
}

export interface KbRecordIngestBody {
  domain?: string;
  kind?: string;
  type?: string;
  data?: unknown;
  idempotency_key?: string;
  embedding_model?: string;
  embedding_provider?: string;
}

export interface KbTextIngestBody {
  domain?: string;
  kind?: string;
  type?: string;
  title?: string;
  text?: string;
  async?: boolean;
  idempotency_key?: string;
  embedding_model?: string;
  embedding_provider?: string;
  chunking?: KbIngestRunBody['chunking'];
}

export interface SourceImportBody {
  domain?: string;
  source?: string;
  embedding_model?: string;
  embedding_provider?: string;
  config?: {
    urls?: string[];
    timeout_s?: number;
    tickers?: string[];
    ciks?: string[];
    forms?: string[];
    days?: number;
    per_ticker_per_form?: number;
    limit_total?: number;
    user_agent?: string;
  };
  auto_ingest?: boolean;
}

export interface EdgarTickerRow {
  cik_str?: number | string;
  ticker?: string;
  title?: string;
}

export interface EdgarSubmissionsResponse {
  cik?: string;
  name?: string;
  filings?: {
    recent?: Record<string, unknown[]>;
  };
}

export interface EdgarFilingCandidate {
  ticker: string | null;
  cik: string;
  cikNumber: string;
  companyName: string | null;
  accession: string;
  accessionNoDashes: string;
  form: string;
  filingDate: string;
  primaryDocument: string;
  url: string;
  filename: string;
}

export interface KbSearchBody {
  domain?: string;
  query?: string;
  top_k?: number;
  min_score?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

export interface KbQueryBody extends KbSearchBody {
  question?: string;
  scope?: string;
  session_id?: string;
  answer_mode?: AnswerMode;
  answer_model?: string;
}

export interface KbSessionBody {
  domain?: string;
  id?: string;
  entries?: JsonRecord[];
}

export interface KbAnswerPayload {
  project: string;
  domain: string;
  index_id: string | null;
  route: string;
  ai_used: boolean;
  trace_id: string;
  session_id: string | null;
  answer_mode: AnswerMode;
  answer_model: string | null;
  question: string;
  answer: string;
  citations: CitationRecord[];
  confidence: JsonRecord;
  data: SearchResult[];
}

export interface IngestVectorsBody {
  chunks?: Array<{
    id?: string;
    document_id?: string;
    document_content?: string;
    document_external_id?: string;
    content?: string;
    embedding?: number[];
    chunk_index?: number;
    metadata?: JsonRecord;
  }>;
}

export interface ResolvedEmbeddingProfile {
  semanticModel: SemanticModel;
  vectorizeProfile: VectorizeProfileKey;
  vectorizeBinding: string;
  model: string;
  provider?: string | undefined;
  dimensions: number;
}

export type EmbeddingModelCatalogRow = FreeAiEmbeddingModel & {
  configured_profile: SemanticModel | null;
  compatible_profile: string | null;
  vectorize_binding: string | null;
  selectable: boolean;
};

export interface ConfiguredVectorizeProfile {
  key: VectorizeProfileKey;
  semanticModel: SemanticModel;
  dimensions: number;
  binding: VectorizeBinding;
  bindingName: string;
  model?: string | undefined;
}

export type WorkerHealthPayload = {
  ok: boolean;
  d1: boolean;
  d1_schema: boolean;
  vectorize: boolean;
  r2: boolean;
  version: string;
  deploy_fingerprint: string;
  d1_schema_check_skipped?: boolean;
  error?: string;
};
