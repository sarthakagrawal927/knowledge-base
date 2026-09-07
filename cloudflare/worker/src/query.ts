import {
  CORRECTIVE_SEMANTIC_MIN_SCORE,
  DEFAULT_ANSWER_MODEL,
  LEXICAL_SCORING_VERSION,
  MAX_RERANK_CONTEXT_CHARS,
  MAX_TOP_K,
  SEMANTIC_LEXICAL_FAST_PATH_MIN_OVERLAP,
  SEMANTIC_LEXICAL_FAST_PATH_MIN_SCORE,
  STOP_WORDS,
  type AnswerMode,
  type AppContext,
  type CacheStatus,
  type EmbeddingCallOptions,
  type KbAnswerPayload,
  type KbQueryBody,
  type ParseEvalCase,
  type QueryBody,
  type QueryEvalCase,
  type QueryPayload,
  type QueryPlan,
  type QueryPlanVariant,
  type QueryPlanVariantKind,
  type RagTiming,
  type RerankModel,
  type SearchEvalCase,
} from './app-types';
import { analyticsNumber, analyticsString, elapsedMs, jsonRecord, writeAnalyticsPoint } from './app-utils';
import { embedTexts } from './embeddings';
import { freeAiChatRaw, freeAiEmbed, freeAiSynthEnabled, freeAiSynthModel } from './free-ai';
import type { EntityRecord, EntityRelationshipRecord, MetadataRepository, QueryTraceRecord } from './kb-metadata-repository';
import type { ChunkRecord, CitationRecord, Env, JsonRecord, SearchResult } from './types';

export function clampTopK(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value || 5);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_TOP_K);
}

export function sortResultsByVectorOrder(ids: string[], rows: ChunkRecord[]): ChunkRecord[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is ChunkRecord => Boolean(row));
}

export function fuseHybridResults(lexical: QueryPayload | null, semantic: QueryPayload, topK: number): QueryPayload {
  const fused = new Map<
    string,
    SearchResult & {
      lexical_rrf?: number;
      semantic_rrf?: number;
      lexical_score?: number;
      semantic_score?: number;
    }
  >();
  const add = (result: SearchResult, rank: number, source: 'lexical' | 'semantic') => {
    const existing = fused.get(result.chunk_id) ?? {
      ...result,
      score: 0,
      metadata: {
        ...result.metadata,
        hybrid_sources: [],
      },
    };
    const contribution = 1 / (60 + rank + 1);
    existing.score += contribution;
    if (source === 'lexical') {
      existing.lexical_rrf = contribution;
      existing.lexical_score = result.score;
    } else {
      existing.semantic_rrf = contribution;
      existing.semantic_score = result.score;
    }
    const sources = Array.isArray(existing.metadata.hybrid_sources) ? existing.metadata.hybrid_sources : [];
    existing.metadata = {
      ...existing.metadata,
      hybrid_sources: sources.includes(source) ? sources : [...sources, source],
      ...(existing.lexical_score !== undefined ? { lexical_score: existing.lexical_score } : {}),
      ...(existing.semantic_score !== undefined ? { semantic_score: existing.semantic_score } : {}),
    };
    fused.set(result.chunk_id, existing);
  };
  lexical?.data.forEach((result, rank) => add(result, rank, 'lexical'));
  semantic.data.forEach((result, rank) => add(result, rank, 'semantic'));
  return {
    data: [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ lexical_rrf, semantic_rrf, lexical_score, semantic_score, ...result }) => result),
  };
}

function contentTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
}

function sparseTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9-]{2,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) ?? []
  );
}

function stemLexicalToken(token: string): string {
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 6 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function lexicalNgrams(token: string): string[] {
  if (token.length < 6) return [];
  const grams: string[] = [];
  for (let i = 0; i <= token.length - 3; i += 1) {
    const gram = token.slice(i, i + 3);
    if (!STOP_WORDS.has(gram)) grams.push(gram);
  }
  return grams;
}

function lexicalPrefilterTokens(queryTokens: string[]): string[] {
  const out = new Set<string>();
  for (const token of queryTokens) {
    out.add(token);
    out.add(stemLexicalToken(token));
    for (const gram of lexicalNgrams(token)) out.add(gram);
  }
  return [...out].filter((token) => token.length >= 3).slice(0, 32);
}

function boundedEditDistance(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = current[0] ?? 0;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? maxDistance + 1) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      const insertion = (current[j - 1] ?? maxDistance + 1) + 1;
      const deletion = (previous[j] ?? maxDistance + 1) + 1;
      const value = Math.min(substitution, insertion, deletion);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length] ?? maxDistance + 1;
}

function lexicalTokenSimilarity(queryToken: string, chunkToken: string): number {
  if (queryToken === chunkToken) return 1;
  const queryStem = stemLexicalToken(queryToken);
  const chunkStem = stemLexicalToken(chunkToken);
  if (queryStem === chunkStem) return 0.92;
  if (queryToken.length >= 5 && chunkToken.length >= 5 && (queryToken.includes(chunkToken) || chunkToken.includes(queryToken))) return 0.82;
  if (queryToken.length < 5 || chunkToken.length < 5) return 0;
  const maxLength = Math.max(queryToken.length, chunkToken.length);
  const maxDistance = maxLength <= 7 ? 1 : 2;
  const distance = boundedEditDistance(queryToken, chunkToken, maxDistance);
  if (distance > maxDistance) return 0;
  return Math.max(0, 1 - distance / maxLength);
}

function bestLexicalMatch(queryToken: string, counts: Map<string, number>): { token: string; count: number; similarity: number } | null {
  const exact = counts.get(queryToken);
  if (exact) return { token: queryToken, count: exact, similarity: 1 };
  let best: { token: string; count: number; similarity: number } | null = null;
  for (const [token, count] of counts.entries()) {
    const similarity = lexicalTokenSimilarity(queryToken, token);
    if (similarity < 0.72) continue;
    if (!best || similarity > best.similarity || (similarity === best.similarity && count > best.count)) {
      best = { token, count, similarity };
    }
  }
  return best;
}

export function sparseLexicalScore(
  chunks: ChunkRecord[],
  queryTokens: string[],
): Array<{
  chunk: ChunkRecord;
  score: number;
  overlap: number;
  matchedTerms: string[];
}> {
  if (chunks.length === 0 || queryTokens.length === 0) return [];
  const uniqueQueryTokens = Array.from(new Set(queryTokens));
  const chunkTerms = chunks.map((chunk) => {
    const tokens = sparseTokens(chunk.content);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { chunk, tokens, counts };
  });
  const documentFrequency = new Map<string, number>();
  for (const token of uniqueQueryTokens) {
    documentFrequency.set(token, chunkTerms.filter((entry) => bestLexicalMatch(token, entry.counts)).length);
  }
  const averageLength = Math.max(1, chunkTerms.reduce((sum, entry) => sum + entry.tokens.length, 0) / chunkTerms.length);
  const k1 = 1.2;
  const b = 0.75;
  return chunkTerms
    .map((entry) => {
      let score = 0;
      const matchedTerms: string[] = [];
      for (const token of uniqueQueryTokens) {
        const match = bestLexicalMatch(token, entry.counts);
        const tf = match?.count ?? 0;
        if (tf <= 0 || !match) continue;
        matchedTerms.push(match.token === token ? token : `${token}~${match.token}`);
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (chunkTerms.length - df + 0.5) / (df + 0.5));
        const denominator = tf + k1 * (1 - b + b * (entry.tokens.length / averageLength));
        score += idf * ((tf * (k1 + 1)) / denominator) * match.similarity;
      }
      return { chunk: entry.chunk, score, overlap: matchedTerms.length, matchedTerms };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.chunk.chunk_index - b.chunk.chunk_index);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

interface MmrCandidate {
  result: SearchResult;
  tokens: Set<string>;
  score: number;
}

function selectMmrRanked(candidates: MmrCandidate[], topK: number): SearchResult[] {
  const selected: MmrCandidate[] = [];
  const remaining = [...candidates];
  while (remaining.length > 0 && selected.length < topK) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (const [i, candidate] of remaining.entries()) {
      const maxSimilarity = selected.reduce((max, item) => Math.max(max, jaccardSimilarity(candidate.tokens, item.tokens)), 0);
      const mmrScore = 0.82 * candidate.score - 0.18 * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) {
      chosen.result.metadata = {
        ...chosen.result.metadata,
        mmr_score: bestScore,
        mmr_rank: selected.length + 1,
      };
      selected.push(chosen);
    }
  }
  return selected.map((item) => item.result);
}

export function rerankAndDiversifyResults(payload: QueryPayload, query: string, topK: number, useMmr: boolean): QueryPayload {
  if (payload.data.length <= 1) return payload;
  const queryTokens = tokenizeLexicalQuery(query);
  const queryTokenSet = new Set(queryTokens);
  const candidates = payload.data
    .map((result) => {
      const tokens = contentTokens(result.chunk_content);
      let overlap = 0;
      for (const token of queryTokenSet) {
        if (tokens.has(token)) overlap += 1;
      }
      const rerankScore = result.score + (queryTokens.length ? (overlap / queryTokens.length) * 0.08 : 0);
      return {
        result: {
          ...result,
          score: rerankScore,
          metadata: {
            ...result.metadata,
            rerank_score: rerankScore,
            rerank_overlap: overlap,
          } as JsonRecord,
        },
        tokens,
        score: rerankScore,
      };
    })
    .sort((a, b) => b.score - a.score);
  if (!useMmr) return { data: candidates.slice(0, topK).map((item) => item.result) };
  return { data: selectMmrRanked(candidates, topK) };
}

export function diversifyRankedResults(results: SearchResult[], topK: number, useMmr: boolean): QueryPayload {
  if (!useMmr) return { data: results.slice(0, topK) };
  const candidates = results.map((result) => ({ result, tokens: contentTokens(result.chunk_content), score: result.score }));
  return { data: selectMmrRanked(candidates, topK) };
}

export function rerankModelFromBody(body: QueryBody): RerankModel {
  return body.rerank_model === 'workers_ai' ? 'workers_ai' : 'keyword';
}

export function answerModeFromBody(body: KbQueryBody): AnswerMode {
  return body.answer_mode === 'workers_ai' ? 'workers_ai' : 'extractive';
}

export function rerankResponseRows(response: unknown): Array<{ id: number; score: number }> {
  const rows = response && typeof response === 'object' ? (response as { response?: unknown }).response : null;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as { id?: unknown; index?: unknown; score?: unknown };
    const id = typeof item.id === 'number' ? item.id : typeof item.index === 'number' ? item.index : null;
    const score = typeof item.score === 'number' ? item.score : null;
    return id === null || score === null ? [] : [{ id, score }];
  });
}

export function tokenizeLexicalQuery(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g);
  if (!tokens) return [];
  return Array.from(new Set(tokens.filter((token) => !STOP_WORDS.has(token)))).slice(0, 8);
}

export function normalizeSemanticQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

function compactQueryVariant(value: string): string {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:please|show|find|tell me|list|give me|what|which|where|when|who|how|does|do|did|are|is|was|were|the|a|an)\b/gi, ' ')
    .replace(/\b(?:document|documents|docs|file|files|corpus|domain|about|mention|mentions|mentioned|discuss|discusses|documented)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9_\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function variantTokenCount(value: string): number {
  return tokenizeLexicalQuery(value).length;
}

function pushQueryVariant(variants: QueryPlanVariant[], seen: Set<string>, query: string, kind: QueryPlanVariantKind): void {
  const normalized = normalizeSemanticQuery(query);
  if (!normalized || seen.has(normalized) || variantTokenCount(normalized) === 0) return;
  variants.push({ query: normalized, kind });
  seen.add(normalized);
}

export function buildQueryPlan(query: string, body: QueryBody): QueryPlan {
  const variants: QueryPlanVariant[] = [];
  const seen = new Set([normalizeSemanticQuery(query)]);
  if (body.query_rewrite !== false) {
    const rewritten = compactQueryVariant(query);
    if (variantTokenCount(rewritten) >= 2) pushQueryVariant(variants, seen, rewritten, 'rewrite');
  }
  if (body.query_decompose !== false && /\b(?:and|or|versus|vs|compare|compared)\b|[;?]/i.test(query)) {
    const parts = query
      .split(/\b(?:and|or|versus|vs|compare(?:d)?(?:\s+to)?)\b|[;?]/i)
      .map(compactQueryVariant)
      .filter((part) => variantTokenCount(part) > 0);
    for (const part of parts) {
      pushQueryVariant(variants, seen, part, 'decompose');
      if (variants.length >= 4) break;
    }
  }
  return { variants: variants.slice(0, 4) };
}

export function fuseQueryPlanResults(
  entries: Array<{ query: string; kind: 'original' | QueryPlanVariantKind; payload: QueryPayload | null }>,
  topK: number,
): QueryPayload {
  const fused = new Map<
    string,
    SearchResult & {
      query_plan_sources?: string[];
      query_plan_score?: number;
    }
  >();
  for (const entry of entries) {
    entry.payload?.data.forEach((result, rank) => {
      const source = entry.kind === 'original' ? 'original' : `${entry.kind}:${entry.query}`;
      const contribution = result.score + 1 / (80 + rank + 1);
      const existing = fused.get(result.chunk_id) ?? {
        ...result,
        score: 0,
        metadata: { ...result.metadata },
        query_plan_sources: [],
        query_plan_score: 0,
      };
      existing.score += contribution;
      existing.query_plan_score = (existing.query_plan_score ?? 0) + contribution;
      const sources = existing.query_plan_sources ?? [];
      existing.query_plan_sources = sources.includes(source) ? sources : [...sources, source];
      existing.metadata = {
        ...existing.metadata,
        query_plan_sources: existing.query_plan_sources,
        query_plan_score: existing.query_plan_score,
      };
      fused.set(result.chunk_id, existing);
    });
  }
  return {
    data: [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ query_plan_sources, query_plan_score, ...result }) => result),
  };
}

export const DEFAULT_EVAL_JUDGE_MODEL = DEFAULT_ANSWER_MODEL;

export function evalMatch(result: SearchResult, testCase: SearchEvalCase): boolean {
  if (testCase.expected_chunk_ids?.includes(result.chunk_id)) return true;
  if (testCase.expected_document_ids?.includes(result.document_id)) return true;
  const expectedText = testCase.expected_text?.trim().toLowerCase();
  if (expectedText && result.chunk_content.toLowerCase().includes(expectedText)) return true;
  return false;
}

export function queryEvalHit(payload: KbAnswerPayload, testCase: QueryEvalCase): boolean {
  const expectedText = (testCase.expected_answer_text ?? testCase.expected_citation_text ?? testCase.expected_text ?? '').trim().toLowerCase();
  const hasExpectedIds = Boolean(testCase.expected_chunk_ids?.length || testCase.expected_document_ids?.length);
  if (hasExpectedIds && payload.data.some((result) => evalMatch(result, testCase))) return true;
  if (!expectedText) return hasExpectedIds ? false : payload.data.length > 0;
  const evidenceText = [payload.answer, ...payload.citations.map((citation) => citation.excerpt), ...payload.data.map((item) => item.chunk_content)]
    .join('\n')
    .toLowerCase();
  return evidenceText.includes(expectedText);
}

export function parseEvalCaseBytes(testCase: ParseEvalCase): ArrayBuffer {
  function copyBytes(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  }
  if (typeof testCase.content_base64 === 'string' && testCase.content_base64.trim()) {
    const binary = atob(testCase.content_base64.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return copyBytes(bytes);
  }
  const bytes = new TextEncoder().encode(testCase.content ?? '');
  return copyBytes(bytes);
}

export function expectedTextList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return value?.trim() ? [value.trim()] : [];
}

export function visionOcrModelChain(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function normalizeEvalText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function evalTextTokens(value: string): string[] {
  return normalizeEvalText(value).match(/[a-z0-9]{2,}/g) ?? [];
}

function parseEvalItemMatched(parsedText: string, expected: string): boolean {
  if (normalizeEvalText(parsedText).includes(normalizeEvalText(expected))) return true;
  const haystack = new Set(evalTextTokens(parsedText));
  const expectedTokens = [...new Set(evalTextTokens(expected))];
  if (expectedTokens.length < 3) return false;
  const matchedTokens = expectedTokens.filter((token) => haystack.has(token)).length;
  return matchedTokens / expectedTokens.length >= 0.6;
}

export function parseEvalMatch(parsedText: string, expected: string[]): { matched: string[]; missing: string[] } {
  const matched = expected.filter((item) => parseEvalItemMatched(parsedText, item));
  return {
    matched,
    missing: expected.filter((item) => !matched.includes(item)),
  };
}

function traceRoute(trace: QueryTraceRecord): string {
  const confidenceRoute = trace.confidence?.route;
  if (typeof confidenceRoute === 'string') return confidenceRoute;
  const filterRoute = trace.filters?.route;
  if (typeof filterRoute === 'string') return filterRoute;
  return 'unknown';
}

function traceChunkIds(trace: QueryTraceRecord): string[] {
  return trace.retrieved.map((result) => result.chunk_id).filter(Boolean);
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}

function qualityTokens(text: string | null | undefined): string[] {
  const tokens = (text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g);
  if (!tokens) return [];
  return Array.from(new Set(tokens.filter((token) => !STOP_WORDS.has(token))));
}

function roundedRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function answerSupportQuality(answer: string | null | undefined, citations: CitationRecord[], retrieved: SearchResult[]): JsonRecord {
  const answerTokens = qualityTokens(answer);
  const evidenceText = [...citations.map((citation) => citation.excerpt), ...retrieved.map((result) => result.chunk_content)].join('\n');
  const evidenceTokens = new Set(qualityTokens(evidenceText));
  const supportedTokens = answerTokens.filter((token) => evidenceTokens.has(token));
  const unsupportedTokens = answerTokens.filter((token) => !evidenceTokens.has(token));
  const citationRows = citations.map((citation) => {
    const citationTokens = new Set(qualityTokens(citation.excerpt));
    const overlap = answerTokens.filter((token) => citationTokens.has(token));
    return {
      index: citation.index,
      chunk_id: citation.chunk_id,
      document_id: citation.document_id,
      filename: citation.filename,
      page_start: citation.page_start,
      page_end: citation.page_end,
      score: citation.score,
      excerpt_length: citation.excerpt.length,
      answer_token_overlap_count: overlap.length,
      answer_token_overlap_ratio: roundedRatio(overlap.length, answerTokens.length),
      overlapping_answer_tokens: overlap,
      excerpt: citation.excerpt,
    };
  });
  const coverage = roundedRatio(supportedTokens.length, answerTokens.length);
  const status =
    !answer || answerTokens.length === 0
      ? 'no_answer'
      : citations.length === 0
        ? 'no_citations'
        : (coverage ?? 0) >= 0.65
          ? 'supported'
          : (coverage ?? 0) >= 0.35
            ? 'partial'
            : 'weak';
  return {
    status,
    answer_token_count: answerTokens.length,
    supported_answer_token_count: supportedTokens.length,
    unsupported_answer_token_count: unsupportedTokens.length,
    citation_coverage: coverage,
    citation_count: citations.length,
    retrieved_count: retrieved.length,
    supported_answer_tokens: supportedTokens,
    unsupported_answer_tokens: unsupportedTokens,
    citations: citationRows,
  };
}

function confidenceWithVerification(confidence: JsonRecord, quality: JsonRecord): JsonRecord {
  const coverage = typeof quality.citation_coverage === 'number' ? quality.citation_coverage : null;
  const status = typeof quality.status === 'string' ? quality.status : 'unknown';
  const currentLevel = typeof confidence.level === 'string' ? confidence.level : 'low';
  const verifiedLevel =
    status === 'supported'
      ? currentLevel
      : status === 'partial'
        ? currentLevel === 'high'
          ? 'medium'
          : currentLevel
        : status === 'no_answer' || status === 'no_citations'
          ? 'none'
          : 'low';
  return {
    ...confidence,
    level: verifiedLevel,
    verification_status: status,
    verification_checked: true,
    verification_method: 'deterministic_answer_evidence_token_overlap',
    citation_coverage: coverage,
    supported_answer_token_count: quality.supported_answer_token_count,
    unsupported_answer_token_count: quality.unsupported_answer_token_count,
    unsupported_answer_tokens: quality.unsupported_answer_tokens,
    calibration: `${String(confidence.calibration ?? 'retrieval_score')}_with_deterministic_evidence_verification`,
  };
}

export function answerQualityDrilldown(trace: QueryTraceRecord): JsonRecord {
  return {
    route: traceRoute(trace),
    latency_ms: trace.latency_ms,
    ...answerSupportQuality(trace.answer, trace.citations, trace.retrieved),
  };
}

function aiTextResponse(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const record = response as JsonRecord;
  if (typeof record.response === 'string') return record.response;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.text === 'string') return record.text;
  return JSON.stringify(response);
}

// Embedding provider seam: route through the free-ai gateway when configured,
// otherwise use Cloudflare Workers AI. Matches the embedTexts signature so it
// drops into the createApp `embed` dependency.
export function defaultEmbed(env: Env, texts: string[], options: EmbeddingCallOptions = {}): Promise<number[][]> {
  return env.RAG_EMBED_PROVIDER === 'free_ai' ? freeAiEmbed(env, texts, options) : embedTexts(env, texts, options);
}

// Chat/synthesis provider seam: free-ai gateway or Workers AI. Both return a
// response shape aiTextResponse() understands.
async function runAiChat(
  env: Env,
  model: string,
  body: {
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
    response_format?: unknown;
  },
): Promise<unknown> {
  if (freeAiSynthEnabled(env)) {
    return freeAiChatRaw(env, model, body);
  }
  return env.AI.run(model, body as unknown as JsonRecord);
}

function parseJudgeJson(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
    } catch {
      return null;
    }
  }
}

function boundedEvidenceText(citations: CitationRecord[], retrieved: SearchResult[]): string {
  const citationText = citations
    .slice(0, 5)
    .map((citation) => `[${citation.index}] ${citation.excerpt}`)
    .join('\n');
  const retrievedText = retrieved
    .slice(0, 5)
    .map((item, i) => `retrieved-${i + 1}: ${item.chunk_content}`)
    .join('\n');
  return `${citationText}\n${retrievedText}`.trim().slice(0, 6000);
}

function parseAnswerText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const parsed = parseJudgeJson(trimmed);
  const answer = parsed?.answer ?? parsed?.response ?? parsed?.text;
  return typeof answer === 'string' ? answer.trim() : trimmed;
}

async function synthesizeAnswerWithAi(input: {
  env: Env;
  question: string;
  citations: CitationRecord[];
  retrieved: SearchResult[];
  model?: string | undefined;
}): Promise<{ answer: string; model: string }> {
  const model = freeAiSynthEnabled(input.env) ? freeAiSynthModel(input.env) : input.model?.trim() || input.env.RAG_ANSWER_MODEL?.trim() || DEFAULT_ANSWER_MODEL;
  const evidence = boundedEvidenceText(input.citations, input.retrieved);
  const response = await runAiChat(input.env, model, {
    messages: [
      {
        role: 'system',
        content: [
          'You answer questions using only the cited evidence provided by a retrieval system.',
          'Every factual claim must include bracket citations like [1] that match the evidence numbers.',
          'If the evidence is insufficient, say that the answer is not available from the provided domain evidence.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question: input.question,
          evidence,
          instructions: ['Return a concise answer.', 'Use only citation ids present in the evidence.', 'Do not mention evidence ids that are not provided.'],
        }),
      },
    ],
    max_tokens: 512,
    temperature: 0.1,
  });
  return { answer: parseAnswerText(aiTextResponse(response)).slice(0, 4000), model };
}

export async function answerFromEvidence(input: {
  env: Env;
  question: string;
  citations: CitationRecord[];
  retrieved: SearchResult[];
  extractiveAnswer: string;
  baseConfidence: JsonRecord;
  requestedMode: AnswerMode;
  requestedModel?: string | undefined;
}): Promise<{
  answer: string;
  confidence: JsonRecord;
  answerMode: AnswerMode;
  answerModel: string | null;
  aiUsed: boolean;
  timing: RagTiming;
}> {
  let answer = input.extractiveAnswer;
  let answerMode: AnswerMode = 'extractive';
  let answerModel: string | null = null;
  let aiUsed = false;
  const timing: RagTiming = {
    answer_requested_mode: input.requestedMode,
    answer_mode: 'extractive',
  };
  if (input.requestedMode === 'workers_ai') {
    const synthesisStarted = performance.now();
    try {
      const synthesized = await synthesizeAnswerWithAi({
        env: input.env,
        question: input.question,
        citations: input.citations,
        retrieved: input.retrieved,
        model: input.requestedModel,
      });
      timing.synthesis_ms = elapsedMs(synthesisStarted);
      timing.synthesis_model = synthesized.model;
      if (synthesized.answer && /\[\d+\]/.test(synthesized.answer)) {
        answer = synthesized.answer;
        answerMode = 'workers_ai';
        answerModel = synthesized.model;
        aiUsed = true;
        timing.answer_mode = 'workers_ai';
      } else {
        timing.synthesis_fallback = 'empty_or_uncited_response';
      }
    } catch (error) {
      timing.synthesis_ms = elapsedMs(synthesisStarted);
      timing.synthesis_fallback = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
    }
  }
  return {
    answer,
    confidence: confidenceWithVerification(input.baseConfidence, answerSupportQuality(answer, input.citations, input.retrieved)),
    answerMode,
    answerModel,
    aiUsed,
    timing,
  };
}

export async function judgeAnswerWithAi(input: {
  env: Env;
  question: string;
  expectedText: string;
  answer: string;
  citations: CitationRecord[];
  retrieved: SearchResult[];
  model?: string;
}): Promise<JsonRecord> {
  const model = freeAiSynthEnabled(input.env) ? freeAiSynthModel(input.env) : input.model?.trim() || DEFAULT_EVAL_JUDGE_MODEL;
  const evidence = boundedEvidenceText(input.citations, input.retrieved);
  const response = await runAiChat(input.env, model, {
    messages: [
      {
        role: 'system',
        content: [
          'You judge retrieval-augmented answers for answer-in-source support.',
          'Return only JSON. Do not reward correct-looking claims unless they are supported by the provided evidence.',
          'Use status "supported", "partial", or "unsupported".',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question: input.question,
          expected_text: input.expectedText || null,
          answer: input.answer,
          evidence,
          rubric: {
            supported: 'The answer directly follows from the cited/retrieved evidence.',
            partial: 'The answer is partly supported but misses or adds material claims.',
            unsupported: 'The answer is absent, contradicted, or materially unsupported by evidence.',
          },
        }),
      },
    ],
    max_tokens: 256,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['supported', 'partial', 'unsupported'] },
          score: { type: 'number' },
          rationale: { type: 'string' },
        },
        required: ['status', 'score', 'rationale'],
      },
    },
  });
  const parsed = parseJudgeJson(aiTextResponse(response));
  const status = typeof parsed?.status === 'string' && ['supported', 'partial', 'unsupported'].includes(parsed.status) ? parsed.status : 'unsupported';
  const score = typeof parsed?.score === 'number' ? Math.min(1, Math.max(0, parsed.score)) : status === 'supported' ? 1 : status === 'partial' ? 0.5 : 0;
  return {
    model_judged: true,
    model_judge_model: model,
    model_judge_status: status,
    model_judge_score: Math.round(score * 1000) / 1000,
    model_judge_rationale: typeof parsed?.rationale === 'string' ? parsed.rationale.slice(0, 500) : '',
  };
}

export function traceExportSummary(traces: QueryTraceRecord[]): JsonRecord {
  const route_counts: Record<string, number> = {};
  let latencyTotal = 0;
  let latencyCount = 0;
  for (const trace of traces) {
    const route = traceRoute(trace);
    route_counts[route] = (route_counts[route] ?? 0) + 1;
    if (typeof trace.latency_ms === 'number') {
      latencyTotal += trace.latency_ms;
      latencyCount += 1;
    }
  }
  return {
    trace_count: traces.length,
    route_counts,
    avg_latency_ms: latencyCount ? Math.round((latencyTotal / latencyCount) * 100) / 100 : null,
    citation_count: traces.reduce((sum, trace) => sum + trace.citations.length, 0),
  };
}

export function compareTraces(baseline: QueryTraceRecord, candidate: QueryTraceRecord): JsonRecord {
  const baselineIds = traceChunkIds(baseline);
  const candidateIds = traceChunkIds(candidate);
  const retrievedOverlap = overlapCount(baselineIds, candidateIds);
  const baselineCitationIds = baseline.citations.map((citation) => citation.chunk_id).filter(Boolean);
  const candidateCitationIds = candidate.citations.map((citation) => citation.chunk_id).filter(Boolean);
  const citationOverlap = overlapCount(baselineCitationIds, candidateCitationIds);
  return {
    baseline_trace_id: baseline.id,
    candidate_trace_id: candidate.id,
    same_question: baseline.question === candidate.question,
    same_answer: baseline.answer === candidate.answer,
    route: {
      baseline: traceRoute(baseline),
      candidate: traceRoute(candidate),
      changed: traceRoute(baseline) !== traceRoute(candidate),
    },
    latency_delta_ms: typeof baseline.latency_ms === 'number' && typeof candidate.latency_ms === 'number' ? candidate.latency_ms - baseline.latency_ms : null,
    retrieved: {
      baseline_count: baselineIds.length,
      candidate_count: candidateIds.length,
      overlap_count: retrievedOverlap,
      overlap_ratio: baselineIds.length ? retrievedOverlap / baselineIds.length : null,
      added_chunk_ids: candidateIds.filter((id) => !baselineIds.includes(id)),
      removed_chunk_ids: baselineIds.filter((id) => !candidateIds.includes(id)),
    },
    citations: {
      baseline_count: baselineCitationIds.length,
      candidate_count: candidateCitationIds.length,
      overlap_count: citationOverlap,
      overlap_ratio: baselineCitationIds.length ? citationOverlap / baselineCitationIds.length : null,
    },
    answer_lengths: {
      baseline: baseline.answer?.length ?? 0,
      candidate: candidate.answer?.length ?? 0,
    },
  };
}

function oneLineExcerpt(text: string, maxLength = 420): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function numberMetadata(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function stringMetadata(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sentenceSpans(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((span) => span.trim())
    .filter(Boolean);
}

function bestEvidenceSpan(
  text: string,
  question: string | undefined,
  maxLength = 420,
): {
  excerpt: string;
  terms: string[];
} {
  const spans = sentenceSpans(text);
  const queryTokens = qualityTokens(question);
  if (spans.length === 0) return { excerpt: '', terms: [] };
  if (queryTokens.length === 0) return { excerpt: oneLineExcerpt(spans.join(' '), maxLength), terms: [] };
  const querySet = new Set(queryTokens);
  let best = spans[0] ?? '';
  let bestTerms: string[] = [];
  let bestScore = -1;
  for (const span of spans) {
    const spanTokens = qualityTokens(span);
    const terms = Array.from(new Set(spanTokens.filter((token) => querySet.has(token))));
    const score = terms.length * 10 + Math.min(span.length, maxLength) / maxLength;
    if (score > bestScore) {
      best = span;
      bestTerms = terms;
      bestScore = score;
    }
  }
  if (bestTerms.length === 0) return { excerpt: oneLineExcerpt(spans.join(' '), maxLength), terms: [] };
  return { excerpt: oneLineExcerpt(best, maxLength), terms: bestTerms };
}

export function citationsFromResults(results: SearchResult[], question?: string, limit = 5): CitationRecord[] {
  return results.slice(0, limit).map((result, i) => {
    const pageStart = numberMetadata(result.metadata.page_start ?? result.metadata.page, 1);
    const pageEnd = numberMetadata(result.metadata.page_end ?? result.metadata.page, pageStart);
    const span = bestEvidenceSpan(result.chunk_content, question);
    return {
      index: i + 1,
      document_id: result.document_id,
      chunk_id: result.chunk_id,
      file_id: stringMetadata(result.metadata.file_id),
      filename: stringMetadata(result.metadata.filename ?? result.metadata.source),
      page_start: pageStart,
      page_end: Math.max(pageStart, pageEnd),
      excerpt: span.excerpt || oneLineExcerpt(result.chunk_content),
      span_terms: span.terms,
      score: result.score,
      metadata: {
        ...result.metadata,
        citation_span_terms: span.terms,
        citation_span_strategy: question ? 'question_token_sentence' : 'first_excerpt',
      },
    };
  });
}

export function answerFromCitations(question: string, citations: CitationRecord[]): string {
  if (citations.length === 0) {
    return `I cannot answer "${question}" from this domain with citations.`;
  }
  const strongest = citations.slice(0, 3).map((citation) => {
    return `${citation.excerpt} [${citation.index}]`;
  });
  return strongest.join(' ');
}

export function confidenceFromResults(results: SearchResult[]): JsonRecord {
  const topScore = results[0]?.score ?? 0;
  return {
    level: results.length === 0 ? 'none' : topScore >= 0.75 ? 'high' : topScore >= 0.45 ? 'medium' : 'low',
    top_score: topScore,
    result_count: results.length,
    calibration: 'retrieval_score_not_answer_truth',
  };
}

export function weakSemanticReason(payload: QueryPayload): string | null {
  const topScore = payload.data[0]?.score ?? null;
  if (payload.data.length === 0) return 'semantic_empty';
  if (topScore !== null && topScore < CORRECTIVE_SEMANTIC_MIN_SCORE) return 'semantic_low_score';
  return null;
}

export function strongLexicalFastPath(payload: QueryPayload | null): boolean {
  const top = payload?.data[0];
  if (!top) return false;
  const overlap = typeof top.metadata?.lexical_overlap === 'number' ? top.metadata.lexical_overlap : 0;
  return top.score >= SEMANTIC_LEXICAL_FAST_PATH_MIN_SCORE && overlap >= SEMANTIC_LEXICAL_FAST_PATH_MIN_OVERLAP;
}

export function searchResultFromEntity(entity: EntityRecord, score: number, route = 'd1_entities', extraMetadata: JsonRecord = {}): SearchResult {
  const content = entity.evidence_text || JSON.stringify(entity.fields, null, 2);
  return {
    document_id: entity.id,
    chunk_id: entity.evidence_chunk_id || entity.id,
    chunk_content: content,
    score,
    metadata: {
      route,
      ...(entity.file_id ? { file_id: entity.file_id, file_generation: entity.file_generation, filename: entity.filename, page_start: 1, page_end: 1 } : {}),
      entity_id: entity.id,
      entity_type: entity.type,
      identity_key: entity.identity_key,
      display_name: entity.display_name,
      fields: entity.fields,
      ...extraMetadata,
    },
  };
}

function normalizeStructuredFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function entityFieldValue(entity: EntityRecord, normalizedField: string): unknown {
  for (const [field, value] of Object.entries(entity.fields)) {
    if (normalizeStructuredFieldName(field) === normalizedField) return value;
  }
  return undefined;
}

function fieldMatches(value: unknown, expected: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  if (!normalizedExpected) return false;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase() === normalizedExpected;
  const actual = String(value).trim().toLowerCase();
  return actual === normalizedExpected || actual.includes(normalizedExpected);
}

function parseStructuredFieldFilters(question: string): Array<{ field: string; normalized_field: string; value: string }> {
  const filters: Array<{ field: string; normalized_field: string; value: string }> = [];
  const pattern =
    /\b([a-zA-Z_][a-zA-Z0-9_ -]{1,40})\s*(?::|=|\bis\b|\bequals\b)\s*["']?([^"',?;\n]+?)["']?(?=\s+(?:and|or)\s+[a-zA-Z_][a-zA-Z0-9_ -]{1,40}\s*(?::|=|\bis\b|\bequals\b)|[?;,\n]|$)/gi;
  for (const match of question.matchAll(pattern)) {
    const field = (match[1] ?? '').trim();
    const value = (match[2] ?? '').trim();
    const normalizedField = normalizeStructuredFieldName(field);
    if (!field || !value || STOP_WORDS.has(field.toLowerCase())) continue;
    filters.push({ field, normalized_field: normalizedField, value });
  }
  return filters;
}

export async function structuredFieldQueryResults(
  repo: MetadataRepository,
  tenant: string,
  domain: string,
  question: string,
  limit: number,
): Promise<{ filters: JsonRecord[]; entities: EntityRecord[] }> {
  const filters = parseStructuredFieldFilters(question);
  if (filters.length === 0) return { filters: [], entities: [] };
  const entities = await repo.listEntities(tenant, domain, undefined, 500);
  const matches = entities
    .filter((entity) => filters.every((filter) => fieldMatches(entityFieldValue(entity, filter.normalized_field), filter.value)))
    .slice(0, limit);
  if (matches.length === 0) return { filters: [], entities: [] };
  return {
    filters: filters.map((filter) => ({ field: filter.field, normalized_field: filter.normalized_field, value: filter.value })),
    entities: matches,
  };
}

function searchResultFromRelationship(relationship: EntityRelationshipRecord, entitiesById: Map<string, EntityRecord>, score: number): SearchResult {
  const source = entitiesById.get(relationship.src_id);
  const target = entitiesById.get(relationship.dst_id);
  const sourceLabel = source?.display_name ?? source?.identity_key ?? relationship.src_id;
  const targetLabel = target?.display_name ?? target?.identity_key ?? relationship.dst_id;
  const content = `${sourceLabel} ${relationship.rel_type} ${targetLabel}`;
  return {
    document_id: relationship.id,
    chunk_id: relationship.id,
    chunk_content: content,
    score,
    metadata: {
      route: 'd1_graph',
      relationship_id: relationship.id,
      relationship_type: relationship.rel_type,
      source_entity_id: relationship.src_id,
      target_entity_id: relationship.dst_id,
      source_identity_key: source?.identity_key ?? null,
      target_identity_key: target?.identity_key ?? null,
      source_display_name: source?.display_name ?? null,
      target_display_name: target?.display_name ?? null,
      evidence_file: relationship.evidence_file,
      evidence_page: relationship.evidence_page,
    },
  };
}

export async function graphResultsForEntities(
  repo: MetadataRepository,
  tenant: string,
  domain: string,
  entities: EntityRecord[],
  limit = 8,
): Promise<SearchResult[]> {
  const relationships: EntityRelationshipRecord[] = [];
  for (const entity of entities.slice(0, 5)) {
    relationships.push(...(await repo.listRelationships(tenant, domain, undefined, entity.id, limit)));
  }
  const unique = new Map<string, EntityRelationshipRecord>();
  for (const relationship of relationships) {
    if (!unique.has(relationship.id)) unique.set(relationship.id, relationship);
  }
  const entityIds = new Set<string>();
  for (const relationship of unique.values()) {
    entityIds.add(relationship.src_id);
    entityIds.add(relationship.dst_id);
  }
  const knownEntities = new Map(entities.map((entity) => [entity.id, entity]));
  if (entityIds.size > knownEntities.size) {
    const allDomainEntities = await repo.listEntities(tenant, domain, undefined, 500);
    for (const entity of allDomainEntities) {
      if (entityIds.has(entity.id)) knownEntities.set(entity.id, entity);
    }
  }
  return [...unique.values()].slice(0, limit).map((relationship, i) => searchResultFromRelationship(relationship, knownEntities, 0.9 / (i + 1)));
}

export function answerFromStructuredEntities(question: string, citations: CitationRecord[]): string {
  if (citations.length === 0) {
    return `I cannot answer "${question}" from structured entities in this domain.`;
  }
  const strongest = citations.slice(0, 3).map((citation) => {
    const label = stringMetadata(citation.metadata.display_name) ?? stringMetadata(citation.metadata.identity_key) ?? citation.document_id;
    return `${label}: ${citation.excerpt} [${citation.index}]`;
  });
  return strongest.join(' ');
}

export function kbIndexExternalId(domain: string): string {
  return `kb:${domain}`;
}

export function contextWithIndex(c: AppContext, indexId: string): AppContext {
  return {
    ...c,
    req: {
      ...c.req,
      param: (name: string) => (name === 'id' ? indexId : c.req.param(name)),
    },
  } as AppContext;
}

export function isQueryPayload(value: unknown): value is QueryPayload {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as QueryPayload).data));
}

export function withTimingHeaders(timing: RagTiming, cache: CacheStatus, started: number): Record<string, string> {
  timing.cache = cache;
  timing.total_ms = elapsedMs(started);
  const serverTiming = Object.entries(timing)
    .filter((entry): entry is [string, number] => entry[0].endsWith('_ms') && typeof entry[1] === 'number')
    .map(([key, value]) => `rag_${key.slice(0, -3)};dur=${value}`)
    .join(', ');
  return {
    'X-RAG-Cache': cache,
    'X-RAG-Timing': JSON.stringify(timing),
    'Server-Timing': serverTiming,
  };
}

export function sseEvent(event: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

export function timingStages(timing: RagTiming, payload: KbAnswerPayload): JsonRecord[] {
  const stages: JsonRecord[] = [];
  for (const [key, value] of Object.entries(timing)) {
    if (!key.endsWith('_ms') || key === 'total_ms' || typeof value !== 'number') continue;
    stages.push({
      stage: key.slice(0, -3),
      latency_ms: value,
      route: payload.route,
    });
  }
  if (stages.length === 0) {
    stages.push({
      stage: 'answer',
      route: payload.route,
      result_count: payload.data.length,
    });
  }
  return stages;
}

export function confidenceWithTiming(confidence: JsonRecord, timing: RagTiming, payload: KbAnswerPayload): JsonRecord {
  return {
    ...confidence,
    timing,
    timing_stages: timingStages(timing, payload),
    empty_result_diagnostics: {
      result_count: payload.data.length,
      citation_count: payload.citations.length,
      answer_present: Boolean(payload.answer?.trim()),
      status: payload.data.length === 0 ? 'empty_results' : 'has_results',
    },
  };
}

export function writeTraceAnalytics(env: Env, trace: QueryTraceRecord): void {
  const confidence = jsonRecord(trace.confidence);
  writeAnalyticsPoint(env, {
    indexes: [trace.project],
    blobs: [
      'query_trace',
      analyticsString(trace.project),
      analyticsString(trace.domain),
      analyticsString(traceRoute(trace)),
      analyticsString(confidence.verification_status ?? 'unknown'),
    ],
    doubles: [
      analyticsNumber(trace.latency_ms),
      trace.retrieved.length,
      trace.citations.length,
      analyticsNumber(confidence.citation_coverage),
      analyticsNumber(confidence.unsupported_answer_token_count),
    ],
  });
}
