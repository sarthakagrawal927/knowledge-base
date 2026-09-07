export type JsonRecord = Record<string, unknown>;

export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE: VectorizeBinding;
  VECTORIZE_1024?: VectorizeBinding;
  VECTORIZE_768?: VectorizeBinding;
  VECTORIZE_384?: VectorizeBinding;
  VECTORIZE_SMALL?: VectorizeBinding;
  RAW_DOCS?: R2Bucket;
  INGEST_QUEUE?: Queue<KbIngestQueueMessage>;
  KB_INGEST_WORKFLOW?: Workflow<KbIngestQueueMessage>;
  RAG_ANALYTICS?: AnalyticsEngineDataset;
  RAG_SERVICE_KEYS?: string;
  RAG_SERVICE_KEYS_APPEND?: string;
  RAG_SERVICE_DASHBOARD_KEYS?: string;
  RAG_SERVICE_PROOF_KEYS?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_MODEL_SMALL?: string;
  RAG_ANSWER_MODEL?: string;
  // Route inference to an explicitly configured direct provider when set.
  RAG_EMBED_PROVIDER?: string;
  RAG_SYNTH_PROVIDER?: string;
  // Optional injected HTTP transport used by local tests. Production uses fetch.
  AI_HTTP?: Fetcher;
  FREE_AI_API_KEY?: string;
  FREE_AI_BASE_URL?: string;
  FREE_AI_EMBED_MODEL?: string;
  FREE_AI_EMBED_PROVIDER?: string;
  FREE_AI_EMBED_DIMENSIONS?: string;
  FREE_AI_EMBED_MODEL_SMALL?: string;
  FREE_AI_EMBED_PROVIDER_SMALL?: string;
  FREE_AI_EMBED_DIMENSIONS_SMALL?: string;
  FREE_AI_SYNTH_MODEL?: string;
  FREE_AI_SYNTH_PROVIDER?: string;
  RAG_MARKDOWN_CONVERSION?: string;
  RAG_VISION_OCR_MODEL?: string;
  RAG_DEPLOY_FINGERPRINT?: string;
  RAG_SEC_USER_AGENT?: string;
  RAG_SHARED_QUERY_CACHE_ENABLED?: string;
  RAG_SHARED_EMBEDDING_CACHE_ENABLED?: string;
  RAG_CACHE_ENABLED?: string;
  RAG_CACHE_TTL_SECONDS?: string;
  RAG_CACHE_MAX_ENTRIES?: string;
  RAG_ALLOW_UNMIGRATED_LOCAL_D1?: string;
}

export interface KbIngestQueueMessage {
  kind: 'kb_ingest';
  project: string;
  domain: string;
  run_id?: string;
  file_ids?: string[];
  markdown_conversion?: string;
  vision_ocr_model?: string;
  chunking?: {
    size?: number;
    overlap?: number;
  };
}

export interface VectorizeVector {
  id: string;
  values: number[];
  metadata: JsonRecord;
  namespace?: string;
}

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: JsonRecord;
}

export interface VectorizeBinding {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(
    vector: number[],
    options: {
      topK: number;
      filter?: JsonRecord;
      namespace?: string;
      returnMetadata?: 'all' | 'indexed' | 'none' | boolean;
      returnValues?: boolean;
    },
  ): Promise<{ matches: VectorizeMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
  getByIds?(ids: string[]): Promise<Array<{ id: string }>>;
}

export interface IndexRecord {
  id: string;
  tenant: string;
  name: string;
  external_id: string | null;
  dimensions: number;
  embedding_model: string | null;
  embedding_provider: string | null;
  metric: 'cosine';
  created_at: string;
}

export interface DocumentRecord {
  id: string;
  index_id: string;
  tenant: string;
  external_id: string | null;
  content: string;
  metadata: JsonRecord;
  created_at: string;
}

export interface ChunkRecord {
  id: string;
  document_id: string;
  index_id: string;
  tenant: string;
  content: string;
  chunk_index: number;
  metadata: JsonRecord;
  created_at: string;
}

export interface SearchResult {
  document_id: string;
  chunk_id: string;
  chunk_content: string;
  score: number;
  metadata: JsonRecord;
}

export interface CitationRecord {
  index: number;
  document_id: string;
  chunk_id: string;
  file_id: string | null;
  filename: string | null;
  page_start: number;
  page_end: number;
  excerpt: string;
  span_terms?: string[];
  score: number;
  metadata: JsonRecord;
}
