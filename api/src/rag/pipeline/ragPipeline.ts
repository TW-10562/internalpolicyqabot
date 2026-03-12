import { resolveRetrievalIndexLanguage, RetrievalIndexLanguage } from '@/service/languageRouting';
import { detectRagLanguage, hasJapaneseChars } from '@/rag/language/detectLanguage';
import { buildContextFromDocs, ContextSource } from '@/rag/context/contextBuilder';
import {
  buildEnterpriseRagSystemPrompt,
  generationFailureReply,
  noEvidenceReply,
} from '@/rag/generation/promptBuilder';
import { consumeLlmTtftMs, generateEvidenceFirstGroundedAnswer } from '@/rag/generation/llmGenerator';
import {
  countDocTermHits,
  extractJapaneseKeywordTerms,
  extractQueryTermsForRerank,
  rerankDocuments as rerankDocumentsDefault,
} from '@/rag/retrieval/reranker';
import { rerankDocuments as llmRerankDocuments } from '@/rag/retrieval/llmReranker';
import { evaluateRerankPolicy } from '@/rag/retrieval/rerankPolicy';
import { retrieveDocumentsWithSolr } from '@/rag/retrieval/solrRetriever';
import { expandQuery } from '@/rag/query/expandQuery';
import { evaluateEarlyExit, routeQuery } from '@/rag/query/queryRouter';
import { recordRagMetricEvent } from '@/rag/metrics/ragMetrics';
import { recordRagDecision } from '@/rag/metrics/ragDecisionMetrics';
import {
  buildResponseCacheKey,
  getCachedResponse,
  setCachedResponse,
} from '@/rag/cache/responseCache';

export type RunRagPipelineInput = {
  query: string;
  prompt: string;
  retrievalIndexLanguage?: RetrievalIndexLanguage | string;
  outputId?: number;
  historyMessages?: any[];
  chatMaxPredict?: number;
  retrievalOptions?: {
    restrictToDepartment?: boolean;
    departmentCode?: string;
    fileScopeIds?: string[];
    metadataFilters?: Record<string, any>;
    ragBackendUrl?: string;
    ragBackendCollectionName?: string;
    solrTimeoutMs?: number;
    ragBackendTimeoutMs?: number;
    solrRows?: number;
    maxSolrCalls?: number;
    relevanceMinScore?: number;
  };
  contextOptions?: {
    maxChunks?: number;
    contextBudgetChars?: number;
    docContextChars?: number;
  };
  logger?: (line: string) => void;
  retrieveDocuments?: (args: {
    queryForRAG: string;
    multilingualRetrievalQueries: string[];
    userLanguage: 'ja' | 'en';
    retrievalIndexLanguage: RetrievalIndexLanguage;
  }) => Promise<any[]> | Promise<{
    docs: any[];
    retrievalQueryUsed?: string;
    attemptedQueries?: string[];
    queryTranslationApplied?: boolean;
    translatedQuery?: string;
    topScore?: number;
    topTermHits?: number;
    solrCallsCount?: number;
    translateCallsCount?: number;
    translateMs?: number;
    usedSemanticFallback?: boolean;
  }>;
  rerankDocuments?: (args: {
    docs: any[];
    retrievalQueryUsed: string;
  }) => Promise<any[]> | any[];
  buildContext?: (args: {
    docs: any[];
    retrievalQueryUsed: string;
  }) => Promise<{ prompt: string; sources: ContextSource[] }> | { prompt: string; sources: ContextSource[] };
  generateAnswer?: (args: {
    prompt: string;
    userLanguage: 'ja' | 'en';
    hasRetrievedContext: boolean;
    systemPrompt: string;
  }) => Promise<string>;
  buildFastAnswer?: (args: {
    docs: any[];
    retrievalQueryUsed: string;
    userLanguage: 'ja' | 'en';
    queryForRAG: string;
    originalQuery: string;
  }) =>
    | Promise<{ answer: string; sources?: ContextSource[] } | null>
    | { answer: string; sources?: ContextSource[] }
    | null;
};

export type RunRagPipelineResult = {
  userLanguage: 'ja' | 'en';
  retrievalIndexLanguage: RetrievalIndexLanguage;
  normalizedQuery: string;
  queryForRAG: string;
  multilingualRetrievalQueries: string[];
  intentVariants: string[];
  queryTranslationApplied: boolean;
  translateCallsCount: number;
  queryTranslationMs: number;
  retrievalQueryUsed: string;
  docs: any[];
  prompt: string;
  answer: string;
  sources: ContextSource[];
  metrics: {
    documentCount: number;
    promptLength: number;
    retrievalMs: number;
    llmMs: number;
    topScore: number;
    topTermHits: number;
    retrievalConfidence: number;
    confidenceLevel: 'high' | 'medium' | 'low';
    usedSemanticFallback: boolean;
    solrCallsCount: number;
  };
};

type PipelineMode =
  | 'FAST_EXTRACTIVE'
  | 'LLM_GENERATION'
  | 'CACHE_HIT'
  | 'BLOCKED_NO_EVIDENCE';

type CachedPipelineResponse = {
  userLanguage: 'ja' | 'en';
  retrievalIndexLanguage: RetrievalIndexLanguage;
  normalizedQuery: string;
  queryForRAG: string;
  multilingualRetrievalQueries: string[];
  intentVariants: string[];
  queryTranslationApplied: boolean;
  translateCallsCount: number;
  queryTranslationMs: number;
  retrievalQueryUsed: string;
  prompt: string;
  answer: string;
  sources: ContextSource[];
  metrics: RunRagPipelineResult['metrics'];
};

const RESPONSE_CACHE_ENABLED = String(process.env.RAG_RESPONSE_CACHE_ENABLED || '1') !== '0';
const RESPONSE_CACHE_FINGERPRINT_MAX_IDS = Math.max(
  8,
  Number(process.env.RAG_RESPONSE_CACHE_FINGERPRINT_MAX_IDS || 64),
);
const RESPONSE_CACHE_INDEX_VERSION = String(
  process.env.RAG_INDEX_VERSION ||
  process.env.SOLR_INDEX_VERSION ||
  '',
).trim();
const FAST_EXTRACTIVE_MODE_ENABLED = String(process.env.FAST_EXTRACTIVE_MODE_ENABLED || '1') !== '0';
const FAST_EXTRACTIVE_TOP_DOC_ONLY = String(process.env.RAG_FAST_EXTRACTIVE_TOP_DOC_ONLY || '1') !== '0';
const FAST_EXTRACTIVE_CONFIDENCE_THRESHOLD = Math.max(
  0,
  Number(process.env.RAG_FAST_EXTRACTIVE_CONFIDENCE_THRESHOLD || 25),
);
const FAST_EXTRACTIVE_MIN_TOP_TERM_HITS = Math.max(
  0,
  Number(process.env.RAG_FAST_EXTRACTIVE_MIN_TOP_TERM_HITS || 1),
);
const FAST_EXTRACTIVE_MIN_DOCS = Math.max(
  1,
  Number(process.env.RAG_FAST_EXTRACTIVE_MIN_DOCS || 2),
);
const RAG_QUERY_ROUTER_ENABLED = String(process.env.RAG_QUERY_ROUTER_ENABLED || '0') === '1';
const RAG_EARLY_EXIT_ENABLED = String(process.env.RAG_EARLY_EXIT_ENABLED || '0') === '1';
const RAG_EARLY_EXIT_MIN_CONFIDENCE = Math.max(
  0,
  Number(process.env.RAG_EARLY_EXIT_MIN_CONFIDENCE || 25),
);
const RAG_EARLY_EXIT_MIN_DOCS = Math.max(
  1,
  Number(process.env.RAG_EARLY_EXIT_MIN_DOCS || 2),
);
const RAG_EARLY_EXIT_MIN_SCORE_MARGIN = Math.max(
  0,
  Number(process.env.RAG_EARLY_EXIT_MIN_SCORE_MARGIN || 3),
);
const RAG_EARLY_EXIT_MIN_TOP_TERM_HITS = Math.max(
  0,
  Number(process.env.RAG_EARLY_EXIT_MIN_TOP_TERM_HITS || 1),
);
const RAG_EARLY_EXIT_MIN_SOURCE_CONSISTENCY = Math.max(
  0,
  Math.min(1, Number(process.env.RAG_EARLY_EXIT_MIN_SOURCE_CONSISTENCY || 0.34)),
);
const RAG_SELECTIVE_RERANK_ENABLED = String(process.env.RAG_SELECTIVE_RERANK_ENABLED || '0') === '1';
const RAG_ANCHOR_VALIDATION_ENABLED = String(process.env.RAG_ANCHOR_VALIDATION_ENABLED || '1') !== '0';
const RAG_ANCHOR_MIN_OVERLAP = Math.max(1, Number(process.env.RAG_ANCHOR_MIN_OVERLAP || 1));
const RAG_MIN_DOCS_FOR_LLM_GENERATION = Math.max(
  1,
  Number(process.env.RAG_MIN_DOCS_FOR_LLM_GENERATION || 1),
);
const RAG_MIN_TERM_OVERLAP = Math.max(
  1,
  Number(process.env.RAG_MIN_TERM_OVERLAP || 2),
);
const RAG_MAX_DOCUMENTS = Math.max(1, Number(process.env.RAG_MAX_DOCUMENTS || 2));
const RAG_MAX_EVIDENCE_CHUNKS = Math.max(1, Number(process.env.RAG_MAX_EVIDENCE_CHUNKS || 3));
const RAG_MIN_TERM_OVERLAP_STRICT = Math.max(1, Number(process.env.RAG_MIN_TERM_OVERLAP_STRICT || 1));
const RAG_MIN_SEMANTIC_SIMILARITY = Math.max(0, Number(process.env.RAG_MIN_SEMANTIC_SIMILARITY || 0.25));
const RAG_CONTEXT_MAX_TOKENS = Math.max(256, Number(process.env.RAG_CONTEXT_MAX_TOKENS || 1500));
const RAG_EVIDENCE_ALLOW_CROSS_DOC_FALLBACK =
  String(process.env.RAG_EVIDENCE_ALLOW_CROSS_DOC_FALLBACK || '0') === '1';
const RAG_FAST_EXTRACTIVE_MIN_CONFIDENCE = Math.max(0, Number(process.env.RAG_FAST_EXTRACTIVE_MIN_CONFIDENCE || 120));
const RAG_FAST_EXTRACTIVE_REQUIRED_DOC_COUNT = Math.max(
  1,
  Number(process.env.RAG_FAST_EXTRACTIVE_REQUIRED_DOC_COUNT || 1),
);
const RAG_FAST_EXTRACTIVE_REQUIRED_TOP_TERM_HITS = Math.max(
  0,
  Number(process.env.RAG_FAST_EXTRACTIVE_REQUIRED_TOP_TERM_HITS || 3),
);
const RAG_CHUNK_ARTICLE_BOOST = Math.max(0, Number(process.env.RAG_CHUNK_ARTICLE_BOOST || 0.2));
const RAG_DOMAIN_FILTER_ENABLED = String(process.env.RAG_DOMAIN_FILTER_ENABLED || '1') !== '0';

const CLOCK_IN_CORRECTION_QUERY_RE =
  /(?:\bclock[\s-]?(?:in|out)\b|\btime\s*card\b|\btimesheet\b|\battendance\s+record(?:s)?\b|\battendance\s+report\b|\bwork\s+report\b|\bcorrect(?:ion)?\b|\badjust(?:ment)?\b|\bmiss(?:ed)?\b|\bmissing\b|\bforgot(?:ten)?\b|\bforgot\b|打刻漏れ|勤怠修正|修正申請|勤務報告|出勤簿)/i;
const MANAGER_ATTENDANCE_DOC_RE =
  /(?:\bsubordinate\b|\bdirect\s+report\b|\bmanager\b|\bsupervisor\b|\bhuman\s+resources\b|\bhr\b|\bteams\s+chat\b|部下|上司|人事|勤怠不良|面談)/i;
const CLOCK_IN_CORRECTION_DOC_RE =
  /(?:\bclock[\s-]?(?:in|out)\b|\battendance\s+report\b|\bwork\s+report\b|\battendance\s+record(?:s)?\b|\battendance\s+correction\b|\btime\s*card\b|\btimesheet\b|打刻|打刻漏れ|勤怠修正|修正申請|勤怠締め後|勤怠〆後|勤務報告|出勤簿|修正|訂正|更正)/i;

const filterClockInCorrectionDocs = (docs: any[], query: string): any[] => {
  if (!CLOCK_IN_CORRECTION_QUERY_RE.test(String(query || ''))) return docs;
  const rows = Array.isArray(docs) ? docs : [];
  const filtered = rows.filter((doc) => {
    const title = Array.isArray(doc?.title)
      ? String(doc.title[0] || '')
      : String(doc?.title || doc?.file_name_s || doc?.id || '');
    const body = Array.isArray(doc?.content_txt)
      ? String(doc.content_txt.join('\n') || '')
      : String(doc?.content_txt || doc?.content || '');
    const text = `${title}\n${body}`;
    if (!MANAGER_ATTENDANCE_DOC_RE.test(text)) return true;
    return CLOCK_IN_CORRECTION_DOC_RE.test(text);
  });
  return filtered.length > 0 ? filtered : rows;
};

type DomainKeywordMap = Record<string, string[]>;

const parseDomainKeywordMap = (): DomainKeywordMap => {
  const raw = String(process.env.RAG_DOMAIN_FILTER_KEYWORDS_JSON || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized: DomainKeywordMap = {};
    for (const [domain, terms] of Object.entries(parsed as Record<string, unknown>)) {
      const key = String(domain || '').trim().toLowerCase();
      if (!key) continue;
      const list = Array.isArray(terms)
        ? terms.map((term) => String(term || '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (list.length > 0) normalized[key] = Array.from(new Set(list));
    }
    return normalized;
  } catch {
    return {};
  }
};

const DOMAIN_KEYWORD_MAP = parseDomainKeywordMap();
const DOMAIN_NAMES = Object.keys(DOMAIN_KEYWORD_MAP);

const predictDomainFromQuery = (query: string): string => {
  const text = String(query || '').trim().toLowerCase();
  if (!text || !DOMAIN_NAMES.length) return '';
  const tokens = text.split(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff_-]+/).filter(Boolean);
  let bestDomain = '';
  let bestScore = 0;
  for (const domain of DOMAIN_NAMES) {
    const keywords = DOMAIN_KEYWORD_MAP[domain] || [];
    if (!keywords.length) continue;
    let score = 0;
    for (const keyword of keywords) {
      if (!keyword) continue;
      if (keyword.includes(' ') || /[\u3040-\u30ff\u3400-\u9fff]/.test(keyword)) {
        if (text.includes(keyword)) score += 2;
      } else if (tokens.includes(keyword)) {
        score += 2;
      } else if (text.includes(keyword)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestScore > 0 ? bestDomain : '';
};

const docMatchesPredictedDomain = (doc: any, predictedDomain: string): boolean => {
  const domain = String(predictedDomain || '').trim().toLowerCase();
  if (!domain) return true;
  const keywords = DOMAIN_KEYWORD_MAP[domain] || [];
  if (!keywords.length) return true;
  const policyType = String(doc?.policy_type_s || doc?.policy_type || '').toLowerCase();
  const title = String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || '').toLowerCase();
  const fileName = String(doc?.file_name_s || '').toLowerCase();
  const section = String(doc?.section_title_s || doc?.section_title || '').toLowerCase();
  const hay = `${policyType}\n${title}\n${fileName}\n${section}`;
  if (hay.includes(domain)) return true;
  return keywords.some((keyword) => keyword && hay.includes(keyword));
};

const hasPolicyArticleMarker = (row: any): boolean => {
  const text = Array.isArray(row?.content_txt)
    ? String(row.content_txt.join('\n') || '')
    : String(row?.content_txt || row?.content || '');
  return /(?:第\s*[0-9０-９]+\s*条|article\s*[0-9]+)/i.test(text);
};

const CHUNK_METADATA_LINE_PATTERN =
  /(?:^\s*(?:source|document|section|article|page)\s*[:：]|作成ユーザー|更新ユーザー|作成者|更新者|システム管理者|バックオフィスポータル|^\s*exment\s*[|｜])/i;
const CHUNK_ACTION_LINE_PATTERN =
  /(?:\b(?:must|shall|required|apply|request|submit|report|record|return|delete|notify|approve)\b|申請|承認|提出|届出|報告|返還|返却|削除|入力|記録|通知|連絡|第\s*[0-9０-９]+\s*条)/i;

const getChunkBodyText = (row: any): string =>
  Array.isArray(row?.content_txt)
    ? String(row.content_txt.join('\n') || '').trim()
    : String(row?.content_txt || row?.content || '').trim();

const isLowInformationChunk = (row: any): boolean => {
  const text = getChunkBodyText(row);
  if (!text) return true;
  const lines = text
    .split(/\r?\n+/)
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return true;
  const metadataLines = lines.filter((line) => CHUNK_METADATA_LINE_PATTERN.test(line)).length;
  const actionLines = lines.filter((line) => CHUNK_ACTION_LINE_PATTERN.test(line)).length;
  const textChars = text.replace(/\s+/g, '').length;
  if (textChars < 60 && actionLines === 0) return true;
  if (metadataLines >= Math.max(2, Math.ceil(lines.length * 0.5)) && actionLines === 0) return true;
  return false;
};

const getDocId = (row: any): string =>
  String(
    row?.file_id_s ||
    row?.document_id_s ||
    row?.doc_id_s ||
    row?.source_id_s ||
    row?.storage_key_s ||
    row?.file_path_s ||
    row?.file_name_s ||
    (Array.isArray(row?.title) ? row.title[0] : row?.title) ||
    '',
  ).trim();

const getChunkId = (row: any): string =>
  String(
    row?.chunk_id_s ||
    row?.id ||
    row?.row_id ||
    '',
  ).trim();

const getSectionTitle = (row: any): string =>
  String(
    row?.section_title_s ||
    row?.section_title ||
    row?.SectionName ||
    '',
  ).trim();

const getPolicyType = (row: any): string =>
  String(
    row?.policy_type_s ||
    row?.policy_type ||
    row?.rag_tag_s ||
    '',
  ).trim();

const getDocumentLastUpdated = (row: any): string =>
  String(
    row?.document_last_updated_s ||
    row?.updated_at_s ||
    row?.modified_at_s ||
    row?.last_revised_s ||
    row?.last_updated_s ||
    '',
  ).trim();

const getSemanticSimilarityScore = (row: any, topScore: number): number => {
  const semantic = Number(
    row?.semantic_score ??
    row?.vector_similarity ??
    row?.similarity ??
    row?.retrieval_score ??
    NaN,
  );
  if (Number.isFinite(semantic) && semantic > 0) return semantic;
  const docScore = Number(row?.score || 0);
  if (topScore > 0 && docScore > 0) {
    return Math.min(1, Math.max(0, docScore / topScore));
  }
  return 0;
};

const toNormalizedTokens = (value: string): string[] =>
  String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const computeTokenOverlap = (queryTerms: string[], row: any): number => {
  if (!queryTerms.length) return 0;
  const hay = [
    String((Array.isArray(row?.title) ? row.title[0] : row?.title) || ''),
    String(row?.file_name_s || ''),
    String(row?.section_title_s || row?.section_title || ''),
    String(row?.article_number_s || row?.article_number || ''),
    Array.isArray(row?.content_txt) ? row.content_txt.join(' ') : String(row?.content_txt || row?.content || ''),
  ]
    .join('\n')
    .toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(term)) {
      if (hay.includes(term)) hits += 1;
      continue;
    }
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordBoundary = new RegExp(`\\b${escaped}\\b`, 'i');
    if (wordBoundary.test(hay) || (term.length >= 4 && hay.includes(term))) {
      hits += 1;
    }
  }
  return hits;
};

const detectSectionMismatch = (queryTerms: string[], row: any): boolean => {
  const sectionTitle = getSectionTitle(row).toLowerCase();
  const policyType = getPolicyType(row).toLowerCase();
  if (!sectionTitle && !policyType) return false;
  const sectionTerms = new Set(toNormalizedTokens(`${sectionTitle} ${policyType}`));
  if (!sectionTerms.size || !queryTerms.length) return false;
  const queryHasCjk = queryTerms.some((token) => /[\u3040-\u30ff\u3400-\u9fff]/.test(token));
  const sectionHasCjk = Array.from(sectionTerms).some((token) => /[\u3040-\u30ff\u3400-\u9fff]/.test(token));
  if (queryHasCjk !== sectionHasCjk) return false;
  const overlap = queryTerms.filter((token) => sectionTerms.has(token)).length;
  // only treat as mismatch when metadata is present and there is zero topical overlap
  return overlap === 0;
};

const countDistinctDocuments = (rows: any[]): number =>
  Array.from(
    new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => getDocId(row))
        .filter(Boolean),
    ),
  ).length;

type RetrievedChunk = {
  row: any;
  docId: string;
  chunkId: string;
  docRelevanceScore: number;
  chunkRelevanceScore: number;
  termOverlap: number;
  semanticScore: number;
  sectionMismatch: boolean;
};

type RetrieveChunksResult = {
  docs: any[];
  docIds: string[];
};

type FilterChunksResult = {
  chunks: RetrievedChunk[];
  filteredCount: number;
  mode: 'strict_same_language' | 'cross_language_relaxed' | 'mixed';
  keptCount: number;
};

type SelectEvidenceResult = {
  chunks: RetrievedChunk[];
  fallbackTriggered: boolean;
};

const collectResponseCacheFingerprint = (docs: any[]): {
  docIds: string[];
  chunkIds: string[];
  documentLastUpdated: string[];
} => {
  const rows = Array.isArray(docs) ? docs : [];
  const docIdSet = new Set<string>();
  const chunkIdSet = new Set<string>();
  const lastUpdatedSet = new Set<string>();
  for (const row of rows.slice(0, RESPONSE_CACHE_FINGERPRINT_MAX_IDS)) {
    const docIdCandidate = getDocId(row);
    if (docIdCandidate) docIdSet.add(docIdCandidate);
    const chunkIdCandidate = getChunkId(row);
    if (chunkIdCandidate) chunkIdSet.add(chunkIdCandidate);
    const lastUpdated = getDocumentLastUpdated(row);
    if (lastUpdated) lastUpdatedSet.add(lastUpdated);
  }
  return {
    docIds: Array.from(docIdSet).sort(),
    chunkIds: Array.from(chunkIdSet).sort(),
    documentLastUpdated: Array.from(lastUpdatedSet).sort(),
  };
};

export const generateCacheKey = (args: {
  query: string;
  canonicalQuery: string;
  language: 'ja' | 'en';
  departmentCode?: string;
  docIds: string[];
  chunkIds: string[];
  indexVersion: string;
  documentLastUpdated: string[];
}): string =>
  buildResponseCacheKey({
    query: args.query,
    canonicalQuery: args.canonicalQuery,
    language: args.language,
    departmentCode: args.departmentCode,
    docIds: args.docIds,
    chunkIds: args.chunkIds,
    indexVersion: args.indexVersion,
    documentLastUpdated: args.documentLastUpdated,
  });

export const retrieveChunks = (args: {
  docs: any[];
  query: string;
  topScore: number;
  maxDocuments?: number;
  logger?: (line: string) => void;
}): RetrieveChunksResult => {
  const log = args.logger || (() => undefined);
  const rows = Array.isArray(args.docs) ? args.docs : [];
  const queryTerms = Array.from(new Set(toNormalizedTokens(args.query))).slice(0, 20);
  if (!rows.length) return { docs: [], docIds: [] };
  const grouped = new Map<string, RetrievedChunk[]>();
  for (const row of rows) {
    const docId = getDocId(row);
    const chunkId = getChunkId(row);
    if (!docId || !chunkId) continue;
    const termOverlap = computeTokenOverlap(queryTerms, row);
    const semanticScore = getSemanticSimilarityScore(row, args.topScore);
    const sectionMismatch = detectSectionMismatch(queryTerms, row);
    const articleBoost = hasPolicyArticleMarker(row) ? RAG_CHUNK_ARTICLE_BOOST : 0;
    const lowInfoPenalty = isLowInformationChunk(row) ? -4 : 0;
    const chunkRelevanceScore =
      (termOverlap * 3) + (semanticScore * 10) + (sectionMismatch ? -2 : 0) + articleBoost + lowInfoPenalty;
    const item: RetrievedChunk = {
      row,
      docId,
      chunkId,
      docRelevanceScore: 0,
      chunkRelevanceScore,
      termOverlap,
      semanticScore,
      sectionMismatch,
    };
    if (!grouped.has(docId)) grouped.set(docId, []);
    grouped.get(docId)!.push(item);
  }
  const docRank = Array.from(grouped.entries())
    .map(([docId, chunks]) => {
      const sorted = [...chunks].sort((a, b) => b.chunkRelevanceScore - a.chunkRelevanceScore);
      const top = sorted.slice(0, 3);
      const score = top.reduce((acc, row) => acc + row.chunkRelevanceScore, 0) / Math.max(1, top.length);
      top.forEach((row) => {
        row.docRelevanceScore = score;
      });
      return { docId, score, chunks: sorted };
    })
    .sort((a, b) => b.score - a.score);

  const keptDocs = docRank.slice(0, Math.max(1, Number(args.maxDocuments || RAG_MAX_DOCUMENTS)));
  const keptDocIds = keptDocs.map((row) => row.docId);
  const keptChunks = keptDocs.flatMap((row) => row.chunks);
  log(
    `[RAG] doc_relevance_score ${JSON.stringify({
      ranked: keptDocs.map((row) => ({ doc_id: row.docId, score: Number(row.score.toFixed(3)) })),
    })}`,
  );
  return {
    docs: keptChunks.map((chunk) => chunk.row),
    docIds: keptDocIds,
  };
};

export const filterChunks = (args: {
  docs: any[];
  query: string;
  topScore: number;
  queryLanguage?: 'ja' | 'en';
  minTermOverlap?: number;
  minSemanticSimilarity?: number;
  logger?: (line: string) => void;
}): FilterChunksResult => {
  const log = args.logger || (() => undefined);
  const rows = Array.isArray(args.docs) ? args.docs : [];
  const queryTerms = Array.from(new Set(toNormalizedTokens(args.query))).slice(0, 20);
  const minTermOverlap = Math.max(0, Number(args.minTermOverlap ?? RAG_MIN_TERM_OVERLAP_STRICT));
  const minSemanticSimilarity = Math.max(0, Number(args.minSemanticSimilarity || RAG_MIN_SEMANTIC_SIMILARITY));
  const inferRowLanguage = (row: any): 'ja' | 'en' => {
    const title = Array.isArray(row?.title) ? String(row.title[0] || '') : String(row?.title || '');
    const content = Array.isArray(row?.content_txt)
      ? String(row.content_txt.join(' ') || '')
      : String(row?.content_txt || row?.content_txt_ja || row?.content || '');
    return hasJapaneseChars(`${title}\n${content}`) ? 'ja' : 'en';
  };
  let lowInformationFiltered = 0;
  let crossLanguageChunkCount = 0;
  const scored: RetrievedChunk[] = rows.map((row) => {
    const docId = getDocId(row);
    const chunkId = getChunkId(row);
    const termOverlap = computeTokenOverlap(queryTerms, row);
    const semanticScore = getSemanticSimilarityScore(row, args.topScore);
    const sectionMismatch = detectSectionMismatch(queryTerms, row);
    const articleBoost = hasPolicyArticleMarker(row) ? RAG_CHUNK_ARTICLE_BOOST : 0;
    const lowInfoPenalty = isLowInformationChunk(row) ? -4 : 0;
    return {
      row,
      docId,
      chunkId,
      docRelevanceScore: 0,
      chunkRelevanceScore:
        (termOverlap * 3) + (semanticScore * 10) + (sectionMismatch ? -2 : 0) + articleBoost + lowInfoPenalty,
      termOverlap,
      semanticScore,
      sectionMismatch,
    };
  });
  const filtered = scored.filter((chunk) => {
    if (!chunk.docId || !chunk.chunkId) return false;
    const docLanguage = inferRowLanguage(chunk.row);
    const crossLanguageMatch = Boolean(args.queryLanguage) && args.queryLanguage !== docLanguage;
    const effectiveMinTermOverlap = crossLanguageMatch ? 0 : minTermOverlap;
    if (crossLanguageMatch) crossLanguageChunkCount += 1;
    if (chunk.termOverlap < effectiveMinTermOverlap) return false;
    if (chunk.semanticScore < minSemanticSimilarity) return false;
    if (chunk.sectionMismatch) return false;
    if (isLowInformationChunk(chunk.row)) {
      lowInformationFiltered += 1;
      return false;
    }
    return true;
  });
  const chunkFilterMode =
    crossLanguageChunkCount > 0
      ? (crossLanguageChunkCount === scored.length ? 'cross_language_relaxed' : 'mixed')
      : 'strict_same_language';
  log(
    `[RAG] chunk_relevance_score ${JSON.stringify({
      before_count: scored.length,
      after_count: filtered.length,
      chunk_filter_mode: chunkFilterMode,
      min_term_overlap: minTermOverlap,
      min_semantic_similarity: Number(minSemanticSimilarity.toFixed(3)),
      cross_language_chunks: crossLanguageChunkCount,
      filtered_chunks: scored.length - filtered.length,
      low_information_filtered: lowInformationFiltered,
      final_kept_chunk_count: filtered.length,
    })}`,
  );
  return {
    chunks: filtered.sort((a, b) => b.chunkRelevanceScore - a.chunkRelevanceScore),
    filteredCount: Math.max(0, scored.length - filtered.length),
    mode: chunkFilterMode,
    keptCount: filtered.length,
  };
};

export const selectEvidence = (args: {
  chunks: RetrievedChunk[];
  maxChunks?: number;
  allowCrossDocumentFallback?: boolean;
}): SelectEvidenceResult => {
  const list = Array.isArray(args.chunks) ? args.chunks : [];
  const maxChunks = Math.max(1, Number(args.maxChunks || RAG_MAX_EVIDENCE_CHUNKS));
  if (!list.length) return { chunks: [], fallbackTriggered: false };
  const byDoc = new Map<string, RetrievedChunk[]>();
  for (const chunk of list) {
    if (!chunk.docId) continue;
    if (!byDoc.has(chunk.docId)) byDoc.set(chunk.docId, []);
    byDoc.get(chunk.docId)!.push(chunk);
  }
  const rankedDocs = Array.from(byDoc.entries())
    .map(([docId, chunks]) => ({
      docId,
      chunks: chunks.sort((a, b) => b.chunkRelevanceScore - a.chunkRelevanceScore),
      score: chunks.reduce((acc, row) => acc + row.chunkRelevanceScore, 0) / Math.max(1, chunks.length),
    }))
    .sort((a, b) => b.score - a.score);
  const primary = rankedDocs[0];
  const primaryChunks = primary?.chunks || [];
  const primarySection = getSectionTitle(primaryChunks[0]?.row || '').toLowerCase();
  const sectionMatched = primarySection
    ? primaryChunks.filter((chunk) => getSectionTitle(chunk.row).toLowerCase() === primarySection)
    : [];
  const selected = (sectionMatched.length > 0 ? sectionMatched : primaryChunks).slice(0, maxChunks);
  if (selected.length < maxChunks && primaryChunks.length > selected.length) {
    const selectedChunkIds = new Set(selected.map((row) => row.chunkId));
    for (const chunk of primaryChunks) {
      if (selected.length >= maxChunks) break;
      if (selectedChunkIds.has(chunk.chunkId)) continue;
      selected.push(chunk);
      selectedChunkIds.add(chunk.chunkId);
    }
  }
  let fallbackTriggered = false;
  if (
    selected.length < maxChunks &&
    Boolean(args.allowCrossDocumentFallback) &&
    rankedDocs.length > 1
  ) {
    fallbackTriggered = true;
    const remaining = maxChunks - selected.length;
    const fallback = rankedDocs[1].chunks.slice(0, remaining);
    selected.push(...fallback);
  }
  return {
    chunks: selected.slice(0, maxChunks),
    fallbackTriggered,
  };
};

const estimateTokenCount = (value: string): number => {
  const text = String(value || '').trim();
  if (!text) return 0;
  const cjkCount = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const latinApprox = text
    .replace(/[\u3040-\u30ff\u3400-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .length;
  return cjkCount + latinApprox;
};

const trimToTokenBudget = (value: string, maxTokens: number): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (estimateTokenCount(raw) <= maxTokens) return raw;
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const lineTokens = estimateTokenCount(line);
    if (lineTokens <= 0) continue;
    if ((used + lineTokens) > maxTokens) break;
    kept.push(line);
    used += lineTokens;
  }
  return kept.join('\n').trim();
};

const enforcePromptTokenLimit = (prompt: string, maxTokens: number): string => {
  const raw = String(prompt || '').trim();
  if (!raw) return '';
  if (estimateTokenCount(raw) <= maxTokens) return raw;
  const marker = '\n\nDOCUMENT CONTEXT:\n';
  const idx = raw.indexOf(marker);
  if (idx < 0) {
    return trimToTokenBudget(raw, maxTokens);
  }
  const prefix = raw.slice(0, idx + marker.length);
  const context = raw.slice(idx + marker.length);
  const prefixTokens = estimateTokenCount(prefix);
  const remaining = Math.max(80, maxTokens - prefixTokens);
  const trimmedContext = trimToTokenBudget(context, remaining);
  return `${prefix}${trimmedContext}`.trim();
};

export const buildPrompt = (args: {
  query: string;
  chunks: any[];
  maxContextTokens?: number;
}): { prompt: string; promptTokens: number; contextTokens: number; sources: ContextSource[] } => {
  const maxContextTokens = Math.max(256, Number(args.maxContextTokens || RAG_CONTEXT_MAX_TOKENS));
  const queryText = String(args.query || '').trim();
  const rows = (Array.isArray(args.chunks) ? args.chunks : []).slice(0, RAG_MAX_EVIDENCE_CHUNKS);
  const contextBlocks: string[] = [];
  const sources: ContextSource[] = [];
  for (const row of rows) {
    const title = String((Array.isArray(row?.title) ? row.title[0] : row?.title) || row?.file_name_s || 'Document');
    const sectionTitle = getSectionTitle(row);
    const articleNumber = String(row?.article_number_s || row?.article_number || '').trim();
    const pageNumber = Number(row?.page_number_i ?? row?.page_i ?? row?.page);
    const body = Array.isArray(row?.content_txt)
      ? String(row.content_txt.join('\n') || '').trim()
      : String(row?.content_txt || row?.content || '').trim();
    if (!body) continue;
    const sourceLine = [
      `Source: ${title}`,
      sectionTitle ? `Section ${sectionTitle}` : '',
      articleNumber ? `Article ${articleNumber}` : '',
      Number.isFinite(pageNumber) ? `Page ${Number(pageNumber)}` : '',
    ].filter(Boolean).join(' | ');
    const block = [
      `--- Document: ${title} ---`,
      sourceLine,
      body,
    ]
      .filter(Boolean)
      .join('\n');
    contextBlocks.push(block);
    sources.push({
      docId: String(row?.id || ''),
      title,
      page: Number.isFinite(pageNumber) ? Number(pageNumber) : undefined,
    });
  }
  const rawContext = contextBlocks.join('\n\n---\n\n');
  const trimmedContext = trimToTokenBudget(rawContext, maxContextTokens);
  const prompt = `USER QUESTION:\n${queryText}\n\nDOCUMENT CONTEXT:\n${trimmedContext}`;
  return {
    prompt,
    promptTokens: estimateTokenCount(prompt),
    contextTokens: estimateTokenCount(trimmedContext),
    sources: Array.from(new Set(sources.map((source) => `${source.docId}|${source.title}|${source.page ?? ''}`)))
      .map((key) => {
        const [docId, title, page] = key.split('|');
        const parsedPage = Number(page);
        return {
          docId,
          title: title || undefined,
          page: Number.isFinite(parsedPage) ? parsedPage : undefined,
        } as ContextSource;
      }),
  };
};

const buildFastExtractiveAnswer = (params: {
  docs: any[];
  query: string;
  language: 'ja' | 'en';
}): { answer: string; sources: ContextSource[] } | null => {
  const docs = Array.isArray(params.docs) ? params.docs : [];
  if (docs.length < Math.max(1, RAG_FAST_EXTRACTIVE_REQUIRED_DOC_COUNT)) return null;
  const docsForExtraction = FAST_EXTRACTIVE_TOP_DOC_ONLY ? docs.slice(0, 1) : docs.slice(0, 5);
  if (docsForExtraction.length <= 0) return null;
  const query = String(params.query || '').trim().toLowerCase();
  const queryLooksProcedural = /(?:\bwhat\s+should\b|\bdo\s+if\b|\bhow\s+to\b|\bsteps?\b|\bprocedure\b|\bprocess\b|\bapply\b|\bapplication\b|\brequest\b|\bsubmit\b|\bchange\b|\bcorrect(?:ion)?\b|\bforgot\b|\bforget\b|\bmiss(?:ed)?\b|\bclock[\s-]?in\b|\battendance\b|\bbreak\b|\bno\s*break\b|\bwithout\s+taking\s+a?\s*break\b|申請|手順|方法|やり方|流れ|打刻|打刻漏れ|勤怠修正|修正申請|休憩|休憩なし|無休憩|休憩を取らず)/i
    .test(query);
  const queryTokens = query
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9_\-\u3040-\u30ff\u3400-\u9fff]/g, '').trim())
    .filter((token) => token.length >= 2)
    .slice(0, 10);

  const metadataPattern =
    /(https?:\/\/|www\.|table_\d+|\.pdf\b|\.docx?\b|\.xlsx?\b|(?:^|\s)id\s*\d+\b|\d{4}\/\d{2}\/\d{2}|^\s*exment\b|[\u25a1\u25a0\u25c6\u2022]\s*http)/i;
  const actionPattern =
    /(?:submit|request|apply|approval|approve|login|log in|navigate|open|select|enter|report|attendance|workflow|form|portal|overtime|leave|expense|申請|承認|提出|入力|ログイン|勤怠|勤務報告|残業|経費|休暇)/i;
  const normalizeLine = (line: string): string =>
    String(line || '')
      .replace(/\s+/g, ' ')
      .replace(/^[\-\*•●▪︎]+\s*/, '')
      .replace(/^\d+[\).]?\s*/, '')
      .replace(/^[①-⑳⑴-⒇⓪⓫-⓴]+\s*/, '')
      .trim();
  const isLikelyMetadataLine = (line: string): boolean => {
    const value = String(line || '').trim();
    if (!value) return true;
    if (metadataPattern.test(value)) return true;
    const symbolCount = (value.match(/[|~_=\[\]{}<>]/g) || []).length;
    const letterCount = (value.match(/[A-Za-z\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    if (letterCount <= 8 && symbolCount >= 3) return true;
    if (value.length > 220) return true;
    return false;
  };

  const candidates: Array<{ line: string; score: number }> = [];
  const seen = new Set<string>();
  for (const [docIndex, doc] of docsForExtraction.entries()) {
    const rawContent = Array.isArray(doc?.content_txt)
      ? doc.content_txt.join('\n')
      : String(doc?.content_txt || doc?.content || '');
    const normalizedContent = String(rawContent || '').replace(/\r/g, '\n').trim();
    if (!normalizedContent) continue;
    const fragments = normalizedContent
      .split(/\n+|(?<=[。！？.!?])\s+|\s*[•●▪︎-]\s+/)
      .map((v) => normalizeLine(v))
      .filter(Boolean);

    for (const fragment of fragments) {
      if (fragment.length < 14) continue;
      if (isLikelyMetadataLine(fragment)) continue;
      const lower = fragment.toLowerCase();
      const tokenHits = queryTokens.reduce((count, token) => (lower.includes(token) ? count + 1 : count), 0);
      const actionHit = actionPattern.test(fragment) ? 1 : 0;
      const score = tokenHits * 3 + actionHit * 2 + (docIndex === 0 ? 1 : 0);
      // Guard against generic policy boilerplate by requiring at least one
      // query-token hit when query terms are available.
      if (queryTokens.length > 0 && tokenHits <= 0) continue;
      if (score <= 0 && queryTokens.length > 0) continue;
      const dedupeKey = lower.replace(/\s+/g, ' ').trim();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push({ line: fragment, score });
    }
  }

  if (candidates.length === 0) return null;

  const canonicalizeLine = (value: string): string =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const tokenSet = (value: string): Set<string> =>
    new Set(
      canonicalizeLine(value)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    );
  const isNearDuplicate = (line: string, selected: string[]): boolean => {
    const lhs = canonicalizeLine(line);
    if (!lhs) return true;
    const lhsTokens = tokenSet(lhs);
    for (const existing of selected) {
      const rhs = canonicalizeLine(existing);
      if (!rhs) continue;
      if (lhs === rhs || lhs.includes(rhs) || rhs.includes(lhs)) return true;
      const rhsTokens = tokenSet(rhs);
      const overlap = Array.from(lhsTokens).filter((token) => rhsTokens.has(token)).length;
      const minSize = Math.max(1, Math.min(lhsTokens.size, rhsTokens.size));
      if ((overlap / minSize) >= 0.8) return true;
    }
    return false;
  };

  const ranked = candidates
    .sort((a, b) => (b.score - a.score) || (a.line.length - b.line.length))
    .map((entry) => entry.line);
  const selectedLines: string[] = [];
  const maxLines = queryLooksProcedural ? 5 : 6;
  for (const line of ranked) {
    if (selectedLines.length >= maxLines) break;
    if (isNearDuplicate(line, selectedLines)) continue;
    selectedLines.push(line);
  }
  const compactRanked = selectedLines;

  if (compactRanked.length === 0) return null;

  const repairExtractedAnswer = (lines: string[]): string => {
    const uiNoisePattern = /^(?:【[^】]+】|公開承認者検索)$/i;
    const cleanLine = (line: string): string =>
      String(line || '')
        .replace(/\s+/g, ' ')
        .replace(/^[\-\*•●▪︎]+\s*/, '')
        .replace(/^\d+[\).．]?\s*/, '')
        .trim();
    const ensureTerminalPunctuation = (line: string): string => {
      const trimmed = cleanLine(line);
      if (!trimmed) return '';
      if (/[。！？.!?]$/.test(trimmed)) return trimmed;
      return params.language === 'ja' ? `${trimmed}。` : `${trimmed}.`;
    };
    const mergeLines = (left: string, right: string): string => {
      const lhs = String(left || '').trim().replace(/[。.!?]$/, '');
      const rhs = String(right || '').trim();
      if (!lhs) return rhs;
      if (!rhs) return lhs;
      return params.language === 'ja'
        ? ensureTerminalPunctuation(`${lhs} ${rhs}`)
        : ensureTerminalPunctuation(`${lhs} ${rhs.replace(/^[A-Z]/, (char) => char.toLowerCase())}`);
    };

    const repaired: string[] = [];
    for (const rawLine of lines) {
      const normalized = cleanLine(rawLine);
      if (!normalized) continue;
      if (uiNoisePattern.test(normalized)) continue;
      if (isLikelyMetadataLine(normalized)) continue;

      const sentence = ensureTerminalPunctuation(normalized);
      if (!sentence) continue;
      const previous = repaired[repaired.length - 1];
      const shouldMerge =
        Boolean(previous) &&
        previous.length < (params.language === 'ja' ? 80 : 110) &&
        sentence.length < (params.language === 'ja' ? 80 : 110);
      if (shouldMerge) {
        repaired[repaired.length - 1] = mergeLines(previous, sentence);
        continue;
      }
      repaired.push(sentence);
      if (repaired.length >= (queryLooksProcedural ? 2 : 3)) break;
    }

    return repaired.join('\n\n').trim();
  };

  const answer = repairExtractedAnswer(compactRanked);
  if (!answer) return null;
  const sources: ContextSource[] = docsForExtraction.slice(0, 3).map((doc) => ({
    docId: String(doc?.id || ''),
    title: String((Array.isArray(doc?.title) ? doc.title[0] : doc?.title) || '').trim() || undefined,
    page: Number.isFinite(Number(doc?.page_i))
      ? Number(doc.page_i)
      : (Number.isFinite(Number(doc?.page)) ? Number(doc.page) : undefined),
  }));

  return { answer, sources };
};

const PROCEDURAL_QUERY_PATTERN =
  /(?:\bwhat\s+should\b|\bdo\s+if\b|\bhow\s+to\b|\bhow\s+do\s+i\b|\bhow\s+can\s+i\b|\bsteps?\s+to\b|\bprocess\s+for\b|\brequest\s+process\b|\bapply\s+for\b|\bprocedure\b|\bworkflow\b|\bapply\b|\bsubmit\b|\bchange\b|\bcorrect(?:ion)?\b|\bforgot\b|\bforget\b|\bmiss(?:ed)?\b|\bclock[\s-]?in\b|\btime\s*card\b|\battendance\b|\bbreak\b|\bno\s*break\b|\bwithout\s+taking\s+a?\s*break\b|申請方法|申請手順|手順|方法|やり方|流れ|申請|提出|変更|打刻|打刻漏れ|勤怠修正|修正申請|休憩|休憩なし|無休憩|休憩を取らず)/i;

const isProceduralQuery = (query: string, routeClass: string): boolean => {
  if (routeClass === 'procedural') return true;
  return PROCEDURAL_QUERY_PATTERN.test(String(query || '').trim());
};

export const runRagPipeline = async (
  input: RunRagPipelineInput,
): Promise<RunRagPipelineResult> => {
  const log = input.logger || ((line: string) => console.log(line));
  const logMetricStage = (stage: string, payload: Record<string, any>) => {
    log(`[RAG_METRIC] ${stage}=${JSON.stringify(payload)}`);
  };
  const logRagMetric = (params: {
    retrievalMs: number;
    generationMs: number;
    translationMs: number;
    cacheHit: boolean;
    pipelineMode: PipelineMode;
  }) => {
    log(
      `[RAG_METRIC] retrieval_ms=${Math.max(0, Math.round(params.retrievalMs))} generation_ms=${Math.max(0, Math.round(params.generationMs))} translation_ms=${Math.max(0, Math.round(params.translationMs))} cache_hit=${params.cacheHit ? 1 : 0} pipeline_mode=${params.pipelineMode}`,
    );
    logMetricStage('pipeline_mode', {
      value: params.pipelineMode,
      cache_hit: params.cacheHit ? 1 : 0,
    });
  };
  const EN_ANCHOR_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please',
    'the', 'to', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
    'must', 'should', 'do', 'does', 'did', 'can', 'could', 'would', 'will',
    'employees', 'employee', 'company',
    'they', 'them', 'their', 'has', 'have', 'had', 'happens', 'happen',
  ]);
  const ANCHOR_NOISE_RE =
    /^(?:https?|javascript|data|file|blob)$/i;
  const UUID_RE =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
  const HASH_RE =
    /\b[a-f0-9]{24,128}\b/i;
  const NUMERIC_ID_RE =
    /^\d{4,}$/;
  const isNoiseAnchorToken = (token: string): boolean => {
    const value = String(token || '').trim().toLowerCase();
    if (!value) return true;
    if (ANCHOR_NOISE_RE.test(value)) return true;
    if (UUID_RE.test(value)) return true;
    if (HASH_RE.test(value)) return true;
    if (NUMERIC_ID_RE.test(value)) return true;
    if (/^https?:\/\//i.test(value)) return true;
    if (/^[a-f0-9]{8,}-[a-f0-9-]{8,}$/i.test(value)) return true;
    return false;
  };
  const toDocText = (doc: any): string => {
    const title = Array.isArray(doc?.title) ? String(doc.title[0] || '') : String(doc?.title || '');
    const content = Array.isArray(doc?.content_txt)
      ? String(doc.content_txt.join(' ') || '')
      : String(doc?.content_txt || doc?.content || '');
    const fileName = String(doc?.file_name_s || '');
    return `${title}\n${fileName}\n${content}`.toLowerCase();
  };
  const extractAnchorTokens = (queryText: string): string[] => {
    const value = String(queryText || '').trim().toLowerCase();
    if (!value) return [];
    const englishTokens = value
      .split(/[^a-z0-9_-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => /[a-z]/.test(token))
      .filter((token) => !EN_ANCHOR_STOPWORDS.has(token));
    const cjkTokens = (value.match(/[\u30a0-\u30ffー]{2,}|[\u3400-\u9fff]{2,}/g) || [])
      .map((token) => token.trim())
      .filter(Boolean);
    const mixedJapaneseTokens = (value.match(/[\u3040-\u30ff\u3400-\u9fffー]{2,}/g) || [])
      .map((token) => token.trim())
      .filter(Boolean);
    const japaneseKeywordTerms = extractJapaneseKeywordTerms(value);
    return Array.from(new Set([
      ...englishTokens,
      ...cjkTokens,
      ...mixedJapaneseTokens,
      ...japaneseKeywordTerms,
    ]))
      .filter((token) => !isNoiseAnchorToken(String(token || '')))
      .slice(0, 28);
  };
  const countAnchorOverlapForDoc = (doc: any, anchors: string[]): number => {
    if (!anchors.length) return 0;
    const hay = toDocText(doc);
    let hits = 0;
    for (const anchor of anchors) {
      const token = String(anchor || '').trim().toLowerCase();
      if (!token) continue;
      if (/[\u30a0-\u30ffー\u3400-\u9fff]/.test(token)) {
        if (hay.includes(token)) hits += 1;
        continue;
      }
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordBoundary = new RegExp(`\\b${escaped}\\b`, 'i');
      if (wordBoundary.test(hay) || (token.length >= 4 && hay.includes(token))) {
        hits += 1;
      }
    }
    return hits;
  };
  const findMatchedAnchorTokens = (docs: any[], anchors: string[]): string[] => {
    if (!anchors.length || !Array.isArray(docs) || docs.length === 0) return [];
    const hay = docs
      .slice(0, 6)
      .map((doc) => toDocText(doc))
      .join('\n');
    const matched: string[] = [];
    for (const anchor of anchors) {
      const token = String(anchor || '').trim().toLowerCase();
      if (!token) continue;
      if (/[\u30a0-\u30ffー\u3400-\u9fff]/.test(token)) {
        if (hay.includes(token)) matched.push(token);
        continue;
      }
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordBoundary = new RegExp(`\\b${escaped}\\b`, 'i');
      if (wordBoundary.test(hay) || (token.length >= 4 && hay.includes(token))) {
        matched.push(token);
      }
    }
    return Array.from(new Set(matched)).slice(0, 20);
  };
  const computeTopScoreMargin = (rows: any[], fallbackTopScore: number): number => {
    const ranked = Array.isArray(rows) ? rows : [];
    if (!ranked.length) return 0;
    const first = Number(ranked?.[0]?.score ?? fallbackTopScore ?? 0);
    const second = Number(ranked?.[1]?.score ?? 0);
    return Math.max(0, first - second);
  };
  const computeSourceConsistency = (rows: any[]): number => {
    const ranked = (Array.isArray(rows) ? rows : []).slice(0, 5);
    if (!ranked.length) return 0;
    const counts = new Map<string, number>();
    for (const row of ranked) {
      const key = String(
        (Array.isArray(row?.title) ? row.title[0] : row?.title) ||
        row?.file_name_s ||
        row?.id ||
        '',
      ).trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const maxCount = Math.max(0, ...Array.from(counts.values()));
    if (!maxCount) return 0;
    return maxCount / Math.max(1, ranked.length);
  };
  const userLanguage = detectRagLanguage(input.query);
  const retrievalIndexLanguage = resolveRetrievalIndexLanguage(input.retrievalIndexLanguage || 'multi');
  let pipelineMode: PipelineMode = 'LLM_GENERATION';
  const routingEnabled = RAG_QUERY_ROUTER_ENABLED;
  const route = routingEnabled
    ? routeQuery({
        query: String(input.query || ''),
        language: userLanguage,
        hasHistory: Array.isArray(input.historyMessages) && input.historyMessages.length > 0,
      })
    : {
        klass: 'ambiguous' as const,
        confidence: 0,
        enableExpansion: true,
        maxExpansionVariants: 6,
        allowEarlyExit: false,
        preferLexicalFirst: true,
        preferNarrowDomain: false,
      };
  if (routingEnabled) {
    log(
      `[RAG_ROUTE] classification=${route.klass} confidence=${route.confidence.toFixed(3)} expansion=${route.enableExpansion ? 1 : 0} max_variants=${route.maxExpansionVariants} early_exit=${route.allowEarlyExit ? 1 : 0}`,
    );
    recordRagDecision('query_classification', {
      enabled: 1,
      classification: route.klass,
      confidence: Number(route.confidence.toFixed(3)),
      enable_expansion: route.enableExpansion ? 1 : 0,
      allow_early_exit: route.allowEarlyExit ? 1 : 0,
      max_variants: route.maxExpansionVariants,
      prefer_narrow_domain: route.preferNarrowDomain ? 1 : 0,
    }, log);
  }
  const eagerTranslationExpansion = true;

  const expanded = await expandQuery({
    originalQueryText: String(input.query || ''),
    promptText: String(input.prompt || ''),
    userLanguage,
    maxVariants: routingEnabled ? route.maxExpansionVariants : 6,
    enableTranslationExpansion: eagerTranslationExpansion,
  });
  logMetricStage('query_normalized', { value: expanded.normalizedQuery });
  logMetricStage('canonical_query', { value: expanded.canonicalQuery });
  logMetricStage('expanded_queries', { values: expanded.expandedQueries });
  logMetricStage('translation_status', {
    value: expanded.queryTranslationStatus,
    applied: expanded.queryTranslationApplied ? 1 : 0,
    llm_calls: expanded.translateCallsCount,
  });
  log(`[RAG PIPELINE] detected_query_language="${userLanguage}"`);
  log(`[RAG PIPELINE] query_normalized="${expanded.normalizedQuery}"`);
  log(`[RAG PIPELINE] canonical_query="${expanded.canonicalQuery}"`);
  log(`[RAG PIPELINE] expanded_queries=${expanded.expandedQueries.join(' | ')}`);
  if (expanded.generatedJapaneseQueries.length > 0) {
    log(`[RAG PIPELINE] generated_japanese_retrieval_queries=${expanded.generatedJapaneseQueries.join(' | ')}`);
  }
  const synonymExpandedQueries = expanded.expandedQueries
    .map((query) => String(query || '').trim())
    .filter(Boolean)
    .filter((query) => query !== expanded.canonicalQuery);
  if (synonymExpandedQueries.length > 0) {
    log(
      `[RAG] synonym_expansion_applied ${JSON.stringify({
        base_query: expanded.canonicalQuery,
        expansion_count: synonymExpandedQueries.length,
        expansions: synonymExpandedQueries.slice(0, 6),
      })}`,
    );
  }
  if (expanded.intentVariants.length > 0) {
    log(`[RAG PIPELINE] intent_variants=${expanded.intentVariants.join(' | ')}`);
  }

  let retrievalQueryUsed = expanded.canonicalQuery;
  let docs: any[] = [];
  let queryTranslationApplied = expanded.queryTranslationApplied;
  let translateCallsCount = expanded.translateCallsCount;
  let queryTranslationMs = expanded.translateMs;
  let usedSemanticFallback = false;
  let topScore = 0;
  let topTermHits = 0;
  let solrCallsCount = 0;
  let attemptedQueries: string[] = [];
  let rerankMs = 0;
  let chunkFilterMs = 0;
  let promptBuildMs = 0;
  let llmTtftMs = 0;
  const logRagTiming = (llmTotalMs: number): void => {
    log(
      `[RAG_TIMING] retrieval=${Math.max(0, Math.round(retrievalMs))}ms rerank=${Math.max(0, Math.round(rerankMs))}ms chunk_filter=${Math.max(0, Math.round(chunkFilterMs))}ms prompt_build=${Math.max(0, Math.round(promptBuildMs))}ms llm_ttft=${Math.max(0, Math.round(llmTtftMs))}ms llm_total=${Math.max(0, Math.round(llmTotalMs))}ms`,
    );
  };
  const retrievalStart = Date.now();
  if (input.retrieveDocuments) {
    const retrieved = await input.retrieveDocuments({
      queryForRAG: expanded.canonicalQuery,
      multilingualRetrievalQueries: expanded.expandedQueries,
      userLanguage,
      retrievalIndexLanguage,
    });
    if (Array.isArray(retrieved)) {
      docs = retrieved;
    } else {
      docs = Array.isArray(retrieved?.docs) ? retrieved.docs : [];
      retrievalQueryUsed = String(retrieved?.retrievalQueryUsed || retrievalQueryUsed);
      attemptedQueries = Array.isArray(retrieved?.attemptedQueries)
        ? retrieved.attemptedQueries.map((query) => String(query || '').trim()).filter(Boolean)
        : [];
      queryTranslationApplied = queryTranslationApplied || Boolean(retrieved?.queryTranslationApplied);
      translateCallsCount += Number(retrieved?.translateCallsCount || 0);
      queryTranslationMs += Number(retrieved?.translateMs || 0);
      usedSemanticFallback = Boolean(retrieved?.usedSemanticFallback);
      topScore = Number(retrieved?.topScore || 0);
      topTermHits = Number(retrieved?.topTermHits || 0);
      solrCallsCount = Number(retrieved?.solrCallsCount || 0);
    }
  } else {
    const retrieved = await retrieveDocumentsWithSolr({
      queryForRAG: expanded.canonicalQuery,
      multilingualRetrievalQueries: expanded.expandedQueries,
      userLanguage,
      retrievalIndexLanguage,
      restrictToDepartment: input.retrievalOptions?.restrictToDepartment,
      departmentCode: input.retrievalOptions?.departmentCode,
      fileScopeIds: input.retrievalOptions?.fileScopeIds,
      metadataFilters: input.retrievalOptions?.metadataFilters,
      ragBackendUrl: input.retrievalOptions?.ragBackendUrl,
      ragBackendCollectionName: input.retrievalOptions?.ragBackendCollectionName,
      solrTimeoutMs: input.retrievalOptions?.solrTimeoutMs,
      ragBackendTimeoutMs: input.retrievalOptions?.ragBackendTimeoutMs,
      solrRows: input.retrievalOptions?.solrRows,
      maxSolrCalls: input.retrievalOptions?.maxSolrCalls,
      relevanceMinScore: input.retrievalOptions?.relevanceMinScore,
      onLog: (event, payload) => {
        if (event === 'solr_result' && payload) {
          log(
            `[RAG PIPELINE] solr_query="${String(payload.query || '')}" doc_count=${Number(payload.docs || 0)} top_score=${Number(payload.top_score || 0)}`,
          );
          return;
        }
        log(`[RAG PIPELINE] ${event}${payload ? ` ${JSON.stringify(payload)}` : ''}`);
      },
    });
    docs = retrieved.docs;
    retrievalQueryUsed = String(retrieved.retrievalQueryUsed || retrievalQueryUsed);
    attemptedQueries = Array.isArray(retrieved.attemptedQueries)
      ? retrieved.attemptedQueries.map((query) => String(query || '').trim()).filter(Boolean)
      : [];
    queryTranslationApplied = queryTranslationApplied || retrieved.queryTranslationApplied;
    translateCallsCount += Number(retrieved.translateCallsCount || 0);
    queryTranslationMs += Number(retrieved.translateMs || 0);
    usedSemanticFallback = retrieved.usedSemanticFallback;
    topScore = Number(retrieved.topScore || 0);
    topTermHits = Number(retrieved.topTermHits || 0);
    solrCallsCount = Number(retrieved.solrCallsCount || 0);
  }
  const retrievalMs = Date.now() - retrievalStart;
  if (attemptedQueries.length > 0) {
    log(`[RAG PIPELINE] solr_queries=${attemptedQueries.join(' | ')}`);
  }
  if (queryTranslationApplied) {
    log(
      `[RAG] query_translation_applied ${JSON.stringify({
        canonical_query: expanded.canonicalQuery,
        retrieval_query_used: retrievalQueryUsed,
        attempted_queries: attemptedQueries.slice(0, 8),
      })}`,
    );
  }
  log(`[RAG PIPELINE] retrieval_query="${retrievalQueryUsed}" docs=${docs.length} topScore=${topScore.toFixed(3)} topTermHits=${topTermHits}`);

  const confidenceHighThreshold = Math.max(
    10.1,
    Number(process.env.RAG_CONFIDENCE_HIGH || 25),
  );
  const confidenceMediumThreshold = Math.max(
    0,
    Math.min(confidenceHighThreshold - 0.1, Number(process.env.RAG_CONFIDENCE_MEDIUM || 10)),
  );
  let retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
  let confidenceLevel: 'high' | 'medium' | 'low' =
    retrievalConfidence > confidenceHighThreshold
      ? 'high'
      : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
  log(`[RAG PIPELINE] retrieval_confidence=${retrievalConfidence.toFixed(3)}`);
  log(`[RAG PIPELINE] retrieval_confidence_score=${retrievalConfidence.toFixed(3)}`);
  log(`[RAG PIPELINE] confidence_level=${confidenceLevel}`);
  logMetricStage('retrieval_confidence', {
    score: Number(retrievalConfidence.toFixed(3)),
    level: confidenceLevel,
    top_score: Number(topScore.toFixed(3)),
    top_term_hits: topTermHits,
  });

  let skipRerankDueToEarlyExit = false;
  let skipRerankDueToPolicy = false;
  const preRerankScoreMargin = computeTopScoreMargin(docs, topScore);
  const preRerankSourceConsistency = computeSourceConsistency(docs);
  if (routingEnabled && RAG_EARLY_EXIT_ENABLED) {
    const earlyExitDecision = evaluateEarlyExit({
      route,
      retrievalConfidence,
      docCount: docs.length,
      scoreMargin: preRerankScoreMargin,
      topTermHits,
      sourceConsistency: preRerankSourceConsistency,
      thresholds: {
        minConfidence: RAG_EARLY_EXIT_MIN_CONFIDENCE,
        minDocs: RAG_EARLY_EXIT_MIN_DOCS,
        minScoreMargin: RAG_EARLY_EXIT_MIN_SCORE_MARGIN,
        minTopTermHits: RAG_EARLY_EXIT_MIN_TOP_TERM_HITS,
        minSourceConsistency: RAG_EARLY_EXIT_MIN_SOURCE_CONSISTENCY,
      },
    });
    skipRerankDueToEarlyExit = earlyExitDecision.apply;
    log(
      `[RAG_EARLY_EXIT] applied=${earlyExitDecision.apply ? 1 : 0} reason=${earlyExitDecision.reason} required_confidence=${earlyExitDecision.requiredConfidence.toFixed(3)} score_margin=${preRerankScoreMargin.toFixed(3)} source_consistency=${preRerankSourceConsistency.toFixed(3)}`,
    );
    recordRagDecision('early_exit', {
      enabled: 1,
      applied: earlyExitDecision.apply ? 1 : 0,
      reason: earlyExitDecision.reason,
      route_classification: route.klass,
      retrieval_confidence: Number(retrievalConfidence.toFixed(3)),
      required_confidence: Number(earlyExitDecision.requiredConfidence.toFixed(3)),
      doc_count: docs.length,
      score_margin: Number(preRerankScoreMargin.toFixed(3)),
      top_term_hits: topTermHits,
      source_consistency: Number(preRerankSourceConsistency.toFixed(3)),
    }, log);
  }

  if (docs.length > 0 && !skipRerankDueToEarlyExit && RAG_SELECTIVE_RERANK_ENABLED) {
    const rerankDecision = evaluateRerankPolicy({
      routeClass: route.klass,
      docCount: docs.length,
      retrievalConfidence,
      scoreMargin: preRerankScoreMargin,
      topTermHits,
      sourceConsistency: preRerankSourceConsistency,
      topScores: docs.slice(0, 6).map((doc) => Number(doc?.score || 0)),
    });
    skipRerankDueToPolicy = !rerankDecision.apply;
    log(
      `[RAG_RERANK_POLICY] applied=${rerankDecision.apply ? 1 : 0} reason=${rerankDecision.reason} score_entropy=${rerankDecision.scoreEntropy.toFixed(3)} doc_count=${docs.length} retrieval_confidence=${retrievalConfidence.toFixed(3)}`,
    );
    recordRagDecision('rerank_policy', {
      enabled: 1,
      applied: rerankDecision.apply ? 1 : 0,
      reason: rerankDecision.reason,
      score_entropy: Number(rerankDecision.scoreEntropy.toFixed(3)),
      route_classification: route.klass,
      retrieval_confidence: Number(retrievalConfidence.toFixed(3)),
      doc_count: docs.length,
      score_margin: Number(preRerankScoreMargin.toFixed(3)),
      top_term_hits: topTermHits,
      source_consistency: Number(preRerankSourceConsistency.toFixed(3)),
    }, log);
  }

  const rerankStageStart = Date.now();
  if (docs.length > 0 && !skipRerankDueToEarlyExit && !skipRerankDueToPolicy) {
    const llmRerankEnabled = String(process.env.RAG_LLM_RERANK_ENABLED || '0') !== '0';
    if (confidenceLevel === 'low' && llmRerankEnabled) {
      try {
        const llmReranked = await llmRerankDocuments(
          String(input.query || retrievalQueryUsed || '').trim(),
          docs,
        );
        if (Array.isArray(llmReranked) && llmReranked.length > 0) {
          docs = llmReranked;
          log(`[RAG PIPELINE] llm_rerank_applied docs=${docs.length}`);
        }
      } catch (llmRerankError) {
        log(
          `[RAG PIPELINE] llm_rerank_error ${JSON.stringify({
            message: (llmRerankError as any)?.message || String(llmRerankError),
          })}`,
        );
      }
    }

    const rerankQueryUsed = [String(expanded.canonicalQuery || '').trim(), String(retrievalQueryUsed || '').trim()]
      .filter(Boolean)
      .join(' ');
    if (input.rerankDocuments) {
      docs = await input.rerankDocuments({ docs, retrievalQueryUsed: rerankQueryUsed || retrievalQueryUsed });
    } else {
      const ranked = rerankDocumentsDefault(docs, rerankQueryUsed || retrievalQueryUsed);
    docs = ranked.docs;
    topTermHits = ranked.topTermHits;
    topScore = ranked.topScore;
  }
  }
  if (skipRerankDueToEarlyExit) {
    log('[RAG PIPELINE] rerank_skipped reason=early_exit');
  }
  if (skipRerankDueToPolicy) {
    log('[RAG PIPELINE] rerank_skipped reason=selective_policy');
  }
  rerankMs = Date.now() - rerankStageStart;
  retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
  confidenceLevel =
    retrievalConfidence > confidenceHighThreshold
      ? 'high'
      : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
  log(`[RAG PIPELINE] reranked_docs=${docs.length}`);
  log(`[RAG PIPELINE] doc_count=${docs.length} top_score=${topScore.toFixed(3)}`);
  const topSources = docs
    .slice(0, 3)
    .map((doc) =>
      String(
        (Array.isArray(doc?.title) ? doc.title[0] : doc?.title) ||
        doc?.file_name_s ||
        doc?.id ||
        'unknown',
      ))
    .join(' | ');
  if (topSources) {
    log(`[RAG PIPELINE] top_sources=${topSources}`);
  }
  const topicalFilteredDocs = filterClockInCorrectionDocs(
    docs,
    [
      String(input.query || '').trim(),
      String(expanded.canonicalQuery || '').trim(),
      String(retrievalQueryUsed || '').trim(),
    ].filter(Boolean).join(' '),
  );
  if (topicalFilteredDocs.length !== docs.length) {
    log(
      `[RAG] topic_filtered_docs ${JSON.stringify({
        before_count: docs.length,
        after_count: topicalFilteredDocs.length,
      })}`,
    );
    docs = topicalFilteredDocs;
    topScore = Number(docs?.[0]?.score || 0);
    topTermHits = Math.max(...docs.map((doc) => countDocTermHits(doc, extractQueryTermsForRerank(retrievalQueryUsed))), 0);
    retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
    confidenceLevel =
      retrievalConfidence > confidenceHighThreshold
        ? 'high'
        : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
  }
  if (RAG_DOMAIN_FILTER_ENABLED && docs.length > 0 && DOMAIN_NAMES.length > 0) {
    const predictedDomain = predictDomainFromQuery([
      String(input.query || '').trim(),
      String(expanded.canonicalQuery || '').trim(),
      String(retrievalQueryUsed || '').trim(),
    ].filter(Boolean).join(' '));
    if (predictedDomain) {
      const beforeCount = docs.length;
      const domainFiltered = docs.filter((doc) => docMatchesPredictedDomain(doc, predictedDomain));
      if (domainFiltered.length > 0) {
        docs = domainFiltered;
      }
      topScore = Number(docs?.[0]?.score || 0);
      topTermHits = Math.max(...docs.map((doc) => countDocTermHits(doc, extractQueryTermsForRerank(retrievalQueryUsed))), 0);
      retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
      confidenceLevel =
        retrievalConfidence > confidenceHighThreshold
          ? 'high'
          : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
      log(
        `[RAG] domain_filter_applied ${JSON.stringify({
          predicted_domain: predictedDomain,
          before_count: beforeCount,
          after_count: docs.length,
          keywords_configured: DOMAIN_KEYWORD_MAP[predictedDomain]?.length || 0,
        })}`,
      );
    }
  }

  const retrievalSignalQuery = [
    String(input.query || '').trim(),
    String(expanded.canonicalQuery || '').trim(),
    String(retrievalQueryUsed || '').trim(),
    ...expanded.expandedQueries.map((query) => String(query || '').trim()).filter(Boolean),
  ]
    .filter(Boolean)
    .join(' ');
  const chunkFilterStageStart = Date.now();
  const retrievedChunkResult = retrieveChunks({
    docs,
    query: retrievalSignalQuery,
    topScore,
    maxDocuments: RAG_MAX_DOCUMENTS,
    logger: log,
  });
  docs = retrievedChunkResult.docs;
  topScore = Number(docs?.[0]?.score || 0);
  const retrievalTerms = extractQueryTermsForRerank(retrievalSignalQuery);
  topTermHits = Math.max(...docs.map((doc) => countDocTermHits(doc, retrievalTerms)), 0);
  retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
  confidenceLevel =
    retrievalConfidence > confidenceHighThreshold
      ? 'high'
      : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
  log(
    `[RAG] retrieval_score ${JSON.stringify({
      doc_count: docs.length,
      kept_doc_ids: retrievedChunkResult.docIds,
      top_score: Number(topScore.toFixed(3)),
      top_term_hits: topTermHits,
      retrieval_confidence: Number(retrievalConfidence.toFixed(3)),
    })}`,
  );

  const anchorEvidenceText = docs
    .slice(0, 3)
    .map((doc) => {
      const content = Array.isArray(doc?.content_txt)
        ? String(doc.content_txt.join(' ') || '')
        : String(doc?.content_txt || doc?.content || '');
      return content;
    })
    .filter(Boolean)
    .join(' ');
  const anchorContextText = [
    String(input.query || '').trim(),
    anchorEvidenceText,
  ].filter(Boolean).join(' ');
  const anchorTokens = extractAnchorTokens(anchorContextText);
  const hasCrossLanguageExpansion =
    /[a-z]/i.test(String(expanded.canonicalQuery || '')) &&
    expanded.expandedQueries.some((query) => hasJapaneseChars(String(query || '')));
  const effectiveAnchorMinOverlap =
    hasCrossLanguageExpansion && expanded.expandedQueries.length >= 3
      ? Math.max(RAG_ANCHOR_MIN_OVERLAP, 2)
      : RAG_ANCHOR_MIN_OVERLAP;
  const anchorValidationActive = RAG_ANCHOR_VALIDATION_ENABLED && anchorTokens.length > 0;
  if (docs.length > 0 && anchorValidationActive) {
    const candidateDocs = docs;
    const beforeCount = candidateDocs.length;
    const filtered = candidateDocs.filter((doc) => countAnchorOverlapForDoc(doc, anchorTokens) >= effectiveAnchorMinOverlap);
    const removedCount = Math.max(0, beforeCount - filtered.length);
    if (removedCount > 0) {
      log(
        `[RAG] irrelevant_docs_filtered ${JSON.stringify({
          before_count: beforeCount,
          after_count: filtered.length,
          removed_count: removedCount,
          anchor_tokens: anchorTokens.slice(0, 12),
          min_overlap: effectiveAnchorMinOverlap,
        })}`,
      );
    }
    if (filtered.length > 0) {
      docs = filtered;
      topScore = Number(docs?.[0]?.score || 0);
      topTermHits = Math.max(
        ...docs.map((doc) => countAnchorOverlapForDoc(doc, anchorTokens)),
        0,
      );
      retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
      confidenceLevel =
        retrievalConfidence > confidenceHighThreshold
          ? 'high'
          : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
      log(
        `[RAG] anchor_validation_passed ${JSON.stringify({
          doc_count: docs.length,
          anchor_overlap_threshold: effectiveAnchorMinOverlap,
          matched_anchor_tokens: findMatchedAnchorTokens(docs, anchorTokens),
        })}`,
      );
    } else {
      docs = candidateDocs;
      topScore = Number(docs?.[0]?.score || 0);
      topTermHits = Math.max(
        ...docs.map((doc) => countAnchorOverlapForDoc(doc, anchorTokens)),
        0,
      );
      retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
      confidenceLevel =
        retrievalConfidence > confidenceHighThreshold
          ? 'high'
          : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
      log(
        `[RAG] anchor_validation_relaxed_no_overlap ${JSON.stringify({
          before_count: beforeCount,
          after_count: docs.length,
          anchor_overlap_threshold: effectiveAnchorMinOverlap,
          retrieval_query_used: retrievalQueryUsed,
          anchor_tokens: anchorTokens.slice(0, 12),
        })}`,
      );
    }
  }

  if (docs.length > 0) {
    const filtered = filterChunks({
      docs,
      query: retrievalSignalQuery,
      topScore,
      queryLanguage: userLanguage,
      minTermOverlap: RAG_MIN_TERM_OVERLAP_STRICT,
      minSemanticSimilarity: RAG_MIN_SEMANTIC_SIMILARITY,
      logger: log,
    });
    docs = filtered.chunks.map((chunk) => chunk.row);
    if (filtered.filteredCount > 0) {
      log(
        `[RAG] filtered_chunks ${JSON.stringify({
          before_count: filtered.filteredCount + docs.length,
          after_count: docs.length,
          removed_count: filtered.filteredCount,
          chunk_filter_mode: filtered.mode,
          final_kept_chunk_count: filtered.keptCount,
          min_term_overlap: RAG_MIN_TERM_OVERLAP_STRICT,
          min_semantic_similarity: Number(RAG_MIN_SEMANTIC_SIMILARITY.toFixed(3)),
        })}`,
      );
    }
    if (docs.length > 0) {
      const selectedEvidence = selectEvidence({
        chunks: filtered.chunks,
        maxChunks: RAG_MAX_EVIDENCE_CHUNKS,
        allowCrossDocumentFallback: RAG_EVIDENCE_ALLOW_CROSS_DOC_FALLBACK,
      });
      docs = selectedEvidence.chunks.map((chunk) => chunk.row);
      log(
        `[RAG] evidence_selection ${JSON.stringify({
          selected_chunks: docs.length,
          fallback_triggered: selectedEvidence.fallbackTriggered,
          max_chunks: RAG_MAX_EVIDENCE_CHUNKS,
        })}`,
      );
      topScore = Number(docs?.[0]?.score || 0);
      const overlapTerms = extractQueryTermsForRerank(retrievalSignalQuery);
      topTermHits = Math.max(
        ...docs.map((doc) => countDocTermHits(doc, overlapTerms)),
        0,
      );
      retrievalConfidence = Number(topScore || 0) * Math.log(Math.max(0, docs.length) + 1);
      confidenceLevel =
        retrievalConfidence > confidenceHighThreshold
          ? 'high'
          : (retrievalConfidence >= confidenceMediumThreshold ? 'medium' : 'low');
    } else {
      topScore = 0;
      topTermHits = 0;
      retrievalConfidence = 0;
      confidenceLevel = 'low';
      usedSemanticFallback = true;
    }
  }
  chunkFilterMs = Date.now() - chunkFilterStageStart;
  if (docs.length > 0) {
    const previewSource = String(
      (Array.isArray(docs?.[0]?.title) ? docs[0].title[0] : docs?.[0]?.title) ||
      docs?.[0]?.file_name_s ||
      docs?.[0]?.id ||
      '',
    ).trim();
    if (previewSource) {
      log(
        `[RAG] preview_ready ${JSON.stringify({
          doc_count: docs.length,
          source: previewSource,
        })}`,
      );
    }
  }

  const matchedAnchorTokens = findMatchedAnchorTokens(docs, anchorTokens);
  if (docs.length > 0) {
    log(
      `[RAG PIPELINE] generation_gate_relaxed ${JSON.stringify({
        doc_count: docs.length,
        top_score: Number(topScore.toFixed(3)),
        top_term_hits: topTermHits,
        retrieval_confidence: Number(retrievalConfidence.toFixed(3)),
        anchor_tokens: anchorTokens,
        matched_anchor_tokens: matchedAnchorTokens,
        allow_generation: 1,
      })}`,
    );
  }

  const cacheFingerprint = collectResponseCacheFingerprint(docs);
  const cacheIndexVersion = String(
    RESPONSE_CACHE_INDEX_VERSION ||
    input.retrievalOptions?.ragBackendCollectionName ||
    '',
  ).trim();
  const responseCacheKey = generateCacheKey({
    query: String(input.query || '').trim(),
    canonicalQuery: String(expanded.canonicalQuery || '').trim(),
    language: userLanguage,
    departmentCode: String(input.retrievalOptions?.departmentCode || ''),
    docIds: cacheFingerprint.docIds,
    chunkIds: cacheFingerprint.chunkIds,
    indexVersion: cacheIndexVersion,
    documentLastUpdated: cacheFingerprint.documentLastUpdated,
  });
  if (RESPONSE_CACHE_ENABLED && docs.length > 0) {
    const cached = getCachedResponse<CachedPipelineResponse>(responseCacheKey);
    if (cached && String(cached.answer || '').trim()) {
      pipelineMode = 'CACHE_HIT';
      log(
        `[RAG PIPELINE] response_cache_hit=true docs=${docs.length} doc_ids=${cacheFingerprint.docIds.length} chunk_ids=${cacheFingerprint.chunkIds.length} updated_markers=${cacheFingerprint.documentLastUpdated.length} index_version=${cacheIndexVersion || 'none'}`,
      );
      logRagMetric({
        retrievalMs,
        generationMs: 0,
        translationMs: queryTranslationMs,
        cacheHit: true,
        pipelineMode,
      });
      logRagTiming(0);
      return {
        userLanguage,
        retrievalIndexLanguage,
        normalizedQuery: expanded.normalizedQuery,
        queryForRAG: expanded.canonicalQuery,
        multilingualRetrievalQueries: expanded.expandedQueries,
        intentVariants: expanded.intentVariants,
        queryTranslationApplied,
        translateCallsCount,
        queryTranslationMs,
        retrievalQueryUsed,
        docs,
        prompt: String(cached.prompt || ''),
        answer: String(cached.answer || ''),
        sources: Array.isArray(cached.sources) ? cached.sources : [],
        metrics: {
          documentCount: countDistinctDocuments(docs),
          promptLength: String(cached.prompt || '').length,
          retrievalMs,
          llmMs: 0,
          topScore,
          topTermHits,
          retrievalConfidence: Number(retrievalConfidence.toFixed(3)),
          confidenceLevel,
          usedSemanticFallback,
          solrCallsCount,
        },
      };
    }
  }

  let prompt = String(input.prompt || '');
  let sources: ContextSource[] = [];
  let answer = '';
  let llmMs = 0;
  let fastAnswerApplied = false;
  const proceduralQuery = isProceduralQuery(
    String(input.query || input.prompt || '').trim(),
    route.klass,
  );
  const fastExtractiveBlockedByComplianceIntent =
    /(?:\bwhat\s+should\b|\bdo\s+if\b|\bwithout\s+taking\s+a?\s*break\b|\bno\s*break\b|休憩なし|無休憩|休憩を取らず)/i
      .test(String(input.query || input.prompt || ''));
  const distinctDocumentCount = countDistinctDocuments(docs);
  if (fastExtractiveBlockedByComplianceIntent) {
    log('[RAG PIPELINE] fast_extractive_disabled reason=compliance_conditional_query');
  }

  if (
    docs.length > 0 &&
    typeof input.buildFastAnswer === 'function' &&
    FAST_EXTRACTIVE_MODE_ENABLED &&
    !fastExtractiveBlockedByComplianceIntent
  ) {
    try {
      const fastAnswerResult = await input.buildFastAnswer({
        docs,
        retrievalQueryUsed,
        userLanguage,
        queryForRAG: expanded.canonicalQuery,
        originalQuery: String(input.query || input.prompt || '').trim(),
      });
      const fastAnswer = String(fastAnswerResult?.answer || '').trim();
      if (fastAnswer) {
        answer = fastAnswer;
        if (Array.isArray(fastAnswerResult?.sources) && fastAnswerResult.sources.length > 0) {
          sources = fastAnswerResult.sources;
        }
        fastAnswerApplied = true;
        pipelineMode = 'FAST_EXTRACTIVE';
        log(
          `[RAG PIPELINE] fast_answer_applied ${JSON.stringify({
            source_count: sources.length,
            query: String(input.query || '').slice(0, 120),
          })}`,
        );
      }
    } catch (fastAnswerError) {
      log(
        `[RAG PIPELINE] fast_answer_error ${JSON.stringify({
          message: (fastAnswerError as any)?.message || String(fastAnswerError),
        })}`,
      );
    }
  }

  const fastExtractiveEligibility =
    FAST_EXTRACTIVE_MODE_ENABLED &&
    !fastAnswerApplied &&
    !proceduralQuery &&
    !fastExtractiveBlockedByComplianceIntent &&
    retrievalConfidence > RAG_FAST_EXTRACTIVE_MIN_CONFIDENCE &&
    distinctDocumentCount === RAG_FAST_EXTRACTIVE_REQUIRED_DOC_COUNT &&
    topTermHits >= RAG_FAST_EXTRACTIVE_REQUIRED_TOP_TERM_HITS;
  if (fastExtractiveEligibility) {
    const extractive = buildFastExtractiveAnswer({
      docs,
      query: [
        String(input.query || '').trim(),
        String(retrievalQueryUsed || '').trim(),
        ...expanded.expandedQueries.map((query) => String(query || '').trim()).filter(Boolean),
      ].filter(Boolean).join(' '),
      language: userLanguage,
    });
    if (extractive && String(extractive.answer || '').trim()) {
      answer = extractive.answer;
      sources = extractive.sources;
      fastAnswerApplied = true;
      pipelineMode = 'FAST_EXTRACTIVE';
      log('FAST_EXTRACTIVE_MODE_ENABLED');
      log(
        `[RAG PIPELINE] fast_extractive_mode ${JSON.stringify({
          retrieval_confidence_score: Number(retrievalConfidence.toFixed(3)),
          doc_count: docs.length,
          source_count: sources.length,
          top_term_hits: topTermHits,
        })}`,
      );
    }
  }
  if (
    FAST_EXTRACTIVE_MODE_ENABLED &&
    !fastAnswerApplied &&
    !proceduralQuery &&
    !fastExtractiveBlockedByComplianceIntent &&
    !fastExtractiveEligibility
  ) {
    log(
      `[RAG PIPELINE] fast_extractive_disabled reason=strict_gate_not_met retrieval_confidence=${Number(retrievalConfidence.toFixed(3))} required_confidence_gt=${RAG_FAST_EXTRACTIVE_MIN_CONFIDENCE} doc_count=${distinctDocumentCount} required_doc_count=${RAG_FAST_EXTRACTIVE_REQUIRED_DOC_COUNT} top_term_hits=${topTermHits} required_top_term_hits=${RAG_FAST_EXTRACTIVE_REQUIRED_TOP_TERM_HITS}`,
    );
  }
  if (!FAST_EXTRACTIVE_MODE_ENABLED && !proceduralQuery) {
    log('[RAG PIPELINE] fast_extractive_disabled reason=flag_off');
  }
  if (proceduralQuery) {
    log('[RAG PIPELINE] fast_extractive_disabled reason=procedural_query');
  }

  if (!fastAnswerApplied && docs.length > 0) {
    const promptBuildStart = Date.now();
    const builtPrompt = buildPrompt({
      query: String(input.query || input.prompt || '').trim(),
      chunks: docs,
      maxContextTokens: RAG_CONTEXT_MAX_TOKENS,
    });
    if (builtPrompt.contextTokens > 0) {
      prompt = builtPrompt.prompt;
      sources = builtPrompt.sources;
    } else if (input.buildContext) {
      const built = await input.buildContext({ docs, retrievalQueryUsed });
      prompt = built.prompt;
      sources = built.sources;
    } else {
      const contextQueryTerms = Array.from(new Set([
        String(retrievalQueryUsed || '').trim(),
        String(expanded.canonicalQuery || '').trim(),
        String(input.query || '').trim(),
        ...((expanded.expandedQueries || []).map((q) => String(q || '').trim())),
      ].filter(Boolean)));
      const contextRetrievalQuery = contextQueryTerms.join(' ');
      const built = buildContextFromDocs({
        docs,
        retrievalQuery: contextRetrievalQuery,
        maxChunks: RAG_MAX_EVIDENCE_CHUNKS,
        contextBudgetChars: Math.max(800, Number(input.contextOptions?.contextBudgetChars || 900 * 4)),
        docContextChars: Math.max(300, Number(input.contextOptions?.docContextChars || 1200)),
      });
      if (built.usedChunks > 0) {
        prompt = `USER QUESTION:\n${String(input.query || input.prompt || '').trim()}\n\nDOCUMENT CONTEXT:\n${built.documentContent}`;
        sources = built.sources;
      }
    }
    prompt = enforcePromptTokenLimit(prompt, RAG_CONTEXT_MAX_TOKENS);
    log(
      `[RAG] llm_prompt_tokens ${JSON.stringify({
        context_token_limit: RAG_CONTEXT_MAX_TOKENS,
        prompt_tokens: estimateTokenCount(prompt),
      })}`,
    );
    promptBuildMs = Date.now() - promptBuildStart;
  }

  const hasRetrievedContext = /(?:RETRIEVED\s+)?DOCUMENT CONTEXT:/i.test(String(prompt || ''));
  const systemPrompt = buildEnterpriseRagSystemPrompt(userLanguage, hasRetrievedContext);
  const canRunSafeGeneration =
    docs.length > 0 &&
    hasRetrievedContext;
  if (fastAnswerApplied) {
    llmMs = 0;
    llmTtftMs = 0;
  } else if (!canRunSafeGeneration) {
    answer = noEvidenceReply(userLanguage);
    llmMs = 0;
    llmTtftMs = 0;
    log(
      `[RAG] safe_generation_triggered ${JSON.stringify({
        reason: !docs.length
          ? 'doc_count_below_threshold'
          : 'missing_retrieved_context',
        doc_count: docs.length,
        retrieval_confidence: Number(retrievalConfidence.toFixed(3)),
        min_doc_count: RAG_MIN_DOCS_FOR_LLM_GENERATION,
        has_retrieved_context: hasRetrievedContext,
      })}`,
    );
  } else if (input.generateAnswer) {
    const llmStart = Date.now();
    answer = await input.generateAnswer({
      prompt,
      userLanguage,
      hasRetrievedContext,
      systemPrompt,
    });
    llmMs = Date.now() - llmStart;
    llmTtftMs = llmMs;
  } else {
    const llmStart = Date.now();
    log('[RAG PIPELINE] generation_started mode=llm');
    answer = await generateEvidenceFirstGroundedAnswer({
      query: String(input.query || input.prompt || '').trim(),
      queryHints: Array.from(new Set([
        String(retrievalQueryUsed || '').trim(),
        String(expanded.canonicalQuery || '').trim(),
        ...((expanded.expandedQueries || []).map((q) => String(q || '').trim())),
      ].filter(Boolean))),
      prompt,
      userLanguage,
      systemPrompt,
      outputId: input.outputId,
      historyMessages: input.historyMessages,
      chatMaxPredict: Number(input.chatMaxPredict || process.env.RAG_CHAT_MAX_PREDICT || 420),
    });
    if (!String(answer || '').trim()) {
      answer = generationFailureReply(userLanguage);
      log('[RAG PIPELINE] empty_generation_fallback {"type":"generation_failure_reply"}');
    }
    llmMs = Date.now() - llmStart;
    llmTtftMs = Number(consumeLlmTtftMs(input.outputId) || 0);
    log(
      `[RAG PIPELINE] llm_latency_ms=${llmMs} prompt_length=${prompt.length} llm_prompt_tokens=${estimateTokenCount(prompt)} llm_ttft_ms=${Math.max(0, Math.round(llmTtftMs))}`,
    );
  }
  logMetricStage('llm_latency', {
    total_ms: Math.max(0, Math.round(llmMs)),
    ttft_ms: Math.max(0, Math.round(llmTtftMs)),
  });

  const finalAnswer =
    String(answer || '').trim() ||
    (hasRetrievedContext ? generationFailureReply(userLanguage) : noEvidenceReply(userLanguage));
  logMetricStage('retrieval_confidence', {
    score: Number(retrievalConfidence.toFixed(3)),
    level: confidenceLevel,
    top_score: Number(topScore.toFixed(3)),
    top_term_hits: topTermHits,
    final: 1,
  });

  const noEvidenceText = noEvidenceReply(userLanguage);
  const generationFailureText = generationFailureReply(userLanguage);
  const shouldExposeSources =
    docs.length > 0 &&
    finalAnswer !== noEvidenceText &&
    finalAnswer !== generationFailureText;
  const finalSources = shouldExposeSources ? sources : [];

  const result: RunRagPipelineResult = {
    userLanguage,
    retrievalIndexLanguage,
    normalizedQuery: expanded.normalizedQuery,
    queryForRAG: expanded.canonicalQuery,
    multilingualRetrievalQueries: expanded.expandedQueries,
    intentVariants: expanded.intentVariants,
    queryTranslationApplied,
    translateCallsCount,
    queryTranslationMs,
    retrievalQueryUsed,
    docs,
    prompt,
    answer: finalAnswer,
    sources: finalSources,
    metrics: {
      documentCount: countDistinctDocuments(docs),
      promptLength: prompt.length,
      retrievalMs,
      llmMs,
      topScore,
      topTermHits,
      retrievalConfidence: Number(retrievalConfidence.toFixed(3)),
      confidenceLevel,
      usedSemanticFallback,
      solrCallsCount,
    },
  };

  try {
    const retrievalHit = docs.length > 0;
    const usedFallback =
      usedSemanticFallback ||
      !retrievalHit ||
      finalAnswer === noEvidenceText ||
      finalAnswer === generationFailureText;
    const groundedAnswer =
      retrievalHit &&
      finalAnswer !== noEvidenceText &&
      finalAnswer !== generationFailureText;

    recordRagMetricEvent({
      retrievalHit,
      usedFallback,
      groundedAnswer,
      latencyMs: retrievalMs + llmMs,
    });
  } catch (metricsError) {
    log(
      `[RAG PIPELINE] metrics_record_error ${JSON.stringify({
        message: (metricsError as any)?.message || String(metricsError),
      })}`,
    );
  }
  logRagMetric({
    retrievalMs,
    generationMs: llmMs,
    translationMs: queryTranslationMs,
    cacheHit: false,
    pipelineMode,
  });
  logRagTiming(llmMs);

  if (RESPONSE_CACHE_ENABLED && String(finalAnswer || '').trim()) {
    const shouldCache =
      finalAnswer !== noEvidenceText &&
      finalAnswer !== generationFailureText;
    if (shouldCache && docs.length > 0) {
      const cachePayload: CachedPipelineResponse = {
        userLanguage: result.userLanguage,
        retrievalIndexLanguage: result.retrievalIndexLanguage,
        normalizedQuery: result.normalizedQuery,
        queryForRAG: result.queryForRAG,
        multilingualRetrievalQueries: result.multilingualRetrievalQueries,
        intentVariants: result.intentVariants,
        queryTranslationApplied: result.queryTranslationApplied,
        translateCallsCount: result.translateCallsCount,
        queryTranslationMs: result.queryTranslationMs,
        retrievalQueryUsed: result.retrievalQueryUsed,
        prompt: result.prompt,
        answer: result.answer,
        sources: result.sources,
        metrics: result.metrics,
      };
      setCachedResponse(responseCacheKey, cachePayload);
      log(
        `[RAG PIPELINE] response_cache_store=true docs=${cacheFingerprint.docIds.length} chunks=${cacheFingerprint.chunkIds.length} updated_markers=${cacheFingerprint.documentLastUpdated.length} index_version=${cacheIndexVersion || 'none'}`,
      );
    }
  }

  return result;
};
