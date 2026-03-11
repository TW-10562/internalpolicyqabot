import File from '@/mysql/model/file.model';
import KrdGenTask from '@/mysql/model/gen_task.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { IGenTaskOutputSer } from '@/types/genTaskOutput';
import { IGenTaskSer } from '@/types/genTask';
import { config } from '@config/index'
import dns from 'node:dns';
import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import { execute } from '../service/task.dispatch';
import { put, queryList } from '../utils/mapper';
import redis from '@/clients/redis';

import { loadRagProcessor } from '@/service/loadRagProcessor';
import {
  formatSingleLanguageOutput,
  translateText,
  LanguageCode
} from '@/utils/translation';
import { translateQueryForRetrieval as translateQueryKeywordsForRetrieval } from '@/utils/query_translation';
import { classifyQueryIntent as classifySharedQueryIntent, QueryIntent as SharedQueryIntent } from '@/utils/queryIntentClassifier';
import { chatStoreRedis } from '@/service/chatStoreRedis';
import { publishChatStreamEvent } from '@/service/chatStreamService';
import { persistChatTurn } from '@/service/historyPersistenceService';
import { createNotification } from '@/service/notificationService';
import { normalizeDepartmentCode, normalizeRoleCode } from '@/service/rbac';
import { recordContentFlagEvent, recordQueryEvent } from '@/service/analyticsService';
import {
  buildFallbackWildcardQuery,
  canonicalizeRagQuery,
  resolveBucketCorpusLanguage,
  rewriteRagQueryWithSynonyms,
} from '@/service/ragQueryHeuristics';
import { runBoundedSolrRetrieval } from '@/service/ragRetrievalPlanner';
import { runRagPipeline } from '@/rag/pipeline/ragPipeline';
import { routeQuery } from '@/rag/query/queryRouter';
import { canonicalizeQuery } from '@/rag/query/canonicalizeQuery';
import {
  detectRagLanguage,
  japaneseCharRatio,
  looksMostlyEnglish,
} from '@/rag/language/detectLanguage';
import { formatGroundedAnswer } from '@/rag/generation/groundedFormatter';
import { recordRagDecision } from '@/rag/metrics/ragDecisionMetrics';
import {
  normalizeSearchToken,
  shouldKeepQueryToken,
} from '@/rag/retrieval/solrRetriever';
import {
  buildRetrievalCandidates,
  extractCjkTerms,
  countFileTokenHits,
  countDocTermHits,
  extractQueryTermsForRerank,
  scoreFileForQuery,
  tokenizeQueryForFileScope,
} from '@/rag/retrieval/reranker';
import {
  buildContextFromDocs,
  normalizeEvidenceLine,
} from '@/rag/context/contextBuilder';
import {
  buildEnterpriseRagSystemPrompt,
  generationFailureReply,
  noEvidenceReply,
} from '@/rag/generation/promptBuilder';
import {
  callLLM,
  generateWithLLM,
} from '@/rag/generation/llmGenerator';

dns.setDefaultResultOrder('ipv4first');

const getChatModelName = () => {
  return (
    process.env.OLLAMA_MODEL ||
    (config as any)?.Models?.chatModel?.name ||
    (config as any)?.Ollama?.model ||
    'openai/gpt-oss-20b'
  );
};

const getChatTitleModelName = () => {
  return (
    process.env.OLLAMA_TITLE_MODEL ||
    process.env.OLLAMA_MODEL ||
    (config as any)?.Models?.chatTitleGenModel?.name ||
    (config as any)?.Models?.chatModel?.name ||
    (config as any)?.Ollama?.model ||
    'openai/gpt-oss-20b'
  );
};

const parseMetadataSafe = (raw: string): Record<string, any> => {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Keep worker resilient to malformed legacy metadata rows.
    return { prompt: String(raw || '') };
  }
};

const parseHistoryUserText = (rawMetadata: unknown): string => {
  const text = String(rawMetadata || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const fromPayload = String(parsed?.originalQuery || parsed?.prompt || '').trim();
    return fromPayload || text;
  } catch {
    return text;
  }
};

const escapeTermsValue = (value: string) => String(value || '').replace(/([,\\])/g, '\\$1');
const SOLR_TIMEOUT_MS = Math.max(1000, Number(process.env.RAG_SOLR_TIMEOUT_MS || 12000));
const RAG_BACKEND_TIMEOUT_MS = Math.max(800, Number(process.env.RAG_BACKEND_TIMEOUT_MS || 6000));
const SOLR_DEPARTMENT_BOOST = Math.max(0, Number(process.env.RAG_SOLR_DEPARTMENT_BOOST || 20));
const CHAT_HISTORY_TURNS = Math.max(0, Number(process.env.RAG_CHAT_HISTORY_TURNS || 2));
const RAG_RELEVANCE_MIN_SCORE = Math.max(10, Number(process.env.RAG_RELEVANCE_MIN_SCORE || 10));
const SOLR_ROWS = Math.max(2, Number(process.env.RAG_SOLR_ROWS || 4));
const RAG_SOLR_MAX_CALLS = Math.max(2, Number(process.env.RAG_SOLR_MAX_CALLS || 6));
const QUERY_TRANSLATION_TIMEOUT_MS = Math.max(
  1600,
  Math.min(7000, Number(process.env.RAG_QUERY_TRANSLATION_TIMEOUT_MS || 3200)),
);
const QUERY_TRANSLATION_CACHE_TTL_MS = Math.max(1000, Number(process.env.RAG_QUERY_TRANSLATION_CACHE_TTL_MS || 300000));
const QUERY_TRANSLATION_NEGATIVE_CACHE_TTL_MS = Math.max(
  3000,
  Number(process.env.RAG_QUERY_TRANSLATION_NEGATIVE_CACHE_TTL_MS || 8000),
);
const FINAL_TRANSLATION_TIMEOUT_MS = Math.max(2000, Number(process.env.RAG_FINAL_TRANSLATION_TIMEOUT_MS || 6000));
const DOC_CONTEXT_CHARS = Math.max(600, Number(process.env.RAG_DOC_CONTEXT_CHARS || 1200));
const RAG_MAX_CONTEXT_CHUNKS = Math.max(1, Number(process.env.RAG_MAX_CONTEXT_CHUNKS || 3));
const RAG_MAX_CONTEXT_TOKENS = Math.max(200, Number(process.env.RAG_MAX_CONTEXT_TOKENS || 900));
const RAG_CONTEXT_CHARS_PER_TOKEN = Math.max(2, Number(process.env.RAG_CONTEXT_CHARS_PER_TOKEN || 4));
const CHAT_MAX_PREDICT = Math.max(
  120,
  Number(process.env.RAG_CHAT_MAX_PREDICT || process.env.RAG_MAX_OUTPUT_TOKENS || 420),
);
const TITLE_MAX_PREDICT = Math.max(24, Number(process.env.RAG_TITLE_MAX_PREDICT || 48));
const LLM_TIMEOUT_MS = Math.max(20000, Number(process.env.RAG_LLM_TIMEOUT_MS || 90000));
const ASYNC_CHAT_TITLE = String(process.env.RAG_ASYNC_CHAT_TITLE || '1') === '1';
const USE_LLM_FOR_TITLE = String(process.env.RAG_TITLE_WITH_LLM || '0') === '1';
const ALLOW_SUPERADMIN_CROSS_DEPT = String(process.env.RAG_ALLOW_SUPERADMIN_CROSS_DEPT || '1') === '1';
const AUTO_ROUTE_DEPARTMENT = String(process.env.RAG_AUTO_ROUTE_DEPARTMENT || '1') === '1';
const RAG_STAGE1_PREFILTER_ENABLED = String(process.env.RAG_STAGE1_PREFILTER_ENABLED || '1') === '1';
const RAG_STAGE3_POSTFILTER_ENABLED = String(process.env.RAG_STAGE3_POSTFILTER_ENABLED || '1') === '1';
const RAG_STAGE1_MAX_FILE_IDS = Math.max(4, Number(process.env.RAG_STAGE1_MAX_FILE_IDS || 24));
const RAG_STAGE1_STRICT_FILE_IDS = Math.max(4, Number(process.env.RAG_STAGE1_STRICT_FILE_IDS || 12));
const RAG_STAGE1_EXPANDED_FILE_IDS = Math.max(RAG_STAGE1_STRICT_FILE_IDS + 2, Number(process.env.RAG_STAGE1_EXPANDED_FILE_IDS || 40));
const RAG_STAGE1_MIN_SCOPE_SIZE = Math.max(2, Number(process.env.RAG_STAGE1_MIN_SCOPE_SIZE || 3));
const RAG_STAGE1_MIN_SCOPE_CONFIDENCE = Math.min(
  0.95,
  Math.max(0.45, Number(process.env.RAG_STAGE1_MIN_SCOPE_CONFIDENCE || 0.64)),
);
const RAG_INTENT_CONFIDENCE_THRESHOLD = Math.min(0.95, Math.max(0.4, Number(process.env.RAG_INTENT_CONFIDENCE_THRESHOLD || 0.62)));
const RAG_DEBUG_FILTER_TRACE = String(process.env.RAG_DEBUG_FILTER_TRACE || '0') === '1';
const RAG_ANSWER_CACHE = String(process.env.RAG_ANSWER_CACHE || '0') === '1';
const RAG_ANSWER_CACHE_TTL_SEC = Math.max(60, Number(process.env.RAG_ANSWER_CACHE_TTL_SEC || 3600));
const RAG_ANSWER_CACHE_MAX_BYTES = Math.max(512, Number(process.env.RAG_ANSWER_CACHE_MAX_BYTES || 40000));
const RAG_CACHE_MIN_ANSWER_CHARS = Math.max(32, Number(process.env.RAG_CACHE_MIN_ANSWER_CHARS || 96));
const RAG_CACHE_MIN_ANSWER_LINES = Math.max(1, Number(process.env.RAG_CACHE_MIN_ANSWER_LINES || 2));
const RAG_CACHE_REJECT_WEAK_HOWTO = String(process.env.RAG_CACHE_REJECT_WEAK_HOWTO || '1') === '1';
// Cache schema must be externally configurable; avoid hardcoded one-off bumps in code.
const RAG_ANSWER_CACHE_SCHEMA_VERSION = String(
  process.env.RAG_ANSWER_CACHE_SCHEMA_VERSION ||
  process.env.APP_CACHE_SCHEMA_VERSION ||
  'v1',
);
const RAG_FAST_HOWTO_PATH = String(process.env.RAG_FAST_HOWTO_PATH || '1') === '1';
const RAG_FAST_HOWTO_INTENT_CONF = Math.min(0.99, Math.max(0.5, Number(process.env.RAG_FAST_HOWTO_INTENT_CONF || 0.75)));
const RAG_FAST_HOWTO_TOP_SCORE_MIN = Math.max(20, Number(process.env.RAG_FAST_HOWTO_TOP_SCORE_MIN || 20));
const RAG_FAST_HOWTO_TOP_SCORE_MIN_RELAXED = Math.max(
  6,
  Number(process.env.RAG_FAST_HOWTO_TOP_SCORE_MIN_RELAXED || 7),
);
const RAG_FAST_HOWTO_MIN_STEPS = Math.max(1, Number(process.env.RAG_FAST_HOWTO_MIN_STEPS || 2));
const RAG_FAST_HOWTO_MAX_STEPS = Math.max(RAG_FAST_HOWTO_MIN_STEPS, Number(process.env.RAG_FAST_HOWTO_MAX_STEPS || 6));
const RAG_FAST_HOWTO_MIN_TERM_HITS = Math.max(1, Number(process.env.RAG_FAST_HOWTO_MIN_TERM_HITS || 1));
const RAG_FAST_HOWTO_MIN_TERM_HITS_EN = Math.max(
  RAG_FAST_HOWTO_MIN_TERM_HITS,
  Number(process.env.RAG_FAST_HOWTO_MIN_TERM_HITS_EN || 2),
);
const RAG_FAST_HOWTO_MIN_TERM_HITS_RELAXED_EN = Math.max(
  RAG_FAST_HOWTO_MIN_TERM_HITS_EN,
  Number(process.env.RAG_FAST_HOWTO_MIN_TERM_HITS_RELAXED_EN || 4),
);
const RAG_FAST_HOWTO_MIN_ACTION_STEPS = Math.max(
  1,
  Number(process.env.RAG_FAST_HOWTO_MIN_ACTION_STEPS || 2),
);
const RAG_FAST_HOWTO_MIN_ACTION_RATIO = Math.min(
  1,
  Math.max(0, Number(process.env.RAG_FAST_HOWTO_MIN_ACTION_RATIO || 0.5)),
);
const RAG_FAST_HOWTO_MAX_LEGAL_STYLE_RATIO = Math.min(
  1,
  Math.max(0, Number(process.env.RAG_FAST_HOWTO_MAX_LEGAL_STYLE_RATIO || 0.34)),
);
const RAG_FAST_HOWTO_DETAIL_MIN_STEPS_JA = Math.max(
  RAG_FAST_HOWTO_MIN_STEPS,
  Number(process.env.RAG_FAST_HOWTO_DETAIL_MIN_STEPS_JA || 4),
);
const RAG_FAST_HOWTO_DETAIL_MIN_STEPS_EN = Math.max(
  RAG_FAST_HOWTO_MIN_STEPS,
  Number(process.env.RAG_FAST_HOWTO_DETAIL_MIN_STEPS_EN || 5),
);
const RAG_FAST_HOWTO_DETAIL_MAX_STEPS = Math.max(
  RAG_FAST_HOWTO_MAX_STEPS,
  Number(process.env.RAG_FAST_HOWTO_DETAIL_MAX_STEPS || 8),
);
const RAG_FAST_HOWTO_DETAIL_MIN_CHARS_JA = Math.max(
  120,
  Number(process.env.RAG_FAST_HOWTO_DETAIL_MIN_CHARS_JA || 220),
);
const RAG_FAST_HOWTO_DETAIL_MIN_CHARS_EN = Math.max(
  140,
  Number(process.env.RAG_FAST_HOWTO_DETAIL_MIN_CHARS_EN || 280),
);
const RAG_FAST_HOWTO_EN_TRANSLATE_FALLBACK = String(process.env.RAG_FAST_HOWTO_EN_TRANSLATE_FALLBACK || '1') === '1';
const RAG_FAST_HOWTO_EN_TRANSLATE_TIMEOUT_MS = Math.max(
  2500,
  Math.min(20000, Number(process.env.RAG_FAST_HOWTO_EN_TRANSLATE_TIMEOUT_MS || 12000)),
);
const RAG_FAST_HOWTO_EN_TRANSLATE_RETRIES = Math.max(
  0,
  Math.min(2, Number(process.env.RAG_FAST_HOWTO_EN_TRANSLATE_RETRIES || 1)),
);
const RAG_GROUNDED_FORMATTER_ENABLED = String(process.env.RAG_GROUNDED_FORMATTER_ENABLED || '0') === '1';
const RAG_PROCEDURAL_FORCE_LLM_SYNTHESIS_ENABLED = String(
  process.env.RAG_PROCEDURAL_FORCE_LLM_SYNTHESIS_ENABLED || '0',
) === '1';
const RAG_SKIP_POST_LLM_RECOVERY_FOR_PROCEDURAL = String(
  process.env.RAG_SKIP_POST_LLM_RECOVERY_FOR_PROCEDURAL || '1',
) === '1';
const RAG_ALLOW_GENERIC_RESCUE_FOR_HOWTO = String(process.env.RAG_ALLOW_GENERIC_RESCUE_FOR_HOWTO || '0') === '1';
const RAG_TIER2_PROGRESS_PREFACE = String(process.env.RAG_TIER2_PROGRESS_PREFACE || '1') === '1';
const RAG_REPAIR_COLLAPSED_ENGLISH = String(process.env.RAG_REPAIR_COLLAPSED_ENGLISH || '0') === '1';
const RAG_CACHE_TRANSLATE_ALLOWED = String(process.env.RAG_CACHE_TRANSLATE_ALLOWED || '0') === '1';
const RAG_CACHE_BYPASS_FACT_QUERIES = String(process.env.RAG_CACHE_BYPASS_FACT_QUERIES || '1') === '1';
const RAG_SIMPLE_SOLR_MODE = String(process.env.RAG_SIMPLE_SOLR_MODE || '1') === '1';
const RAG_ENABLE_SURROGATE_QUERY = String(process.env.RAG_ENABLE_SURROGATE_QUERY || '0') === '1';
const FILE_INVENTORY_CACHE_TTL_MS = Math.max(
  120000,
  Math.min(300000, Number(process.env.RAG_FILE_INVENTORY_CACHE_TTL_MS || 180000)),
);
const CANDIDATE_SCOPE_CACHE_TTL_MS = Math.max(
  120000,
  Math.min(300000, Number(process.env.RAG_CANDIDATE_SCOPE_CACHE_TTL_MS || 180000)),
);
const SOLR_RESULT_CACHE_TTL_MS = Math.max(
  120000,
  Math.min(600000, Number(process.env.RAG_SOLR_RESULT_CACHE_TTL_MS || 300000)),
);
const QUERY_TRANSLATION_CACHE_MAX_ENTRIES = Math.max(
  200,
  Number(process.env.RAG_QUERY_TRANSLATION_CACHE_MAX_ENTRIES || 3000),
);
const FILE_INVENTORY_CACHE_MAX_ENTRIES = Math.max(
  8,
  Number(process.env.RAG_FILE_INVENTORY_CACHE_MAX_ENTRIES || 96),
);
const CANDIDATE_SCOPE_CACHE_MAX_ENTRIES = Math.max(
  100,
  Number(process.env.RAG_CANDIDATE_SCOPE_CACHE_MAX_ENTRIES || 3000),
);
const SOLR_RESULT_CACHE_MAX_ENTRIES = Math.max(
  100,
  Number(process.env.RAG_SOLR_RESULT_CACHE_MAX_ENTRIES || 4000),
);

const queryTranslationCache = new Map<string, { value: string; expiresAt: number }>();
const fileInventoryCache = new Map<string, { files: CandidateFileRecord[]; expiresAt: number }>();
const candidateScopeCache = new Map<string, { strict: string[]; expanded: string[]; expiresAt: number }>();
const solrResultCache = new Map<string, { value: { docs: any[]; numFound: number; topScore: number }; expiresAt: number }>();

type LocalMemoryCacheName =
  | 'queryTranslation'
  | 'fileInventory'
  | 'candidateScope'
  | 'solrResult';

type LocalMemoryCacheStats = {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  expired: number;
};

const buildEmptyLocalMemoryCacheStats = (): LocalMemoryCacheStats => ({
  hits: 0,
  misses: 0,
  writes: 0,
  evictions: 0,
  expired: 0,
});

const localMemoryCacheStats: Record<LocalMemoryCacheName, LocalMemoryCacheStats> = {
  queryTranslation: buildEmptyLocalMemoryCacheStats(),
  fileInventory: buildEmptyLocalMemoryCacheStats(),
  candidateScope: buildEmptyLocalMemoryCacheStats(),
  solrResult: buildEmptyLocalMemoryCacheStats(),
};

const bumpLocalMemoryCacheStat = (
  cache: LocalMemoryCacheName,
  field: keyof LocalMemoryCacheStats,
  delta = 1,
): void => {
  localMemoryCacheStats[cache][field] += delta;
};

const getLocalMemoryCacheStats = (): Record<LocalMemoryCacheName, LocalMemoryCacheStats> => ({
  queryTranslation: { ...localMemoryCacheStats.queryTranslation },
  fileInventory: { ...localMemoryCacheStats.fileInventory },
  candidateScope: { ...localMemoryCacheStats.candidateScope },
  solrResult: { ...localMemoryCacheStats.solrResult },
});

const summarizeLocalMemoryCacheStatsDelta = (
  before: Record<LocalMemoryCacheName, LocalMemoryCacheStats>,
  after: Record<LocalMemoryCacheName, LocalMemoryCacheStats>,
) => {
  const caches: LocalMemoryCacheName[] = ['queryTranslation', 'fileInventory', 'candidateScope', 'solrResult'];
  let hits = 0;
  let misses = 0;
  let writes = 0;
  let evictions = 0;
  let expired = 0;
  for (const cacheName of caches) {
    hits += Math.max(0, (after[cacheName]?.hits || 0) - (before[cacheName]?.hits || 0));
    misses += Math.max(0, (after[cacheName]?.misses || 0) - (before[cacheName]?.misses || 0));
    writes += Math.max(0, (after[cacheName]?.writes || 0) - (before[cacheName]?.writes || 0));
    evictions += Math.max(0, (after[cacheName]?.evictions || 0) - (before[cacheName]?.evictions || 0));
    expired += Math.max(0, (after[cacheName]?.expired || 0) - (before[cacheName]?.expired || 0));
  }
  return { hits, misses, writes, evictions, expired };
};

const getExpiringCacheEntry = <T extends { expiresAt: number }>(
  cache: Map<string, T>,
  key: string,
  cacheName: LocalMemoryCacheName,
): T | null => {
  const hit = cache.get(key);
  if (!hit) {
    bumpLocalMemoryCacheStat(cacheName, 'misses');
    return null;
  }
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    bumpLocalMemoryCacheStat(cacheName, 'expired');
    bumpLocalMemoryCacheStat(cacheName, 'misses');
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  bumpLocalMemoryCacheStat(cacheName, 'hits');
  return hit;
};

const setExpiringCacheEntryBounded = <T extends { expiresAt: number }>(
  cache: Map<string, T>,
  key: string,
  value: T,
  maxEntries: number,
  cacheName: LocalMemoryCacheName,
): void => {
  if (maxEntries <= 0) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  bumpLocalMemoryCacheStat(cacheName, 'writes');

  // Opportunistic expiry cleanup before LRU eviction.
  let expiredRemoved = 0;
  const now = Date.now();
  const cleanupBudget = Math.max(12, Math.floor(maxEntries / 8));
  for (const [entryKey, entryValue] of cache) {
    if (expiredRemoved >= cleanupBudget) break;
    if (entryValue.expiresAt > now) continue;
    cache.delete(entryKey);
    expiredRemoved += 1;
  }
  if (expiredRemoved > 0) {
    bumpLocalMemoryCacheStat(cacheName, 'expired', expiredRemoved);
  }

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
    bumpLocalMemoryCacheStat(cacheName, 'evictions');
  }
};

type CandidateFileRecord = {
  id?: number;
  filename: string;
  storage_key: string;
  department_code?: string;
  created_at?: string;
};

type QueryIntentLabel =
  | 'HR_PAYROLL_ATTENDANCE'
  | 'FINANCE_ACCOUNTING'
  | 'COMMUTING_ALLOWANCE'
  | 'IT_SUPPORT'
  | 'GENERAL_POLICY'
  | 'UNKNOWN';

type QueryIntentResult = {
  label: QueryIntentLabel;
  confidence: number;
  matchedTerms: string[];
  isHowTo: boolean;
};

type Stage1RelaxProfile = {
  step: 'A_STRICT' | 'B_RELAX_DATE' | 'C_RELAX_TAGS' | 'D_EXPAND_CANDIDATES' | 'E_GLOBAL_FALLBACK';
  reason: string;
  candidateFileIds: string[];
  metadataFilters?: Record<string, any>;
  solrExtraFq?: string[];
};

type DateRangeFilter = {
  start?: string;
  end?: string;
};

type Stage3DroppedDoc = {
  id: string;
  title: string;
  reason: 'deny_rule' | 'low_relevance' | 'not_procedural';
  score: number;
  termHits: number;
  proceduralScore: number;
};

type Stage3PostFilterResult = {
  docs: any[];
  dropped: Stage3DroppedDoc[];
};

type ResponseTier = 'tier0' | 'tier1' | 'tier2';

type AnswerCacheRecord = {
  answer: string;
  sources: string[];
  source_titles?: string[];
  timestamp: number;
  confidence: number;
  intent_label?: QueryIntentLabel;
  source_file_ids?: string[];
  top_relax_step?: string;
  language?: 'ja' | 'en';
  canonical_query?: string;
};

type FastHowToAnswer = {
  answer: string;
  sources: Array<{ docId: string; title?: string }>;
  confidence: number;
};

type RagBackendDoc = {
  id: string;
  title: string;
  content_txt: string;
  score: number;
  semantic_score: number;
  file_name_s?: string;
  department_code_s?: string;
};

let answerCacheLookupCount = 0;
let answerCacheHitCount = 0;

const logFilterTrace = (event: string, payload: Record<string, any>) => {
  if (!RAG_DEBUG_FILTER_TRACE) return;
  console.log(
    `[RAG_FILTER_TRACE] ${JSON.stringify({
      event,
      ...payload,
    })}`,
  );
};

const hashShort = (value: string): string =>
  createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);

const normalizeQueryForAnswerCache = (query: string): string =>
  canonicalizeQuery(String(query || ''))
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildFileScopeHash = (params: {
  useSpecificFileFilter: boolean;
  shouldRestrictToDepartment: boolean;
  departmentCode?: string;
  strictCandidateIds: string[];
  expandedCandidateIds: string[];
  availableFilesCount: number;
}): string => {
  const strictIds = uniqueStringList(params.strictCandidateIds, RAG_STAGE1_STRICT_FILE_IDS).sort();
  const expandedIds = uniqueStringList(params.expandedCandidateIds, RAG_STAGE1_EXPANDED_FILE_IDS).sort();
  const scopeFingerprint = JSON.stringify({
    specific: !!params.useSpecificFileFilter,
    restrict_department: !!params.shouldRestrictToDepartment,
    department: String(params.departmentCode || ''),
    strict_ids: strictIds,
    expanded_ids: expandedIds,
    file_count: Number(params.availableFilesCount || 0),
  });
  return hashShort(scopeFingerprint);
};

const buildAnswerCacheKey = (params: {
  userId: number;
  departmentCode?: string;
  canonicalQuery: string;
  fileScopeHash: string;
  language: 'ja' | 'en';
}): string => {
  const queryHash = hashShort(params.canonicalQuery || '');
  return [
    'rag',
    'answer_cache',
    String(RAG_ANSWER_CACHE_SCHEMA_VERSION || 'v1'),
    String(params.userId || 0),
    String(params.departmentCode || 'ALL'),
    String(params.language || 'en'),
    String(params.fileScopeHash || 'none'),
    queryHash,
  ].join(':');
};

const buildCandidateScopeCacheKey = (params: {
  departmentCode?: string;
  roleCode?: string;
  processingPath?: string;
  intentLabel: QueryIntentLabel;
  querySignature?: string;
}): string =>
  [
    'rag',
    'candidate_scope',
    String(params.departmentCode || 'ALL'),
    String(params.roleCode || 'ANY'),
    String(params.processingPath || 'UNKNOWN').toUpperCase(),
    String(params.intentLabel || 'UNKNOWN'),
    hashShort(canonicalizeRagQuery(params.querySignature || '')),
  ].join(':');

const readCandidateScopeCache = (
  cacheKey: string,
  availableIds: Set<string>,
): { strict: string[]; expanded: string[] } | null => {
  const hit = getExpiringCacheEntry(candidateScopeCache, cacheKey, 'candidateScope');
  if (!hit) return null;
  const strict = uniqueStringList(hit.strict || [], RAG_STAGE1_STRICT_FILE_IDS)
    .filter((id) => availableIds.has(id));
  const expanded = uniqueStringList(hit.expanded || [], RAG_STAGE1_EXPANDED_FILE_IDS)
    .filter((id) => availableIds.has(id));
  if (!strict.length && !expanded.length) return null;
  return { strict, expanded: expanded.length ? expanded : strict };
};

const writeCandidateScopeCache = (
  cacheKey: string,
  scope: { strict: string[]; expanded: string[] },
): void => {
  const strict = uniqueStringList(scope.strict || [], RAG_STAGE1_STRICT_FILE_IDS);
  const expanded = uniqueStringList(scope.expanded || [], RAG_STAGE1_EXPANDED_FILE_IDS);
  if (!strict.length && !expanded.length) return;
  setExpiringCacheEntryBounded(
    candidateScopeCache,
    cacheKey,
    {
      strict,
      expanded: expanded.length ? expanded : strict,
      expiresAt: Date.now() + CANDIDATE_SCOPE_CACHE_TTL_MS,
    },
    CANDIDATE_SCOPE_CACHE_MAX_ENTRIES,
    'candidateScope',
  );
};

const buildSolrResultCacheKey = (params: {
  canonicalQuery: string;
  intentLabel: QueryIntentLabel;
  departmentCode?: string;
  roleCode?: string;
  mode: 'primary' | 'fallback';
  candidateFileIds?: string[];
  metadataFilters?: Record<string, any>;
}): string =>
  {
    const candidateScopeHash = hashShort(
      uniqueStringList(params.candidateFileIds || [], RAG_STAGE1_EXPANDED_FILE_IDS)
        .sort()
        .join('|'),
    );
    const metadataHash = hashShort(JSON.stringify(params.metadataFilters || {}));
    return [
      'rag',
      'solr',
      String(params.mode),
      String(params.intentLabel || 'UNKNOWN'),
      String(params.departmentCode || 'ALL'),
      String(params.roleCode || 'ANY'),
      candidateScopeHash,
      metadataHash,
      hashShort(canonicalizeRagQuery(params.canonicalQuery || '')),
    ].join(':');
  };

const readAnswerCache = async (cacheKey: string): Promise<AnswerCacheRecord | null> => {
  try {
    const raw = await redis.get(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(String(raw || ''));
    if (!parsed || typeof parsed !== 'object') return null;
    const answer = String(parsed.answer || '').trim();
    const sources = uniqueStringList(parsed.sources || [], 50);
    if (!answer || !sources.length) return null;
    const lowerAnswer = answer.toLowerCase();
    if (
      lowerAnswer.includes('answer generation failed due to a temporary model issue') ||
      lowerAnswer.includes('回答生成に一時的な問題が発生しました')
    ) {
      return null;
    }
    if (isCannotConfirmStyleAnswer(answer)) {
      return null;
    }
    return {
      answer,
      sources,
      source_titles: uniqueStringList(parsed.source_titles || [], 50),
      timestamp: Number(parsed.timestamp || Date.now()),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
      intent_label: String(parsed.intent_label || '').trim() as QueryIntentLabel,
      source_file_ids: uniqueStringList(parsed.source_file_ids || [], 80),
      top_relax_step: String(parsed.top_relax_step || '').trim() || undefined,
      language: (String(parsed.language || '').trim() as 'ja' | 'en') || undefined,
      canonical_query: String(parsed.canonical_query || '').trim() || undefined,
    };
  } catch (error) {
    console.warn('[AnswerCache] read failed:', (error as any)?.message || error);
    return null;
  }
};

const writeAnswerCache = async (cacheKey: string, record: AnswerCacheRecord): Promise<boolean> => {
  try {
    const payload = JSON.stringify(record);
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > RAG_ANSWER_CACHE_MAX_BYTES) {
      console.log(`[AnswerCache] skip write: payload too large (${bytes} bytes > ${RAG_ANSWER_CACHE_MAX_BYTES}).`);
      return false;
    }
    await redis.set(cacheKey, payload, 'EX', RAG_ANSWER_CACHE_TTL_SEC);
    return true;
  } catch (error) {
    console.warn('[AnswerCache] write failed:', (error as any)?.message || error);
    return false;
  }
};

const getAnswerCacheHitRate = (): number =>
  answerCacheLookupCount > 0 ? (answerCacheHitCount / answerCacheLookupCount) : 0;

const translateQueryTextForRetrieval = async (query: string, targetLang: LanguageCode): Promise<string> => {
  const key = `${targetLang}:${String(query || '').trim().toLowerCase()}`;
  const now = Date.now();
  const hit = getExpiringCacheEntry(queryTranslationCache, key, 'queryTranslation');
  if (hit) return hit.value;

  const source = String(query || '').trim();
  if (!source) return '';

  const isValidTranslation = (value: string) => {
    const translated = String(value || '').trim();
    if (!translated) return false;
    if (translated.toLowerCase() === source.toLowerCase()) return false;
    if (targetLang === 'ja' && !hasJapaneseChars(translated)) return false;
    if (targetLang === 'en' && hasJapaneseChars(translated) && !/[a-z0-9]/i.test(translated)) return false;
    return true;
  };

  const translatedKeywords = await translateQueryKeywordsForRetrieval(source);
  let filteredKeywords = translatedKeywords;
  if (targetLang === 'ja') {
    filteredKeywords = translatedKeywords.filter((keyword) => hasJapaneseChars(keyword));
  } else if (targetLang === 'en') {
    filteredKeywords = translatedKeywords.filter((keyword) => !hasJapaneseChars(keyword));
  }
  if (filteredKeywords.length === 0) {
    filteredKeywords = translatedKeywords;
  }

  const dynamicTranslatedQuery = canonicalizeQuery(filteredKeywords.join(' ')) || filteredKeywords.join(' ');
  if (isValidTranslation(dynamicTranslatedQuery)) {
    setExpiringCacheEntryBounded(
      queryTranslationCache,
      key,
      {
        value: dynamicTranslatedQuery,
        expiresAt: now + QUERY_TRANSLATION_CACHE_TTL_MS,
      },
      QUERY_TRANSLATION_CACHE_MAX_ENTRIES,
      'queryTranslation',
    );
    console.log(`[RAG] Dynamic retrieval translation applied: "${source}" -> "${dynamicTranslatedQuery}"`);
    return dynamicTranslatedQuery;
  }

  // Negative cache to avoid repeating the same slow failed translation path
  // for the same query/target pair during a short window.
  setExpiringCacheEntryBounded(
    queryTranslationCache,
    key,
    {
      value: '',
      expiresAt: now + QUERY_TRANSLATION_NEGATIVE_CACHE_TTL_MS,
    },
    QUERY_TRANSLATION_CACHE_MAX_ENTRIES,
    'queryTranslation',
  );
  return '';
};

const hasJapaneseChars = (value: string) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(String(value || ''));

const DATE_METADATA_KEY_RE = /(date|time|created|updated|effective|period)/i;
const TAG_SYSTEM_METADATA_KEY_RE = /(tag|system|doc_type|document_type|category|domain|policy_type)/i;

const uniqueStringList = (values: unknown[], limit = 200): string[] =>
  Array.from(
    new Set(
      (values || [])
        .map((v) => String(v || '').trim())
        .filter(Boolean),
    ),
  ).slice(0, limit);

const isHowToStyleQuery = (query: string): boolean => {
  const text = String(query || '').trim();
  if (!text) return false;
  const englishProcessHowPattern =
    /\bhow\b[\s\S]{0,80}\b(manage|managed|management|handle|handled|handling|work|works|working|operate|operates|operating|process|processed|processing|report|reported|reporting|apply|applied|application|request|requested|approval|approve|approved)\b/i;
  return (
    /\b(how\s+to|where\s+to|what\s+should|how\s+can\s+i|how\s+do\s+i|procedure|procedures|steps?|process|workflow|apply|application|request|report)\b/i.test(text) ||
    englishProcessHowPattern.test(text) ||
    /(どうすれば|どのように|方法|手順|申請方法|流れ|進め方|対応手順)/.test(text) ||
    /(^|\n)\s*([0-9０-９]+[\).．]|[\-*•●◦▪・]|step\s*[0-9０-９]+|ステップ\s*[0-9０-９]+)/i.test(text)
  );
};

const hasExplicitProcedureCue = (query: string): boolean => {
  const text = String(query || '').trim();
  if (!text) return false;
  const strongProcedureCue =
    /\b(how\s+to|where\s+to|steps?|step\s*[0-9０-９]+|procedure|procedures|process|workflow|apply|application|request|report|submit|approval|approve|form|portal)\b/i.test(text) ||
    /(手順|申請|申込|報告|提出|承認|流れ|進め方|対応手順|フォーム|ポータル)/.test(text);
  const weakHowCue =
    /\b(how|where)\b/i.test(text) ||
    /(どうすれば|どのように|方法)/.test(text);
  const managementSummaryCue =
    /\b(manage|managed|management|policy|policies|purpose|defined|classification)\b/i.test(text) ||
    /(管理(?:され|する|方法)?|方針|規程|目的|定義|区分)/.test(text);

  if (strongProcedureCue) return true;
  if (managementSummaryCue && !strongProcedureCue) return false;
  return weakHowCue;
};

const buildAnswerStyleProbeText = (originalQuery: string, retrievalQuery: string): string =>
  [String(originalQuery || '').trim(), String(retrievalQuery || '').trim()]
    .filter(Boolean)
    .join(' ');

const shouldAllowFastHowToUnknownIntent = (
  intent: QueryIntentResult,
  _query: string,
): boolean => {
  if (intent.label !== 'UNKNOWN') return false;
  if (!intent.isHowTo) return false;
  return intent.confidence >= 0.5;
};

const isFactValueQuery = (_query: string): boolean => false;

const buildCanonicalSemanticQuery = (
  query: string,
  _intent: QueryIntentResult,
  _confidenceThreshold: number,
): string => {
  const normalized = normalizeQueryForAnswerCache(query);
  return normalized;
};

const classifyQueryIntent = (query: string): QueryIntentResult => {
  const rawInput = String(query || '').trim();
  const input = rewriteRagQueryWithSynonyms(rawInput);
  const isHowTo = isHowToStyleQuery(rawInput) || isHowToStyleQuery(input);
  if (!input) {
    return { label: 'UNKNOWN', confidence: 0, matchedTerms: [], isHowTo };
  }

  const matchedTerms = extractQueryTermsForRerank(input).slice(0, 8);
  const baseConfidence = Math.max(
    0.25,
    Math.min(0.6, 0.3 + (Math.log2(Math.max(2, matchedTerms.length + 1)) * 0.12)),
  );
  const confidence = Math.min(0.7, baseConfidence + (isHowTo ? 0.08 : 0));

  return {
    label: 'UNKNOWN',
    confidence,
    matchedTerms,
    isHowTo,
  };
};

const scoreIntentForFile = (_file: CandidateFileRecord, _intent: QueryIntentResult): number => 0;

const hasStrongDenyDomainSignal = (_value: string): boolean => false;

const summarizeDocForTrace = (doc: any) => {
  const title = Array.isArray(doc?.title) ? String(doc.title[0] || '') : String(doc?.title || '');
  return {
    id: String(doc?.id || ''),
    title: title || String(doc?.file_name_s || doc?.id || ''),
    score: Number(doc?.score || 0),
  };
};

const computeSemanticDocCohesion = (
  docs: Array<{ title?: string; content_txt?: string }>,
): number => {
  const rows = Array.isArray(docs) ? docs.slice(0, 4) : [];
  if (!rows.length) return 0;

  const normalizedTitles = rows
    .map((doc) => String(doc?.title || '').trim().toLowerCase())
    .filter(Boolean);
  const titleCounts = new Map<string, number>();
  for (const title of normalizedTitles) {
    titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
  }
  const dominantTitleCount = Math.max(0, ...Array.from(titleCounts.values()));

  const termSets = rows.map((doc) => {
    const text = String(doc?.content_txt || '');
    const terms = extractCjkTerms(text).slice(0, 16);
    return new Set(terms);
  });

  let overlapPairs = 0;
  for (let i = 0; i < termSets.length; i++) {
    for (let j = i + 1; j < termSets.length; j++) {
      let overlap = 0;
      for (const term of termSets[i]) {
        if (termSets[j].has(term)) overlap += 1;
      }
      if (overlap >= 2) overlapPairs += 1;
    }
  }

  return (dominantTitleCount * 1.5) + overlapPairs;
};

const buildSemanticSurrogateQuery = (
  docs: Array<{ title?: string; content_txt?: string }>,
): string => {
  const rows = Array.isArray(docs) ? docs.slice(0, 5) : [];
  if (!rows.length) return '';

  const tf = new Map<string, number>();
  const df = new Map<string, number>();
  const docCount = rows.length;
  for (const doc of rows) {
    const title = String(doc?.title || '');
    const content = String(doc?.content_txt || '');
    const titleTerms = extractCjkTerms(title).slice(0, 8);
    const bodyTerms = extractCjkTerms(content).slice(0, 18);
    const docSeen = new Set<string>();

    for (const term of [...titleTerms, ...bodyTerms]) {
      const t = String(term || '').trim();
      if (t.length < 2) continue;
      const isFromTitle = title.includes(t);
      const tfBoost = isFromTitle ? 1.6 : 1.1;
      tf.set(t, (tf.get(t) || 0) + tfBoost);
      if (!docSeen.has(t)) {
        docSeen.add(t);
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
  }

  const scored = [...tf.entries()]
    .map(([term, tfScore]) => {
      const docFreq = Number(df.get(term) || 1);
      const idf = Math.log((docCount + 1) / (docFreq + 0.5));
      const lengthBoost = Math.min(2, Math.max(0, (term.length - 1) / 3));
      const score = (tfScore * (0.8 + idf)) + lengthBoost;
      return { term, score };
    })
    .sort((a, b) => (b.score - a.score) || (b.term.length - a.term.length));
  const ranked = scored
    .map((row) => row.term)
    .slice(0, 4);
  return ranked.join(' ').trim();
};

const countAnswerQueryOverlap = (answer: string, query: string): number => {
  const text = String(answer || '').toLowerCase();
  if (!text) return 0;
  const terms = extractQueryTermsForRerank(query)
    .map((t) => String(t || '').trim().toLowerCase())
    .filter((t) => t.length >= 4)
    .filter((t) => !hasJapaneseChars(t))
    .slice(0, 8);
  if (!terms.length) return 0;
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits;
};

const parseDateRangeFromTaskMetadata = (data: any): DateRangeFilter | undefined => {
  const dateRange = (data && typeof data === 'object') ? (data.dateRange || data.date_range || null) : null;
  const start =
    String(dateRange?.start || dateRange?.from || data?.dateFrom || data?.date_from || data?.startDate || '').trim();
  const end =
    String(dateRange?.end || dateRange?.to || data?.dateTo || data?.date_to || data?.endDate || '').trim();
  if (!start && !end) return undefined;
  return {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
};

const parseTimestampSafe = (value: string): number | undefined => {
  const t = Date.parse(String(value || ''));
  if (!Number.isFinite(t)) return undefined;
  return t;
};

const filterCandidateIdsByDateRange = (
  candidateIds: string[],
  files: CandidateFileRecord[],
  range?: DateRangeFilter,
): string[] => {
  if (!range) return candidateIds;
  if (!candidateIds.length) return candidateIds;

  const startTs = parseTimestampSafe(String(range.start || ''));
  const endTs = parseTimestampSafe(String(range.end || ''));
  if (!startTs && !endTs) return candidateIds;

  const fileByStorageKey = new Map(
    (files || [])
      .map((f): [string, CandidateFileRecord] => [String(f?.storage_key || ''), f])
      .filter((row): row is [string, CandidateFileRecord] => Boolean(row[0])),
  );

  return candidateIds.filter((storageKey) => {
    const file = fileByStorageKey.get(String(storageKey || ''));
    if (!file?.created_at) return true; // Soft usage: keep docs when date metadata is unavailable.
    const fileTs = parseTimestampSafe(String(file.created_at || ''));
    if (!fileTs) return true;
    if (startTs && fileTs < startTs) return false;
    if (endTs && fileTs > endTs) return false;
    return true;
  });
};

const extractTaskMetadataFilters = (data: any): Record<string, any> => {
  const raw = data?.metadataFilters || data?.metadata_filters;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key || '').trim();
    if (!k) continue;
    if (value == null) continue;
    if (Array.isArray(value)) {
      const list = uniqueStringList(value, 30);
      if (list.length) out[k] = list;
      continue;
    }
    const v = String(value).trim();
    if (!v) continue;
    out[k] = v;
  }
  return out;
};

const dropMetadataFilterKeys = (
  source: Record<string, any> | undefined,
  shouldDrop: (key: string) => boolean,
): Record<string, any> | undefined => {
  if (!source || typeof source !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(source)) {
    if (shouldDrop(String(key || ''))) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
};

const buildIntentMetadataFilters = (intent: QueryIntentResult): Record<string, any> | undefined => {
  void intent;
  return undefined;
};

const mergeMetadataFilters = (...parts: Array<Record<string, any> | undefined>): Record<string, any> | undefined => {
  const merged: Record<string, any> = {};
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    for (const [key, value] of Object.entries(part)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        const list = uniqueStringList(value, 30);
        if (list.length) merged[key] = list;
      } else {
        const v = String(value).trim();
        if (v) merged[key] = v;
      }
    }
  }
  return Object.keys(merged).length ? merged : undefined;
};

const SOLR_FILTERABLE_METADATA_FIELDS = new Set([
  'department_code_s',
  'system_s',
  'doc_type_s',
  'access_level_s',
  'rag_tag_s',
]);

const buildSolrFqFromMetadataFilters = (metadataFilters?: Record<string, any>): string[] => {
  if (!metadataFilters || typeof metadataFilters !== 'object') return [];
  const fqParts: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(metadataFilters)) {
    const key = String(rawKey || '').trim();
    if (!key || !SOLR_FILTERABLE_METADATA_FIELDS.has(key)) continue;
    if (rawValue == null) continue;

    if (Array.isArray(rawValue)) {
      const list = uniqueStringList(rawValue, 20);
      if (!list.length) continue;
      if (list.length === 1) {
        const v = list[0];
        const quoted = `"${String(v).replace(/["\\]/g, '\\$&')}"`;
        fqParts.push(`${key}:${quoted}`);
      } else {
        fqParts.push(`{!terms f=${key}}${list.map(escapeTermsValue).join(',')}`);
      }
      continue;
    }

    const value = String(rawValue || '').trim();
    if (!value) continue;
    const quoted = `"${value.replace(/["\\]/g, '\\$&')}"`;
    fqParts.push(`${key}:${quoted}`);
  }
  return fqParts;
};

// retrieval tokenization, candidate expansion, and term-hit scoring live in src/rag/retrieval/*

const buildStage1CandidateScope = (
  query: string,
  files: CandidateFileRecord[],
): string[] => {
  if (!RAG_STAGE1_PREFILTER_ENABLED) return [];
  if (!Array.isArray(files) || files.length < 12) return [];

  const queryTokens = tokenizeQueryForFileScope(query);
  if (!queryTokens.length) return [];
  // Keep 1-token queries unscoped, but allow 2+ token queries to narrow candidate files.
  if (queryTokens.length < 2) return [];

  const scored = files
    .map((f) => ({
      file: f,
      score: scoreFileForQuery(f, queryTokens),
      tokenHits: countFileTokenHits(f, queryTokens),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];

  const topScore = scored[0].score;
  const topHits = scored[0].tokenHits;
  if (topScore < 3) return [];
  // Guardrail: avoid over-narrowing file scope when only one weak lexical token matched.
  if (queryTokens.length >= 2 && topHits < 2) return [];

  const keepThreshold = Math.max(2, topScore - 2);
  const scoped = scored
    .filter((row) => row.score >= keepThreshold)
    .slice(0, RAG_STAGE1_MAX_FILE_IDS)
    .map((row) => String(row.file.storage_key || '').trim())
    .filter(Boolean);

  // Avoid over-constraining to a tiny set unless we are confident.
  if (scoped.length < 2) return [];
  if (scoped.length >= files.length) return [];
  return scoped;
};

const buildIntentScopedCandidateScope = (
  query: string,
  files: CandidateFileRecord[],
  fallbackScope: string[],
  intent: QueryIntentResult,
): { strict: string[]; expanded: string[] } => {
  const baseFallback = uniqueStringList(fallbackScope, RAG_STAGE1_EXPANDED_FILE_IDS);
  if (!RAG_STAGE1_PREFILTER_ENABLED) {
    return { strict: [], expanded: [] };
  }
  if (!Array.isArray(files) || !files.length) {
    return {
      strict: baseFallback.slice(0, RAG_STAGE1_STRICT_FILE_IDS),
      expanded: baseFallback.slice(0, RAG_STAGE1_EXPANDED_FILE_IDS),
    };
  }

  const queryTokens = tokenizeQueryForFileScope(query);
  // Keep Stage-1 dynamic but avoid over-constraining single-token broad queries.
  if (queryTokens.length < 2) {
    return { strict: [], expanded: [] };
  }

  const scored = files
    .map((file) => {
      const queryScore = scoreFileForQuery(file, queryTokens);
      const intentScore = scoreIntentForFile(file, intent);
      const denyPenalty = 0;
      const total = (queryScore * 1.2) + (intentScore * 0.4) - denyPenalty;
      return {
        file,
        total,
        intentScore,
        denySignal: false,
      };
    })
    .filter((row) => row.total > 0 || row.intentScore > 0)
    .sort((a, b) => b.total - a.total);

  if (!scored.length) {
    return {
      strict: baseFallback.slice(0, RAG_STAGE1_STRICT_FILE_IDS),
      expanded: baseFallback.slice(0, RAG_STAGE1_EXPANDED_FILE_IDS),
    };
  }

  const topTotal = Number(scored[0]?.total || 0);
  const strictThreshold = Math.max(2, topTotal - 2.5);
  const expandedThreshold = Math.max(1, topTotal - 5);

  const strict = uniqueStringList(
    scored
      .filter((row) => row.total >= strictThreshold)
      .filter((row) => !row.denySignal)
      .map((row) => row.file.storage_key),
    RAG_STAGE1_STRICT_FILE_IDS,
  );

  const expanded = uniqueStringList(
    scored
      .filter((row) => row.total >= expandedThreshold)
      .map((row) => row.file.storage_key),
    RAG_STAGE1_EXPANDED_FILE_IDS,
  );

  const finalStrict = strict.length > 0
    ? strict
    : uniqueStringList([...expanded, ...baseFallback], RAG_STAGE1_STRICT_FILE_IDS);
  const finalExpanded = uniqueStringList(
    [...expanded, ...finalStrict, ...baseFallback],
    RAG_STAGE1_EXPANDED_FILE_IDS,
  );

  const tinyScope = finalExpanded.length > 0 && finalExpanded.length < RAG_STAGE1_MIN_SCOPE_SIZE;
  const broadUnknownIntent =
    intent.label === 'UNKNOWN' &&
    (intent.confidence < RAG_STAGE1_MIN_SCOPE_CONFIDENCE || intent.isHowTo);
  if (tinyScope && broadUnknownIntent) {
    return { strict: [], expanded: [] };
  }

  return {
    strict: finalStrict,
    expanded: finalExpanded,
  };
};

const buildStage1RelaxProfiles = (params: {
  data: any;
  files: CandidateFileRecord[];
  intent: QueryIntentResult;
  strictCandidateIds: string[];
  expandedCandidateIds: string[];
  useSpecificFileFilter: boolean;
  fixedCandidateIds: string[];
  shouldRestrictToDepartment: boolean;
  departmentCode?: string;
}): Stage1RelaxProfile[] => {
  const {
    data,
    files,
    intent,
    strictCandidateIds,
    expandedCandidateIds,
    useSpecificFileFilter,
    fixedCandidateIds,
    shouldRestrictToDepartment,
    departmentCode,
  } = params;
  const dateRange = parseDateRangeFromTaskMetadata(data);
  const taskMetadataFilters = extractTaskMetadataFilters(data);
  const accessLevel = String(data?.accessLevel || data?.access_level || '').trim();

  const mandatoryFilters = mergeMetadataFilters(
    shouldRestrictToDepartment && departmentCode ? { department_code_s: departmentCode } : undefined,
    accessLevel ? { access_level_s: accessLevel } : undefined,
  );

  const intentFilters = buildIntentMetadataFilters(intent);
  const strictMetadata = mergeMetadataFilters(mandatoryFilters, taskMetadataFilters, intentFilters);
  const relaxDateMetadata = dropMetadataFilterKeys(
    strictMetadata,
    (key) => DATE_METADATA_KEY_RE.test(String(key || '')),
  );
  const relaxTagsMetadata = dropMetadataFilterKeys(
    relaxDateMetadata,
    (key) => TAG_SYSTEM_METADATA_KEY_RE.test(String(key || '')),
  );

  const fixedIds = uniqueStringList(fixedCandidateIds, RAG_STAGE1_EXPANDED_FILE_IDS);
  const strictIdsRaw = useSpecificFileFilter
    ? fixedIds
    : uniqueStringList(strictCandidateIds, RAG_STAGE1_STRICT_FILE_IDS);
  const expandedIdsRaw = useSpecificFileFilter
    ? fixedIds
    : uniqueStringList(
      expandedCandidateIds.length ? expandedCandidateIds : strictCandidateIds,
      RAG_STAGE1_EXPANDED_FILE_IDS,
    );
  const strictDateFiltered = filterCandidateIdsByDateRange(strictIdsRaw, files, dateRange);

  const profileA: Stage1RelaxProfile = {
    step: 'A_STRICT',
    reason: dateRange
      ? 'Strict intent/domain + date range + access constraints.'
      : 'Strict intent/domain + access constraints.',
    candidateFileIds: strictDateFiltered,
    metadataFilters: strictMetadata,
  };
  const profileB: Stage1RelaxProfile = {
    step: 'B_RELAX_DATE',
    reason: dateRange
      ? 'Relaxed date range after strict stage had no hits.'
      : 'No explicit date range; keeping strict scope.',
    candidateFileIds: strictIdsRaw,
    metadataFilters: relaxDateMetadata,
  };
  const profileC: Stage1RelaxProfile = {
    step: 'C_RELAX_TAGS',
    reason: 'Relaxed tag/system/doc_type fields while retaining access/domain scope.',
    candidateFileIds: strictIdsRaw,
    metadataFilters: relaxTagsMetadata,
  };
  const profileD: Stage1RelaxProfile = {
    step: 'D_EXPAND_CANDIDATES',
    reason: 'Expanded candidate_file_ids cap inside current intent/domain.',
    candidateFileIds: uniqueStringList([...expandedIdsRaw, ...strictIdsRaw], RAG_STAGE1_EXPANDED_FILE_IDS),
    metadataFilters: relaxTagsMetadata,
  };
  const profileE: Stage1RelaxProfile = {
    step: 'E_GLOBAL_FALLBACK',
    reason: useSpecificFileFilter
      ? 'Specific-file retrieval requested; keep fixed file scope.'
      : 'Last resort global fallback with mandatory access controls only.',
    candidateFileIds: useSpecificFileFilter ? fixedIds : [],
    metadataFilters: mandatoryFilters,
  };

  if (RAG_SIMPLE_SOLR_MODE) {
    // In simple mode we use one-pass retrieval with a tiny call budget.
    // Prefer the tag-relaxed profile to avoid over-filtering on sparse metadata.
    return [profileC];
  }
  return [profileA, profileB, profileC, profileD, profileE];
};

const scoreProceduralSignal = (doc: any): number => {
  const title = Array.isArray(doc?.title) ? String(doc.title[0] || '') : String(doc?.title || '');
  const body = Array.isArray(doc?.content_txt)
    ? String(doc.content_txt.join('\n') || '')
    : String(doc?.content_txt || doc?.content || '');
  const text = `${title}\n${body}`;
  const lines = text.split('\n').slice(0, 80);
  let score = 0;
  for (const line of lines) {
    if (PROCEDURAL_LINE_RE.test(line)) score += 2;
    if (/[→>]/.test(line)) score += 1;
  }
  return Math.min(8, score);
};

const hasDefinitionOnlySignal = (doc: any): boolean => {
  const body = Array.isArray(doc?.content_txt)
    ? String(doc.content_txt.join('\n') || '')
    : String(doc?.content_txt || doc?.content || '');
  const bodyLength = String(body || '').trim().length;
  return bodyLength > 0 && bodyLength < 220 && scoreProceduralSignal(doc) <= 0;
};

const applyStage3PostFilter = (
  docs: any[],
  query: string,
  intent: QueryIntentResult,
): Stage3PostFilterResult => {
  if (!RAG_STAGE3_POSTFILTER_ENABLED) return { docs, dropped: [] };
  if (!Array.isArray(docs) || docs.length <= 1) return { docs, dropped: [] };

  const intentTerms = tokenizeQueryForFileScope(query);
  const topicProfile = buildQueryTopicProfile(query);
  if (!intentTerms.length) return { docs, dropped: [] };

  void intent;

  const scored = docs.map((doc) => ({
    doc,
    hits: countDocTermHits(doc, intentTerms),
    score: Number(doc?.score || 0),
    proceduralScore: scoreProceduralSignal(doc),
    definitionOnly: hasDefinitionOnlySignal(doc),
    topicScore: scoreTopicAlignment(
      `${
        Array.isArray(doc?.title)
          ? String(doc.title[0] || '')
          : String(doc?.title || doc?.file_name_s || doc?.id || '')
      }\n${
        Array.isArray(doc?.content_txt)
          ? String(doc.content_txt.join('\n') || '')
          : String(doc?.content_txt || doc?.content || '')
      }`.slice(0, 1600),
      topicProfile,
    ),
    denySignal: false,
  }));

  const bestScore = Math.max(...scored.map((row) => row.score), 0);
  const dropped: Stage3DroppedDoc[] = [];
  const narrowed = scored.filter((row) => {
    const docId = String(row.doc?.id || '');
    const title = Array.isArray(row.doc?.title)
      ? String(row.doc.title[0] || '')
      : String(row.doc?.title || row.doc?.file_name_s || row.doc?.id || '');

    if ((topicProfile.clockIn || topicProfile.attendanceCorrection) && row.topicScore <= -3) {
      dropped.push({
        id: docId,
        title,
        reason: 'deny_rule',
        score: row.score,
        termHits: row.hits,
        proceduralScore: row.proceduralScore,
      });
      return false;
    }

    const weakRelevance = row.hits <= 0 && row.score < (bestScore * 0.35);
    if (weakRelevance) {
      dropped.push({
        id: docId,
        title,
        reason: 'low_relevance',
        score: row.score,
        termHits: row.hits,
        proceduralScore: row.proceduralScore,
      });
      return false;
    }

    if (intent.isHowTo) {
      const proceduralWeak =
        row.proceduralScore <= 0 &&
        row.hits <= 1 &&
        (row.definitionOnly || row.score < (bestScore * 0.7));
      if (proceduralWeak) {
        dropped.push({
          id: docId,
          title,
          reason: 'not_procedural',
          score: row.score,
          termHits: row.hits,
          proceduralScore: row.proceduralScore,
        });
        return false;
      }
    }

    return true;
  }).map((row) => row.doc);

  if (narrowed.length <= 0) {
    return { docs, dropped: [] };
  }
  return { docs: narrowed, dropped };
};

const PROCEDURAL_HEADER_RE = /^\s*([0-9０-９]+[\).．:：]|[①-⑳]|[\-*•●◦▪・]|step\s*[0-9０-９]+|ステップ\s*[0-9０-９]+|menu\s*[:>\-]|メニュー\s*[:>\-])/i;
const PROCEDURAL_ACTION_RE = /(申請|提出|審査|決定|承認|実施|設定|確認|管理|調査|通知|修正|訂正|更正|review|submit|approve|determin|set|investigat|manage|conduct|correct|adjust|edit|update|must|shall|required)/i;
const PROCEDURAL_LINE_RE = new RegExp(
  `${PROCEDURAL_HEADER_RE.source}|${PROCEDURAL_ACTION_RE.source}`,
  'i',
);
const LEGAL_ARTICLE_STYLE_RE = /^(?:[0-9０-９]+\s*[.)．:：]\s*)?(?:第\s*[0-9０-９]+\s*(?:条|項)|article\s*[0-9０-９]+|clause\s*[0-9０-９]+)/i;
const HOWTO_ACTION_LINE_RE = /(申請|提出|入力|登録|記録|起票|承認|確認|送信|選択|報告|添付|開始|ログイン|修正|訂正|更正|open|enter|submit|approve|review|record|notify|select|upload|start|complete|click|correct|adjust|edit|update)/i;
const HOWTO_WORKFLOW_SIGNAL_RE = /(申請|フォーム|ポータル|メニュー|入力|提出|承認|選択|起票|打刻|修正|訂正|更正|workflow|portal|menu|form|submit|approve|report|attendance|clock-?in|clock-?out|correct|adjust|edit|update|overtime|残業|時間外)/i;
const HOWTO_POLICY_ONLY_RE = /(must be handled according to .*regulations|according to .*policy|に従って.*(?:規程|規定))/i;
const HOWTO_QUESTION_STYLE_RE = /(教えてください|できますか|ですか|what\s+is|who\s+can|can\s+i|how\s+to|\?|？)/i;
const HOWTO_METADATA_NOISE_RE = /(?:\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b|\bNo\.\d+_[^\s]+\b|\.pdf\b|\.docx?\b|\.xlsx?\b|\.csv\b)/i;
const POLICY_SIGNAL_RE =
  /(?:\b(?:must|shall|required|submit|request|apply|approval|approve|record|report|follow|need(?:ed)?|employees?|supervisor|attendance|overtime)\b|必要|申請|承認|提出|報告|記録|従う|規程|規則|就業|賃金|残業|勤怠|上司)/i;
const POLICY_LINE_NOISE_RE = /(https?:\/\/|www\.|table_\d+|song\/laravel-admin|\bID\s*\d+\b|^\s*[\W_]+\s*$)/i;

const JA_GENERIC_FALLBACK_QUERY_TERMS = new Set([
  '制度',
  '規程',
  '規定',
  '方針',
  '管理',
  '手順',
  '手続',
  '会社',
  '社内',
]);

const areFallbackQueryTermsTooGeneric = (terms: string[]): boolean => {
  const normalized = (terms || [])
    .map((term) => String(term || '').trim())
    .filter(Boolean);
  if (!normalized.length) return false;
  return normalized.every((term) => JA_GENERIC_FALLBACK_QUERY_TERMS.has(term));
};

const buildFallbackQueryTerms = (
  query: string,
  language: 'ja' | 'en',
  maxTerms = 18,
): string[] => {
  const base = extractQueryTermsForRerank(String(query || ''))
    .map((term) => normalizeEvidenceLine(String(term || '')).toLowerCase())
    .filter((term) => term.length >= 2);

  void language;
  return Array.from(new Set(base)).slice(0, maxTerms);
};

const normalizePolicyCandidate = (line: string): string =>
  String(line || '')
    .replace(/\s+/g, ' ')
    .replace(/^[➡→]+\s*/, '')
    .replace(/^[①-⑳]\s*/, '')
    .replace(/^[0-9０-９]+\s*[.)．:：]\s*/, '')
    .replace(/^第\s*[0-9０-９]+\s*(条|項)\s*/i, '')
    .replace(/^article\s*[0-9０-９]+\s*/i, '')
    .trim();

const toEnglishPolicyLine = (line: string): string | null => {
  const candidate = normalizePolicyCandidate(line);
  if (!candidate) return null;
  if (hasJapaneseChars(candidate)) return null;
  if (HOWTO_METADATA_NOISE_RE.test(candidate) || POLICY_LINE_NOISE_RE.test(candidate)) return null;
  const latinChars = (candidate.match(/[A-Za-z]/g) || []).length;
  if (latinChars < 10) return null;
  if (!POLICY_SIGNAL_RE.test(candidate) && !HOWTO_WORKFLOW_SIGNAL_RE.test(candidate)) return null;
  return /[.!?]$/.test(candidate) ? candidate : `${candidate}.`;
};

const toJapanesePolicyLine = (line: string): string | null => {
  const candidate = normalizePolicyCandidate(line);
  if (!candidate) return null;
  if (!hasJapaneseChars(candidate)) return null;
  if (HOWTO_METADATA_NOISE_RE.test(candidate) || POLICY_LINE_NOISE_RE.test(candidate)) return null;
  if (!POLICY_SIGNAL_RE.test(candidate) && !HOWTO_WORKFLOW_SIGNAL_RE.test(candidate)) return null;
  return /[。！？]$/.test(candidate) ? candidate : `${candidate}。`;
};

const normalizeFallbackLineKey = (line: string): string =>
  String(line || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(' ');

type QueryTopicProfile = {
  clockIn: boolean;
  attendanceCorrection: boolean;
  overtime: boolean;
  businessTrip: boolean;
  subordinateAttendanceIssue: boolean;
};

const CLOCK_IN_TOPIC_RE =
  /\b(clock[\s-]?in|clock[\s-]?out|missed\s+(?:a\s+)?clock[\s-]?in|missed\s+(?:a\s+)?clock[\s-]?out|attendance\s+report|work\s+report|attendance\s+record(?:s)?|time\s*clock|timecard|timesheet|punch(?:ing)?)\b|打刻|出勤\/退勤|勤怠報告|勤務報告|出勤簿/i;
const ATTENDANCE_CORRECTION_TOPIC_RE =
  /\b(correct(?:ion)?|adjust(?:ment)?|fix|edit|revise|update|missing|missed|forgot(?:ten)?|forgot\s+to|attendance\s+record(?:s)?|attendance\s+report)\b|修正|訂正|更正|打刻漏れ|勤怠〆後|勤怠締め後/i;
const OVERTIME_TOPIC_RE = /\b(overtime|over\s*time|extra\s+hours)\b|残業|時間外/i;
const BUSINESS_TRIP_TOPIC_RE = /\b(business\s+trip|trip|travel|direct\s+return|direct\s+work)\b|出張|直行|直帰/i;
const SUBORDINATE_ATTENDANCE_ISSUE_TOPIC_RE =
  /\b(subordinate|direct\s+report|manager|supervisor|interview|hr|human\s+resources|teams\s+chat)\b|部下|上司|面談|人事|勤怠不良/i;
const GENERAL_ATTENDANCE_TOPIC_RE = /\b(attendance|timesheet|timecard|work\s+report)\b|勤怠|出勤|退勤|勤務/i;

const buildQueryTopicProfile = (query: string): QueryTopicProfile => {
  const text = String(query || '');
  return {
    clockIn: CLOCK_IN_TOPIC_RE.test(text),
    attendanceCorrection: ATTENDANCE_CORRECTION_TOPIC_RE.test(text),
    overtime: OVERTIME_TOPIC_RE.test(text),
    businessTrip: BUSINESS_TRIP_TOPIC_RE.test(text),
    subordinateAttendanceIssue: SUBORDINATE_ATTENDANCE_ISSUE_TOPIC_RE.test(text),
  };
};

const scoreTopicAlignment = (text: string, profile: QueryTopicProfile): number => {
  const value = String(text || '').trim();
  if (!value) return 0;

  const hasClockIn = CLOCK_IN_TOPIC_RE.test(value);
  const hasCorrection = ATTENDANCE_CORRECTION_TOPIC_RE.test(value);
  const hasOvertime = OVERTIME_TOPIC_RE.test(value);
  const hasBusinessTrip = BUSINESS_TRIP_TOPIC_RE.test(value);
  const hasSubordinateAttendanceIssue = SUBORDINATE_ATTENDANCE_ISSUE_TOPIC_RE.test(value);
  const hasGeneralAttendance = GENERAL_ATTENDANCE_TOPIC_RE.test(value);

  let score = 0;
  if (profile.clockIn && hasClockIn) score += 3;
  if (profile.attendanceCorrection && hasCorrection) score += 3;
  if ((profile.clockIn || profile.attendanceCorrection) && hasGeneralAttendance) score += 1;
  if (profile.businessTrip && hasBusinessTrip) score += 2;
  if (profile.overtime && hasOvertime) score += 2;
  if (profile.subordinateAttendanceIssue && hasSubordinateAttendanceIssue) score += 2;

  if (!profile.overtime && hasOvertime && !hasClockIn && !hasCorrection) score -= 4;
  if (!profile.businessTrip && hasBusinessTrip && !hasClockIn && !hasCorrection) score -= 2;
  if (!profile.subordinateAttendanceIssue && hasSubordinateAttendanceIssue && !hasClockIn && !hasCorrection) {
    score -= 4;
  }

  return score;
};

const filterTopicAlignedLines = (
  lines: string[],
  profile: QueryTopicProfile,
  minCount: number,
): string[] => {
  const scored = (lines || []).map((line) => ({
    line: String(line || '').trim(),
    score: scoreTopicAlignment(line, profile),
  })).filter((row) => row.line);
  if (!scored.length) return [];

  const hasPositive = scored.some((row) => row.score > 0);
  if (!hasPositive) return scored.map((row) => row.line);

  const nonNegative = scored.filter((row) => row.score >= 0).map((row) => row.line);
  if (nonNegative.length >= minCount) return nonNegative;

  const positiveOnly = scored.filter((row) => row.score > 0).map((row) => row.line);
  if (positiveOnly.length >= minCount) return positiveOnly;

  return nonNegative.length > 0 ? nonNegative : scored.map((row) => row.line);
};

const filterRenderedHowToBodyByTopic = (
  text: string,
  profile: QueryTopicProfile,
  minCount: number,
): string => {
  const renderedLines = uniqueStringList(
    String(text || '')
      .split(/\n+/)
      .flatMap((line) =>
        String(line || '')
          .split(/(?<=[.!?])\s+/)
          .map((part) => String(part || '').trim())
          .filter(Boolean),
      ),
    RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
  );
  if (!renderedLines.length) return String(text || '').trim();
  const filtered = filterTopicAlignedLines(renderedLines, profile, minCount);
  if (filtered.length < minCount) return String(text || '').trim();
  return filtered
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .join('\n\n')
    .trim();
};

const EMAIL_SIGNATURE_QUERY_RE =
  /(?:\be-?mail\s+signature\b|\bmail\s+signature\b|\bemail\s+disclaimer\b|メール署名|e-mail署名|秘密情報保持のお願い|署名欄)/i;
const EMAIL_SIGNATURE_ANSWER_RE =
  /(?:\be-?mail\s+signature\b|\bmail\s+signature\b|\bemail\s+disclaimer\b|\battachments?\b|メール署名|e-mail署名|秘密情報保持のお願い|署名欄|誤送信|送信した電子メール)/i;
const EMAIL_SIGNATURE_NOTICE_EN_FALLBACK =
  'Sent electronic mail (including attachments) may contain personal or confidential information. If you received it in error, do not copy, use, or disclose it; promptly contact the sender and delete it from the system.';
const EMAIL_SIGNATURE_NOTICE_JA_FALLBACK = [
  '送信した電子メール（添付ファイル等を含みます）には、',
  '個人情報や秘密情報が含まれている場合があります。',
  'もし誤って受信された場合には、一切の複写、利用、',
  '開示等をなさらず、すみやかに送信元にご連絡をいただき、',
  'システム上から削除していただきますようお願いいたします。',
].join('');

const requiresEmailSignatureCoverage = (query: string): boolean =>
  EMAIL_SIGNATURE_QUERY_RE.test(String(query || ''));

const hasEmailSignatureCoverage = (text: string): boolean =>
  EMAIL_SIGNATURE_ANSWER_RE.test(String(text || ''));

const extractEmailSignatureRequiredNotice = (
  text: string,
  language: 'ja' | 'en',
): string => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const englishMatch = normalized.match(
    /This email \(including any attachments\) may contain personal information or proprietary information\.\s*If you are not the intended recipient, please refrain from copying, using or disclosing this email and\/or any attachments, notify (?:us|the sender) immediately, and delete all copies of the email and any attachments from the system\./i,
  );
  if (englishMatch?.[0]) {
    return String(englishMatch[0]).replace(/\s+/g, ' ').trim();
  }

  const japaneseMatch = normalized.match(
    /送信した電子メール（添付ファイル等を含みます）には、\s*個人情報や秘密情報が含まれている場合があります。\s*もし誤って受信された場合には、一切の複写、利用、\s*開示等をなさらず、すみやかに送信元にご連絡をいただき、\s*システム上から削除していただきますようお願いいたします。/i,
  );
  if (!japaneseMatch?.[0]) return '';
  return language === 'ja'
    ? EMAIL_SIGNATURE_NOTICE_JA_FALLBACK
    : EMAIL_SIGNATURE_NOTICE_EN_FALLBACK;
};

const buildExtractiveEmailSignatureAnswerFromText = (params: {
  text: string;
  language: 'ja' | 'en';
  query: string;
  sources: Array<{ docId: string; title?: string }>;
}): FastHowToAnswer | null => {
  const rawText = String(params.text || '').trim();
  if (!rawText || !hasEmailSignatureCoverage(rawText)) return null;

  const normalizedText = rawText.replace(/\s+/g, ' ').trim();
  const requiredNotice = extractEmailSignatureRequiredNotice(normalizedText, params.language);
  const requiresAllEmployees =
    /すべての役員.*従業員.*送信するeメール.*署名.*必ず記載/i.test(normalizedText) ||
    /all executives.*employees.*email.*signature/i.test(normalizedText);
  const requiresPersonalEmailUsers =
    /個人のメールアドレス.*署名欄.*秘密情報.*文章.*追加/i.test(normalizedText);
  const useExactWording =
    /原文のままご使用ください|use (?:the notice|it) exactly as written/i.test(normalizedText);
  const hasAttachmentGuide =
    /文章記載方法|ご参照ください|英語版、中国語版|attached instructions?/i.test(normalizedText);
  const hasReminder =
    /署名がついていないメール|相手にひと声|相互確認|missing the signature/i.test(normalizedText);

  const sourceMap = new Map<string, { docId: string; title?: string }>();
  for (const source of Array.isArray(params.sources) ? params.sources : []) {
    const docId = String(source?.docId || '').trim();
    const title = String(source?.title || '').trim();
    const key = docId || title;
    if (!key || sourceMap.has(key)) continue;
    sourceMap.set(key, { docId, title });
  }
  const sources = Array.from(sourceMap.values());

  if (params.language === 'en') {
    const answerLines: string[] = [];
    if (requiresAllEmployees) {
      answerLines.push('All executives and employees must include the required signature notice in every email they send.');
    } else if (requiresPersonalEmailUsers) {
      answerLines.push('Employees who use a personal email address must add the prescribed confidentiality notice to the email signature field.');
    } else {
      answerLines.push('The documents require a confidentiality notice to be added to the email signature.');
    }
    if (useExactWording) {
      answerLines.push('The notice must be used exactly as written.');
    }
    if (hasAttachmentGuide && !requiresAllEmployees) {
      answerLines.push('The document points employees to the attached instructions for how to add the notice to the signature field.');
    }
    if (requiredNotice) {
      answerLines.push(`Required notice: ${requiredNotice}`);
    }
    if (hasReminder) {
      answerLines.push('If an internal email is missing the signature, employees should remind the sender to add it.');
    }
    const answer = appendSourceFooter(answerLines.join('\n\n'), sources, params.query, 'en');
    return {
      answer,
      sources,
      confidence: requiredNotice ? 0.92 : 0.86,
    };
  }

  const answerLines: string[] = [];
  if (requiresAllEmployees) {
    answerLines.push('すべての役員・従業員が送信するEメールには、指定された署名（注意文）を必ず記載します。');
  } else if (requiresPersonalEmailUsers) {
    answerLines.push('個人のメールアドレスを利用する場合は、署名欄に指定の「秘密情報保持のお願い」を追加します。');
  } else {
    answerLines.push('Eメール署名には、指定された秘密情報保持の注意文を追加する必要があります。');
  }
  if (useExactWording) {
    answerLines.push('署名末尾に追加する定型文は、原文のまま使用します。');
  }
  if (hasAttachmentGuide && !requiresAllEmployees) {
    answerLines.push('署名欄への追加方法は、添付の案内に従ってください。');
  }
  if (requiredNotice) {
    answerLines.push(`記載する定型文: ${requiredNotice}`);
  }
  if (hasReminder) {
    answerLines.push('署名が付いていないメールを見かけた場合は、送信者へ追記を依頼します。');
  }
  const answer = appendSourceFooter(answerLines.join('\n\n'), sources, params.query, 'ja');
  return {
    answer,
    sources,
    confidence: requiredNotice ? 0.9 : 0.84,
  };
};

const buildExtractiveEmailSignatureAnswerFromPromptContext = (params: {
  prompt: string;
  language: 'ja' | 'en';
  query: string;
  sources: Array<{ docId: string; title?: string }>;
}): FastHowToAnswer | null => {
  if (!requiresEmailSignatureCoverage(params.query)) return null;
  const rawPrompt = String(params.prompt || '').trim();
  if (!rawPrompt) return null;
  const contextMatch = rawPrompt.match(/DOCUMENT CONTEXT:\s*([\s\S]*)$/i);
  const contextText = String(contextMatch?.[1] || rawPrompt).trim();
  return buildExtractiveEmailSignatureAnswerFromText({
    text: contextText,
    language: params.language,
    query: params.query,
    sources: params.sources,
  });
};

const deriveHighPriorityPolicyLines = (docs: any[], query: string, minScore = 2): string[] => {
  if (!Array.isArray(docs) || docs.length === 0) return [];
  const queryTerms = buildFallbackQueryTerms(String(query || ''), 'en', 18);
  const topicProfile = buildQueryTopicProfile(query);
  const aggregate = new Map<string, { text: string; score: number; hits: number }>();
  for (const doc of docs.slice(0, 3)) {
    for (const line of extractEvidenceLinesFromDoc(doc)) {
      const normalized = normalizePolicyCandidate(line);
      if (!normalized) continue;
      if (HOWTO_METADATA_NOISE_RE.test(normalized) || POLICY_LINE_NOISE_RE.test(normalized)) continue;
      const lower = normalized.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (lower.includes(String(term || '').toLowerCase())) score += 2;
      }
      score += scoreTopicAlignment(normalized, topicProfile) * 2;
      if (POLICY_SIGNAL_RE.test(normalized)) score += 2;
      if (HOWTO_WORKFLOW_SIGNAL_RE.test(normalized)) score += 1;
      if (score < minScore) continue;
      const existing = aggregate.get(normalized);
      if (existing) {
        existing.hits += 1;
      } else {
        aggregate.set(normalized, { text: normalized, score, hits: 1 });
      }
    }
  }

  return [...aggregate.values()]
    .sort((a, b) => (b.score - a.score) || (b.hits - a.hits) || (b.text.length - a.text.length))
    .map((entry) => entry.text);
};

const assessHowToStepQuality = (steps: string[]): {
  stepCount: number;
  actionCount: number;
  actionRatio: number;
  legalStyleCount: number;
  legalStyleRatio: number;
  workflowSignalCount: number;
  policyOnlyCount: number;
  weak: boolean;
} => {
  const normalizedSteps = (steps || [])
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[0-9０-９]+\s*[.)．:：]\s*/, '')
        .replace(/^[①-⑳]\s*/, '')
        .replace(/^第\s*[0-9０-９]+\s*(?:条|項)\s*/i, '')
        .replace(/^step\s*[0-9０-９]+\s*[:.)-]?\s*/i, '')
        .replace(/^ステップ\s*[0-9０-９]+\s*[:.)-]?\s*/i, '')
        .trim(),
    )
    .filter(Boolean);

  const stepCount = normalizedSteps.length;
  if (!stepCount) {
    return {
      stepCount: 0,
      actionCount: 0,
      actionRatio: 0,
      legalStyleCount: 0,
      legalStyleRatio: 0,
      workflowSignalCount: 0,
      policyOnlyCount: 0,
      weak: true,
    };
  }

  const actionCount = normalizedSteps.filter(
    (line) => HOWTO_ACTION_LINE_RE.test(line) && !LEGAL_ARTICLE_STYLE_RE.test(line),
  ).length;
  const legalStyleCount = normalizedSteps.filter(
    (line) => LEGAL_ARTICLE_STYLE_RE.test(line) && !HOWTO_WORKFLOW_SIGNAL_RE.test(line),
  ).length;
  const workflowSignalCount = normalizedSteps.filter((line) => HOWTO_WORKFLOW_SIGNAL_RE.test(line) || /[→>]/.test(line)).length;
  const policyOnlyCount = normalizedSteps.filter((line) => HOWTO_POLICY_ONLY_RE.test(line)).length;

  const actionRatio = actionCount / stepCount;
  const legalStyleRatio = legalStyleCount / stepCount;
  const policyOnlyRatio = policyOnlyCount / stepCount;

  const weak =
    stepCount < RAG_FAST_HOWTO_MIN_STEPS ||
    actionCount < RAG_FAST_HOWTO_MIN_ACTION_STEPS ||
    actionRatio < RAG_FAST_HOWTO_MIN_ACTION_RATIO ||
    legalStyleRatio >= RAG_FAST_HOWTO_MAX_LEGAL_STYLE_RATIO ||
    policyOnlyRatio >= 0.5 ||
    workflowSignalCount === 0;

  return {
    stepCount,
    actionCount,
    actionRatio,
    legalStyleCount,
    legalStyleRatio,
    workflowSignalCount,
    policyOnlyCount,
    weak,
  };
};

const isHeadingOnlyProceduralLine = (line: string): boolean => {
  const value = String(line || '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  if (/[。.!?]$/.test(value)) return false;
  if (value.length > 26) return false;
  if (/[,:;、，：\-‐‑‒–—―→>]/.test(value)) return false;
  const nonSpaceChars = value.replace(/\s+/g, '');
  return nonSpaceChars.length >= 4;
};

const extractProceduralLines = (doc: any): string[] => {
  const body = Array.isArray(doc?.content_txt)
    ? String(doc.content_txt.join('\n') || '')
    : String(doc?.content_txt || doc?.content || '');
  const text = body;
  if (!text.trim()) return [];

  const rawLines = text
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(0, 120);
  const selected = new Set<string>();

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const line = rawLines[idx];
    const normalized = line.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    if (HOWTO_QUESTION_STYLE_RE.test(normalized)) {
      continue;
    }
    if (HOWTO_METADATA_NOISE_RE.test(normalized)) {
      continue;
    }
    if (LEGAL_ARTICLE_STYLE_RE.test(normalized)) {
      continue;
    }
    const proceduralHit =
      PROCEDURAL_HEADER_RE.test(normalized) ||
      PROCEDURAL_ACTION_RE.test(normalized) ||
      /[→>]/.test(normalized);
    if (!proceduralHit) continue;
    let candidate = normalized;
    if (isHeadingOnlyProceduralLine(normalized)) {
      const nextLine = String(rawLines[idx + 1] || '').replace(/\s+/g, ' ').trim();
      if (
        nextLine &&
        nextLine.length >= 6 &&
        nextLine.length <= 180 &&
        !PROCEDURAL_LINE_RE.test(nextLine)
      ) {
        candidate = `${normalized}: ${nextLine}`;
      }
    }
    if (candidate.length < 4) continue;
    if (candidate.length > 240) continue;
    selected.add(candidate);
    if (selected.size >= RAG_FAST_HOWTO_MAX_STEPS * 2) break;
  }

  if (selected.size >= RAG_FAST_HOWTO_MIN_STEPS) {
    return [...selected];
  }

  // Sentence-level fallback when original chunks are long single-line paragraphs.
  const sentenceCandidates = body
    .split(/[\n。！？.!?]/)
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 6 && s.length <= 180)
    .filter((s) => PROCEDURAL_HEADER_RE.test(s) || PROCEDURAL_ACTION_RE.test(s) || /[→>]/.test(s))
    .slice(0, RAG_FAST_HOWTO_MAX_STEPS * 2);
  for (const sentence of sentenceCandidates) selected.add(sentence);

  return [...selected];
};

const computeFastHowToTopTermHits = (docs: any[], probeQuery: string): number => {
  const candidates = Array.isArray(docs) ? docs : [];
  if (!candidates.length) return 0;
  const terms = extractQueryTermsForRerank(String(probeQuery || ''));
  if (!terms.length) return 0;
  return Math.max(
    ...candidates.map((doc) => countDocTermHits(doc, terms)),
    0,
  );
};

const isFastHowToTopScoreEligible = ({
  topScore,
  topTermHits,
  language,
  explicitHowToCue,
}: {
  topScore: number;
  topTermHits: number;
  language: 'ja' | 'en';
  explicitHowToCue: boolean;
}): boolean => {
  if (topScore > RAG_FAST_HOWTO_TOP_SCORE_MIN) return true;
  if (
    language === 'en' &&
    explicitHowToCue &&
    topScore >= RAG_FAST_HOWTO_TOP_SCORE_MIN_RELAXED &&
    topTermHits >= RAG_FAST_HOWTO_MIN_TERM_HITS_RELAXED_EN
  ) {
    return true;
  }
  return false;
};

const buildExtractiveHowToAnswer = (
  docs: any[],
  language: 'ja' | 'en',
  focusQuery: string = '',
): FastHowToAnswer | null => {
  if (!Array.isArray(docs) || docs.length === 0) return null;

  const queryTerms = buildFallbackQueryTerms(String(focusQuery || ''), language, 18);
  const topicProfile = buildQueryTopicProfile(focusQuery);

  const scoredDocs = docs
    .slice(0, 6)
    .map((doc) => {
      const title = Array.isArray(doc?.title)
        ? String(doc.title[0] || '')
        : String(doc?.title || doc?.file_name_s || doc?.id || '');
      const body = Array.isArray(doc?.content_txt)
        ? String(doc.content_txt.join('\n') || '')
        : String(doc?.content_txt || doc?.content || '');
      return {
        doc,
        title,
        termHits: queryTerms.length > 0 ? countDocTermHits(doc, queryTerms) : 0,
        proceduralScore: scoreProceduralSignal(doc),
        topicScore: scoreTopicAlignment(`${title}\n${body.slice(0, 1400)}`, topicProfile),
        score: Number(doc?.score || 0),
      };
    })
    .sort((a, b) =>
      (b.termHits - a.termHits) ||
      (b.topicScore - a.topicScore) ||
      (b.proceduralScore - a.proceduralScore) ||
      (b.score - a.score),
    );

  let candidateRows = scoredDocs
    .filter((row) => queryTerms.length === 0 || row.termHits > 0 || row.topicScore > 0)
    .slice(0, 5);
  if (candidateRows.length === 0) {
    candidateRows = scoredDocs.slice(0, 4);
  }
  if (candidateRows.some((row) => row.topicScore > 0)) {
    const topicAlignedRows = candidateRows.filter((row) => row.topicScore >= 0);
    if (topicAlignedRows.length > 0) {
      candidateRows = topicAlignedRows;
    }
  }
  const topDocs = candidateRows.map((row) => row.doc);

  const stepRows: Array<{ text: string; score: number; docId: string; title: string }> = [];
  const seen = new Set<string>();
  for (const doc of topDocs) {
    const docId = String(doc?.id || '');
    const title = Array.isArray(doc?.title)
      ? String(doc.title[0] || '')
      : String(doc?.title || doc?.file_name_s || doc?.id || '');
    const docBaseScore = Number(doc?.score || 0) / 100;
    for (const line of extractProceduralLines(doc)) {
      const normalized = normalizeEvidenceLine(line);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const topicScore = scoreTopicAlignment(line, topicProfile);
      if (topicScore <= -3) continue;

      const termHits = queryTerms.length > 0
        ? queryTerms.reduce((hits, term) => hits + (key.includes(term) ? 1 : 0), 0)
        : 0;
      if (queryTerms.length > 0 && termHits <= 0 && topicScore <= 0) continue;

      const score =
        (termHits * 3) +
        (topicScore * 2.5) +
        (PROCEDURAL_LINE_RE.test(line) ? 1 : 0) +
        (/[→>]/.test(line) ? 1 : 0) +
        docBaseScore;
      stepRows.push({ text: line, score, docId, title });
    }
  }

  if (stepRows.length < RAG_FAST_HOWTO_MIN_STEPS) return null;

  stepRows.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  const selected = stepRows.slice(0, RAG_FAST_HOWTO_DETAIL_MAX_STEPS);
  let steps = selected.map((row) => row.text);
  const detailTargetSteps = language === 'en'
    ? RAG_FAST_HOWTO_DETAIL_MIN_STEPS_EN
    : RAG_FAST_HOWTO_DETAIL_MIN_STEPS_JA;
  const desiredMinSteps =
    language === 'en' && hasExplicitProcedureCue(String(focusQuery || ''))
      ? Math.max(RAG_FAST_HOWTO_MIN_STEPS, 3)
      : RAG_FAST_HOWTO_MIN_STEPS;
  if (language === 'en') {
    const isUsableEnglishStep = (line: string): boolean => {
      const value = String(line || '').replace(/\s+/g, ' ').trim();
      if (!value) return false;
      if (HOWTO_METADATA_NOISE_RE.test(value)) return false;
      if (/(https?:\/\/|www\.|table_\d+|song\/laravel-admin|\bID\s*\d+\b)/i.test(value)) return false;
      const latinChars = (value.match(/[A-Za-z]/g) || []).length;
      const digitChars = (value.match(/[0-9]/g) || []).length;
      if (latinChars < 12) return false;
      if (digitChars > latinChars) return false;
      return true;
    };
    let mappedSteps = uniqueStringList(
      steps
        .map((line) => toEnglishPolicyLine(line))
        .filter((line): line is string => Boolean(String(line || '').trim())),
      RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
    );
    mappedSteps = uniqueStringList(
      mappedSteps
        .flatMap((line) =>
          String(line || '')
            .split(/(?<=[.!?])\s+/)
            .map((part) => String(part || '').trim())
            .filter(Boolean),
        )
        .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`)),
      RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
    );
    mappedSteps = mappedSteps.filter((line) => isUsableEnglishStep(line));
    const actionStepRe = /^(log in|open|enter|submit|have|obtain|record|review|complete|report|notify)\b/i;
    const actionSteps = mappedSteps.filter((line) => actionStepRe.test(String(line || '').trim()));
    if (actionSteps.length >= desiredMinSteps) {
      mappedSteps = uniqueStringList(actionSteps, RAG_FAST_HOWTO_DETAIL_MAX_STEPS);
    } else if (actionSteps.length > 0) {
      mappedSteps = uniqueStringList(
        [...actionSteps, ...mappedSteps],
        RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
      );
    }
    const policyOnlyLineRe = /must be handled according to .*regulations/i;
    if (mappedSteps.length > desiredMinSteps) {
      const filtered = mappedSteps.filter((line) => !policyOnlyLineRe.test(String(line || '').trim()));
      if (filtered.length >= desiredMinSteps) {
        mappedSteps = filtered;
      }
    }
    if (mappedSteps.length < detailTargetSteps || mappedSteps.join('\n').length < RAG_FAST_HOWTO_DETAIL_MIN_CHARS_EN) {
      const policySupplements = uniqueStringList(
        deriveHighPriorityPolicyLines(topDocs, focusQuery, 4),
        RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
      );
      mappedSteps = uniqueStringList(
        [...mappedSteps, ...policySupplements],
        RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
      );
    }
    if (mappedSteps.length > desiredMinSteps) {
      const filtered = mappedSteps.filter((line) => !policyOnlyLineRe.test(String(line || '').trim()));
      if (filtered.length >= desiredMinSteps) {
        mappedSteps = filtered;
      }
    }
    steps = mappedSteps;
  } else {
    let mappedSteps = uniqueStringList(
      steps
        .map((line) => toJapanesePolicyLine(line))
        .filter((line): line is string => Boolean(String(line || '').trim())),
      RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
    );
    steps = mappedSteps;
  }
  steps = filterTopicAlignedLines(steps, topicProfile, desiredMinSteps);
  steps = steps.filter((line) => !HOWTO_METADATA_NOISE_RE.test(String(line || '').trim()));
  if (steps.length < desiredMinSteps) return null;
  const stepQuality = assessHowToStepQuality(steps);
  if (stepQuality.weak) return null;

  const sourceMap = new Map<string, { docId: string; title?: string }>();
  for (const row of selected) {
    if (!sourceMap.has(row.docId)) {
      sourceMap.set(row.docId, { docId: row.docId, title: row.title });
    }
  }
  const sources = Array.from(sourceMap.values());
  const answerBody = uniqueStringList(
    steps.map((step) => String(step || '').trim()).filter(Boolean),
    RAG_FAST_HOWTO_DETAIL_MAX_STEPS,
  ).join(language === 'ja' ? '\n\n' : '\n\n');
  const answer = appendSourceFooter(answerBody, sources, focusQuery, language);
  return {
    answer,
    sources,
    confidence: Math.min(0.94, 0.68 + Math.min(0.2, steps.length * 0.04)),
  };
};

const extractEvidenceLinesFromDoc = (doc: any): string[] => {
  const body = Array.isArray(doc?.content_txt)
    ? String(doc.content_txt.join('\n') || '')
    : String(doc?.content_txt || doc?.content || '');
  const text = body;
  if (!text.trim()) return [];
  return uniqueStringList(
    text
      .split(/[\n。！？.!?]/)
      .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
      .filter((line) => line.length >= 8 && line.length <= 200),
    200,
  );
};

const hasStructuredPolicyArticles = (docs: any[]): boolean => {
  const rows = Array.isArray(docs) ? docs : [];
  if (!rows.length) return false;
  let articleSignalCount = 0;
  for (const doc of rows.slice(0, 4)) {
    const title = Array.isArray(doc?.title)
      ? String(doc.title[0] || '')
      : String(doc?.title || doc?.file_name_s || '');
    const body = Array.isArray(doc?.content_txt)
      ? String(doc.content_txt.join('\n') || '')
      : String(doc?.content_txt || doc?.content || '');
    const text = `${title}\n${body}`;
    const matches = text.match(/(?:第\s*[0-9０-９]+\s*(?:条|項)|article\s*[0-9０-９]+|clause\s*[0-9０-９]+)/ig) || [];
    articleSignalCount += matches.length;
    if (articleSignalCount >= 2) return true;
  }
  return false;
};

const buildExtractiveContextAnswer = (
  docs: any[],
  language: 'ja' | 'en',
  query: string,
): FastHowToAnswer | null => {
  if (!Array.isArray(docs) || docs.length === 0) return null;
  if (hasStructuredPolicyArticles(docs)) {
    // For structured policy docs, avoid generic sentence fallback.
    // The primary reasoning-based evidence extractor should produce the final answer.
    return null;
  }
  const topDocs = docs.slice(0, 3);
  const queryTerms = buildFallbackQueryTerms(query, language, 18);
  if (areFallbackQueryTermsTooGeneric(queryTerms)) {
    return null;
  }

  const scoredLines: Array<{ text: string; score: number }> = [];
  for (const doc of topDocs) {
    for (const line of extractEvidenceLinesFromDoc(doc)) {
      const lower = line.toLowerCase();
      let hits = 0;
      for (const term of queryTerms) {
        if (term && lower.includes(term)) hits += 1;
      }
      const score = hits * 2 + (PROCEDURAL_LINE_RE.test(line) ? 1 : 0) + (/[→>]/.test(line) ? 1 : 0);
      scoredLines.push({ text: line, score });
    }
  }

  scoredLines.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  const selected = uniqueStringList(
    scoredLines
      .filter((row) => row.score > 0)
      .map((row) => row.text),
    4,
  );
  if (selected.length === 0) {
    if (queryTerms.length > 0) return null;
    const fallbackLines = uniqueStringList(
      topDocs.flatMap((doc) => extractEvidenceLinesFromDoc(doc)).slice(0, 4),
      4,
    );
    if (fallbackLines.length === 0) return null;
    selected.push(...fallbackLines);
  }

  let rendered = selected;
  if (language === 'en') {
    let mapped = uniqueStringList(
      selected
        .map((line) => toEnglishPolicyLine(line))
        .filter((line): line is string => Boolean(String(line || '').trim())),
      4,
    );
    if (mapped.length === 0) {
      mapped = uniqueStringList(
        deriveHighPriorityPolicyLines(topDocs, query, 5),
        3,
      );
    }
    if (mapped.length === 0) return null;

    const sentenceCandidates = mapped
      .flatMap((line) =>
        String(line || '')
          .split(/(?<=[.!?])\s+/)
          .map((part) => String(part || '').trim())
          .filter(Boolean),
      )
      .map((sentence) =>
        /[.!?]$/.test(sentence) ? sentence : `${sentence}.`,
      );

    const compactRendered: string[] = [];
    const seenKeys = new Set<string>();
    for (const sentence of sentenceCandidates) {
      const key = normalizeFallbackLineKey(sentence);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      compactRendered.push(sentence);
      if (compactRendered.length >= 3) break;
    }
    rendered = compactRendered.length > 0 ? compactRendered : mapped;
    if (rendered.length < 2) {
      const enrichLines = deriveHighPriorityPolicyLines(topDocs, query, 8);
      for (const line of enrichLines) {
        const sentence = /[.!?]$/.test(line) ? line : `${line}.`;
        const key = normalizeFallbackLineKey(sentence);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        rendered.push(sentence);
        if (rendered.length >= 3) break;
      }
    }
    rendered = uniqueStringList(rendered, 3);
  }

  const renderedText = rendered.join('\n');
  if (requiresEmailSignatureCoverage(query) && !hasEmailSignatureCoverage(renderedText)) {
    return null;
  }

  const sources = topDocs.map((doc) => ({
    docId: String(doc?.id || ''),
    title: Array.isArray(doc?.title)
      ? String(doc.title[0] || '')
      : String(doc?.title || doc?.file_name_s || doc?.id || ''),
  }));
  const intro = language === 'ja'
    ? '関連する社内文書の記載（抜粋）:'
    : 'Relevant policy points from internal documents:';
  const bullets = rendered.map((line) => `- ${line}`).join('\n');
  const answer = appendSourceFooter(`${intro}\n${bullets}`, sources, query, language);
  return {
    answer,
    sources,
    confidence: Math.min(0.88, 0.6 + Math.min(0.18, selected.length * 0.05)),
  };
};

const buildExtractiveEmailSignatureAnswer = (
  docs: any[],
  language: 'ja' | 'en',
  query: string,
): FastHowToAnswer | null => {
  if (!requiresEmailSignatureCoverage(query)) return null;
  const topDocs = (Array.isArray(docs) ? docs : []).slice(0, 3);
  if (!topDocs.length) return null;

  const relevantDocs = topDocs.filter((doc) => {
    const title = Array.isArray(doc?.title)
      ? String(doc.title[0] || '')
      : String(doc?.title || doc?.file_name_s || '');
    const body = Array.isArray(doc?.content_txt)
      ? String(doc.content_txt.join('\n') || '')
      : String(doc?.content_txt || doc?.content || '');
    return hasEmailSignatureCoverage(`${title}\n${body}`);
  });
  const sourceDocs = relevantDocs.length > 0 ? relevantDocs : topDocs;
  const sources = sourceDocs.map((doc) => ({
    docId: String(doc?.id || ''),
    title: Array.isArray(doc?.title)
      ? String(doc.title[0] || '')
      : String(doc?.title || doc?.file_name_s || doc?.id || ''),
  }));
  const combinedText = sourceDocs
    .map((doc) => {
      const title = Array.isArray(doc?.title)
        ? String(doc.title[0] || '')
        : String(doc?.title || doc?.file_name_s || doc?.id || '');
      const body = Array.isArray(doc?.content_txt)
        ? String(doc.content_txt.join('\n') || '')
        : String(doc?.content_txt || doc?.content || '');
      return `${title}\n${body}`.trim();
    })
    .filter(Boolean)
    .join('\n\n');

  return buildExtractiveEmailSignatureAnswerFromText({
    text: combinedText,
    language,
    query,
    sources,
  });
};

// doc-level reranking + snippet extraction live in src/rag/retrieval and src/rag/context

// prompt templates live in src/rag/generation/promptBuilder

const isCannotConfirmStyleAnswer = (value: string): boolean => {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  const compactLatin = text.replace(/[^a-z]/g, '');
  const compactJa = text.replace(/[\s。、，,.:;!?！？「」『』【】（）()]/g, '');
  return (
    text.includes('i can’t confirm from the provided documents') ||
    text.includes("i can't confirm from the provided documents") ||
    text.includes('i could not find a matching section in internal policy documents') ||
    text.includes('i could not find relevant information in the available company documents') ||
    text.includes('i could not find relevant information in the available thirdwave internal documents') ||
    text.includes('the requested information was not found in the available company documents') ||
    text.includes('the requested information was not found in the available thirdwave internal documents') ||
    text.includes('提供された文書から確認できません') ||
    text.includes('社内文書から該当する記載を確認できません') ||
    text.includes('利用可能な社内文書内で、要求された情報は見つかりませんでした') ||
    text.includes('利用可能なサードウェーブ社内文書内で、要求された情報は見つかりませんでした') ||
    compactLatin.includes('icouldnotfindrelevantinformationintheavailablecompanydocuments') ||
    compactLatin.includes('icouldnotfindrelevantinformationintheavailablethirdwaveinternaldocuments') ||
    compactLatin.includes('therequestedinformationwasnotfoundintheavailablecompanydocuments') ||
    compactLatin.includes('therequestedinformationwasnotfoundintheavailablethirdwaveinternaldocuments') ||
    compactJa.includes('利用可能なサードウェーブ社内文書内で要求された情報は見つかりませんでした') ||
    compactJa.includes('利用可能な社内文書内で要求された情報は見つかりませんでした')
  );
};

const isGenerationFailureStyleAnswer = (value: string): boolean => {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('answer generation failed due to a temporary model issue') ||
    text.includes('回答生成に一時的な問題が発生しました')
  );
};

const isWeakHowToAnswer = (value: string, language: 'ja' | 'en'): boolean => {
  const text = String(value || '').trim();
  if (!text) return true;

  const body = text
    .split('\n')
    .filter((line) => !/^\s*SOURCE\s*:/i.test(String(line || '')))
    .join('\n')
    .trim();
  if (!body) return true;

  const stepLines = body
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter((line) => /^(?:[0-9０-９]+[\).．]|[①-⑳]|step\s*[0-9０-９]+|ステップ\s*[0-9０-９]+)/i.test(line));
  const hasStepList = stepLines.length > 0;
  if (hasStepList) {
    const stepQuality = assessHowToStepQuality(stepLines);
    return stepQuality.weak;
  }

  const hasWorkflowSignal = PROCEDURAL_LINE_RE.test(body) || /[→>]/.test(body);

  if (language === 'ja') {
    if (/[、,:：]\s*$/.test(body)) return true;
    if (body.length < 45 && !hasWorkflowSignal) return true;
    return false;
  }

  if (/[,:;\-]\s*$/.test(body)) return true;
  if (body.length < 60 && !hasWorkflowSignal) return true;
  return false;
};

const isWeakGeneralAnswer = (value: string, language: 'ja' | 'en'): boolean => {
  const text = String(value || '').trim();
  if (!text) return true;

  const body = stripExistingSourceFooter(text).trim();
  if (!body) return true;
  if (hasStepHeaderWithoutDetail(body)) return true;

  const lines = body
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (!lines.length) return true;
  const last = String(lines[lines.length - 1] || '').trim();
  if (isHeadingLikeTailLine(last)) return true;

  if (language === 'en') {
    const hasEnglishSignal = /[A-Za-z]/.test(body);
    if (!hasEnglishSignal) return true;
    if (body.length < 120 && lines.length < 3) return true;
    if (lines.length === 1 && !/[.!?]$/.test(last)) return true;
    return false;
  }

  if (body.length < 80 && lines.length < 2) return true;
  if (lines.length === 1 && !/[。！？.!?]$/.test(last)) return true;
  return false;
};

const answerBodyLines = (value: string): string[] =>
  stripExistingSourceFooter(String(value || ''))
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean);

const HOWTO_STEP_LINE_RE = /^(?:[0-9０-９]+[\).．]|[①-⑳]|step\s*[0-9０-９]+|ステップ\s*[0-9０-９]+)/i;

const isInsufficientHowToDetail = (value: string, language: 'ja' | 'en'): boolean => {
  const lines = answerBodyLines(value);
  if (!lines.length) return true;
  const body = lines.join('\n').trim();
  if (!body) return true;

  const bodyLines = lines.filter((line) => !/^\s*SOURCES?\s*:/i.test(String(line || '')));
  const numberedSteps = bodyLines.filter((line) => HOWTO_STEP_LINE_RE.test(String(line || '').trim())).length;
  const effectiveStepCount = numberedSteps > 0
    ? numberedSteps
    : Math.max(0, bodyLines.length - 1); // ignore intro line when not explicitly numbered
  const minSteps = language === 'en'
    ? RAG_FAST_HOWTO_DETAIL_MIN_STEPS_EN
    : RAG_FAST_HOWTO_DETAIL_MIN_STEPS_JA;
  const minChars = language === 'en'
    ? RAG_FAST_HOWTO_DETAIL_MIN_CHARS_EN
    : RAG_FAST_HOWTO_DETAIL_MIN_CHARS_JA;

  return effectiveStepCount < minSteps || body.length < minChars;
};

const hasRelaxedFastHowToDetail = (value: string, language: 'ja' | 'en'): boolean => {
  if (language !== 'en') return !isInsufficientHowToDetail(value, language);
  const lines = answerBodyLines(value);
  if (!lines.length) return false;
  const body = lines.join('\n').trim();
  if (!body) return false;

  const bodyLines = lines.filter((line) => !/^\s*SOURCES?\s*:/i.test(String(line || '')));
  const numberedSteps = bodyLines.filter((line) => HOWTO_STEP_LINE_RE.test(String(line || '').trim())).length;
  const effectiveStepCount = numberedSteps > 0
    ? numberedSteps
    : Math.max(0, bodyLines.length);

  return (
    effectiveStepCount >= Math.max(RAG_FAST_HOWTO_MIN_STEPS, 3) &&
    body.length >= Math.max(150, Math.floor(RAG_FAST_HOWTO_DETAIL_MIN_CHARS_EN * 0.6))
  );
};

const looksEnglishEnoughForHowTo = (text: string): boolean => {
  const value = String(text || '').trim();
  if (!value) return false;
  const latinChars = (value.match(/[A-Za-z]/g) || []).length;
  if (latinChars < 32) return false;
  const japaneseChars = (value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  if (japaneseChars === 0) return true;
  return japaneseChars <= Math.max(8, Math.floor(latinChars * 0.12));
};

const buildDetailedEnglishHowToFromJapaneseEvidence = async (params: {
  docs: any[];
  focusQuery: string;
  originalQuery: string;
}): Promise<FastHowToAnswer | null> => {
  if (!RAG_FAST_HOWTO_EN_TRANSLATE_FALLBACK) return null;
  if (!Array.isArray(params.docs) || params.docs.length === 0) return null;

  const jaExtractive = buildExtractiveHowToAnswer(params.docs, 'ja', params.focusQuery);
  if (!jaExtractive) return null;
  if (isInsufficientHowToDetail(jaExtractive.answer, 'ja')) return null;

  const jaBody = stripExistingSourceFooter(jaExtractive.answer).trim();
  if (!jaBody) return null;

  let translatedBody = '';
  try {
    translatedBody = String(
      await translateText(
        jaBody,
        'en',
        false,
        RAG_FAST_HOWTO_EN_TRANSLATE_RETRIES,
        RAG_FAST_HOWTO_EN_TRANSLATE_TIMEOUT_MS,
      ),
    ).trim();
  } catch (error) {
    console.warn('[HOWTO] EN detail translation fallback failed:', (error as any)?.message || error);
    return null;
  }

  if (!translatedBody || translatedBody === jaBody) return null;
  translatedBody = sanitizeEnglishBodyText(stripExistingSourceFooter(translatedBody));
  translatedBody = filterRenderedHowToBodyByTopic(
    translatedBody,
    buildQueryTopicProfile(params.originalQuery || params.focusQuery),
    Math.max(RAG_FAST_HOWTO_MIN_STEPS, 3),
  );
  if (!looksEnglishEnoughForHowTo(translatedBody)) return null;

  const answer = appendSourceFooter(
    translatedBody,
    jaExtractive.sources,
    params.originalQuery || params.focusQuery,
    'en',
  );
  if (isWeakHowToAnswer(answer, 'en')) return null;
  if (isInsufficientHowToDetail(answer, 'en') && !hasRelaxedFastHowToDetail(answer, 'en')) return null;

  return {
    answer,
    sources: jaExtractive.sources,
    confidence: Math.max(jaExtractive.confidence, 0.72),
  };
};

const isCacheAnswerHealthy = (params: {
  answer: string;
  language: 'ja' | 'en';
  queryIntent: QueryIntentResult;
  originalQuery: string;
}): { ok: boolean; reason?: string } => {
  const answer = String(params.answer || '').trim();
  if (!answer) return { ok: false, reason: 'empty_answer' };
  if (isCannotConfirmStyleAnswer(answer)) return { ok: false, reason: 'cannot_confirm_style' };
  if (isGenerationFailureStyleAnswer(answer)) return { ok: false, reason: 'generation_failure_style' };

  const bodyLines = answerBodyLines(answer);
  const body = bodyLines.join('\n').trim();
  if (!body) return { ok: false, reason: 'empty_body' };
  if (body.length < RAG_CACHE_MIN_ANSWER_CHARS && bodyLines.length < RAG_CACHE_MIN_ANSWER_LINES) {
    return { ok: false, reason: 'body_too_short' };
  }

  const looksHowTo = params.queryIntent.isHowTo || hasExplicitProcedureCue(String(params.originalQuery || ''));
  if (looksHowTo && RAG_CACHE_REJECT_WEAK_HOWTO && isWeakHowToAnswer(answer, params.language)) {
    return { ok: false, reason: 'weak_howto' };
  }
  if (looksHowTo && isInsufficientHowToDetail(answer, params.language)) {
    return { ok: false, reason: 'howto_detail_too_short' };
  }
  if (!looksHowTo && isWeakGeneralAnswer(answer, params.language)) {
    return { ok: false, reason: 'weak_general' };
  }
  return { ok: true };
};

const computeOrganicRetrievalMs = (metrics: any): number => {
  const safe = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  };

  const cacheLookupMs = safe(metrics?.cacheLookupTime);
  if (metrics?.cacheHit && cacheLookupMs > 0) {
    return Math.round(cacheLookupMs);
  }

  const composed =
    safe(metrics?.solrMs) +
    safe(metrics?.rerankMs) +
    safe(metrics?.candidateMs) +
    safe(metrics?.intentMs) +
    safe(metrics?.queryTranslationTime);
  if (composed > 0) return Math.round(composed);

  const ragMs = safe(metrics?.ragTime);
  if (ragMs > 0) return Math.round(ragMs);

  return 0;
};

const SOURCE_LINE_RE = /^\s*SOURCE\s*:/i;
const SOURCES_HEADER_LINE_RE = /^\s*SOURCES?\s*:/i;

const DRAFT_META_PATTERNS = [
  /^\s*(we|i)\s+need\s+to\b/i,
  /^\s*the\s+question\s*[:\-]/i,
  /^\s*use\s+only\s+(the\s+)?provided\s+context\b/i,
  /^\s*do\s+not\s+(invent|assume)\b/i,
  /^\s*never\s+assume\b/i,
  /^\s*answer\s+length\b/i,
  /^\s*(let(?:'s)?|so)\s+(craft|answer|we)\b/i,
  /^\s*we\s+(can|should|must)\b/i,
  /^\s*according\s+to\s+rules?\b/i,
  /^\s*source\s+footer\b/i,
];

const BULLET_LINE_RE = /^\s*[-*•]\s+/;
const NUMBERED_LINE_RE = /^\s*[0-9０-９]+[\).]\s+/;

const isLikelyDraftMetaLine = (line: string): boolean => {
  const value = String(line || '').trim();
  if (!value) return false;
  if (SOURCES_HEADER_LINE_RE.test(value) || SOURCE_LINE_RE.test(value)) return false;
  if (BULLET_LINE_RE.test(value) || NUMBERED_LINE_RE.test(value)) return false;
  return DRAFT_META_PATTERNS.some((pattern) => pattern.test(value));
};

const stripDraftReasoningLeak = (text: string): string => {
  const normalized = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/```(?:analysis|reasoning|thought)[\s\S]*?```/gi, '')
    .trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  let startIndex = 0;
  while (startIndex < lines.length) {
    const line = String(lines[startIndex] || '').trim();
    if (!line || isLikelyDraftMetaLine(line)) {
      startIndex += 1;
      continue;
    }
    break;
  }

  const strippedHead = lines.slice(startIndex).join('\n').trim() || normalized;
  const filtered = strippedHead
    .split('\n')
    .filter((line) => {
      const value = String(line || '').trim();
      if (!value) return true;
      if (SOURCES_HEADER_LINE_RE.test(value) || SOURCE_LINE_RE.test(value)) return true;
      return !isLikelyDraftMetaLine(value);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return filtered || strippedHead;
};

const isHeadingLikeTailLine = (line: string): boolean => {
  const value = String(line || '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  if (SOURCES_HEADER_LINE_RE.test(value) || SOURCE_LINE_RE.test(value)) return false;
  if (/[.!?。！？]$/.test(value)) return false;
  if (/\d/.test(value)) return false;
  if (/[,:;、，：\-‐‑‒–—―→>]$/.test(value)) return true;
  if (value.length > 34) return false;
  const words = value.split(/\s+/).filter(Boolean).length;
  if (words > 6) return false;
  return /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(value);
};

const STEP_HEADER_RE = /^\s*(?:step|ステップ)\s*[0-9０-９]+\s*[:：]/i;
const EN_DANGLING_TAIL_RE = /\b(?:is|are|was|were|be|been|being|to|and|or|of|for|with|by|from|in|on|at|as|that|which|who|whom|whose|this|these|those)\s*$/i;
const JA_DANGLING_TAIL_RE = /(?:は|が|を|に|へ|で|と|から|まで|より|の)\s*$/;
const TRUNCATION_RECOVERY_MAX_LEN = Math.max(
  320,
  Number(process.env.RAG_TRUNCATION_RECOVERY_MAX_LEN || 480),
);
const RAG_RECOVERY_MAX_CALLS = Math.max(
  1,
  Number(process.env.RAG_RECOVERY_MAX_CALLS || 2),
);
const RAG_RECOVERY_MAX_MS = Math.max(
  800,
  Number(process.env.RAG_RECOVERY_MAX_MS || 5000),
);

type RecoveryBudget = {
  maxCalls: number;
  maxMs: number;
  calls: number;
  spentMs: number;
};

const createRecoveryBudget = (): RecoveryBudget => ({
  maxCalls: RAG_RECOVERY_MAX_CALLS,
  maxMs: RAG_RECOVERY_MAX_MS,
  calls: 0,
  spentMs: 0,
});

const canUseRecoveryBudget = (budget?: RecoveryBudget): boolean => {
  if (!budget) return true;
  if (budget.calls >= budget.maxCalls) return false;
  if (budget.spentMs >= budget.maxMs) return false;
  return true;
};

const consumeRecoveryBudget = (budget: RecoveryBudget | undefined, elapsedMs: number): void => {
  if (!budget) return;
  budget.calls += 1;
  budget.spentMs += Math.max(0, Number(elapsedMs || 0));
};

const hasStepHeaderWithoutDetail = (body: string): boolean => {
  const lines = String(body || '')
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (!lines.length) return false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!STEP_HEADER_RE.test(line)) continue;
    let j = i + 1;
    while (j < lines.length && !String(lines[j] || '').trim()) j += 1;
    if (j >= lines.length) return true;
    if (STEP_HEADER_RE.test(String(lines[j] || '').trim())) return true;
  }
  return false;
};

const isLikelyTruncatedAnswer = (text: string, language: 'ja' | 'en'): boolean => {
  const body = stripExistingSourceFooter(stripDraftReasoningLeak(text)).trim();
  if (!body) return false;
  if (hasStepHeaderWithoutDetail(body)) return true;

  const lines = body.split('\n').map((line) => String(line || '').trim()).filter(Boolean);
  if (!lines.length) return false;
  const last = String(lines[lines.length - 1] || '').trim();
  if (!last) return false;

  const endsWithPunctuation = /[.!?。！？]$/.test(last);
  const hasOpenParenImbalance = (last.match(/[（(]/g) || []).length > (last.match(/[）)]/g) || []).length;
  const endsWithConnector = /[,:;、，：\-‐‑‒–—―]$/.test(last);
  if (hasOpenParenImbalance || endsWithConnector) return true;
  if (endsWithPunctuation) return false;

  // Treat short trailing heading-like lines as incomplete when they appear at the end.
  if (
    lines.length >= 2 &&
    last.length <= 28 &&
    !/\s{2,}/.test(last) &&
    !/(SOURCE|SOURCES)\s*:/i.test(last)
  ) {
    return true;
  }

  if (language === 'en') return EN_DANGLING_TAIL_RE.test(last);
  return JA_DANGLING_TAIL_RE.test(last);
};

const hasExplicitTruncationTail = (text: string): boolean => {
  const body = stripExistingSourceFooter(stripDraftReasoningLeak(String(text || ''))).trim();
  if (!body) return false;
  const lines = body.split('\n').map((line) => String(line || '').trim()).filter(Boolean);
  if (!lines.length) return false;
  const last = String(lines[lines.length - 1] || '').trim();
  if (!last) return false;
  if (/[,:;、，：\-‐‑‒–—―(（]$/.test(last)) return true;
  if (/\b(for example|such as|including|e\.g\.?)\s*$/i.test(last)) return true;
  const openParenCount = (last.match(/[（(]/g) || []).length;
  const closeParenCount = (last.match(/[）)]/g) || []).length;
  if (openParenCount > closeParenCount) return true;
  return hasStepHeaderWithoutDetail(body);
};

const recoverTruncatedAnswerFromContext = async (params: {
  answer: string;
  qaPrompt: string;
  language: 'ja' | 'en';
  recoveryBudget?: RecoveryBudget;
}): Promise<{ answer: string; recovered: boolean; latencyMs: number }> => {
  const candidate = stripDraftReasoningLeak(String(params.answer || '')).trim();
  if (!candidate) return { answer: candidate, recovered: false, latencyMs: 0 };
  const likelyTruncated = isLikelyTruncatedAnswer(candidate, params.language);
  if (!likelyTruncated) {
    return { answer: candidate, recovered: false, latencyMs: 0 };
  }
  const explicitTail = hasExplicitTruncationTail(candidate);
  if (!explicitTail && candidate.length > TRUNCATION_RECOVERY_MAX_LEN) {
    return { answer: candidate, recovered: false, latencyMs: 0 };
  }
  if (!/DOCUMENT CONTEXT:/i.test(String(params.qaPrompt || ''))) {
    return { answer: candidate, recovered: false, latencyMs: 0 };
  }
  if (!canUseRecoveryBudget(params.recoveryBudget)) {
    return { answer: candidate, recovered: false, latencyMs: 0 };
  }

  const startedAt = Date.now();
  const recoveredRaw = await buildEvidenceRecoveryAnswer({
    qaPrompt: String(params.qaPrompt || ''),
    language: params.language,
    recoveryBudget: params.recoveryBudget,
  });
  const latencyMs = Date.now() - startedAt;
  const recovered = stripDraftReasoningLeak(String(recoveredRaw || '')).trim();
  if (!recovered) return { answer: candidate, recovered: false, latencyMs };

  const recoveredIsTruncated = isLikelyTruncatedAnswer(recovered, params.language);
  const lengthGain = recovered.length - candidate.length;
  const shouldUseRecovered =
    !recoveredIsTruncated &&
    (
      recovered.length >= Math.max(60, Math.floor(candidate.length * 0.7)) ||
      lengthGain >= 40
    );

  if (!shouldUseRecovered) return { answer: candidate, recovered: false, latencyMs };
  return { answer: recovered, recovered: true, latencyMs };
};

const sanitizeEnglishBodyText = (text: string): string => {
  const normalized = String(text || '').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const sourceStart = lines.findIndex((line) => SOURCES_HEADER_LINE_RE.test(String(line || '')));
  const bodyLines = sourceStart >= 0 ? lines.slice(0, sourceStart) : lines;
  const sourceLines = sourceStart >= 0 ? lines.slice(sourceStart) : [];

  const cleanedBodyLines: string[] = [];
  for (const line of bodyLines) {
    let out = String(line || '');
    if (!out.trim()) continue;

    // Prefer translated labels when both JP and EN appear.
    out = out.replace(/「[^」]+」\s*[（(]([^()（）]+)[）)]/g, '$1');
    out = out.replace(/([A-Za-z][^()\n]{0,120})\s*[（(][^()（）]*[\u3040-\u30ff\u3400-\u9fff][^()（）]*[）)]/g, '$1');

    if (hasJapaneseChars(out) && !/[A-Za-z]/.test(out)) {
      const mapped = toEnglishPolicyLine(out);
      if (!mapped) continue;
      out = mapped;
    } else if (/[A-Za-z]/.test(out) && hasJapaneseChars(out)) {
      out = out.replace(/[\u3040-\u30ff\u3400-\u9fff]+/g, '');
    }

    out = out
      .replace(/""+/g, '')
      .replace(/[“"]\s*[”"]/g, '')
      .replace(/\bthe\s+[“"]\s*[”"]\s+page\b/gi, 'the attendance page')
      .replace(/\bto the\s+page\b/gi, 'to the attendance page')
      .replace(/([,;:!?])([A-Za-z])/g, '$1 $2')
      .replace(/([A-Za-z])([,;:!?])/g, '$1$2 ')
      .replace(/\)\(/g, ') (')
      .replace(/([A-Za-z])&([A-Za-z])/g, '$1 & $2')
      .replace(/\.\s*-\s*/g, '.\n- ')
      .replace(/([!?])\s*-\s*/g, '$1\n- ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
    if (!out) continue;
    cleanedBodyLines.push(out);
  }

  const finalLines = [...cleanedBodyLines, ...sourceLines].filter((line) => String(line || '').trim().length > 0);
  const finalText = finalLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return finalText || normalized;
};

const trimIncompleteTail = (text: string): string => {
  const normalized = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return '';
  const lines = normalized.split('\n');
  if (lines.length === 0) return normalized;

  const last = String(lines[lines.length - 1] || '').trim();
  if (!last) return normalized;
  if (SOURCE_LINE_RE.test(last)) return normalized;

  const hasTerminalPunctuation = /[.!?。！？]$/.test(last);
  const openParenCount = (last.match(/[（(]/g) || []).length;
  const closeParenCount = (last.match(/[）)]/g) || []).length;
  const hasUnclosedParen = openParenCount > closeParenCount;
  const looksDangling =
    /[(:\-‐‑‒–—―]$/.test(last) ||
    hasUnclosedParen ||
    /\b(for example|such as|including|e\.g\.?)\s*$/i.test(last) ||
    /\bpage(?:s)?\s*$/i.test(last);

  if (!hasTerminalPunctuation && (looksDangling || last.length < 24 || isHeadingLikeTailLine(last))) {
    lines.pop();
    const trimmed = lines.join('\n').trim();
    return trimmed || normalized;
  }
  return normalized;
};

const trimDanglingBodyBeforeSources = (text: string): string => {
  const lines = String(text || '').split('\n');
  if (!lines.length) return String(text || '');

  let splitAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    if (SOURCE_LINE_RE.test(line)) {
      splitAt = i;
      continue;
    }
    break;
  }

  if (splitAt >= lines.length) return String(text || '').trim();

  const bodyLines = lines.slice(0, splitAt);
  const footerLines = lines.slice(splitAt).filter((line) => String(line || '').trim());
  while (bodyLines.length > 0) {
    const last = String(bodyLines[bodyLines.length - 1] || '').trim();
    if (!last) {
      bodyLines.pop();
      continue;
    }
    const hasTerminalPunctuation = /[.!?。！？]$/.test(last);
    const openParenCount = (last.match(/[（(]/g) || []).length;
    const closeParenCount = (last.match(/[）)]/g) || []).length;
    const looksDangling =
      /[(:\-‐‑‒–—―]$/.test(last) ||
      openParenCount > closeParenCount ||
      /\b(for example|such as|including|e\.g\.?)\s*$/i.test(last) ||
      isHeadingLikeTailLine(last);
    if (!hasTerminalPunctuation && looksDangling) {
      bodyLines.pop();
      continue;
    }
    break;
  }

  const body = bodyLines.join('\n').trim();
  const footer = footerLines.join('\n').trim();
  return [body, footer].filter(Boolean).join('\n\n').trim();
};

const normalizeCompanyBranding = (text: string, language: 'ja' | 'en'): string => {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const lines = raw.split('\n');
  const sourceStart = lines.findIndex((line) => SOURCES_HEADER_LINE_RE.test(String(line || '')));
  const bodyLines = sourceStart >= 0 ? lines.slice(0, sourceStart) : lines;
  const sourceLines = sourceStart >= 0 ? lines.slice(sourceStart) : [];

  const normalizedBody = bodyLines.map((line) => {
    if (language === 'en') {
      return String(line || '')
        .replace(/\b(?:your|our|this)\s+company\b/gi, 'Thirdwave')
        .replace(/\bthe\s+company\b/gi, 'Thirdwave')
        .replace(/\bcompany's\b/gi, "Thirdwave's");
    }

    return String(line || '')
      .replace(/あなたの会社/g, 'サードウェーブ')
      .replace(/(?:貴社|御社|当社|自社)/g, 'サードウェーブ');
  });

  return [...normalizedBody, ...sourceLines].join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const finalizeAnswerCompleteness = async (params: {
  answer: string;
  qaPrompt: string;
  language: 'ja' | 'en';
  ragUsed: boolean;
  recoveryBudget?: RecoveryBudget;
}): Promise<{ answer: string; recovered: boolean; latencyMs: number }> => {
  let current = String(params.answer || '').trim();
  if (!current || !params.ragUsed) {
    return { answer: current, recovered: false, latencyMs: 0 };
  }

  current = trimDanglingBodyBeforeSources(trimIncompleteTail(current));
  if (!isLikelyTruncatedAnswer(current, params.language)) {
    return { answer: current, recovered: false, latencyMs: 0 };
  }

  const hasExplicitTailSignal = hasExplicitTruncationTail(current);
  if (!hasExplicitTailSignal) {
    return { answer: current, recovered: false, latencyMs: 0 };
  }

  const recovered = await recoverTruncatedAnswerFromContext({
    answer: current,
    qaPrompt: String(params.qaPrompt || ''),
    language: params.language,
    recoveryBudget: params.recoveryBudget,
  });
  if (recovered.recovered && String(recovered.answer || '').trim()) {
    return { answer: recovered.answer, recovered: true, latencyMs: recovered.latencyMs };
  }

  let latencyMs = recovered.latencyMs;
  current = trimDanglingBodyBeforeSources(trimIncompleteTail(String(recovered.answer || current)));
  if (!isLikelyTruncatedAnswer(current, params.language)) {
    return { answer: current, recovered: false, latencyMs };
  }

  if (/DOCUMENT CONTEXT:/i.test(String(params.qaPrompt || ''))) {
    if (!canUseRecoveryBudget(params.recoveryBudget)) {
      return { answer: current, recovered: false, latencyMs };
    }
    const rebuildStart = Date.now();
    const rebuilt = stripDraftReasoningLeak(
      String(
        await buildEvidenceRecoveryAnswer({
          qaPrompt: String(params.qaPrompt || ''),
          language: params.language,
          recoveryBudget: params.recoveryBudget,
        }),
      ),
    ).trim();
    latencyMs += Date.now() - rebuildStart;
    if (rebuilt && !isLikelyTruncatedAnswer(rebuilt, params.language)) {
      return { answer: rebuilt, recovered: true, latencyMs };
    }
  }

  return { answer: current, recovered: false, latencyMs };
};

const stripExistingSourceFooter = (text: string): string => {
  const lines = String(text || '').split('\n');
  if (!lines.length) return String(text || '').trim();
  const firstSourceLineIndex = lines.findIndex((line) => /^\s*SOURCES?\s*:/i.test(String(line || '')));
  if (firstSourceLineIndex < 0) return String(text || '').trim();
  return lines.slice(0, firstSourceLineIndex).join('\n').trim();
};

const splitAnswerAndSourceFooter = (text: string): { body: string; footer: string } => {
  const lines = String(text || '').split('\n');
  if (!lines.length) {
    return { body: String(text || '').trim(), footer: '' };
  }
  const firstSourceLineIndex = lines.findIndex((line) => /^\s*SOURCES?\s*:/i.test(String(line || '')));
  if (firstSourceLineIndex < 0) {
    return { body: String(text || '').trim(), footer: '' };
  }
  return {
    body: lines.slice(0, firstSourceLineIndex).join('\n').trim(),
    footer: lines.slice(firstSourceLineIndex).join('\n').trim(),
  };
};

const ensureAnswerMatchesUserLanguage = async (
  answer: string,
  userLanguage: 'ja' | 'en',
): Promise<{ answer: string; translated: boolean }> => {
  const rawAnswer = String(answer || '').trim();
  if (!rawAnswer) return { answer: rawAnswer, translated: false };

  const { body, footer } = splitAnswerAndSourceFooter(rawAnswer);
  if (!body) return { answer: rawAnswer, translated: false };

  const answerLanguage = detectRagLanguage(body);
  const needsTranslation =
    userLanguage === 'ja'
      ? answerLanguage !== 'ja' || !hasJapaneseChars(body)
      : answerLanguage !== 'en' || hasJapaneseChars(body);

  if (!needsTranslation) {
    return { answer: rawAnswer, translated: false };
  }

  try {
    const effectiveFinalTranslationTimeoutMs =
      userLanguage === 'en'
        ? Math.max(1200, Math.min(3000, FINAL_TRANSLATION_TIMEOUT_MS))
        : FINAL_TRANSLATION_TIMEOUT_MS;
    let translatedBody = String(
      await translateText(
        body,
        userLanguage,
        true,
        0,
        effectiveFinalTranslationTimeoutMs,
      ),
    ).trim();

    if (!translatedBody || translatedBody === body) {
      return { answer: rawAnswer, translated: false };
    }

    if (userLanguage === 'en') {
      translatedBody = sanitizeEnglishBodyText(translatedBody);
    }

    if (!translatedBody) {
      return { answer: rawAnswer, translated: false };
    }

    const finalAnswer = [translatedBody, footer].filter(Boolean).join('\n\n').trim();
    return { answer: finalAnswer, translated: true };
  } catch (error) {
    console.warn('[STEP 3] Final output language enforcement failed, using original answer:', error);
    return { answer: rawAnswer, translated: false };
  }
};

const compactHowToAnswer = (text: string, language: 'ja' | 'en'): string => {
  const body = stripExistingSourceFooter(String(text || '')).trim();
  if (!body) return String(text || '').trim();

  const lines = body
    .split('\n')
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (!lines.length) return body;
  if (body.length <= 900 && lines.length <= 12) return body;

  const limit = language === 'ja' ? 9 : 10;
  const compact: string[] = [];
  compact.push(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (isLikelyDraftMetaLine(line)) continue;
    if (language === 'en' && hasJapaneseChars(line)) continue;
    if (
      isHeadingLikeTailLine(line) &&
      (i === lines.length - 1 || isHeadingLikeTailLine(lines[i + 1] || ''))
    ) {
      continue;
    }
    if (compact[compact.length - 1] === line) continue;
    compact.push(line);
    if (compact.length >= limit) break;
  }

  let result = compact.join('\n').trim();
  if (lines.length > compact.length) {
    const tail = language === 'ja'
      ? '詳細は出典文書を参照してください。'
      : 'Refer to the cited documents for full details.';
    if (!result.endsWith(tail)) {
      result = `${result}\n${tail}`.trim();
    }
  }
  return result;
};

const looksCollapsedEnglishAnswer = (text: string): boolean => {
  const body = String(text || '')
    .split('\n')
    .filter((line) => !SOURCE_LINE_RE.test(String(line || '')))
    .join('\n')
    .trim();
  if (!body) return false;
  const letters = (body.match(/[A-Za-z]/g) || []).length;
  const spaces = (body.match(/\s/g) || []).length;
  const longRuns = body.match(/[A-Za-z]{18,}/g) || [];
  if (letters < 80) return false;
  const spaceRatio = spaces / Math.max(letters, 1);
  return spaceRatio < 0.08 || longRuns.length >= 2;
};

const repairCollapsedEnglishAnswer = async (text: string): Promise<string> => {
  const input = String(text || '').trim();
  if (!input) return input;
  const instruction = [
    'Fix only spacing and punctuation in the English answer below.',
    'Do not change facts, wording intent, or citations.',
    'Keep SOURCE/SOURCES lines and file names exactly as-is.',
    'Output plain text only.',
    '',
    input,
  ].join('\n');

  const repaired = String(
    await callLLM({
      messages: [{ role: 'user', content: instruction }],
      temperature: 0,
      chatMaxPredict: Math.max(220, Math.min(900, input.length + 120)),
    }),
  ).trim();
  if (!repaired) return input;
  return sanitizeEnglishBodyText(repaired);
};

const appendSourceFooter = (
  answer: string,
  sources: Array<{ docId: string; title?: string; page?: number }>,
  queryHint: string = '',
  language: 'ja' | 'en' = 'en',
): string => {
  const rawBase = String(answer || '').trimEnd();
  if (!rawBase) return rawBase;
  const base = stripExistingSourceFooter(rawBase).trimEnd();

  const sourceNames = Array.from(
    new Set(
      (sources || [])
        .map((s) => String(s?.title || s?.docId || '').trim())
        .filter(Boolean),
    ),
  );
  if (!sourceNames.length) return base;

  let bodyWithCitation = base;
  if (!/\[\d{1,2}\]/.test(bodyWithCitation)) {
    const lines = bodyWithCitation.split('\n');
    let injected = false;
    const rendered: string[] = [];
    for (const line of lines) {
      const value = String(line || '').trim();
      if (!value) {
        rendered.push(line);
        continue;
      }
      const isEligible =
        /^(?:- |\d+[\).．]\s+)/.test(value) ||
        (!/[:：]$/.test(value) && value.length >= 16);
      if (!injected && isEligible) {
        rendered.push(/\[\d{1,2}\]$/.test(value) ? value : `${value} [1]`);
        injected = true;
      } else {
        rendered.push(line);
      }
    }
    if (!injected && rendered.length > 0) {
      const last = String(rendered[rendered.length - 1] || '').trim();
      if (last) {
        rendered[rendered.length - 1] = /\[\d{1,2}\]$/.test(last) ? last : `${last} [1]`;
      }
    }
    bodyWithCitation = rendered.join('\n').trim();
  }

  const queryTerms = uniqueStringList(buildFallbackQueryTerms(String(queryHint || ''), language, 10), 10)
    .map((term) => String(term || '').trim().toLowerCase())
    .filter((term) => term.length >= 2)
    .slice(0, 6);

  const scoredSources = sourceNames.map((name, idx) => {
    const lowered = name.toLowerCase();
    const hits = queryTerms.reduce((sum, term) => sum + (lowered.includes(term) ? 1 : 0), 0);
    return { name, idx, hits };
  });

  const positive = scoredSources.filter((row) => row.hits > 0);
  const fallbackLimit = positive.length > 0 ? 3 : 1;
  const selected = (positive.length > 0 ? positive : scoredSources)
    .sort((a, b) => (b.hits - a.hits) || (a.idx - b.idx))
    .slice(0, fallbackLimit)
    .map((row) => row.name);

  const queryHintCompact = String(queryHint || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const hintTerms = queryTerms.slice(0, 4);
  const hintLabel = language === 'ja' ? '照会語' : 'matched query';
  const decorated = selected.map((name) => {
    if (!queryHintCompact) return name;
    return `${name} (${hintLabel}: ${queryHintCompact})`;
  });

  const footer = decorated.length === 1
    ? `SOURCE: ${decorated[0]}`
    : `SOURCES:\n${decorated.map((name) => `- ${name}`).join('\n')}`;

  return `${bodyWithCitation}\n\n${footer}`;
};

const buildEvidenceRecoveryAnswer = async (params: {
  qaPrompt: string;
  language: 'ja' | 'en';
  recoveryBudget?: RecoveryBudget;
}): Promise<string> => {
  const qaPrompt = String(params.qaPrompt || '').trim();
  if (!qaPrompt || !/DOCUMENT CONTEXT:/i.test(qaPrompt)) return '';
  if (!canUseRecoveryBudget(params.recoveryBudget)) return '';
  const fallback = noEvidenceReply(params.language);
  const outputLanguage = params.language === 'ja' ? 'Japanese' : 'English';
  const instruction = [
    'Use ONLY the provided document context to answer.',
    `Respond in ${outputLanguage}.`,
    `When referring to the company, use ${params.language === 'ja' ? '"サードウェーブ"' : '"Thirdwave"'}.`,
    'Do not use generic company references like "your company", "our company", "the company", "当社", or "貴社".',
    'If procedure is not explicitly defined, state what the policy says and clearly mention that no explicit application process is specified.',
    'Keep the answer concise and complete (target: 4-6 short points).',
    'Do not end with a heading-only line or an incomplete trailing phrase.',
    'If you write a section title, include at least one detail sentence immediately after it.',
    `Use "${fallback}" only if context is empty or unrelated.`,
    'Do not include source footer.',
    '',
    qaPrompt,
  ].join('\n');

  const startedAt = Date.now();
  const recovered = String(
    await callLLM({
      messages: [
        {
          role: 'system',
          content: 'You are a strict enterprise RAG assistant. Return grounded factual output only.',
        },
        {
          role: 'user',
          content: instruction,
        },
      ],
      temperature: 0.1,
      chatMaxPredict: Math.max(220, Math.min(360, CHAT_MAX_PREDICT)),
    }),
  ).trim();
  consumeRecoveryBudget(params.recoveryBudget, Date.now() - startedAt);
  return recovered;
};

const llmCandidateToText = (candidate: any): string => {
  if (candidate == null) return '';
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(candidate)) {
    return candidate
      .map((item) => llmCandidateToText(item))
      .filter((v) => String(v || '').length > 0)
      .join('');
  }
  if (typeof candidate === 'object') {
    return String(candidate.content || candidate.text || candidate.value || '');
  }
  return String(candidate || '');
};

const extractLLMChunkText = (payload: any): string => {
  if (!payload) return '';
  const candidates = [
    payload?.message?.content,
    payload?.response,
    payload?.choices?.[0]?.delta?.content,
    payload?.choices?.[0]?.message?.content,
    payload?.text,
  ];
  for (const c of candidates) {
    const text = llmCandidateToText(c);
    if (text) return text;
  }
  return '';
};

const ragPromptHasEvidence = (value: string): boolean => {
  const text = String(value || '');
  if (!text) return false;
  // splitByPage prompt format
  if (/###\s*参考資料\s+\d+/m.test(text)) return true;
  // splitByArticle prompt format
  const m = text.match(/【参考情報】([\s\S]*?)【質問】/);
  if (!m) return false;
  const body = String(m[1] || '').replace(/\s+/g, '');
  return body.length > 20;
};

const fetchRagBackendDocs = async (
  queryText: string,
  options?: {
    candidateFileIds?: string[];
    metadataFilters?: Record<string, any>;
  },
): Promise<RagBackendDoc[]> => {
  const backendUrl = String(config?.RAG?.Backend?.url || process.env.RAG_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (!backendUrl) return [];

  const candidateFileIds = Array.isArray(options?.candidateFileIds)
    ? Array.from(new Set(options!.candidateFileIds.map((v) => String(v || '').trim()).filter(Boolean))).slice(0, RAG_STAGE1_MAX_FILE_IDS)
    : [];
  const metadataFilters = options?.metadataFilters && typeof options.metadataFilters === 'object'
    ? options.metadataFilters
    : undefined;

  const payload = {
    collection_name: config?.RAG?.PreProcess?.PDF?.splitByArticle?.collectionName || 'splitByArticleWithHybridSearch',
    query: String(queryText || ''),
    top_k: Number(config?.RAG?.Retrieval?.topK || 10),
    vector_only: config?.RAG?.Retrieval?.HybridSearch?.vector_only ?? true,
    bm25_only: config?.RAG?.Retrieval?.HybridSearch?.bm25_only ?? false,
    vector_weight: config?.RAG?.Retrieval?.HybridSearch?.vector_weight ?? 0.5,
    bm25_weight: config?.RAG?.Retrieval?.HybridSearch?.bm25_weight ?? 0.5,
    bm25_params: config?.RAG?.Retrieval?.HybridSearch?.bm25_params || { k1: 1.8, b: 0.75 },
    ...(candidateFileIds.length ? { candidate_file_ids: candidateFileIds } : {}),
    ...(metadataFilters ? { metadata_filters: metadataFilters } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RAG_BACKEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${backendUrl}/search/hybrid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 404) {
        console.warn(
          `[STEP 2] RAG backend endpoint /search/hybrid not found at ${backendUrl}. Check RAG_BACKEND_URL/service routing.`,
        );
      }
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const topK = Math.max(1, Number(payload.top_k || 10));
    return data
      .map((item: any, idx: number) => {
        const metadata = item?.metadata || {};
        const content = String(item?.page_content || '').trim();
        if (!content) return null;
        const id = String(item?.id || metadata?.file_id || metadata?.file_path_s || `rag_backend_${idx + 1}`);
        const title = String(
          metadata?.DocumentName ||
          metadata?.file_name_s ||
          metadata?.title ||
          metadata?.ArticleName ||
          `rag_doc_${idx + 1}`,
        );
        const rawSimilarity = Number(
          item?.score ??
          item?.similarity ??
          item?.relevance_score ??
          item?.rerank_score,
        );
        const rawDistance = Number(item?.distance ?? item?.dist ?? item?.vector_distance);
        const semanticScore =
          Number.isFinite(rawSimilarity) && rawSimilarity > 0
            ? rawSimilarity
            : (Number.isFinite(rawDistance) && rawDistance >= 0
              ? (1 / (1 + rawDistance))
              : Math.max(0.05, (topK - idx) / topK));
        // Keep score scale roughly comparable with lexical scores for shared rerank flows.
        const score = Math.max(0.05, semanticScore * 30);
        const fileName = String(metadata?.file_name_s || '').trim();
        const departmentCode = String(metadata?.department_code_s || '').trim();
        return {
          id,
          title,
          content_txt: content,
          score,
          semantic_score: semanticScore,
          ...(fileName ? { file_name_s: fileName } : {}),
          ...(departmentCode ? { department_code_s: departmentCode } : {}),
        };
      })
      .filter(Boolean) as RagBackendDoc[];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
};

// LLM generation calls are moved to src/rag/generation/llmGenerator

export async function createChatTitle(prompt: string, content: string): Promise<string> {
  const source = String(prompt || '').trim();
  const heuristic = source
    .replace(/\s+/g, ' ')
    .replace(/^User query:\s*/i, '')
    .slice(0, 30)
    .trim();

  if (!USE_LLM_FOR_TITLE) {
    return heuristic || 'チャット';
  }

  try {
    const message = `
Please summarize the following conversation (question and answer) into a Japanese chat title of about 15 characters.
Output only the title—no explanation or extra text.

Conversation:
Question: ${prompt}
Answer: ${content}`;
    const messages = [
      { role: 'system', content: 'You are a helpful assistant. Answer in Japanese.' },
      { role: 'user', content: message },
    ];
    const result = await callLLM({
      messages,
      temperature: 0.3,
      modelOverride: getChatTitleModelName(),
      numPredictOverride: TITLE_MAX_PREDICT,
      chatMaxPredict: CHAT_MAX_PREDICT,
    });
    return result?.substring(0, 30).trim() || '空のチャットタイトル';
  } catch {
    return '空のチャットタイトル';
  }
}

export async function getDualLanguageOutput(japaneseAnswer: string): Promise<string> {
  const { formatDualLanguageOutput } = await import('@/utils/translation');
  let translated = '';
  try {
    translated = await translateText(japaneseAnswer, 'en', true);
  } catch (e) {
    console.error('[Show Button] Failed to translate Japanese answer to English:', e);
    translated = '[Translation failed]';
  }
  return formatDualLanguageOutput(japaneseAnswer, translated, 'en');
}

export const chatGenProcess = async (job) => {
  const { taskId } = job.data;
  const type = 'CHAT';
  const mode: string = (config.RAG.mode || ['splitByPage'])[0];
  let ragProcessor: { search: (prompt: string) => Promise<string> | string } | null = null;
  try {
    ragProcessor = await loadRagProcessor(mode) as any;
  } catch (e: any) {
    console.warn(`[CHAT PROCESS] Failed to load RAG processor "${mode}":`, e?.message || e);
  }

  const callAviary = async (outputId: number, metadata: string) => {
    // KPI Metrics tracking
    const kpiMetrics = {
      startTime: Date.now(),
      endTime: 0,
      totalTime: 0,
      ragUsed: false,
      ragTime: 0,
      llmTime: 0,
      translationTime: 0,
      queryTranslationTime: 0,
      titleTime: 0,
      inputTokens: 0,
      outputTokens: 0,
      modelUsed: config.Models.chatModel.name,
      userLanguage: 'unknown',
      fileCount: 0,
      responseLength: 0,
      englishLength: 0,
      japaneseLength: 0,
      tierUsed: 'tier2' as ResponseTier,
      tierLatency: 0,
      cacheHit: false,
      cacheLookupTime: 0,
      cacheWriteTime: 0,
      dbFetchMs: 0,
      intentMs: 0,
      candidateMs: 0,
      solrMs: 0,
      translateMs: 0,
      rerankMs: 0,
      solrCallsCount: 0,
      translateCallsCount: 0,
      fileInventoryCacheHit: false,
      candidateScopeCacheHit: false,
      solrCacheHit: false,
      localCacheHitCount: 0,
      localCacheMissCount: 0,
      localCacheWriteCount: 0,
      localCacheEvictionCount: 0,
      localCacheExpiredCount: 0,
      recoveryBudgetCalls: 0,
      recoveryBudgetSpentMs: 0,
      recoveryBudgetMaxCalls: RAG_RECOVERY_MAX_CALLS,
      recoveryBudgetMaxMs: RAG_RECOVERY_MAX_MS,
    };
    const localCacheStatsStart = getLocalMemoryCacheStats();
    const recoveryBudget = createRecoveryBudget();
    const updateLocalCacheMetrics = () => {
      const localCacheStatsEnd = getLocalMemoryCacheStats();
      const delta = summarizeLocalMemoryCacheStatsDelta(localCacheStatsStart, localCacheStatsEnd);
      kpiMetrics.localCacheHitCount = delta.hits;
      kpiMetrics.localCacheMissCount = delta.misses;
      kpiMetrics.localCacheWriteCount = delta.writes;
      kpiMetrics.localCacheEvictionCount = delta.evictions;
      kpiMetrics.localCacheExpiredCount = delta.expired;
      kpiMetrics.recoveryBudgetCalls = recoveryBudget.calls;
      kpiMetrics.recoveryBudgetSpentMs = recoveryBudget.spentMs;
    };

    const activeOutputStatuses = new Set(['WAIT', 'IN_PROCESS', 'PROCESSING']);
    let outputWritesAborted = false;
    const canMutateOutput = async (): Promise<boolean> => {
      if (outputWritesAborted) return false;
      const [latestOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
      const latestStatus = String(latestOutput?.status || '').trim().toUpperCase();
      if (!activeOutputStatuses.has(latestStatus)) {
        outputWritesAborted = true;
        return false;
      }
      return true;
    };

    let [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
    if (String(curOutput?.status || '').trim().toUpperCase() === 'CANCEL') {
      return { outputId, isOk: false, content: '' };
    }
    const publishLive = async (
      event: 'status' | 'chunk' | 'replace' | 'done' | 'error',
      payload: Record<string, any>,
    ) => {
      if (event !== 'done' && event !== 'error' && !(await canMutateOutput())) {
        return;
      }
      await publishChatStreamEvent(String(taskId), event, {
        outputId,
        ...payload,
      }).catch(() => undefined);
    };
    const publishLiveStatus = async (message: string, status = 'PROCESSING') => {
      if (!(await canMutateOutput())) return;
      if (outputId) {
        await put<IGenTaskOutputSer>(
          KrdGenTaskOutput,
          { id: outputId },
          {
            status,
            update_by: 'JOB',
          },
        ).catch(() => undefined);
      }
      await publishLive('status', { status, message });
    };
    await publishLiveStatus('Retrieving documents...', 'IN_PROCESS');

    const outputs = await queryList(KrdGenTaskOutput, {
      task_id: { [Op.eq]: taskId },
      status: { [Op.ne]: 'IN_PROCESS' },
    });

    const recentOutputs = [...outputs]
      .sort((a: any, b: any) => Number(a?.id || 0) - Number(b?.id || 0))
      .slice(-CHAT_HISTORY_TURNS);
    const messages = recentOutputs.flatMap((op) => {
      const userMessage = parseHistoryUserText(op.metadata);
      const assistantMessage = String(op.content || '').trim();
      return [
        ...(userMessage ? [{ role: 'user', content: userMessage }] : []),
        ...(assistantMessage ? [{ role: 'assistant', content: assistantMessage }] : []),
      ];
    });

    const data = parseMetadataSafe(metadata);
    const departmentCode = normalizeDepartmentCode(data.departmentCode);
    const roleCode = normalizeRoleCode(data.roleCode);
    const isSuperAdmin = roleCode === 'SUPER_ADMIN';
    const shouldRestrictToDepartment = Boolean(departmentCode) && (!isSuperAdmin || !ALLOW_SUPERADMIN_CROSS_DEPT);
    const originalQueryText = String(data.originalQuery || data.prompt || '');
    const declaredQueryIntent = String(data.queryIntent || '').trim();
    const isDeclaredQueryIntent = (value: string): value is SharedQueryIntent =>
      value === 'rag_query' ||
      value === 'general_chat' ||
      value === 'translation_request' ||
      value === 'faq_lookup';
    const sharedQueryIntent = isDeclaredQueryIntent(declaredQueryIntent)
      ? { intent: declaredQueryIntent, confidence: 1, matchedRule: 'task_metadata' }
      : classifySharedQueryIntent(originalQueryText || String(data.prompt || ''));
    const shouldUseRagPipeline = sharedQueryIntent.intent === 'rag_query';
    console.log(`\n========== [CHAT PROCESS] Starting chat generation ==========`);
    console.log(`[CHAT PROCESS] PID: ${process.pid}, Task ID: ${taskId}, Output ID: ${outputId}`);
    console.log(`[CHAT PROCESS] Metadata:`, JSON.stringify(data, null, 2));
    console.log(
      `[CHAT PROCESS] Query intent: ${sharedQueryIntent.intent} (confidence=${sharedQueryIntent.confidence.toFixed(2)}, matchedRule=${sharedQueryIntent.matchedRule || 'default'})`,
    );

    // Check if files are uploaded
    const explicitFileIds = Array.isArray(data.fileId) ? data.fileId : [];
    const metadataFileIds = Array.isArray(data.usedFileIds) ? data.usedFileIds : [];
    const requestedFileIds = Array.from(
      new Set(
        [...explicitFileIds, ...metadataFileIds]
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v > 0),
      ),
    );
    const hasSpecificFiles = shouldUseRagPipeline && requestedFileIds.length > 0;
    let useSpecificFileFilter = hasSpecificFiles;
    const requestedAllFileSearch = data.allFileSearch === true;
    const isCompanyPath =
      shouldUseRagPipeline &&
      (String(data.processingPath || '').toUpperCase() === 'COMPANY' || data.ragTriggered === true);
    const defaultAllFileSearch = !hasSpecificFiles && !requestedAllFileSearch && isCompanyPath;
    const shouldSearchAllFiles = shouldUseRagPipeline && (requestedAllFileSearch || defaultAllFileSearch);

    // Track sources used for response (for citations + chat history)
    const ragSources: { docId: string; title?: string; page?: number }[] = [];
    const availableFilesForSearch: CandidateFileRecord[] = [];
    
    let storage_keyArray: string[] = [];
    let hasFiles = hasSpecificFiles;
    const dbFetchStart = Date.now();
    
    if (hasSpecificFiles) {
      console.log(`[CHAT PROCESS] Processing ${requestedFileIds.length} specific file(s)`);
      const requestedFiles = await queryList(File, {
        id: { [Op.in]: requestedFileIds },
        ...(shouldRestrictToDepartment ? { department_code: { [Op.eq]: departmentCode } } : {}),
      });

      for (const file of requestedFiles || []) {
        if (file?.storage_key) {
          storage_keyArray.push(file.storage_key);
          availableFilesForSearch.push({
            id: Number(file?.id),
            filename: String(file?.filename || ''),
            storage_key: String(file?.storage_key || ''),
            department_code: String(file?.department_code || ''),
            created_at: file?.created_at ? String(file.created_at) : undefined,
          });
        }
        console.log(`[CHAT PROCESS] File ID ${file?.id}: ${file?.filename} (storage_key: ${file?.storage_key})`);
      }

      // Keep RAG enabled when task metadata contains document IDs, even if storage_key lookup fails.
      // In that case we fallback to global/department lexical search without id filter.
      hasFiles = requestedFileIds.length > 0;
      if (storage_keyArray.length === 0) {
        useSpecificFileFilter = false;
        console.warn(
          `[CHAT PROCESS] Requested file IDs present (${requestedFileIds.join(', ')}) but no storage_key rows found; falling back to non-id-filtered retrieval.`,
        );
      }
      kpiMetrics.fileCount = storage_keyArray.length || requestedFileIds.length;
    } else if (shouldSearchAllFiles) {
      const inventoryCacheKey = `inventory:${shouldRestrictToDepartment ? String(departmentCode || 'ALL') : 'ALL'}`;
      const inventoryCacheHit = getExpiringCacheEntry(
        fileInventoryCache,
        inventoryCacheKey,
        'fileInventory',
      );
      if (inventoryCacheHit) {
        availableFilesForSearch.push(...inventoryCacheHit.files);
        hasFiles = inventoryCacheHit.files.length > 0;
        kpiMetrics.fileCount = inventoryCacheHit.files.length;
        kpiMetrics.fileInventoryCacheHit = true;
        console.log(`[CHAT PROCESS] File inventory cache hit (${inventoryCacheHit.files.length} files)`);
      }

      if (availableFilesForSearch.length === 0) {
        if (defaultAllFileSearch) {
          console.log(
            `[CHAT PROCESS] allFileSearch not provided by client; defaulting to true for COMPANY path and fetching all files...`,
          );
        } else {
          console.log(`[CHAT PROCESS] allFileSearch=true, fetching all files from database...`);
        }
        const allFiles = await queryList(
          File,
          shouldRestrictToDepartment ? { department_code: { [Op.eq]: departmentCode } } : {},
        );
        if (allFiles && allFiles.length > 0) {
          hasFiles = true;
          kpiMetrics.fileCount = allFiles.length;
          const normalizedFiles = allFiles
            .map((file: any) => ({
              id: Number(file?.id),
              filename: String(file?.filename || ''),
              storage_key: String(file?.storage_key || ''),
              department_code: String(file?.department_code || ''),
              created_at: file?.created_at ? String(file.created_at) : undefined,
            }))
            .filter((file: CandidateFileRecord) => Boolean(file.storage_key));
          availableFilesForSearch.push(...normalizedFiles);
          setExpiringCacheEntryBounded(
            fileInventoryCache,
            inventoryCacheKey,
            {
              files: normalizedFiles,
              expiresAt: Date.now() + FILE_INVENTORY_CACHE_TTL_MS,
            },
            FILE_INVENTORY_CACHE_MAX_ENTRIES,
            'fileInventory',
          );
          console.log(`[CHAT PROCESS] File inventory cache stored (${normalizedFiles.length} files)`);
          console.log(`[CHAT PROCESS] Found ${allFiles.length} file(s) in database`);
        } else {
          console.log(`[CHAT PROCESS] No files in database`);
        }
      }
    } else {
      console.log(`[CHAT PROCESS] No files to search`);
    }
    kpiMetrics.dbFetchMs = Date.now() - dbFetchStart;
    
    const filesAvailable =
      shouldUseRagPipeline &&
      (Boolean(data.ragTriggered) || (hasFiles && (useSpecificFileFilter ? storage_keyArray.length > 0 : true)));
    
    console.log(
      `[CHAT PROCESS] File check: hasFiles=${hasFiles}, fileCount=${kpiMetrics.fileCount}, allFileSearch=${data.allFileSearch}, effectiveAllFileSearch=${shouldSearchAllFiles}`,
    );
    console.log(`[CHAT PROCESS] Files available for RAG: ${filesAvailable}`)

    console.log(`[CHAT PROCESS] Checking output status...`);
    try {
      [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
      console.log(`[CHAT PROCESS] Output status: ${curOutput?.status}`);
    } catch (dbError) {
      console.error(`[CHAT PROCESS] Database error:`, dbError);
      return { outputId, isOk: false, content: 'Database error' };
    }
    
    if (curOutput.status === 'CANCEL') {
      console.log(`[CHAT PROCESS] Output ${outputId} was cancelled, aborting`);
      return { outputId, isOk: false, content: '' };
    }

    let prompt = String(data.prompt || originalQueryText);
    const useModularPipeline = String(process.env.RAG_USE_MODULAR_CHAT_PIPELINE || '1') !== '0';

    if (useModularPipeline && shouldUseRagPipeline) {
      console.log('\n[CHAT PROCESS] Modular pipeline mode enabled. Delegating retrieval + generation to runRagPipeline.');
      let userLanguage: 'ja' | 'en' = detectRagLanguage(originalQueryText || prompt);
      let retrievalIndexLanguage: 'ja' | 'en' | 'multi' = 'multi';
      let queryForRAG = '';
      let retrievalQueryUsed = '';
      let queryTranslationApplied = false;
      let finalAnswer = '';
      const queryIntent = classifyQueryIntent(originalQueryText || prompt);
      let proceduralLlmSynthesisActive = false;
      let isOk = true;
      let selectedTier: ResponseTier = 'tier2';
      let tierLatencyMs = 0;
      let content = '';
      let generationStatus: 'ok' | 'empty_llm_response' = 'ok';
      let generationUsedFallback = false;
      let pipelineDocs: any[] = [];
      let streamedPreviewAnswer = '';
      let lastPreviewWriteAt = 0;
      const STREAM_PREVIEW_MIN_INTERVAL_MS = 220;
      const allowExtractiveRescue = (): boolean =>
        !(RAG_PROCEDURAL_FORCE_LLM_SYNTHESIS_ENABLED && queryIntent.isHowTo && proceduralLlmSynthesisActive);
      const markAnswerFallbackUsed = (reason: string) => {
        generationUsedFallback = true;
        console.warn(`[STEP 3] Answer fallback applied (${reason}).`);
      };
      const markEmptyLlmResponseFallback = (reason: string) => {
        generationStatus = 'empty_llm_response';
        generationUsedFallback = true;
        console.warn(`[STEP 3] Empty LLM response fallback applied (${reason}).`);
      };

      const pushProcessingPreview = async (answer: string, opts?: { force?: boolean }): Promise<void> => {
        const next = String(answer || '').trim();
        if (!next) return;
        if (isGenerationFailureStyleAnswer(next) || isCannotConfirmStyleAnswer(next)) return;
        if (!(await canMutateOutput())) return;

        const now = Date.now();
        const force = Boolean(opts?.force);
        if (!force) {
          if (next === streamedPreviewAnswer) return;
          if (now - lastPreviewWriteAt < STREAM_PREVIEW_MIN_INTERVAL_MS) return;
        }

        streamedPreviewAnswer = next;
        lastPreviewWriteAt = now;

        try {
          await put<IGenTaskOutputSer>(
            KrdGenTaskOutput,
            { id: outputId },
            {
              content: next,
              status: 'PROCESSING',
              update_by: 'JOB',
            },
          );
        } catch (previewError) {
          console.warn('[STEP 3] Failed to stream processing preview:', (previewError as any)?.message || previewError);
        }
      };

      const tryModularHowToExtractiveFallback = (reason: string): boolean => {
        const explicitHowToCue = hasExplicitProcedureCue(String(originalQueryText || prompt || ''));
        if (!queryIntent.isHowTo && !explicitHowToCue) return false;
        if (!Array.isArray(pipelineDocs) || pipelineDocs.length === 0) return false;
        const focusQuery = String(retrievalQueryUsed || queryForRAG || originalQueryText || prompt);
        const styleProbeQuery = buildAnswerStyleProbeText(
          String(originalQueryText || prompt || ''),
          focusQuery,
        );
        const useProcedureStyle = hasExplicitProcedureCue(styleProbeQuery);
        if (!useProcedureStyle) return false;
        const procedureQueryHint = styleProbeQuery || focusQuery;
        const extractive = buildExtractiveHowToAnswer(
          pipelineDocs,
          userLanguage,
          procedureQueryHint,
        );
        if (!extractive) return false;
        if (isWeakHowToAnswer(extractive.answer, userLanguage)) return false;
        finalAnswer = stripExistingSourceFooter(extractive.answer);
        ragSources.splice(0, ragSources.length, ...extractive.sources);
        logFilterTrace('howto_extractive_rescue_modular', {
          reason,
          language: userLanguage,
          style: 'procedure',
          source_count: extractive.sources.length,
          query: String(originalQueryText || '').slice(0, 120),
        });
        console.log(`[STEP 3] Applied modular extractive fallback (${reason}).`);
        return true;
      };

      const tryModularGenericExtractiveFallback = (reason: string): boolean => {
        if (!Array.isArray(pipelineDocs) || pipelineDocs.length === 0) return false;
        if (hasStructuredPolicyArticles(pipelineDocs)) {
          logFilterTrace('generic_extractive_rescue_skipped_structured_policy', {
            reason,
            language: userLanguage,
            query: String(originalQueryText || '').slice(0, 120),
          });
          return false;
        }
        const extractive = buildExtractiveContextAnswer(
          pipelineDocs,
          userLanguage,
          String(originalQueryText || queryForRAG || prompt || ''),
        );
        if (!extractive) return false;
        finalAnswer = stripExistingSourceFooter(extractive.answer);
        ragSources.splice(0, ragSources.length, ...extractive.sources);
        logFilterTrace('generic_extractive_rescue_modular', {
          reason,
          language: userLanguage,
          source_count: extractive.sources.length,
          query: String(originalQueryText || '').slice(0, 120),
        });
        console.log(`[STEP 3] Applied modular generic extractive fallback (${reason}).`);
        return true;
      };

      const tryModularEmailSignatureRescue = (reason: string): boolean => {
        const emailSignatureQuery = String(originalQueryText || prompt || '');
        if (!requiresEmailSignatureCoverage(emailSignatureQuery)) return false;

        const docRescue = buildExtractiveEmailSignatureAnswer(
          pipelineDocs,
          userLanguage,
          emailSignatureQuery,
        );
        if (docRescue) {
          finalAnswer = stripExistingSourceFooter(docRescue.answer);
          ragSources.splice(0, ragSources.length, ...docRescue.sources);
          logFilterTrace('email_signature_rescue_modular', {
            reason,
            mode: 'docs',
            language: userLanguage,
            source_count: docRescue.sources.length,
            query: emailSignatureQuery.slice(0, 120),
          });
          console.log(`[STEP 3] Applied modular email-signature rescue (${reason}, docs).`);
          return true;
        }

        const fallbackSources = ragSources.length > 0
          ? ragSources.map((source) => ({
            docId: String(source?.docId || ''),
            title: String(source?.title || source?.docId || ''),
          }))
          : (Array.isArray(pipelineDocs) ? pipelineDocs.slice(0, 3).map((doc) => ({
            docId: String(doc?.id || ''),
            title: Array.isArray(doc?.title)
              ? String(doc.title[0] || '')
              : String(doc?.title || doc?.file_name_s || doc?.id || ''),
          })) : []);
        const promptRescue = buildExtractiveEmailSignatureAnswerFromPromptContext({
          prompt: String(prompt || ''),
          language: userLanguage,
          query: emailSignatureQuery,
          sources: fallbackSources,
        });
        if (!promptRescue) return false;

        finalAnswer = stripExistingSourceFooter(promptRescue.answer);
        ragSources.splice(0, ragSources.length, ...promptRescue.sources);
        logFilterTrace('email_signature_rescue_modular', {
          reason,
          mode: 'prompt_context',
          language: userLanguage,
          source_count: promptRescue.sources.length,
          query: emailSignatureQuery.slice(0, 120),
        });
        console.log(`[STEP 3] Applied modular email-signature rescue (${reason}, prompt_context).`);
        return true;
      };

      const tryModularEvidenceContextRecovery = async (reason: string): Promise<boolean> => {
        if (!kpiMetrics.ragUsed) return false;
        if (!/DOCUMENT CONTEXT:/i.test(String(prompt || ''))) return false;

        const recoveryStart = Date.now();
        const recovered = await buildEvidenceRecoveryAnswer({
          qaPrompt: String(prompt || ''),
          language: userLanguage,
          recoveryBudget,
        });
        kpiMetrics.llmTime += Date.now() - recoveryStart;

        if (!recovered) return false;
        if (isCannotConfirmStyleAnswer(recovered) || isGenerationFailureStyleAnswer(recovered)) return false;

        finalAnswer = stripExistingSourceFooter(recovered);
        logFilterTrace('evidence_context_recovery_modular', {
          reason,
          language: userLanguage,
          query: String(originalQueryText || '').slice(0, 120),
        });
        console.log(`[STEP 3] Evidence context recovery generated a grounded answer (${reason}).`);
        return true;
      };

      try {
        if (filesAvailable) {
          await publishLiveStatus('Searching documents...');
          let publishedSearchingStatus = false;
          let publishedBuildingStatus = false;
          let publishedGeneratingStatus = false;
          let publishedPreview = false;
          const pipelineLogger = (line: string) => {
            console.log(line);
            const v = String(line || '');
            if (!publishedSearchingStatus && /(?:solr_query|retrieval_query|reranked_docs|top_sources)/i.test(v)) {
              publishedSearchingStatus = true;
              void publishLiveStatus('Searching documents...');
            }
            if (!publishedPreview && /\[RAG\]\s+preview_ready\s+\{/.test(v)) {
              publishedPreview = true;
              try {
                const jsonText = v.slice(v.indexOf('{'));
                const parsed = JSON.parse(jsonText);
                const source = String(parsed?.source || '').trim();
                if (source) {
                  void publishLive('replace', {
                    status: 'PROCESSING',
                    content: `Searching internal policies...\n\nFound relevant policy:\n${source}\n\nGenerating answer...`,
                  });
                }
              } catch {
                // best effort preview only
              }
            }
            if (!publishedBuildingStatus && /(?:evidence_selection|llm_prompt_tokens|DOCUMENT CONTEXT)/i.test(v)) {
              publishedBuildingStatus = true;
              void publishLiveStatus('Building answer...');
            }
            if (!publishedGeneratingStatus && /(?:generation_started mode=llm|llm_latency_ms)/i.test(v)) {
              publishedGeneratingStatus = true;
              void publishLiveStatus('Generating response...');
            }
          };
          const pipelineResult = await runRagPipeline({
            query: originalQueryText,
            prompt,
            retrievalIndexLanguage: process.env.RAG_INDEX_LANGUAGE || 'multi',
            outputId,
            historyMessages: messages,
            chatMaxPredict: CHAT_MAX_PREDICT,
            retrievalOptions: {
              restrictToDepartment: shouldRestrictToDepartment,
              departmentCode,
              fileScopeIds: useSpecificFileFilter
                ? uniqueStringList(storage_keyArray, RAG_STAGE1_EXPANDED_FILE_IDS)
                : [],
              ragBackendUrl: String(config?.RAG?.Backend?.url || '').trim(),
              ragBackendCollectionName: String(
                config?.RAG?.PreProcess?.PDF?.splitByArticle?.collectionName || 'splitByArticleWithHybridSearch',
              ),
              solrTimeoutMs: SOLR_TIMEOUT_MS,
              ragBackendTimeoutMs: RAG_BACKEND_TIMEOUT_MS,
              solrRows: SOLR_ROWS,
              maxSolrCalls: RAG_SOLR_MAX_CALLS,
              relevanceMinScore: RAG_RELEVANCE_MIN_SCORE,
            },
            contextOptions: {
              maxChunks: RAG_MAX_CONTEXT_CHUNKS,
              contextBudgetChars: Math.max(800, RAG_MAX_CONTEXT_TOKENS * RAG_CONTEXT_CHARS_PER_TOKEN),
              docContextChars: DOC_CONTEXT_CHARS,
            },
            logger: pipelineLogger,
            buildFastAnswer: async ({ docs, retrievalQueryUsed: fastRetrievalQuery, userLanguage: fastLanguage, queryForRAG: fastQueryForRag, originalQuery: fastOriginalQuery }) => {
              if (!RAG_FAST_HOWTO_PATH) return null;
              const fastOriginalText = String(fastOriginalQuery || originalQueryText || prompt || '');
              if (requiresEmailSignatureCoverage(fastOriginalText)) {
                const emailSignatureAnswer = buildExtractiveEmailSignatureAnswer(
                  docs,
                  fastLanguage,
                  fastOriginalText,
                );
                if (emailSignatureAnswer) {
                  logFilterTrace('fast_email_signature_extractive_modular', {
                    query: String(originalQueryText || '').slice(0, 120),
                    language: fastLanguage,
                    source_count: emailSignatureAnswer.sources.length,
                  });
                  return {
                    answer: stripExistingSourceFooter(emailSignatureAnswer.answer),
                    sources: emailSignatureAnswer.sources,
                  };
                }
              }
              const explicitHowToCue = hasExplicitProcedureCue(
                fastOriginalText,
              );
              if (!queryIntent.isHowTo && !explicitHowToCue) return null;
              const allowUnknownIntent = shouldAllowFastHowToUnknownIntent(
                queryIntent,
                String(originalQueryText || prompt || ''),
              );
              const topScore = Number(docs?.[0]?.score || 0);
              const focusQuery = String(
                fastRetrievalQuery || fastQueryForRag || fastOriginalQuery || originalQueryText || prompt,
              );
              const signalProbeQuery = [
                String(fastOriginalQuery || originalQueryText || ''),
                String(focusQuery || ''),
              ].filter(Boolean).join(' ');
              const fastTopTermHits = computeFastHowToTopTermHits(docs, signalProbeQuery);
              const fastMinTermHits = fastLanguage === 'en'
                ? RAG_FAST_HOWTO_MIN_TERM_HITS_EN
                : RAG_FAST_HOWTO_MIN_TERM_HITS;
              if (fastTopTermHits < fastMinTermHits) {
                logFilterTrace('fast_howto_skip_low_signal_modular', {
                  query: String(originalQueryText || '').slice(0, 120),
                  language: fastLanguage,
                  top_score: Number(topScore.toFixed(3)),
                  top_term_hits: fastTopTermHits,
                  min_term_hits: fastMinTermHits,
                  retrieval_query: focusQuery,
                });
                return null;
              }
              if (!isFastHowToTopScoreEligible({
                topScore,
                topTermHits: fastTopTermHits,
                language: fastLanguage,
                explicitHowToCue,
              })) {
                logFilterTrace('fast_howto_skip_low_top_score_modular', {
                  query: String(originalQueryText || '').slice(0, 120),
                  language: fastLanguage,
                  top_score: Number(topScore.toFixed(3)),
                  top_term_hits: fastTopTermHits,
                  threshold_top_score: RAG_FAST_HOWTO_TOP_SCORE_MIN,
                  threshold_top_score_relaxed: RAG_FAST_HOWTO_TOP_SCORE_MIN_RELAXED,
                });
                return null;
              }
              const allowStrongHowToOverride =
                explicitHowToCue && isFastHowToTopScoreEligible({
                  topScore: Math.max(topScore, RAG_FAST_HOWTO_TOP_SCORE_MIN_RELAXED),
                  topTermHits: fastTopTermHits,
                  language: fastLanguage,
                  explicitHowToCue,
                });
              const enforceIntentConfidence = !explicitHowToCue;
              if (enforceIntentConfidence &&
                  queryIntent.confidence < RAG_FAST_HOWTO_INTENT_CONF &&
                  !allowUnknownIntent &&
                  !allowStrongHowToOverride) {
                return null;
              }
              const styleProbeQuery = buildAnswerStyleProbeText(
                String(fastOriginalQuery || originalQueryText || prompt || ''),
                focusQuery,
              );
              const useProcedureStyle = hasExplicitProcedureCue(styleProbeQuery);
              if (!useProcedureStyle) return null;
              const procedureQueryHint = styleProbeQuery || focusQuery;
              const extractive = buildExtractiveHowToAnswer(
                docs,
                fastLanguage,
                procedureQueryHint,
              );
              const detailedEnglish =
                fastLanguage === 'en'
                  ? await buildDetailedEnglishHowToFromJapaneseEvidence({
                    docs,
                    focusQuery: procedureQueryHint,
                    originalQuery: String(fastOriginalQuery || originalQueryText || prompt || ''),
                  })
                  : null;
              const fastAnswerCandidate = extractive &&
                !isWeakHowToAnswer(extractive.answer, fastLanguage) &&
                (!isInsufficientHowToDetail(extractive.answer, fastLanguage) || hasRelaxedFastHowToDetail(extractive.answer, fastLanguage))
                ? extractive
                : detailedEnglish;
              if (!fastAnswerCandidate) return null;
              if (isWeakHowToAnswer(fastAnswerCandidate.answer, fastLanguage)) {
                logFilterTrace('fast_howto_skip_weak_answer_modular', {
                  query: String(originalQueryText || '').slice(0, 120),
                  language: fastLanguage,
                  style: 'procedure',
                  top_score: Number(topScore.toFixed(3)),
                  top_term_hits: fastTopTermHits,
                });
                return null;
              }
              if (
                isInsufficientHowToDetail(fastAnswerCandidate.answer, fastLanguage) &&
                !hasRelaxedFastHowToDetail(fastAnswerCandidate.answer, fastLanguage)
              ) {
                logFilterTrace('fast_howto_skip_insufficient_detail_modular', {
                  query: String(originalQueryText || '').slice(0, 120),
                  language: fastLanguage,
                  style: 'procedure',
                  top_score: Number(topScore.toFixed(3)),
                  top_term_hits: fastTopTermHits,
                });
                return null;
              }

              logFilterTrace('fast_howto_extractive_modular', {
                query: String(originalQueryText || '').slice(0, 120),
                language: fastLanguage,
                style: 'procedure',
                top_score: Number(topScore.toFixed(3)),
                top_term_hits: fastTopTermHits,
                source_count: fastAnswerCandidate.sources.length,
                intent_confidence: Number(queryIntent.confidence.toFixed(3)),
                unknown_intent_override: allowUnknownIntent,
                strong_howto_override: allowStrongHowToOverride,
              });
              console.log('[STEP 2.5] Applied modular fast extractive path (LLM bypass).');
              return {
                answer: stripExistingSourceFooter(fastAnswerCandidate.answer),
                sources: fastAnswerCandidate.sources,
              };
            },
          });

          userLanguage = pipelineResult.userLanguage;
          retrievalIndexLanguage = pipelineResult.retrievalIndexLanguage;
          queryForRAG = pipelineResult.queryForRAG;
          retrievalQueryUsed = String(pipelineResult.retrievalQueryUsed || queryForRAG);
          queryTranslationApplied = pipelineResult.queryTranslationApplied;
          prompt = pipelineResult.prompt || prompt;
          finalAnswer = String(pipelineResult.answer || '').trim();
          if (!finalAnswer && pipelineResult.metrics.documentCount > 0) {
            markEmptyLlmResponseFallback('modular_pipeline_empty_answer');
          }
          pipelineDocs = Array.isArray(pipelineResult.docs) ? pipelineResult.docs : [];
          ragSources.push(...pipelineResult.sources);

          kpiMetrics.userLanguage = userLanguage;
          kpiMetrics.translateCallsCount += pipelineResult.translateCallsCount;
          kpiMetrics.translateMs += pipelineResult.queryTranslationMs;
          kpiMetrics.queryTranslationTime += pipelineResult.queryTranslationMs;
          kpiMetrics.ragUsed = pipelineResult.metrics.documentCount > 0;
          kpiMetrics.ragTime = pipelineResult.metrics.retrievalMs;
          kpiMetrics.solrMs = pipelineResult.metrics.retrievalMs;
          kpiMetrics.solrCallsCount = pipelineResult.metrics.solrCallsCount;
          kpiMetrics.llmTime = pipelineResult.metrics.llmMs;
          proceduralLlmSynthesisActive =
            Boolean(queryIntent.isHowTo) && Number(pipelineResult.metrics.llmMs || 0) > 0;
          if (RAG_PROCEDURAL_FORCE_LLM_SYNTHESIS_ENABLED && queryIntent.isHowTo) {
            console.log(
              `[STEP 3] Procedural LLM synthesis mode=${proceduralLlmSynthesisActive ? 'active' : 'inactive'} llm_ms=${pipelineResult.metrics.llmMs}`,
            );
          }
          kpiMetrics.inputTokens = Math.ceil(
            (String(pipelineResult.prompt || '').length + messages.map((m) => String(m?.content || '')).join('\n').length) / 4,
          );
          kpiMetrics.outputTokens = Math.ceil(finalAnswer.length / 4);
          kpiMetrics.rerankMs = 0;
          tierLatencyMs = pipelineResult.metrics.retrievalMs + pipelineResult.metrics.llmMs;
          selectedTier = 'tier2';

          console.log(`[STEP 1] Language detected: ${userLanguage}`);
          console.log(`[STEP 1] Retrieval index language: ${retrievalIndexLanguage}`);
          console.log(`[STEP 1] Canonical query: "${queryForRAG}"`);
          console.log(`[STEP 1] Query translation applied: ${queryTranslationApplied}`);
          console.log(
            `[STEP 2] Retrieval complete: docs=${pipelineResult.metrics.documentCount}, topScore=${pipelineResult.metrics.topScore.toFixed(3)}, topTermHits=${pipelineResult.metrics.topTermHits}, semanticFallback=${pipelineResult.metrics.usedSemanticFallback}`,
          );
          console.log(`[STEP 2] Prompt length: ${pipelineResult.metrics.promptLength}`);
          console.log(`[STEP 3] LLM latency: ${pipelineResult.metrics.llmMs}ms`);
        } else {
          userLanguage = detectRagLanguage(originalQueryText || prompt);
          kpiMetrics.userLanguage = userLanguage;
          finalAnswer = noEvidenceReply(userLanguage);
          selectedTier = 'tier2';
          tierLatencyMs = 0;
        }

        if (!finalAnswer) {
          if (kpiMetrics.ragUsed) {
            markEmptyLlmResponseFallback('modular_final_answer_empty');
          }
          finalAnswer = noEvidenceReply(userLanguage);
        }
        const skipExpensiveProceduralPostRecovery =
          RAG_SKIP_POST_LLM_RECOVERY_FOR_PROCEDURAL &&
          proceduralLlmSynthesisActive &&
          queryIntent.isHowTo &&
          kpiMetrics.ragUsed &&
          String(finalAnswer || '').trim().length > 0 &&
          !isGenerationFailureStyleAnswer(finalAnswer) &&
          !isCannotConfirmStyleAnswer(finalAnswer);
        if (skipExpensiveProceduralPostRecovery) {
          console.log('[STEP 3] Skipping redundant post-LLM recovery for procedural synthesis.');
        }

        if (
          kpiMetrics.ragUsed &&
          (
            !String(finalAnswer || '').trim() ||
            isGenerationFailureStyleAnswer(finalAnswer) ||
            isCannotConfirmStyleAnswer(finalAnswer)
          )
        ) {
          const rescuedFromContext = await tryModularEvidenceContextRecovery('generation_failure_or_empty');
          const rescuedEmailSignature = !rescuedFromContext && tryModularEmailSignatureRescue('generation_failure_or_empty');
          if (!rescuedFromContext && !rescuedEmailSignature && allowExtractiveRescue()) {
            tryModularGenericExtractiveFallback('generation_failure_or_empty');
          } else {
            if (!rescuedFromContext && !rescuedEmailSignature) {
              console.log('[STEP 3] Extractive rescue skipped (procedural LLM synthesis active).');
            }
          }
          if (rescuedFromContext || rescuedEmailSignature) {
            markAnswerFallbackUsed('generation_failure_or_empty');
          } else {
            markEmptyLlmResponseFallback('generation_failure_or_empty');
          }
        }
        void pushProcessingPreview(finalAnswer);

        if (!skipExpensiveProceduralPostRecovery && kpiMetrics.ragUsed && /DOCUMENT CONTEXT:/i.test(String(prompt || ''))) {
          const recovered = await recoverTruncatedAnswerFromContext({
            answer: finalAnswer,
            qaPrompt: String(prompt || ''),
            language: userLanguage,
            recoveryBudget,
          });
          if (recovered.latencyMs > 0) {
            kpiMetrics.llmTime += recovered.latencyMs;
          }
          if (recovered.recovered) {
            finalAnswer = recovered.answer;
            console.log('[STEP 3] Recovered truncated answer from retrieved context.');
          } else {
            finalAnswer = recovered.answer;
          }
        }

        finalAnswer = stripDraftReasoningLeak(finalAnswer);
        finalAnswer = trimIncompleteTail(finalAnswer);
        finalAnswer = trimDanglingBodyBeforeSources(finalAnswer);

        if (userLanguage === 'en') {
          finalAnswer = sanitizeEnglishBodyText(finalAnswer);
          if (!skipExpensiveProceduralPostRecovery && RAG_REPAIR_COLLAPSED_ENGLISH && looksCollapsedEnglishAnswer(finalAnswer)) {
            const repairStart = Date.now();
            const repaired = await repairCollapsedEnglishAnswer(finalAnswer);
            kpiMetrics.llmTime += Date.now() - repairStart;
            if (repaired) {
              finalAnswer = repaired;
            }
          }
        }

        if (
          kpiMetrics.ragUsed &&
          requiresEmailSignatureCoverage(String(originalQueryText || prompt || '')) &&
          !isGenerationFailureStyleAnswer(finalAnswer) &&
          !isCannotConfirmStyleAnswer(finalAnswer) &&
          !hasEmailSignatureCoverage(stripExistingSourceFooter(finalAnswer))
        ) {
          tryModularEmailSignatureRescue('missing_signature_coverage');
        }

        if (kpiMetrics.ragUsed && isGenerationFailureStyleAnswer(finalAnswer)) {
          const rescuedEmailSignature = tryModularEmailSignatureRescue('generation_failure_style');
          if (!rescuedEmailSignature && allowExtractiveRescue()) {
            tryModularGenericExtractiveFallback('generation_failure_or_empty');
          } else {
            if (!rescuedEmailSignature) {
              console.log('[STEP 3] Extractive rescue skipped (procedural LLM synthesis active).');
            }
          }
          if (rescuedEmailSignature) {
            markAnswerFallbackUsed('generation_failure_style');
          }
        }

        if (kpiMetrics.ragUsed && isCannotConfirmStyleAnswer(finalAnswer)) {
          const rescuedFromContext = await tryModularEvidenceContextRecovery('cannot_confirm_with_docs');
          const rescuedEmailSignature = !rescuedFromContext && tryModularEmailSignatureRescue('cannot_confirm_with_docs');
          if (!rescuedFromContext && !rescuedEmailSignature && allowExtractiveRescue()) {
            tryModularGenericExtractiveFallback('cannot_confirm_with_docs');
          } else {
            if (!rescuedFromContext && !rescuedEmailSignature) {
              console.log('[STEP 3] Extractive rescue skipped (procedural LLM synthesis active).');
            }
          }
          if (rescuedFromContext || rescuedEmailSignature) {
            markAnswerFallbackUsed('cannot_confirm_with_docs');
          }
        }
        void pushProcessingPreview(finalAnswer);

        if (
          kpiMetrics.ragUsed &&
          !queryIntent.isHowTo &&
          isWeakGeneralAnswer(finalAnswer, userLanguage)
        ) {
          if (!tryModularEmailSignatureRescue('weak_or_short_general')) {
            tryModularGenericExtractiveFallback('weak_or_short_general');
          } else {
            markAnswerFallbackUsed('weak_or_short_general');
          }
        }

        if (!String(finalAnswer || '').trim() && kpiMetrics.ragUsed) {
          markEmptyLlmResponseFallback('post_processing_empty_answer');
          finalAnswer = generationFailureReply(userLanguage);
        }

        if (
          kpiMetrics.ragUsed &&
          ragSources.length > 0 &&
          !isCannotConfirmStyleAnswer(finalAnswer) &&
          !isGenerationFailureStyleAnswer(finalAnswer)
        ) {
          finalAnswer = stripExistingSourceFooter(finalAnswer);
          finalAnswer = appendSourceFooter(
            finalAnswer,
            ragSources,
            String(originalQueryText || queryForRAG || prompt || ''),
            userLanguage,
          );
        }

        if (!skipExpensiveProceduralPostRecovery) {
          const completionFix = await finalizeAnswerCompleteness({
            answer: finalAnswer,
            qaPrompt: String(prompt || ''),
            language: userLanguage,
            ragUsed: Boolean(kpiMetrics.ragUsed),
            recoveryBudget,
          });
          if (completionFix.latencyMs > 0) {
            kpiMetrics.llmTime += completionFix.latencyMs;
          }
          if (completionFix.recovered) {
            console.log('[STEP 3] Applied final completeness recovery.');
          }
          finalAnswer = normalizeCompanyBranding(completionFix.answer, userLanguage);
        } else {
          finalAnswer = normalizeCompanyBranding(finalAnswer, userLanguage);
        }
        if (
          RAG_GROUNDED_FORMATTER_ENABLED &&
          kpiMetrics.ragUsed &&
          !isCannotConfirmStyleAnswer(finalAnswer) &&
          !isGenerationFailureStyleAnswer(finalAnswer)
        ) {
          const routed = routeQuery({
            query: String(originalQueryText || prompt || ''),
            language: userLanguage,
            hasHistory: Array.isArray(messages) && messages.length > 0,
          });
          const grounded = formatGroundedAnswer({
            answer: finalAnswer,
            language: userLanguage,
            queryClass: routed.klass,
          });
          if (grounded.changed) {
            finalAnswer = grounded.answer;
            console.log(
              `[RAG FORMATTER] grounded_formatter_applied mode=${grounded.mode} query_class=${routed.klass}`,
            );
          }
          recordRagDecision('formatter_mode', {
            enabled: 1,
            applied: grounded.changed ? 1 : 0,
            mode: grounded.mode,
            query_classification: routed.klass,
            language: userLanguage,
            answer_length: String(finalAnswer || '').length,
          });
        }
        if (
          kpiMetrics.ragUsed &&
          ragSources.length > 0 &&
          !/(^|\n)\s*SOURCES?\s*:/i.test(String(finalAnswer || '')) &&
          !isCannotConfirmStyleAnswer(finalAnswer) &&
          !isGenerationFailureStyleAnswer(finalAnswer)
        ) {
          finalAnswer = appendSourceFooter(
            stripExistingSourceFooter(finalAnswer),
            ragSources,
            String(originalQueryText || queryForRAG || prompt || ''),
            userLanguage,
          );
        }
        void pushProcessingPreview(finalAnswer, { force: true });
        if (kpiMetrics.ragUsed && isGenerationFailureStyleAnswer(finalAnswer)) {
          markEmptyLlmResponseFallback('generation_failure_style_answer');
        }

        if (!(await canMutateOutput())) {
          console.warn('[CHAT PROCESS] Output became terminal during processing; skipping late persistence.');
          return { outputId, isOk: false, content: '' };
        }

        if (outputs.length === 0) {
          const generateAndStoreTitle = async () => {
            const chatTitle = await createChatTitle(originalQueryText || prompt, finalAnswer);
            console.log(`[STEP 3] Generated chat title: "${chatTitle}"`);
            await put<IGenTaskSer>(KrdGenTask, { id: taskId }, {
              form_data: chatTitle,
              update_by: 'JOB',
            });
            if (data.userName) {
              await chatStoreRedis.setTitle(taskId, chatTitle).catch(() => undefined);
            }
          };
          if (ASYNC_CHAT_TITLE) {
            void generateAndStoreTitle().catch((e) =>
              console.warn('[STEP 3] Async title generation failed:', (e as any)?.message || e),
            );
          } else {
            await generateAndStoreTitle();
          }
        }

        const rawSourceIds = ragSources.map((s) => String(s.docId));
        await persistChatTurn({
          userId: Number(data.userId || 0) || 0,
          userName: String(data.userName || 'anonymous'),
          departmentCode,
          conversationId: String(taskId),
          outputId: Number(outputId),
          userText: originalQueryText,
          userLanguage,
          workingQuery: queryTranslationApplied ? queryForRAG : undefined,
          assistantText: finalAnswer,
          ragUsed: !!kpiMetrics.ragUsed,
          sourceIds: rawSourceIds,
          tokenInput: kpiMetrics.inputTokens,
          tokenOutput: kpiMetrics.outputTokens,
          metadata: {
            retrieval_index_language: retrievalIndexLanguage,
            query_translation_applied: queryTranslationApplied,
            tier: selectedTier,
          },
        }).catch((e) => console.warn('[HistoryPersistence] persistChatTurn failed:', e?.message || e));

        if (Number.isFinite(Number(data.userId)) && Number(data.userId) > 0) {
          await createNotification({
            userId: Number(data.userId),
            departmentCode,
            type: 'chat_reply_ready',
            title: 'Chat response ready',
            body: finalAnswer.length > 140 ? `${finalAnswer.slice(0, 140)}...` : finalAnswer,
            payload: {
              conversation_id: String(taskId),
              message_id: `${outputId}:assistant`,
              rag_used: !!kpiMetrics.ragUsed,
              source_ids: rawSourceIds,
            },
          }).catch((e) => console.warn('[Notification] create chat_reply_ready failed:', e?.message || e));
        }

        if (data.userName && typeof data.userName === 'string' && data.userName.trim().length > 0) {
          const userText = originalQueryText.trim();
          if (userText) {
            await chatStoreRedis
              .appendMessage({ taskId, userName: data.userName, role: 'user', content: userText })
              .catch((e) => console.warn('[RedisChat] Failed to append user message:', e?.message || e));
          }
          await chatStoreRedis
            .appendMessage({
              taskId,
              userName: data.userName,
              role: 'assistant',
              content: finalAnswer,
              sources: ragSources,
            })
            .catch((e) => console.warn('[RedisChat] Failed to append assistant message:', e?.message || e));
        }

        console.log(`\n[STEP 4] Single-Language Output Creation`);
        content = formatSingleLanguageOutput(finalAnswer, userLanguage as LanguageCode, {
          generation_status: generationStatus,
          used_fallback: generationUsedFallback,
        });
        if (config.APP_MODE === 'rag-evaluation') {
          content = `${prompt}\n\n## LLM Response\n\n${content}`;
        }

        if (!(await canMutateOutput())) {
          console.warn('[CHAT PROCESS] Output became terminal before final write; skipping late overwrite.');
          return { outputId, isOk: false, content: '' };
        }

        kpiMetrics.endTime = Date.now();
        kpiMetrics.totalTime = kpiMetrics.endTime - kpiMetrics.startTime;
        kpiMetrics.responseLength = content.length;
        kpiMetrics.tierUsed = selectedTier;
        kpiMetrics.tierLatency = tierLatencyMs;
        updateLocalCacheMetrics();
        const finalStatus = isOk ? 'FINISHED' : 'FAILED';
        logFilterTrace('tier_selection', {
          canonical_query: queryForRAG,
          original_query: String(originalQueryText || '').slice(0, 180),
          language: userLanguage,
          tier: selectedTier,
          tier_latency_ms: tierLatencyMs,
          cache_hit: false,
        });

        await put<IGenTaskOutputSer>(
          KrdGenTaskOutput,
          { id: outputId },
          {
            content,
            status: finalStatus,
            update_by: 'JOB',
          },
        );
        await publishLive('done', { status: finalStatus, content });

        const organicRetrievalMs = computeOrganicRetrievalMs(kpiMetrics);
        await recordQueryEvent({
          taskId: String(taskId),
          taskOutputId: Number(outputId),
          userId: Number(data.userId || 0) || undefined,
          userName: String(data.userName || ''),
          departmentCode,
          status: finalStatus,
          responseMs: kpiMetrics.totalTime,
          ragUsed: !!kpiMetrics.ragUsed,
          queryText: originalQueryText,
          answerText: finalAnswer || content,
          metadata: {
            ragMs: kpiMetrics.ragTime,
            llmMs: kpiMetrics.llmTime,
            retrievalMs: organicRetrievalMs,
            translationMs: kpiMetrics.translationTime,
            queryTranslationMs: kpiMetrics.queryTranslationTime,
            solrMs: kpiMetrics.solrMs,
            translateMs: kpiMetrics.translateMs,
            rerankMs: kpiMetrics.rerankMs,
            solrCallsCount: kpiMetrics.solrCallsCount,
            translateCallsCount: kpiMetrics.translateCallsCount,
            userLanguage: kpiMetrics.userLanguage,
            modelUsed: kpiMetrics.modelUsed,
            tierUsed: selectedTier,
            tierLatencyMs: tierLatencyMs,
            canonicalQuery: queryForRAG,
            localCacheHits: kpiMetrics.localCacheHitCount,
            localCacheMisses: kpiMetrics.localCacheMissCount,
            localCacheWrites: kpiMetrics.localCacheWriteCount,
            localCacheEvictions: kpiMetrics.localCacheEvictionCount,
            localCacheExpired: kpiMetrics.localCacheExpiredCount,
            recoveryBudgetCalls: kpiMetrics.recoveryBudgetCalls,
            recoveryBudgetSpentMs: kpiMetrics.recoveryBudgetSpentMs,
            recoveryBudgetMaxCalls: kpiMetrics.recoveryBudgetMaxCalls,
            recoveryBudgetMaxMs: kpiMetrics.recoveryBudgetMaxMs,
          },
        }).then(() =>
          recordContentFlagEvent({
            taskId: String(taskId),
            taskOutputId: Number(outputId),
            userId: Number(data.userId || 0) || undefined,
            userName: String(data.userName || ''),
            departmentCode,
            queryText: originalQueryText,
            answerText: finalAnswer || content,
          }),
        ).catch((analyticsError) =>
          console.warn('[Analytics] analytics event write failed:', (analyticsError as any)?.message || analyticsError),
        );

        console.log(`\n========== [CHAT PROCESS] Completed ==========`);
        console.log(`[CHAT PROCESS] Final status: ${finalStatus}`);
        console.log(`[CHAT PROCESS] Output ID: ${outputId}, Content length: ${content.length}`);
        console.log(`[CHAT PROCESS] Total processing time: ${kpiMetrics.totalTime}ms`);
        console.log(`[CHAT PROCESS] ===========================================\n`);

        return { outputId, isOk, content };
      } catch (error) {
        console.error('[CHAT PROCESS] Modular pipeline path failed; legacy pipeline is disabled:', error);
        if (!(await canMutateOutput())) {
          console.warn('[CHAT PROCESS] Output already terminal after modular pipeline error; skipping overwrite.');
          return { outputId, isOk: false, content: '' };
        }
        const failureLanguage = detectRagLanguage(originalQueryText || prompt);
        const failureContent = formatSingleLanguageOutput(
          generationFailureReply(failureLanguage),
          failureLanguage as LanguageCode,
          {
            generation_status: 'empty_llm_response',
            used_fallback: false,
          },
        );
        await put<IGenTaskOutputSer>(
          KrdGenTaskOutput,
          { id: outputId },
          {
            content: failureContent,
            status: 'FAILED',
            update_by: 'JOB',
          },
        );
        await publishLive('done', { status: 'FAILED', content: failureContent });
        return { outputId, isOk: false, content: failureContent };
      }
    }
    if (useModularPipeline && !shouldUseRagPipeline) {
      console.log(`[CHAT PROCESS] RAG skipped before pipeline; intent=${sharedQueryIntent.intent}`);
    }

    // Step 1: Detect language and decide working query language for retrieval
    console.log(`\n[STEP 1] Language Detection`);
    console.log(`[STEP 1] Original prompt: "${prompt}"`);
    let userLanguage: 'ja' | 'en' = detectRagLanguage(originalQueryText);
    let retrievalIndexLanguage: 'ja' | 'en' | 'multi' = 'multi';
    let queryForRAG = String(prompt || '');
    let queryTranslationApplied = false;
    let multilingualRetrievalQueries: string[] = [];
    const queryRoutingStart = Date.now();
    try {
      const pipelineResult = await runRagPipeline({
        query: originalQueryText,
        prompt,
        retrievalIndexLanguage: process.env.RAG_INDEX_LANGUAGE || 'multi',
        // Legacy path uses runRagPipeline only for query routing/canonicalization.
        // Retrieval/generation are handled below by legacy code when this path is active.
        retrieveDocuments: async () => [],
      });
      userLanguage = pipelineResult.userLanguage;
      retrievalIndexLanguage = pipelineResult.retrievalIndexLanguage;
      queryForRAG = pipelineResult.queryForRAG || String(originalQueryText || prompt || '').trim();
      multilingualRetrievalQueries = pipelineResult.multilingualRetrievalQueries;
      queryTranslationApplied = pipelineResult.queryTranslationApplied;
      kpiMetrics.translateCallsCount += pipelineResult.translateCallsCount;
      kpiMetrics.translateMs += pipelineResult.queryTranslationMs;
      kpiMetrics.queryTranslationTime += pipelineResult.queryTranslationMs;
    } catch (e) {
      console.warn('[STEP 1] Working query routing failed, using original query:', e);
      userLanguage = detectRagLanguage(originalQueryText);
      retrievalIndexLanguage = 'multi';
      queryForRAG = rewriteRagQueryWithSynonyms(originalQueryText);
      multilingualRetrievalQueries = uniqueStringList([queryForRAG || originalQueryText], 4);
      queryTranslationApplied = false;
    }
    kpiMetrics.userLanguage = userLanguage;
    console.log(`[STEP 1] Language detected: ${userLanguage}`);
    console.log(`[STEP 1] Final response language: ${userLanguage === 'ja' ? 'Japanese' : 'English'}`);
    console.log(`[STEP 1] Retrieval index language: ${retrievalIndexLanguage}`);
    console.log(`[STEP 1] Working query language: ${userLanguage}`);
    console.log(`[STEP 1] Canonical query: "${queryForRAG}"`);
    console.log(`[STEP 1] Retrieval query variants: ${multilingualRetrievalQueries.join(' | ')}`);
    console.log(`[STEP 1] Query translation applied: ${queryTranslationApplied}`);
    const queryRoutingMs = Date.now() - queryRoutingStart;
    if (queryRoutingMs > 0) {
      logFilterTrace('query_routing', {
        ms: queryRoutingMs,
        query: String(queryForRAG || '').slice(0, 180),
      });
    }

    const intentStart = Date.now();
    const queryIntent = classifyQueryIntent(originalQueryText || queryForRAG);
    kpiMetrics.intentMs = Date.now() - intentStart;
    logFilterTrace('intent_routed', {
      query: String(originalQueryText || queryForRAG || '').slice(0, 180),
      intent: queryIntent.label,
      confidence: Number(queryIntent.confidence.toFixed(3)),
      matched_terms: queryIntent.matchedTerms,
      is_how_to: queryIntent.isHowTo,
    });

    const candidateStart = Date.now();
    let stage1StrictCandidateIds: string[] = [];
    let stage1ExpandedCandidateIds: string[] = [];
    if (useSpecificFileFilter) {
      stage1StrictCandidateIds = uniqueStringList(storage_keyArray, RAG_STAGE1_STRICT_FILE_IDS);
      stage1ExpandedCandidateIds = uniqueStringList(storage_keyArray, RAG_STAGE1_EXPANDED_FILE_IDS);
    } else {
      const candidateCacheKey = buildCandidateScopeCacheKey({
        departmentCode,
        roleCode,
        processingPath: String(data.processingPath || ''),
        intentLabel: queryIntent.label,
        querySignature: queryForRAG || originalQueryText,
      });
      const availableSet = new Set(
        availableFilesForSearch
          .map((file) => String(file?.storage_key || '').trim())
          .filter(Boolean),
      );
      const cacheHit = readCandidateScopeCache(candidateCacheKey, availableSet);
      if (cacheHit) {
        stage1StrictCandidateIds = cacheHit.strict;
        stage1ExpandedCandidateIds = cacheHit.expanded;
        kpiMetrics.candidateScopeCacheHit = true;
        logFilterTrace('candidate_scope_cache_hit', {
          key: hashShort(candidateCacheKey),
          strict_count: stage1StrictCandidateIds.length,
          expanded_count: stage1ExpandedCandidateIds.length,
        });
      } else {
        const stage1BaseScopedStorageKeys = buildStage1CandidateScope(
          queryForRAG || originalQueryText,
          availableFilesForSearch,
        );
        const stage1IntentScoped = buildIntentScopedCandidateScope(
          queryForRAG || originalQueryText,
          availableFilesForSearch,
          stage1BaseScopedStorageKeys,
          queryIntent,
        );
        stage1StrictCandidateIds = stage1IntentScoped.strict;
        stage1ExpandedCandidateIds = stage1IntentScoped.expanded;
        writeCandidateScopeCache(candidateCacheKey, {
          strict: stage1StrictCandidateIds,
          expanded: stage1ExpandedCandidateIds,
        });
        logFilterTrace('candidate_scope_cache_store', {
          key: hashShort(candidateCacheKey),
          strict_count: stage1StrictCandidateIds.length,
          expanded_count: stage1ExpandedCandidateIds.length,
        });
      }
    }
    kpiMetrics.candidateMs = Date.now() - candidateStart;
    const stage1ScopeActive = !useSpecificFileFilter && stage1StrictCandidateIds.length > 0;
    if (stage1ScopeActive) {
      console.log(
        `[STEP 1] Stage-1 prefilter active: narrowed candidate files to ${stage1StrictCandidateIds.length}/${availableFilesForSearch.length}`,
      );
    }
    const stage1RelaxProfiles = buildStage1RelaxProfiles({
      data,
      files: availableFilesForSearch,
      intent: queryIntent,
      strictCandidateIds: stage1StrictCandidateIds,
      expandedCandidateIds: stage1ExpandedCandidateIds,
      useSpecificFileFilter,
      fixedCandidateIds: storage_keyArray,
      shouldRestrictToDepartment,
      departmentCode,
    });
    if (!useSpecificFileFilter && stage1StrictCandidateIds.length > 0) {
      const minScoped = Math.max(RAG_STAGE1_MIN_SCOPE_SIZE, 2);
      const isTinyScope = stage1StrictCandidateIds.length < minScoped;
      const shouldBypassTinyScope =
        isTinyScope &&
        queryIntent.label === 'UNKNOWN' &&
        (queryIntent.isHowTo || queryIntent.confidence < RAG_STAGE1_MIN_SCOPE_CONFIDENCE);
      if (shouldBypassTinyScope) {
        const tinyCount = stage1StrictCandidateIds.length;
        stage1StrictCandidateIds = [];
        stage1ExpandedCandidateIds = [];
        for (const profile of stage1RelaxProfiles) {
          profile.candidateFileIds = [];
        }
        console.log(
          `[STEP 1] Stage-1 prefilter bypassed: tiny scope ${tinyCount}/${availableFilesForSearch.length} for broad UNKNOWN query.`,
        );
      }
    }
    logFilterTrace('stage1_profiles', {
      profile_count: stage1RelaxProfiles.length,
      profiles: stage1RelaxProfiles.map((profile) => ({
        step: profile.step,
        reason: profile.reason,
        candidate_file_ids_count: profile.candidateFileIds.length,
        metadata_filter_keys: Object.keys(profile.metadataFilters || {}),
      })),
    });

    const rawCacheQuery = String(originalQueryText || queryForRAG || prompt || '').trim();
    const canonicalQuery = buildCanonicalSemanticQuery(
      rawCacheQuery,
      queryIntent,
      RAG_INTENT_CONFIDENCE_THRESHOLD,
    );
    const fileScopeHash = buildFileScopeHash({
      useSpecificFileFilter,
      shouldRestrictToDepartment,
      departmentCode,
      strictCandidateIds: stage1StrictCandidateIds,
      expandedCandidateIds: stage1ExpandedCandidateIds,
      availableFilesCount: availableFilesForSearch.length,
    });
    logFilterTrace('canonical_query_built', {
      canonical_query: canonicalQuery,
      original_query: rawCacheQuery.slice(0, 180),
      language: userLanguage,
      intent_label: queryIntent.label,
      intent_confidence: Number(queryIntent.confidence.toFixed(3)),
    });

    const answerCacheKey = canonicalQuery
      ? buildAnswerCacheKey({
        userId: Number(data.userId || 0) || 0,
        departmentCode,
        canonicalQuery,
        fileScopeHash,
        language: userLanguage,
      })
      : '';
    const bypassTier0Cache =
      RAG_CACHE_BYPASS_FACT_QUERIES &&
      isFactValueQuery(rawCacheQuery);
    if (bypassTier0Cache) {
      logFilterTrace('tier0_cache_bypassed', {
        reason: 'fact_query',
        canonical_query: canonicalQuery,
        original_query: rawCacheQuery.slice(0, 180),
        language: userLanguage,
      });
    }
    const alternateLanguage = userLanguage === 'ja' ? 'en' : 'ja';
    const alternateLanguageCacheKey = canonicalQuery
      ? buildAnswerCacheKey({
        userId: Number(data.userId || 0) || 0,
        departmentCode,
        canonicalQuery,
        fileScopeHash,
        language: alternateLanguage,
      })
      : '';

    let content = '';
    let isOk = true;
    let finalAnswer = '';
    let selectedTier: ResponseTier = 'tier2';
    let tierLatencyMs = 0;
    let generationStatus: 'ok' | 'empty_llm_response' = 'ok';
    let generationUsedFallback = false;
    let answerResolvedByFastTier = false;
    let tier1FastPathUsed = false;
    let cacheLookupMs = 0;
    let cacheWriteMs = 0;
    let topRelaxStepUsed = '';
    let docsForHowToRescue: any[] = [];
    const markEmptyLlmResponseFallback = (reason: string) => {
      generationStatus = 'empty_llm_response';
      generationUsedFallback = true;
      console.warn(`[STEP 3] Empty LLM response fallback applied (${reason}).`);
    };

    const isCacheIntentValid = (cachedIntentLabel?: QueryIntentLabel): boolean => {
      if (queryIntent.confidence < RAG_INTENT_CONFIDENCE_THRESHOLD) return true;
      if (!cachedIntentLabel) return false;
      return cachedIntentLabel === queryIntent.label;
    };

    if (RAG_ANSWER_CACHE && answerCacheKey && !bypassTier0Cache) {
      const cacheLookupStart = Date.now();
      answerCacheLookupCount += 1;
      let cachedAnswer = await readAnswerCache(answerCacheKey);
      let cacheSourceLanguage: 'ja' | 'en' = userLanguage;
      let translatedFromAlternate = false;
      if (cachedAnswer && !isCacheIntentValid(cachedAnswer.intent_label)) {
        logFilterTrace('tier0_cache_rejected', {
          reason: 'intent_mismatch',
          canonical_query: canonicalQuery,
          cached_intent_label: cachedAnswer.intent_label,
          current_intent_label: queryIntent.label,
          current_intent_confidence: Number(queryIntent.confidence.toFixed(3)),
        });
        cachedAnswer = null;
      }

      if (!cachedAnswer && RAG_CACHE_TRANSLATE_ALLOWED && alternateLanguageCacheKey) {
        const altCached = await readAnswerCache(alternateLanguageCacheKey);
        if (altCached && isCacheIntentValid(altCached.intent_label)) {
          cachedAnswer = altCached;
          cacheSourceLanguage = alternateLanguage;
          translatedFromAlternate = true;
        }
      }

      cacheLookupMs = Date.now() - cacheLookupStart;
      kpiMetrics.cacheLookupTime = cacheLookupMs;
      if (cachedAnswer) {
        if (translatedFromAlternate) {
          const answerText = String(cachedAnswer.answer || '').trim();
          const lines = answerText.split('\n');
          const sourceLines = lines.filter((line) => SOURCE_LINE_RE.test(String(line || '')));
          const bodyLines = lines.filter((line) => !SOURCE_LINE_RE.test(String(line || '')));
          const translatedBody = String(
            await translateText(
              bodyLines.join('\n').trim(),
              userLanguage,
              true,
              0,
              Math.min(FINAL_TRANSLATION_TIMEOUT_MS, 4500),
            ),
          ).trim();
          if (translatedBody) {
            cachedAnswer.answer = [translatedBody, ...sourceLines].filter(Boolean).join('\n\n').trim();
          } else {
            cachedAnswer = null;
          }
        }
      }

      if (cachedAnswer) {
        const cacheHealth = isCacheAnswerHealthy({
          answer: String(cachedAnswer.answer || ''),
          language: userLanguage,
          queryIntent,
          originalQuery: String(originalQueryText || prompt || ''),
        });
        if (!cacheHealth.ok) {
          logFilterTrace('tier0_cache_rejected', {
            reason: cacheHealth.reason || 'cache_answer_unhealthy',
            canonical_query: canonicalQuery,
            current_intent_label: queryIntent.label,
            current_intent_confidence: Number(queryIntent.confidence.toFixed(3)),
            translated_from_alternate_language: translatedFromAlternate,
          });
          cachedAnswer = null;
        }
      }

      if (cachedAnswer) {
        answerCacheHitCount += 1;
        selectedTier = 'tier0';
        tierLatencyMs = cacheLookupMs;
        answerResolvedByFastTier = true;
        kpiMetrics.cacheHit = true;
        kpiMetrics.ragUsed = true;
        kpiMetrics.ragTime = cacheLookupMs;
        finalAnswer = cachedAnswer.answer;
        content = finalAnswer;
        topRelaxStepUsed = String(cachedAnswer.top_relax_step || '');
        for (let i = 0; i < cachedAnswer.sources.length; i++) {
          const sourceId = String(cachedAnswer.sources[i] || '').trim();
          if (!sourceId) continue;
          ragSources.push({
            docId: sourceId,
            title: String(cachedAnswer.source_titles?.[i] || '') || undefined,
          });
        }
        logFilterTrace('tier0_cache_hit', {
          cache_key_hash: hashShort(answerCacheKey),
          canonical_query: canonicalQuery,
          intent: queryIntent.label,
          confidence: Number(queryIntent.confidence.toFixed(3)),
          source_count: ragSources.length,
          cache_source_language: cacheSourceLanguage,
          translated_from_alternate_language: translatedFromAlternate,
          latency_ms: cacheLookupMs,
          cache_hit_rate: Number(getAnswerCacheHitRate().toFixed(4)),
        });
      } else {
        logFilterTrace('tier0_cache_miss', {
          cache_key_hash: hashShort(answerCacheKey),
          canonical_query: canonicalQuery,
          intent: queryIntent.label,
          confidence: Number(queryIntent.confidence.toFixed(3)),
          latency_ms: cacheLookupMs,
          cache_hit_rate: Number(getAnswerCacheHitRate().toFixed(4)),
        });
      }
    }

    // Step 2: RAG search
    const useRAGForQuery = filesAvailable;
    
    console.log(`\n[STEP 2] RAG Decision: useRAGForQuery=${useRAGForQuery} (filesAvailable=${filesAvailable})`);
    
    if (useRAGForQuery && !answerResolvedByFastTier) {
      console.log(`\n[STEP 2] RAG Search`);
      const ragStartTime = Date.now();
      try {
        [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
        if (curOutput.status === 'CANCEL') {
          console.log(`[STEP 2] Output cancelled during RAG search`);
          return { outputId, isOk: false, content: '' };
        }

        console.log(`[STEP 2] Starting RAG search`);
        console.log(`[STEP 2] Searching ${useSpecificFileFilter ? storage_keyArray.length : 'all'} document(s) via Solr`);
        
        try {
          // Use language-routed working query for retrieval.
          const searchQuery = rewriteRagQueryWithSynonyms(queryForRAG);
          console.log(`[STEP 2] Solr search query: "${searchQuery}"`);
          
          let solrCallCount = 0;
          const runSolrSearch = async (
            queryText: string,
            relaxProfile: Stage1RelaxProfile,
            mode: 'primary' | 'fallback',
          ) => {
            if (solrCallCount >= RAG_SOLR_MAX_CALLS) {
              return { docs: [], numFound: 0, topScore: 0 };
            }

            const solrCacheKey = buildSolrResultCacheKey({
              canonicalQuery: queryText,
              intentLabel: queryIntent.label,
              departmentCode,
              roleCode,
              mode,
              candidateFileIds: relaxProfile?.candidateFileIds,
              metadataFilters: relaxProfile?.metadataFilters,
            });
            const cached = getExpiringCacheEntry(solrResultCache, solrCacheKey, 'solrResult');
            if (cached) {
              kpiMetrics.solrCacheHit = true;
              logFilterTrace('solr_cache_hit', {
                key: hashShort(solrCacheKey),
                mode,
                docs: cached.value.docs.length,
                num_found: cached.value.numFound,
              });
              return cached.value;
            }

            solrCallCount += 1;
            kpiMetrics.solrCallsCount = solrCallCount;
            const activeStorageScope = uniqueStringList(
              relaxProfile?.candidateFileIds || [],
              RAG_STAGE1_EXPANDED_FILE_IDS,
            );
            const rawTokens = String(queryText || '').split(/\s+/).map(normalizeSearchToken).filter(Boolean);
            const searchTokens = rawTokens.filter(shouldKeepQueryToken);
            const effectiveTokens = (searchTokens.length ? searchTokens : rawTokens).slice(0, 20);
            const isMostlyJapaneseQuery = hasJapaneseChars(queryText);
            const searchTerms = effectiveTokens
              .map((t) => {
                const cleaned = String(t || '').trim();
                if (!cleaned) return '';
                if (hasJapaneseChars(cleaned) || /[*?]/.test(cleaned)) return cleaned;
                return `"${cleaned.replace(/"/g, '\\"')}"`;
              })
              .filter(Boolean)
              .join(' ');
            const solrQuery = encodeURIComponent(searchTerms || '*:*');
            const fileFilter = (activeStorageScope.length)
              ? `{!terms f=id}${activeStorageScope.map(escapeTermsValue).join(',')}`
              : '';
            const coreName = encodeURIComponent(config.ApacheSolr.coreName || 'mycore');
            const fqParts: string[] = [];
            if (fileFilter) fqParts.push(fileFilter);
            if (shouldRestrictToDepartment && departmentCode) {
              fqParts.push(`department_code_s:${departmentCode}`);
            }
            for (const metadataFq of buildSolrFqFromMetadataFilters(relaxProfile?.metadataFilters)) {
              if (!metadataFq) continue;
              if (shouldRestrictToDepartment && departmentCode && metadataFq.startsWith('department_code_s:')) continue;
              fqParts.push(metadataFq);
            }
            const fq = fqParts.map((part) => `&fq=${encodeURIComponent(part)}`).join('');
            const qf = encodeURIComponent(
              'title^4 file_name_s^3 section_title_s^3 article_number_s^2 policy_type_s^2 content_txt content_txt_ja',
            );
            const pf = encodeURIComponent(
              'title^8 file_name_s^6 section_title_s^6 article_number_s^4 policy_type_s^4 content_txt^2 content_txt_ja^2',
            );
            const mm = encodeURIComponent(isMostlyJapaneseQuery ? '2<75%' : '2<70%');
            const departmentBoost =
              SOLR_DEPARTMENT_BOOST > 0 && shouldRestrictToDepartment && departmentCode
                ? `&bq=${encodeURIComponent(`department_code_s:${departmentCode}^${SOLR_DEPARTMENT_BOOST}`)}`
                : '';
            const solrUrl = `${config.ApacheSolr.url}/solr/${coreName}/select?q=${solrQuery}${fq}&defType=edismax&qf=${qf}&pf=${pf}&q.op=OR&mm=${mm}${departmentBoost}&fl=id,title,file_name_s,section_title_s,article_number_s,policy_type_s,content_txt,content_txt_ja,department_code_s,score&rows=${SOLR_ROWS}&wt=json`;

            const solrStart = Date.now();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), SOLR_TIMEOUT_MS);
            const response = await fetch(solrUrl, { signal: controller.signal }).finally(() => clearTimeout(timeout));
            kpiMetrics.solrMs += Date.now() - solrStart;
            if (!response.ok) {
              throw new Error(`Solr HTTP ${response.status} ${response.statusText}`);
            }
            const results = await response.json();
            const docs = Array.isArray(results?.response?.docs)
              ? results.response.docs.map((doc: any) => ({
                  ...doc,
                  content_txt: doc?.content_txt || doc?.content_txt_ja || '',
                }))
              : [];
            const numFound = Number(results?.response?.numFound || docs.length || 0);
            const topScore = Number(docs?.[0]?.score || 0);
            const value = { docs, numFound, topScore };
            setExpiringCacheEntryBounded(
              solrResultCache,
              solrCacheKey,
              {
                value,
                expiresAt: Date.now() + SOLR_RESULT_CACHE_TTL_MS,
              },
              SOLR_RESULT_CACHE_MAX_ENTRIES,
              'solrResult',
            );
            console.log(
              `[STEP 2] Solr[${mode}] returned ${docs.length} doc(s), numFound=${numFound}, topScore=${topScore}, call=${solrCallCount}/${RAG_SOLR_MAX_CALLS}`,
            );
            return value;
          };

          const runFastSolrSinglePass = async (queryText: string, relaxProfile: Stage1RelaxProfile) => {
            const activeStorageScope = uniqueStringList(
              relaxProfile?.candidateFileIds || [],
              RAG_STAGE1_EXPANDED_FILE_IDS,
            );
            const rawTokens = queryText.split(/\s+/).map(normalizeSearchToken).filter(Boolean);
            const searchTokens = rawTokens.filter(shouldKeepQueryToken);
            const effectiveTokens = (searchTokens.length ? searchTokens : rawTokens).slice(0, 20);
            const isMostlyJapaneseQuery = hasJapaneseChars(queryText);
            const searchTerms = effectiveTokens
              .map((t) => {
                const cleaned = String(t || '').trim();
                if (!cleaned) return '';
                if (hasJapaneseChars(cleaned) || /[*?]/.test(cleaned)) return cleaned;
                return `"${cleaned.replace(/"/g, '\\"')}"`;
              })
              .filter(Boolean)
              .join(' ');

            const solrQuery = encodeURIComponent(searchTerms || '*:*');
            const fileFilter = activeStorageScope.length
              ? `{!terms f=id}${activeStorageScope.map(escapeTermsValue).join(',')}`
              : '';
            const coreName = encodeURIComponent(config.ApacheSolr.coreName || 'mycore');
            const fqParts: string[] = [];
            if (fileFilter) fqParts.push(fileFilter);
            if (shouldRestrictToDepartment && departmentCode) {
              fqParts.push(`department_code_s:${departmentCode}`);
            }
            for (const metadataFq of buildSolrFqFromMetadataFilters(relaxProfile?.metadataFilters)) {
              if (!metadataFq) continue;
              if (shouldRestrictToDepartment && departmentCode && metadataFq.startsWith('department_code_s:')) {
                continue;
              }
              fqParts.push(metadataFq);
            }
            const fq = fqParts.map((part) => `&fq=${encodeURIComponent(part)}`).join('');
            const qf = encodeURIComponent(
              'title^4 file_name_s^3 section_title_s^3 article_number_s^2 policy_type_s^2 content_txt content_txt_ja',
            );
            const mm = encodeURIComponent(isMostlyJapaneseQuery ? '2<75%' : '1');
            const departmentBoost =
              SOLR_DEPARTMENT_BOOST > 0 && shouldRestrictToDepartment && departmentCode
                ? `&bq=${encodeURIComponent(`department_code_s:${departmentCode}^${SOLR_DEPARTMENT_BOOST}`)}`
                : '';
            const rows = Math.max(1, Math.min(2, SOLR_ROWS));
            const solrUrl = `${config.ApacheSolr.url}/solr/${coreName}/select?q=${solrQuery}${fq}&defType=edismax&qf=${qf}&q.op=OR&mm=${mm}${departmentBoost}&fl=id,title,file_name_s,section_title_s,article_number_s,policy_type_s,content_txt,content_txt_ja,department_code_s,score&rows=${rows}&wt=json`;

            const solrStart = Date.now();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), SOLR_TIMEOUT_MS);
            const response = await fetch(solrUrl, { signal: controller.signal }).finally(() => clearTimeout(timeout));
            kpiMetrics.solrMs += Date.now() - solrStart;
            kpiMetrics.solrCallsCount += 1;
            if (!response.ok) {
              throw new Error(`Solr HTTP ${response.status} ${response.statusText}`);
            }
            const results = await response.json();
            const docs = Array.isArray(results?.response?.docs)
              ? results.response.docs
                  .slice(0, rows)
                  .map((doc: any) => ({
                    ...doc,
                    content_txt: doc?.content_txt || doc?.content_txt_ja || '',
                  }))
              : [];
            const numFound = Number(results?.response?.numFound || docs.length || 0);
            const topScore = Number(docs?.[0]?.score || 0);
            return { docs, numFound, topScore };
          };

          let docs: any[] = [];
          let retrievalQueryUsed = searchQuery;
          let bestNumFound = Number.POSITIVE_INFINITY;
          let bestTopScore = Number.NEGATIVE_INFINITY;
          let bestCandidateTermHits = Number.NEGATIVE_INFINITY;
          let bestCandidateRank = Number.NEGATIVE_INFINITY;
          let translatedQuery = '';
          let simpleSolrDone = false;
          const effectiveSimpleSolrMode = RAG_SIMPLE_SOLR_MODE && multilingualRetrievalQueries.length <= 1;
          const shouldTryTranslatedCandidates =
            !queryTranslationApplied &&
            userLanguage === 'en' &&
            retrievalIndexLanguage === 'ja';
          let translatedAttempted = false;
          let relaxStepUsed = stage1RelaxProfiles[0];

          if (effectiveSimpleSolrMode) {
            const primaryProfile = stage1RelaxProfiles[0];
            const primaryQuery = rewriteRagQueryWithSynonyms(searchQuery);
            const bounded = await runBoundedSolrRetrieval({
              query: primaryQuery,
              intentLabel: queryIntent.label,
              userLanguage,
              bucketCorpusLanguage:
                retrievalIndexLanguage === 'multi'
                  ? 'multi'
                  : resolveBucketCorpusLanguage(queryIntent.label as any),
              translationTimeoutMs: QUERY_TRANSLATION_TIMEOUT_MS,
              runSolr: async (queryText, mode) => runSolrSearch(queryText, primaryProfile, mode),
              buildFallbackQuery: (seedQuery, intentLabel) => buildFallbackWildcardQuery(seedQuery, intentLabel as any),
              translateQuery: async (queryText, targetLang) => {
                kpiMetrics.translateCallsCount += 1;
                return await translateQueryTextForRetrieval(queryText, targetLang);
              },
            });
            docs = bounded.result.docs;
            retrievalQueryUsed = bounded.retrievalQueryUsed || primaryQuery;
            bestNumFound = bounded.result.numFound;
            bestTopScore = bounded.result.topScore;
            translatedQuery = bounded.translatedQuery || '';
            if (bounded.queryTranslationApplied) {
              queryTranslationApplied = true;
            }
            if (bounded.translateCallsCount > 0) {
              translatedAttempted = true;
            }
            kpiMetrics.queryTranslationTime += bounded.translateMs;
            kpiMetrics.translateMs += bounded.translateMs;
            kpiMetrics.solrCallsCount = Math.max(kpiMetrics.solrCallsCount, bounded.solrCallsCount);
            bestCandidateTermHits = Math.max(
              ...docs.map((doc) => countDocTermHits(doc, extractQueryTermsForRerank(retrievalQueryUsed))),
              0,
            );
            relaxStepUsed = primaryProfile;
            topRelaxStepUsed = String(primaryProfile?.step || 'A_STRICT');
            simpleSolrDone = true;
            logFilterTrace('solr_simple_mode', {
              enabled: true,
              call_budget: 2,
              calls_used: bounded.solrCallsCount,
              retrieval_query: retrievalQueryUsed,
              docs: docs.length,
              translated_query_applied: bounded.queryTranslationApplied,
            });
          }

          if (RAG_FAST_HOWTO_PATH && !effectiveSimpleSolrMode) {
            const fastStart = Date.now();
            let fastRejectReason = '';
            const fastQuery = searchQuery;
            const fastProfile =
              stage1RelaxProfiles.find((p) => p.step === 'C_RELAX_TAGS') ||
              stage1RelaxProfiles[0];
            const unknownIntentOverride = shouldAllowFastHowToUnknownIntent(queryIntent, fastQuery);
            const fastIntentThreshold = unknownIntentOverride ? 0.5 : RAG_FAST_HOWTO_INTENT_CONF;
            if (!queryIntent.isHowTo) {
              fastRejectReason = 'query_not_howto_style';
            } else if (queryIntent.label === 'UNKNOWN' && !unknownIntentOverride) {
              fastRejectReason = 'intent_unknown';
            } else if (queryIntent.confidence < fastIntentThreshold) {
              fastRejectReason = 'intent_confidence_below_threshold';
            } else if (!fastProfile) {
              fastRejectReason = 'missing_fast_profile';
            } else {
              try {
                const fastResult = await runFastSolrSinglePass(fastQuery, fastProfile);
                logFilterTrace('tier1_fast_query', {
                  intent: queryIntent.label,
                  confidence: Number(queryIntent.confidence.toFixed(3)),
                  unknown_intent_override: unknownIntentOverride,
                  fast_profile_step: fastProfile.step,
                  candidate_file_ids_count: fastProfile.candidateFileIds.length,
                  top_score: Number(fastResult.topScore.toFixed(3)),
                  num_found: fastResult.numFound,
                });
                if (fastResult.docs.length === 0) {
                  fastRejectReason = 'no_hits_in_fast_profile';
                } else {
                  const stage3Fast = applyStage3PostFilter(fastResult.docs, originalQueryText || fastQuery, queryIntent);
                  const fastSignalProbeQuery = [
                    String(originalQueryText || fastQuery || ''),
                    String(fastQuery || ''),
                ].filter(Boolean).join(' ');
                const fastTopTermHits = computeFastHowToTopTermHits(stage3Fast.docs, fastSignalProbeQuery);
                const fastMinTermHits = userLanguage === 'en'
                  ? RAG_FAST_HOWTO_MIN_TERM_HITS_EN
                  : RAG_FAST_HOWTO_MIN_TERM_HITS;
                if (fastTopTermHits < fastMinTermHits) {
                  fastRejectReason = 'top_term_hits_below_threshold';
                  logFilterTrace('tier1_fast_skip_low_signal', {
                    query: String(originalQueryText || '').slice(0, 120),
                      language: userLanguage,
                      top_score: Number(fastResult.topScore.toFixed(3)),
                      top_term_hits: fastTopTermHits,
                      min_term_hits: fastMinTermHits,
                    });
                  } else if (!isFastHowToTopScoreEligible({
                    topScore: fastResult.topScore,
                    topTermHits: fastTopTermHits,
                    language: userLanguage,
                    explicitHowToCue: hasExplicitProcedureCue(
                      buildAnswerStyleProbeText(
                        String(originalQueryText || prompt || ''),
                        String(fastQuery || originalQueryText || ''),
                      ),
                    ),
                  })) {
                    fastRejectReason = 'top_score_below_threshold';
                    logFilterTrace('tier1_fast_skip_low_top_score', {
                      query: String(originalQueryText || '').slice(0, 120),
                      language: userLanguage,
                      top_score: Number(fastResult.topScore.toFixed(3)),
                      top_term_hits: fastTopTermHits,
                      threshold_top_score: RAG_FAST_HOWTO_TOP_SCORE_MIN,
                      threshold_top_score_relaxed: RAG_FAST_HOWTO_TOP_SCORE_MIN_RELAXED,
                    });
                  } else {
                    const extractive = buildExtractiveHowToAnswer(
                      stage3Fast.docs,
                      userLanguage,
                      buildAnswerStyleProbeText(
                        String(originalQueryText || prompt || ''),
                        String(fastQuery || originalQueryText || ''),
                      ),
                    );
                    const detailedEnglish =
                      userLanguage === 'en'
                        ? await buildDetailedEnglishHowToFromJapaneseEvidence({
                          docs: stage3Fast.docs,
                          focusQuery: buildAnswerStyleProbeText(
                            String(originalQueryText || prompt || ''),
                            String(fastQuery || originalQueryText || ''),
                          ),
                          originalQuery: String(originalQueryText || prompt || ''),
                        })
                        : null;
                    const fastAnswerCandidate = extractive &&
                      !isWeakHowToAnswer(extractive.answer, userLanguage) &&
                      (!isInsufficientHowToDetail(extractive.answer, userLanguage) || hasRelaxedFastHowToDetail(extractive.answer, userLanguage))
                      ? extractive
                      : detailedEnglish;
                    if (!fastAnswerCandidate) {
                      fastRejectReason = 'procedural_extraction_or_evidence_failed';
                    } else if (isWeakHowToAnswer(fastAnswerCandidate.answer, userLanguage)) {
                      fastRejectReason = 'weak_howto_answer';
                      logFilterTrace('tier1_fast_skip_weak_answer', {
                        query: String(originalQueryText || '').slice(0, 120),
                        language: userLanguage,
                        top_score: Number(fastResult.topScore.toFixed(3)),
                        top_term_hits: fastTopTermHits,
                      });
                    } else if (
                      isInsufficientHowToDetail(fastAnswerCandidate.answer, userLanguage) &&
                      !hasRelaxedFastHowToDetail(fastAnswerCandidate.answer, userLanguage)
                    ) {
                      fastRejectReason = 'insufficient_howto_detail';
                      logFilterTrace('tier1_fast_skip_insufficient_detail', {
                        query: String(originalQueryText || '').slice(0, 120),
                        language: userLanguage,
                        top_score: Number(fastResult.topScore.toFixed(3)),
                        top_term_hits: fastTopTermHits,
                      });
                    } else {
                      selectedTier = 'tier1';
                      tier1FastPathUsed = true;
                      answerResolvedByFastTier = true;
                      tierLatencyMs = Date.now() - fastStart;
                      docs = stage3Fast.docs;
                      docsForHowToRescue = docs.slice(0, 4);
                      retrievalQueryUsed = fastQuery;
                      bestNumFound = fastResult.numFound;
                      bestTopScore = fastResult.topScore;
                      bestCandidateTermHits = fastTopTermHits;
                      relaxStepUsed = fastProfile;
                      topRelaxStepUsed = String(fastProfile.step || '');
                      finalAnswer = fastAnswerCandidate.answer;
                      content = finalAnswer;
                      kpiMetrics.ragUsed = true;
                      kpiMetrics.ragTime = tierLatencyMs;
                      ragSources.splice(0, ragSources.length, ...fastAnswerCandidate.sources);
                      logFilterTrace('tier1_fast_hit', {
                        relax_step: fastProfile.step,
                        top_score: Number(fastResult.topScore.toFixed(3)),
                        step_count: fastAnswerCandidate.answer.split('\n').filter((line) => /^\d+\./.test(line.trim())).length,
                        source_count: fastAnswerCandidate.sources.length,
                        latency_ms: tierLatencyMs,
                      });
                    }
                  }
                }
              } catch (error) {
                fastRejectReason = `fast_query_error:${(error as any)?.message || error}`;
              }
            }
            if (!tier1FastPathUsed) {
              logFilterTrace('tier1_fast_skip', {
                reason: fastRejectReason || 'not_eligible',
                intent: queryIntent.label,
                confidence: Number(queryIntent.confidence.toFixed(3)),
                unknown_intent_override: unknownIntentOverride,
                threshold_conf: fastIntentThreshold,
                threshold_top_score: RAG_FAST_HOWTO_TOP_SCORE_MIN,
              });
            }
          }

          if (!tier1FastPathUsed && !simpleSolrDone) {
            for (const relaxProfile of stage1RelaxProfiles) {
            const candidateQueries = buildRetrievalCandidates(searchQuery);
            const pushCandidate = (value: string) => {
              const v = String(value || '').trim();
              if (!v) return;
              if (!candidateQueries.includes(v)) candidateQueries.push(v);
            };
            for (const dynamicQuery of multilingualRetrievalQueries) {
              for (const c of buildRetrievalCandidates(dynamicQuery)) {
                pushCandidate(c);
              }
            }

            let stepDocs: any[] = [];
            let stepRetrievalQueryUsed = searchQuery;
            let stepBestNumFound = Number.POSITIVE_INFINITY;
            let stepBestTopScore = Number.NEGATIVE_INFINITY;
            let stepBestCandidateTermHits = Number.NEGATIVE_INFINITY;
            let stepBestCandidateRank = Number.NEGATIVE_INFINITY;

            logFilterTrace('stage1_relax_step_start', {
              step: relaxProfile.step,
              reason: relaxProfile.reason,
              candidate_file_ids_count: relaxProfile.candidateFileIds.length,
              metadata_filter_keys: Object.keys(relaxProfile.metadataFilters || {}),
            });

            const evaluateCandidate = async (candidate: string) => {
              if (candidate !== searchQuery) {
                console.log(`[STEP 2] Solr retry query candidate (${relaxProfile.step}): "${candidate}"`);
              }
              const { docs: candidateDocs, numFound, topScore } = await runSolrSearch(
                candidate,
                relaxProfile,
                candidate === searchQuery ? 'primary' : 'fallback',
              );
              if (candidateDocs.length > 0) {
                const candidateTerms = extractQueryTermsForRerank(candidate);
                const candidateTopTermHits = Math.max(
                  ...candidateDocs.map((doc) => countDocTermHits(doc, candidateTerms)),
                );
                console.log(
                  `[STEP 2] Candidate quality (${relaxProfile.step}): "${candidate}" (topTermHits=${candidateTopTermHits}, topScore=${topScore}, numFound=${numFound})`,
                );
                // Favor strong lexical relevance first; term hits are secondary.
                const candidateRank =
                  (topScore * 10) +
                  (candidateTopTermHits * 2) -
                  Math.log10(Math.max(1, numFound) + 1);
                const shouldReplace =
                  stepDocs.length === 0 ||
                  candidateRank > stepBestCandidateRank ||
                  (candidateRank === stepBestCandidateRank &&
                    (topScore > stepBestTopScore ||
                      (topScore === stepBestTopScore &&
                        (candidateTopTermHits > stepBestCandidateTermHits ||
                          (candidateTopTermHits === stepBestCandidateTermHits && numFound < stepBestNumFound)))));
                if (shouldReplace) {
                  stepDocs = candidateDocs;
                  stepRetrievalQueryUsed = candidate;
                  stepBestNumFound = numFound;
                  stepBestTopScore = topScore;
                  stepBestCandidateTermHits = candidateTopTermHits;
                  stepBestCandidateRank = candidateRank;
                }
              }
            };

            for (const candidate of candidateQueries) {
              await evaluateCandidate(candidate);
            }

            const weakLexicalSelection =
              stepDocs.length > 0 &&
              userLanguage === 'en' &&
              (stepBestCandidateTermHits <= 0 ||
                (stepBestCandidateTermHits <= 1 && stepBestTopScore < Math.max(10, RAG_RELEVANCE_MIN_SCORE + 3)));

            if (shouldTryTranslatedCandidates && (weakLexicalSelection || stepDocs.length <= 0)) {
              if (weakLexicalSelection) {
                console.log(
                  `[STEP 2] Weak EN lexical hit (${relaxProfile.step}); trying translated retrieval candidates.`,
                );
              }
              if (!translatedAttempted) {
                translatedAttempted = true;
                const targetLang: LanguageCode = userLanguage === 'en' ? 'ja' : 'en';
                const translationStart = Date.now();
                kpiMetrics.translateCallsCount += 1;
                translatedQuery = await translateQueryTextForRetrieval(searchQuery, targetLang);
                const translationElapsed = Date.now() - translationStart;
                kpiMetrics.translateMs += translationElapsed;
                kpiMetrics.queryTranslationTime += translationElapsed;
                if (translatedQuery && translatedQuery.toLowerCase() !== searchQuery.toLowerCase()) {
                } else {
                  translatedQuery = '';
                  console.log('[STEP 2] Query translation unavailable/unchanged; keeping original lexical selection.');
                }
              }
              if (translatedQuery) {
                const prevCount = candidateQueries.length;
                for (const c of buildRetrievalCandidates(translatedQuery)) {
                  pushCandidate(c);
                }
                const newlyAdded = candidateQueries.slice(prevCount);
                for (const candidate of newlyAdded) {
                  await evaluateCandidate(candidate);
                }
              }
            }

            if (stepDocs.length > 0) {
              docs = stepDocs;
              retrievalQueryUsed = stepRetrievalQueryUsed;
              bestNumFound = stepBestNumFound;
              bestTopScore = stepBestTopScore;
              bestCandidateTermHits = stepBestCandidateTermHits;
              bestCandidateRank = stepBestCandidateRank;
              relaxStepUsed = relaxProfile;
              topRelaxStepUsed = String(relaxProfile.step || '');
              logFilterTrace('stage1_relax_step_result', {
                step: relaxProfile.step,
                status: 'hit',
                reason: relaxProfile.reason,
                selected_query: stepRetrievalQueryUsed,
                top_score: Number(stepBestTopScore.toFixed(3)),
                top_term_hits: stepBestCandidateTermHits,
                candidate_file_ids_count: relaxProfile.candidateFileIds.length,
              });
              break;
            }

            logFilterTrace('stage1_relax_step_result', {
              step: relaxProfile.step,
              status: 'no_hit',
              reason: relaxProfile.reason,
              candidate_file_ids_count: relaxProfile.candidateFileIds.length,
            });
          }
          }

          if (!tier1FastPathUsed) {
            console.log(
              `[STEP 2] Selected candidate query: "${retrievalQueryUsed}" (bestTopTermHits=${bestCandidateTermHits}, bestTopScore=${bestTopScore}, bestNumFound=${bestNumFound}, relaxStep=${relaxStepUsed?.step})`,
            );

            if (docs.length > 0 && translatedQuery && retrievalQueryUsed !== searchQuery && userLanguage === 'en') {
              queryForRAG = retrievalQueryUsed;
              queryTranslationApplied = true;
            }

            if (docs.length > 0) {
              const rerankStart = Date.now();
              const rerankTerms = extractQueryTermsForRerank(retrievalQueryUsed);
              let reranked = docs
                .map((doc) => ({
                  doc,
                  score: Number(doc?.score || 0),
                  termHits: countDocTermHits(doc, rerankTerms),
                }))
                .sort((a, b) => (b.score - a.score) || (b.termHits - a.termHits));

              if (isSuperAdmin && ALLOW_SUPERADMIN_CROSS_DEPT && AUTO_ROUTE_DEPARTMENT) {
                const topDepartment = String(reranked?.[0]?.doc?.department_code_s || '').toUpperCase();
                if (topDepartment === 'HR' || topDepartment === 'GA' || topDepartment === 'ACC' || topDepartment === 'OTHER') {
                  const sameDept = reranked.filter(
                    (row) => String(row?.doc?.department_code_s || '').toUpperCase() === topDepartment,
                  );
                  if (sameDept.length > 0) {
                    console.log(
                      `[STEP 2] Department routing: selected ${topDepartment} from top hit; restricting context to ${sameDept.length} doc(s) in same department.`,
                    );
                    reranked = sameDept;
                  }
                }
              }

              // Keep only high-signal docs to avoid polluting context with weak matches.
              if (reranked.length > 1) {
                const topScoreRef = Number(reranked?.[0]?.score || 0);
                const minKeepScore = Math.max(2, topScoreRef * 0.22);
                const narrowed = reranked.filter((row) =>
                  Number(row?.score || 0) >= minKeepScore || Number(row?.termHits || 0) >= 2);
                if (narrowed.length > 0 && narrowed.length < reranked.length) {
                  console.log(
                    `[STEP 2] Context narrowing: kept ${narrowed.length}/${reranked.length} doc(s) (minScore=${minKeepScore.toFixed(3)}).`,
                  );
                  reranked = narrowed;
                }
              }

              docs = reranked.map((row) => row.doc);
              const rerankPreview = reranked
                .slice(0, 3)
                .map((row) => {
                  const title = Array.isArray(row.doc?.title) ? row.doc.title[0] : row.doc?.title;
                  return `${String(title || row.doc?.id || 'unknown')}(hits=${row.termHits},score=${row.score.toFixed(3)})`;
                })
                .join(' | ');
              if (rerankPreview) {
                console.log(`[STEP 2] Post-rerank top hits: ${rerankPreview}`);
              }
              const bestTermHits = Number(reranked?.[0]?.termHits || 0);
              const bestLexScore = Number(reranked?.[0]?.score || 0);
              const relevanceFloor = hasJapaneseChars(retrievalQueryUsed)
                ? Math.max(2, RAG_RELEVANCE_MIN_SCORE - 4)
                : RAG_RELEVANCE_MIN_SCORE;
              const originalQueryTerms = extractQueryTermsForRerank(searchQuery)
                .filter((t) => !hasJapaneseChars(t) && t.length >= 4)
                .slice(0, 6)
                .map((t) => t.toLowerCase());
              const titleOrNameOverlap = reranked.slice(0, 3).some((row) => {
                const d = row?.doc || {};
                const title = Array.isArray(d?.title) ? String(d.title[0] || '') : String(d?.title || '');
                const fileName = String(d?.file_name_s || d?.id || '');
                const hay = `${title} ${fileName}`.toLowerCase();
                return originalQueryTerms.some((term) => hay.includes(term));
              });
              if (bestTermHits <= 0 && bestLexScore < relevanceFloor && !titleOrNameOverlap) {
                console.log('[STEP 2] Relevance gate: top docs have zero query-term overlap; ignoring lexical hits.');
                docs = [];
              } else if (bestLexScore < Math.max(1.2, relevanceFloor * 0.25) && !titleOrNameOverlap) {
                console.log(
                  `[STEP 2] Relevance gate: top score too weak (score=${bestLexScore}) without title overlap; ignoring lexical hits.`,
                );
                docs = [];
              } else if (bestTermHits <= 0) {
                console.log(
                  `[STEP 2] Relevance gate bypassed: termHits=0 with lexical/title overlap signal (score=${bestLexScore}, overlap=${titleOrNameOverlap}).`,
                );
              }

              if (docs.length > 0) {
                logFilterTrace('stage3_before', {
                  relax_step: relaxStepUsed?.step,
                  top_sources: docs.slice(0, 5).map((doc) => summarizeDocForTrace(doc)),
                });
                const stage3 = applyStage3PostFilter(docs, originalQueryText || retrievalQueryUsed, queryIntent);
                if (stage3.docs.length !== docs.length) {
                  console.log(
                    `[STEP 2] Stage-3 post-filter removed ${docs.length - stage3.docs.length} low-relevance document(s).`,
                  );
                }
                docs = stage3.docs;
                logFilterTrace('stage3_after', {
                  relax_step: relaxStepUsed?.step,
                  top_sources: docs.slice(0, 5).map((doc) => summarizeDocForTrace(doc)),
                  dropped: stage3.dropped.slice(0, 12),
                });
              }
              kpiMetrics.rerankMs += Date.now() - rerankStart;
            }

            // Fallback to semantic retrieval backend when Solr has no lexical hits.
            // Keep this enabled even in simple Solr mode so EN queries can still retrieve JP docs.
            let semanticBackendQueried = false;
            if (!docs.length) {
              semanticBackendQueried = true;
              console.log('[STEP 2] Solr returned no docs; trying RAG backend semantic search...');
              for (const relaxProfile of stage1RelaxProfiles) {
                const backendSearchOptions = {
                  candidateFileIds: relaxProfile.candidateFileIds.length
                    ? relaxProfile.candidateFileIds.slice(0, RAG_STAGE1_EXPANDED_FILE_IDS)
                    : undefined,
                  metadataFilters: relaxProfile.metadataFilters,
                };
                logFilterTrace('backend_relax_step_start', {
                  step: relaxProfile.step,
                  reason: relaxProfile.reason,
                  candidate_file_ids_count: relaxProfile.candidateFileIds.length,
                  metadata_filter_keys: Object.keys(relaxProfile.metadataFilters || {}),
                });
                let bestBackendDocs: RagBackendDoc[] = [];
                let bestBackendQuery = '';
                let bestBackendRank = Number.NEGATIVE_INFINITY;
                let bestBackendTopHits = Number.NEGATIVE_INFINITY;

                const evaluateBackendQuery = async (candidateQuery: string) => {
                  const q = String(candidateQuery || '').trim();
                  if (!q) return;
                  const candidateDocs = await fetchRagBackendDocs(q, backendSearchOptions);
                  if (!candidateDocs.length) return;
                  const terms = extractQueryTermsForRerank(q);
                  const topHits = Math.max(
                    ...candidateDocs.map((doc) => countDocTermHits(doc, terms)),
                    0,
                  );
                  const avgHits =
                    candidateDocs.slice(0, 3).reduce((sum, doc) => sum + countDocTermHits(doc, terms), 0) /
                    Math.max(1, Math.min(candidateDocs.length, 3));
                  const topSemanticScore = Math.max(...candidateDocs.map((doc) => Number(doc?.semantic_score || 0)), 0);
                  const avgSemanticScore =
                    candidateDocs.slice(0, 3).reduce((sum, doc) => sum + Number(doc?.semantic_score || 0), 0) /
                    Math.max(1, Math.min(candidateDocs.length, 3));
                  const untranslatedCrossLanguageCandidate =
                    userLanguage === 'en' &&
                    !translatedQuery &&
                    !hasJapaneseChars(searchQuery) &&
                    hasJapaneseChars(q);
                  const effectiveTopHits = untranslatedCrossLanguageCandidate ? 0 : topHits;
                  const effectiveAvgHits = untranslatedCrossLanguageCandidate ? 0 : avgHits;
                  const rank =
                    (effectiveTopHits * 12) +
                    (effectiveAvgHits * 2) +
                    (topSemanticScore * 3) +
                    (avgSemanticScore * 2) +
                    Math.min(3, candidateDocs.length) * 0.1;
                  const shouldReplace =
                    bestBackendDocs.length === 0 ||
                    rank > bestBackendRank ||
                    (rank === bestBackendRank && effectiveTopHits > bestBackendTopHits);
                  if (shouldReplace) {
                    bestBackendDocs = candidateDocs;
                    bestBackendQuery = q;
                    bestBackendRank = rank;
                    bestBackendTopHits = effectiveTopHits;
                  }
                };

                const primaryBackendCandidates = buildRetrievalCandidates(searchQuery);
                for (const candidateQuery of primaryBackendCandidates) {
                  await evaluateBackendQuery(candidateQuery);
                }

                const needsTranslationExpansion =
                  userLanguage === 'en' &&
                  retrievalIndexLanguage !== 'en' &&
                  (!bestBackendDocs.length || bestBackendTopHits <= 0);

                if (needsTranslationExpansion && !translatedAttempted) {
                  translatedAttempted = true;
                  const translationStart = Date.now();
                  kpiMetrics.translateCallsCount += 1;
                  translatedQuery = await translateQueryTextForRetrieval(searchQuery, 'ja');
                  if (!translatedQuery) {
                    const rawQuery = String(originalQueryText || '').trim();
                    if (rawQuery && rawQuery.toLowerCase() !== searchQuery.toLowerCase()) {
                      kpiMetrics.translateCallsCount += 1;
                      const rawTranslated = await translateQueryTextForRetrieval(rawQuery, 'ja');
                      if (rawTranslated && rawTranslated.toLowerCase() !== rawQuery.toLowerCase()) {
                        translatedQuery = canonicalizeQuery(rawTranslated) || rawTranslated;
                      }
                    }
                  }
                  const translationElapsed = Date.now() - translationStart;
                  kpiMetrics.translateMs += translationElapsed;
                  kpiMetrics.queryTranslationTime += translationElapsed;
                  if (translatedQuery && translatedQuery.toLowerCase() !== searchQuery.toLowerCase()) {
                    console.log(`[STEP 2] Semantic fallback translated query: "${translatedQuery}"`);
                  } else {
                    translatedQuery = '';
                  }
                }

                if (translatedQuery) {
                  const translatedBackendCandidates = buildRetrievalCandidates(translatedQuery);
                  for (const candidateQuery of translatedBackendCandidates) {
                    await evaluateBackendQuery(candidateQuery);
                  }
                }

                const bestSemanticTopScoreBeforeSurrogate =
                  bestBackendDocs.length > 0
                    ? Math.max(...bestBackendDocs.map((doc) => Number(doc?.semantic_score || 0)), 0)
                    : 0;
                const bestCohesionBeforeSurrogate =
                  bestBackendDocs.length > 0 ? computeSemanticDocCohesion(bestBackendDocs) : 0;
                const shouldTrySurrogateExpansion =
                  RAG_ENABLE_SURROGATE_QUERY &&
                  userLanguage === 'en' &&
                  retrievalIndexLanguage !== 'en' &&
                  !translatedQuery &&
                  bestBackendDocs.length > 0 &&
                  Number(bestBackendTopHits || 0) <= 0 &&
                  (bestCohesionBeforeSurrogate < 3 || bestSemanticTopScoreBeforeSurrogate < 0.45);

                if (shouldTrySurrogateExpansion) {
                  const surrogateQuery = buildSemanticSurrogateQuery(bestBackendDocs);
                  if (surrogateQuery && surrogateQuery !== bestBackendQuery) {
                    console.log(`[STEP 2] Semantic fallback surrogate JP query: "${surrogateQuery}"`);
                    for (const candidateQuery of buildRetrievalCandidates(surrogateQuery)) {
                      await evaluateBackendQuery(candidateQuery);
                    }
                  }
                }

                if (bestBackendDocs.length > 0) {
                  const usesJapaneseBackendQuery =
                    hasJapaneseChars(bestBackendQuery || '') &&
                    (bestBackendQuery || '') !== searchQuery;
                  const translatedSelectionPreview = usesJapaneseBackendQuery;
                  const semanticCohesionScore = computeSemanticDocCohesion(bestBackendDocs);
                  const lowSignalCrossLanguageHit =
                    userLanguage === 'en' &&
                    retrievalIndexLanguage !== 'en' &&
                    !translatedSelectionPreview &&
                    Number(bestBackendTopHits || 0) <= 0 &&
                    semanticCohesionScore < 3;
                  if (lowSignalCrossLanguageHit) {
                    logFilterTrace('backend_relax_step_result', {
                      step: relaxProfile.step,
                      status: 'no_hit',
                      reason: 'low_signal_without_translated_query',
                      source_query: bestBackendQuery || searchQuery,
                      result_count: bestBackendDocs.length,
                      top_term_hits: Number(bestBackendTopHits || 0),
                      cohesion_score: Number(semanticCohesionScore.toFixed(3)),
                    });
                    continue;
                  }

                  docs = bestBackendDocs;
                  retrievalQueryUsed = bestBackendQuery || searchQuery;
                  if (usesJapaneseBackendQuery) {
                    queryForRAG = translatedQuery || retrievalQueryUsed;
                    queryTranslationApplied = true;
                  }
                  relaxStepUsed = relaxProfile;
                  topRelaxStepUsed = String(relaxProfile.step || '');
                  if (usesJapaneseBackendQuery) {
                    console.log(
                      `[STEP 2] RAG backend (JP expansion query) returned ${bestBackendDocs.length} document(s) [${relaxProfile.step}]`,
                    );
                  } else {
                    console.log(`[STEP 2] RAG backend returned ${bestBackendDocs.length} document(s) [${relaxProfile.step}]`);
                  }
                  logFilterTrace('backend_relax_step_result', {
                    step: relaxProfile.step,
                    status: 'hit',
                    source_query: retrievalQueryUsed,
                    result_count: bestBackendDocs.length,
                    top_term_hits: Number(bestBackendTopHits || 0),
                    cohesion_score: Number(semanticCohesionScore.toFixed(3)),
                  });
                  break;
                }

                logFilterTrace('backend_relax_step_result', {
                  step: relaxProfile.step,
                  status: 'no_hit',
                  reason: relaxProfile.reason,
                });
              }
            }

            if (docs.length > 0 && semanticBackendQueried) {
              const semanticRerankStart = Date.now();
              const rerankTerms = extractQueryTermsForRerank(retrievalQueryUsed || searchQuery);
              let semanticReranked = docs
                .map((doc) => ({
                  doc,
                  score: Number(doc?.score || 0),
                  semanticScore: Number(doc?.semantic_score || 0),
                  termHits: countDocTermHits(doc, rerankTerms),
                }))
                .sort((a, b) =>
                  (b.termHits - a.termHits) ||
                  (b.semanticScore - a.semanticScore) ||
                  (b.score - a.score),
                );

              if (semanticReranked.length > 1) {
                const topSemanticScore = Number(semanticReranked?.[0]?.semanticScore || 0);
                const minKeepSemantic = Math.max(0.03, topSemanticScore * 0.35);
                const narrowed = semanticReranked.filter((row) =>
                  Number(row?.termHits || 0) >= 1 || Number(row?.semanticScore || 0) >= minKeepSemantic);
                if (narrowed.length > 0 && narrowed.length < semanticReranked.length) {
                  console.log(
                    `[STEP 2] Semantic narrowing: kept ${narrowed.length}/${semanticReranked.length} doc(s) (minSemantic=${minKeepSemantic.toFixed(3)}).`,
                  );
                  semanticReranked = narrowed;
                }
              }

              if (semanticReranked.length > 3) {
                const perSourceCap = Math.max(1, Number(process.env.RAG_SEMANTIC_MAX_DOCS_PER_SOURCE || 1));
                const counts = new Map<string, number>();
                const diversified: typeof semanticReranked = [];
                for (const row of semanticReranked) {
                  const key = String(
                    (Array.isArray(row?.doc?.title) ? row.doc.title[0] : row?.doc?.title) ||
                    row?.doc?.file_name_s ||
                    row?.doc?.id ||
                    '',
                  ).trim();
                  const sourceKey = key || String(row?.doc?.id || '');
                  const used = Number(counts.get(sourceKey) || 0);
                  if (used >= perSourceCap) continue;
                  counts.set(sourceKey, used + 1);
                  diversified.push(row);
                }
                if (diversified.length >= 2 && diversified.length < semanticReranked.length) {
                  console.log(
                    `[STEP 2] Semantic diversity: kept ${diversified.length}/${semanticReranked.length} doc(s) (max ${perSourceCap} per source).`,
                  );
                  semanticReranked = diversified;
                }
              }

              const topSemanticPreview = semanticReranked
                .slice(0, 3)
                .map((row) => {
                  const title = Array.isArray(row.doc?.title) ? row.doc.title[0] : row.doc?.title;
                  return `${String(title || row.doc?.id || 'unknown')}(hits=${row.termHits},semantic=${row.semanticScore.toFixed(3)})`;
                })
                .join(' | ');
              if (topSemanticPreview) {
                console.log(`[STEP 2] Semantic post-rerank top hits: ${topSemanticPreview}`);
              }

              docs = semanticReranked.map((row) => row.doc);
              logFilterTrace('stage3_before', {
                relax_step: relaxStepUsed?.step,
                top_sources: docs.slice(0, 5).map((doc) => summarizeDocForTrace(doc)),
              });
              const stage3 = applyStage3PostFilter(docs, originalQueryText || retrievalQueryUsed, queryIntent);
              if (stage3.docs.length !== docs.length) {
                console.log(
                  `[STEP 2] Stage-3 post-filter removed ${docs.length - stage3.docs.length} low-relevance semantic document(s).`,
                );
              }
              docs = stage3.docs;
              logFilterTrace('stage3_after', {
                relax_step: relaxStepUsed?.step,
                top_sources: docs.slice(0, 5).map((doc) => summarizeDocForTrace(doc)),
                dropped: stage3.dropped.slice(0, 12),
              });
              kpiMetrics.rerankMs += Date.now() - semanticRerankStart;
            }

            // Mode-aware fallback (splitByPage / splitByArticle) without hardcoded collections.
            const shouldRunModeAwareFallback =
              !effectiveSimpleSolrMode && !!ragProcessor && mode !== 'splitByArticleWithHybridSearch';
            if (!docs.length && shouldRunModeAwareFallback) {
              console.log(`[STEP 2] No docs yet; trying mode-aware ragProcessor.search (mode=${mode})...`);
              try {
                const ragPrompt = String(await ragProcessor.search(searchQuery) || '').trim();
                if (ragPromptHasEvidence(ragPrompt)) {
                  prompt = ragPrompt;
                  kpiMetrics.ragUsed = true;
                  console.log(`[STEP 2] ragProcessor.search provided evidence-backed context (len=${ragPrompt.length}).`);
                } else {
                  console.log('[STEP 2] ragProcessor.search returned no evidence block.');
                }
              } catch (e: any) {
                console.warn('[STEP 2] ragProcessor.search failed:', e?.message || e);
              }
            } else if (!docs.length && ragProcessor) {
              const skipReason = semanticBackendQueried
                ? 'semantic fallback already queried RAG backend'
                : effectiveSimpleSolrMode
                  ? 'simple Solr mode is active'
                  : `mode (${mode}) is excluded`;
              console.log(
                `[STEP 2] Skipping mode-aware ragProcessor.search for ${mode} because ${skipReason}.`,
              );
            }

            if (docs.length > 0) {
              docsForHowToRescue = docs.slice(0, 6);
              const maxChunks = Math.max(1, RAG_MAX_CONTEXT_CHUNKS);
              const contextBudgetChars = Math.max(800, RAG_MAX_CONTEXT_TOKENS * RAG_CONTEXT_CHARS_PER_TOKEN);
              const useOriginalQueryForContext =
                userLanguage === 'en' &&
                queryTranslationApplied &&
                !translatedQuery &&
                hasJapaneseChars(retrievalQueryUsed);
              const contextRetrievalQuery = useOriginalQueryForContext
                ? String(canonicalQuery || searchQuery || originalQueryText || retrievalQueryUsed)
                : retrievalQueryUsed;
              if (useOriginalQueryForContext) {
                console.log('[STEP 2] Using original English query for context snippet anchoring (surrogate JP query detected).');
              }
              const builtContext = buildContextFromDocs({
                docs,
                retrievalQuery: contextRetrievalQuery,
                maxChunks,
                contextBudgetChars,
                docContextChars: DOC_CONTEXT_CHARS,
              });
              for (const detail of builtContext.details) {
                console.log(`[STEP 2] Added document: ${detail.docId}, content length: ${detail.contentLength}`);
              }
              ragSources.push(...builtContext.sources);

              if (builtContext.usedChunks > 0) {
                prompt = `USER QUESTION:\n${originalQueryText || prompt}\n\nDOCUMENT CONTEXT:\n${builtContext.documentContent}`;
                kpiMetrics.ragUsed = true;
                console.log(
                  `[STEP 2] RAG content prepared: chunks=${builtContext.usedChunks}/${maxChunks}, chars=${builtContext.usedChars}/${contextBudgetChars}, totalPromptLen=${prompt.length}`,
                );
              } else {
                docsForHowToRescue = [];
                console.log('[STEP 2] Retrieved docs were duplicate/empty after context limits; skipping RAG context.');
                prompt = originalQueryText || prompt;
              }
            } else {
              docsForHowToRescue = [];
              console.log(`[STEP 2] No documents found, continuing without RAG context`);
              prompt = originalQueryText || prompt;
            }
          } else {
            console.log('[STEP 2] Tier1 fast path selected; skipping full retrieval ladder and context assembly.');
          }
        } catch (solrError) {
          console.error(`[STEP 2] Solr search error:`, solrError);
          prompt = originalQueryText || prompt;
        }
        kpiMetrics.ragTime = Date.now() - ragStartTime;
        console.log(`[STEP 2] RAG search completed in ${kpiMetrics.ragTime}ms`);

        [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
        if (curOutput.status === 'CANCEL') {
          console.log(`[STEP 2] Output cancelled after RAG search`);
          return { outputId, isOk: false, content: '' };
        }
      } catch (e) {
        console.error(`[STEP 2] RAG search outer error:`, e);
        content = '';
        isOk = false;
      }
    } else if (!useRAGForQuery) {
      console.log(`\n[STEP 2] Skipping RAG (No files uploaded - using LLM only)`);
    } else {
      console.log(`\n[STEP 2] Skipping retrieval because ${selectedTier} already resolved response.`);
    }

    const noInternalEvidence = useRAGForQuery && !kpiMetrics.ragUsed;
    
    // Step 3: Generate answer with LLM in the user's language (grounded to JP docs when available)
    if (answerResolvedByFastTier) {
      finalAnswer = finalAnswer || content;
      content = content || finalAnswer;
      console.log(`[STEP 3] Skipping LLM generation (${selectedTier}).`);
    } else if (noInternalEvidence) {
      finalAnswer = noEvidenceReply(userLanguage);
      content = finalAnswer;
      console.log('[STEP 3] Skipping generic LLM answer because no internal evidence was found.');
    } else if (isOk) {
      console.log(`\n[STEP 3] LLM Generation`);
      const hasRetrievedContext = kpiMetrics.ragUsed && /(?:RETRIEVED\s+)?DOCUMENT CONTEXT:/i.test(String(prompt || ''));
      const systemMessageContent = buildEnterpriseRagSystemPrompt(userLanguage, hasRetrievedContext);
      const systemMessage = { role: 'system', content: systemMessageContent };
      const messagesWithSystem = [systemMessage, ...messages, { role: 'user', content: prompt }];
      const inputText = messagesWithSystem.map(m => m.content).join(' ');
      kpiMetrics.inputTokens = Math.ceil(inputText.length / 4);

      [curOutput] = await queryList(KrdGenTaskOutput, { id: { [Op.eq]: outputId } });
      if (curOutput.status === 'CANCEL') {
        console.log(`[STEP 3] Output cancelled before LLM generation`);
        return { outputId, isOk: false, content: '' };
      }

      if (RAG_TIER2_PROGRESS_PREFACE && outputId && selectedTier === 'tier2') {
        const preface = userLanguage === 'ja'
          ? '確認中です。社内文書を参照して回答を作成しています。'
          : 'Working on it. Checking internal documents now.';
        await put<IGenTaskOutputSer>(
          KrdGenTaskOutput,
          { id: outputId },
          {
            content: preface,
            status: 'PROCESSING',
            update_by: 'JOB',
          },
        ).catch((e) => console.warn('[STEP 3] Failed to write preface:', (e as any)?.message || e));
      }

      const llmStartTime = Date.now();
      console.log(`[STEP 3] Calling LLM to generate response...`);
      let llmAnswer = await generateWithLLM(messagesWithSystem, outputId, CHAT_MAX_PREDICT);
      kpiMetrics.llmTime = Date.now() - llmStartTime;
      kpiMetrics.outputTokens = Math.ceil(llmAnswer.length / 4);

      // Clean up LLM answer - remove all markdown formatting and markers
      llmAnswer = llmAnswer
        .replace(/\*+(English|日本語|Japanese|Translation)\*+\s*:?\s*\n?/gi, '')
        .replace(/\[(English|Japanese)\]\s*:?\s*\n?/gi, '')
        .replace(/^(English|Japanese|Translation)[\s:]*\n?/gmi, '')
        .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/^#+\s+/gm, '')
        .replace(/\n\n\n+/g, '\n\n')
        .trim();

      const tryHowToExtractiveRescue = (reason: string): FastHowToAnswer | null => {
        if (!queryIntent.isHowTo) return null;
        if (!kpiMetrics.ragUsed) return null;
        if (!Array.isArray(docsForHowToRescue) || docsForHowToRescue.length === 0) return null;
        const focusQuery = String(queryForRAG || canonicalQuery || originalQueryText || '');
        const styleProbeQuery = buildAnswerStyleProbeText(
          String(originalQueryText || prompt || ''),
          focusQuery,
        );
        const useProcedureStyle = hasExplicitProcedureCue(styleProbeQuery);
        if (!useProcedureStyle) return null;
        const resolved = buildExtractiveHowToAnswer(
          docsForHowToRescue,
          userLanguage,
          styleProbeQuery || focusQuery,
        );
        if (!resolved) return null;
        if (isWeakHowToAnswer(resolved.answer, userLanguage)) return null;
        logFilterTrace('howto_extractive_rescue', {
          reason,
          language: userLanguage,
          style: 'procedure',
          intent: queryIntent.label,
          confidence: Number(queryIntent.confidence.toFixed(3)),
          source_count: resolved.sources.length,
        });
        return resolved;
      };

      const tryGenericExtractiveRescue = (reason: string): FastHowToAnswer | null => {
        if (!kpiMetrics.ragUsed) return null;
        if (!Array.isArray(docsForHowToRescue) || docsForHowToRescue.length === 0) return null;
        if (hasStructuredPolicyArticles(docsForHowToRescue)) {
          logFilterTrace('generic_extractive_rescue_skipped_structured_policy', {
            reason,
            language: userLanguage,
            query: String(originalQueryText || '').slice(0, 120),
          });
          return null;
        }
        const extractive = buildExtractiveContextAnswer(
          docsForHowToRescue,
          userLanguage,
          String(queryForRAG || canonicalQuery || originalQueryText || ''),
        );
        if (!extractive) return null;
        logFilterTrace('generic_extractive_rescue', {
          reason,
          language: userLanguage,
          source_count: extractive.sources.length,
        });
        return extractive;
      };

      let translationAppliedToFinalAnswer = false;
      if (!llmAnswer) {
        markEmptyLlmResponseFallback('legacy_llm_answer_empty');
        const rescue =
          tryHowToExtractiveRescue('empty_llm_answer') ||
          tryGenericExtractiveRescue('empty_llm_answer');
        if (rescue) {
          finalAnswer = rescue.answer;
          content = finalAnswer;
          ragSources.splice(0, ragSources.length, ...rescue.sources);
        } else {
          console.warn('[STEP 3] LLM returned empty output after fallback; using controlled failure reply.');
          finalAnswer = generationFailureReply(userLanguage);
          content = finalAnswer;
        }
      } else {
        // Final language guardrail: translate only if model output language mismatches.
        const answerLanguage = detectRagLanguage(llmAnswer);
        const hasJapaneseInEnglishOutput =
          userLanguage === 'en' && japaneseCharRatio(llmAnswer) >= 0.12;
        const skipFinalTranslation = userLanguage === 'en' && looksMostlyEnglish(llmAnswer) && !hasJapaneseInEnglishOutput;
        if ((answerLanguage !== userLanguage || hasJapaneseInEnglishOutput) && !skipFinalTranslation) {
          try {
            const translationStart = Date.now();
            const targetLang: LanguageCode = userLanguage;
            const effectiveFinalTranslationTimeoutMs =
              targetLang === 'en'
                ? Math.max(1200, Math.min(3000, FINAL_TRANSLATION_TIMEOUT_MS))
                : FINAL_TRANSLATION_TIMEOUT_MS;
            const translated = await translateText(
              llmAnswer,
              targetLang,
              true,
              0,
              effectiveFinalTranslationTimeoutMs,
            );
            kpiMetrics.translationTime += Date.now() - translationStart;
            const translatedText = String(translated || '').trim();
            if (translatedText && translatedText !== String(llmAnswer || '').trim()) {
              finalAnswer = translatedText;
              content = translatedText;
              translationAppliedToFinalAnswer = true;
              console.log(`[STEP 3] Final answer translated to ${userLanguage}`);
            } else {
              finalAnswer = llmAnswer;
              content = llmAnswer;
              translationAppliedToFinalAnswer = false;
              console.log(`[STEP 3] Translation returned unchanged/empty content; using original model output.`);
            }
          } catch (e) {
            console.warn('[STEP 3] Final language translation failed, using raw model answer:', e);
            finalAnswer = llmAnswer;
            content = llmAnswer;
          }
        } else {
          if (skipFinalTranslation) {
            console.log('[STEP 3] Skipping final translation because answer is already mostly English.');
          }
          finalAnswer = llmAnswer;
          content = llmAnswer;
        }
      }

      if (queryIntent.isHowTo && isWeakHowToAnswer(finalAnswer, userLanguage)) {
        const rescue = tryHowToExtractiveRescue('weak_howto_answer');
        if (rescue) {
          finalAnswer = rescue.answer;
          content = finalAnswer;
          ragSources.splice(0, ragSources.length, ...rescue.sources);
        }
      }

      if (!queryIntent.isHowTo && isWeakGeneralAnswer(finalAnswer, userLanguage)) {
        const rescue = tryGenericExtractiveRescue('weak_general_answer');
        if (rescue) {
          finalAnswer = rescue.answer;
          content = finalAnswer;
          ragSources.splice(0, ragSources.length, ...rescue.sources);
        }
      }

      if (
        isCannotConfirmStyleAnswer(finalAnswer) &&
        kpiMetrics.ragUsed &&
        /DOCUMENT CONTEXT:/i.test(String(prompt || ''))
      ) {
        const recoveryStart = Date.now();
        const recovered = await buildEvidenceRecoveryAnswer({
          qaPrompt: String(prompt || ''),
          language: userLanguage,
          recoveryBudget,
        });
        kpiMetrics.llmTime += Date.now() - recoveryStart;
        if (recovered && !isCannotConfirmStyleAnswer(recovered)) {
          finalAnswer = recovered;
          content = finalAnswer;
          console.log('[STEP 3] Evidence recovery generated a grounded answer from retrieved context.');
        }
      }

      if (isCannotConfirmStyleAnswer(finalAnswer)) {
        finalAnswer = noEvidenceReply(userLanguage);
        content = finalAnswer;
      }
      if (kpiMetrics.ragUsed && isGenerationFailureStyleAnswer(finalAnswer)) {
        markEmptyLlmResponseFallback('legacy_generation_failure_style');
      }

      if (
        userLanguage === 'en' &&
        kpiMetrics.ragUsed &&
        /DOCUMENT CONTEXT:/i.test(String(prompt || '')) &&
        !isCannotConfirmStyleAnswer(finalAnswer)
      ) {
        const overlapQuery = String(canonicalQuery || queryForRAG || originalQueryText || '').trim();
        const overlapHits = countAnswerQueryOverlap(finalAnswer, overlapQuery);
        if (overlapQuery && overlapHits <= 0) {
          const overlapRecoveryStart = Date.now();
          const recovered = await buildEvidenceRecoveryAnswer({
            qaPrompt: String(prompt || ''),
            language: userLanguage,
            recoveryBudget,
          });
          kpiMetrics.llmTime += Date.now() - overlapRecoveryStart;
          const recoveredHits = countAnswerQueryOverlap(recovered, overlapQuery);
          if (recovered && recoveredHits > overlapHits) {
            finalAnswer = recovered;
            content = finalAnswer;
            console.log(
              `[STEP 3] Regenerated low-overlap answer from context (queryOverlap ${overlapHits} -> ${recoveredHits}).`,
            );
          }
        }
      }

      if (kpiMetrics.ragUsed && /DOCUMENT CONTEXT:/i.test(String(prompt || ''))) {
        const recovered = await recoverTruncatedAnswerFromContext({
          answer: finalAnswer,
          qaPrompt: String(prompt || ''),
          language: userLanguage,
          recoveryBudget,
        });
        if (recovered.latencyMs > 0) {
          kpiMetrics.llmTime += recovered.latencyMs;
        }
        if (recovered.recovered) {
          finalAnswer = recovered.answer;
          content = finalAnswer;
          console.log('[STEP 3] Recovered truncated answer from retrieved context.');
        } else {
          finalAnswer = recovered.answer;
          content = finalAnswer;
        }
      }

      finalAnswer = stripDraftReasoningLeak(finalAnswer);
      finalAnswer = trimIncompleteTail(finalAnswer);
      finalAnswer = trimDanglingBodyBeforeSources(finalAnswer);
      content = finalAnswer;

      if (userLanguage === 'en') {
        finalAnswer = sanitizeEnglishBodyText(finalAnswer);
        if (RAG_REPAIR_COLLAPSED_ENGLISH && looksCollapsedEnglishAnswer(finalAnswer)) {
          const repairStart = Date.now();
          const repaired = await repairCollapsedEnglishAnswer(finalAnswer);
          kpiMetrics.llmTime += Date.now() - repairStart;
          if (repaired) {
            finalAnswer = repaired;
          }
        }
        content = finalAnswer;
      }

      if (kpiMetrics.ragUsed && queryIntent.isHowTo && isInsufficientHowToDetail(finalAnswer, userLanguage)) {
        let detailRecovered = false;
        const focusQuery = String(queryForRAG || canonicalQuery || originalQueryText || '');
        if (userLanguage === 'en' && Array.isArray(docsForHowToRescue) && docsForHowToRescue.length > 0) {
          const translatedDetail = await buildDetailedEnglishHowToFromJapaneseEvidence({
            docs: docsForHowToRescue,
            focusQuery,
            originalQuery: String(originalQueryText || queryForRAG || prompt || ''),
          });
          if (translatedDetail) {
            detailRecovered = true;
            finalAnswer = stripExistingSourceFooter(translatedDetail.answer);
            content = finalAnswer;
            ragSources.splice(0, ragSources.length, ...translatedDetail.sources);
            logFilterTrace('howto_detail_en_recovery', {
              language: userLanguage,
              source_count: translatedDetail.sources.length,
              query: String(originalQueryText || '').slice(0, 120),
            });
          }
        }
        if (!detailRecovered && /DOCUMENT CONTEXT:/i.test(String(prompt || ''))) {
          const recoveryStart = Date.now();
          const recovered = await buildEvidenceRecoveryAnswer({
            qaPrompt: String(prompt || ''),
            language: userLanguage,
            recoveryBudget,
          });
          kpiMetrics.llmTime += Date.now() - recoveryStart;
          if (
            recovered &&
            !isCannotConfirmStyleAnswer(recovered) &&
            !isGenerationFailureStyleAnswer(recovered) &&
            !isWeakHowToAnswer(recovered, userLanguage) &&
            !isInsufficientHowToDetail(recovered, userLanguage)
          ) {
            finalAnswer = recovered;
            content = finalAnswer;
            detailRecovered = true;
            logFilterTrace('howto_detail_context_recovery', {
              language: userLanguage,
              query: String(originalQueryText || '').slice(0, 120),
            });
          }
        }
        if (detailRecovered) {
          console.log('[STEP 3] Recovered detailed how-to answer.');
        }
      }

      if (kpiMetrics.ragUsed && queryIntent.isHowTo) {
        finalAnswer = compactHowToAnswer(finalAnswer, userLanguage);
        content = finalAnswer;
      }

      if (
        kpiMetrics.ragUsed &&
        ragSources.length > 0 &&
        !isCannotConfirmStyleAnswer(finalAnswer) &&
        !isGenerationFailureStyleAnswer(finalAnswer)
      ) {
        finalAnswer = stripExistingSourceFooter(finalAnswer);
          finalAnswer = appendSourceFooter(
            finalAnswer,
            ragSources,
            String(originalQueryText || queryForRAG || prompt || ''),
            userLanguage,
          );
        content = finalAnswer;
      }

      const completionFix = await finalizeAnswerCompleteness({
        answer: finalAnswer,
        qaPrompt: String(prompt || ''),
        language: userLanguage,
        ragUsed: Boolean(kpiMetrics.ragUsed),
        recoveryBudget,
      });
      if (completionFix.latencyMs > 0) {
        kpiMetrics.llmTime += completionFix.latencyMs;
      }
      if (completionFix.recovered) {
        console.log('[STEP 3] Applied final completeness recovery.');
      }
      finalAnswer = normalizeCompanyBranding(completionFix.answer, userLanguage);
      if (
        RAG_GROUNDED_FORMATTER_ENABLED &&
        kpiMetrics.ragUsed &&
        !isCannotConfirmStyleAnswer(finalAnswer) &&
        !isGenerationFailureStyleAnswer(finalAnswer)
      ) {
        const routed = routeQuery({
          query: String(originalQueryText || queryForRAG || prompt || ''),
          language: userLanguage,
          hasHistory: Array.isArray(messages) && messages.length > 0,
        });
        const grounded = formatGroundedAnswer({
          answer: finalAnswer,
          language: userLanguage,
          queryClass: routed.klass,
        });
        if (grounded.changed) {
          finalAnswer = grounded.answer;
          console.log(
            `[RAG FORMATTER] grounded_formatter_applied mode=${grounded.mode} query_class=${routed.klass}`,
          );
        }
        recordRagDecision('formatter_mode', {
          enabled: 1,
          applied: grounded.changed ? 1 : 0,
          mode: grounded.mode,
          query_classification: routed.klass,
          language: userLanguage,
          answer_length: String(finalAnswer || '').length,
        });
      }
      {
        const enforcedLanguageAnswer = await ensureAnswerMatchesUserLanguage(
          finalAnswer,
          userLanguage,
        );
        if (enforcedLanguageAnswer.translated) {
          translationAppliedToFinalAnswer = true;
          finalAnswer = enforcedLanguageAnswer.answer;
          console.log(`[STEP 3] Enforced final answer language: ${userLanguage}`);
        } else {
          finalAnswer = enforcedLanguageAnswer.answer;
        }
      }
      if (
        kpiMetrics.ragUsed &&
        ragSources.length > 0 &&
        !/(^|\n)\s*SOURCES?\s*:/i.test(String(finalAnswer || '')) &&
        !isCannotConfirmStyleAnswer(finalAnswer) &&
        !isGenerationFailureStyleAnswer(finalAnswer)
      ) {
          finalAnswer = appendSourceFooter(
            stripExistingSourceFooter(finalAnswer),
            ragSources,
            String(originalQueryText || queryForRAG || prompt || ''),
            userLanguage,
          );
      }
      content = finalAnswer;

      if (outputs.length === 0) {
        const generateAndStoreTitle = async () => {
          console.log(`[STEP 3] First message in chat - generating title...`);
          const titleStart = Date.now();
          const chatTitle = await createChatTitle(originalQueryText || prompt, finalAnswer);
          kpiMetrics.titleTime = Date.now() - titleStart;
          console.log(`[STEP 3] Generated chat title: "${chatTitle}"`);
          await put<IGenTaskSer>(KrdGenTask, { id: taskId }, {
            form_data: chatTitle,
            update_by: 'JOB',
          });
          if (data.userName) {
            await chatStoreRedis.setTitle(taskId, chatTitle).catch(() => undefined);
          }
        };

        if (ASYNC_CHAT_TITLE) {
          void generateAndStoreTitle().catch((e) =>
            console.warn('[STEP 3] Async title generation failed:', (e as any)?.message || e),
          );
        } else {
          await generateAndStoreTitle();
        }
      }

      // Durable history in Postgres (source of truth) + Redis cache already handled below.
      const rawSourceIds = ragSources.map((s) => String(s.docId));
      await persistChatTurn({
        userId: Number(data.userId || 0) || 0,
        userName: String(data.userName || 'anonymous'),
        departmentCode,
        conversationId: String(taskId),
        outputId: Number(outputId),
        userText: originalQueryText,
        userLanguage,
        workingQuery: queryTranslationApplied ? queryForRAG : undefined,
        assistantText: finalAnswer,
        ragUsed: !!kpiMetrics.ragUsed,
        sourceIds: rawSourceIds,
        tokenInput: kpiMetrics.inputTokens,
        tokenOutput: kpiMetrics.outputTokens,
        metadata: {
          retrieval_index_language: retrievalIndexLanguage,
          query_translation_applied: queryTranslationApplied,
          final_translation_applied: translationAppliedToFinalAnswer,
        },
      }).catch((e) => console.warn('[HistoryPersistence] persistChatTurn failed:', e?.message || e));

      if (Number.isFinite(Number(data.userId)) && Number(data.userId) > 0) {
        await createNotification({
          userId: Number(data.userId),
          departmentCode,
          type: 'chat_reply_ready',
          title: 'Chat response ready',
          body: finalAnswer.length > 140 ? `${finalAnswer.slice(0, 140)}...` : finalAnswer,
          payload: {
            conversation_id: String(taskId),
            message_id: `${outputId}:assistant`,
            rag_used: !!kpiMetrics.ragUsed,
            source_ids: rawSourceIds,
          },
        }).catch((e) => console.warn('[Notification] create chat_reply_ready failed:', e?.message || e));
      }
    }
    
    if (!String(content || '').trim() || String(content || '').trim().toLowerCase() === 'error happen') {
      const fallback = generationFailureReply(userLanguage);
      finalAnswer = finalAnswer || fallback;
      content = fallback;
    }
    isOk = content.length > 0;
    console.log(`[STEP 3] Generation status: ${isOk ? 'SUCCESS' : 'FAILED'}`);
    const finalCacheHealth = isCacheAnswerHealthy({
      answer: String(finalAnswer || ''),
      language: userLanguage,
      queryIntent,
      originalQuery: String(originalQueryText || prompt || ''),
    });

    if (
      RAG_ANSWER_CACHE &&
      answerCacheKey &&
      !bypassTier0Cache &&
      selectedTier !== 'tier0' &&
      isOk &&
      !!kpiMetrics.ragUsed &&
      String(finalAnswer || '').trim().length > 0 &&
      ragSources.length > 0 &&
      !isCannotConfirmStyleAnswer(finalAnswer) &&
      !isGenerationFailureStyleAnswer(finalAnswer) &&
      finalCacheHealth.ok
    ) {
      const cacheSourceIds = uniqueStringList(ragSources.map((s) => String(s.docId || '').trim()), 50);
      if (cacheSourceIds.length > 0) {
        const cacheRecord: AnswerCacheRecord = {
          answer: String(finalAnswer || '').trim(),
          sources: cacheSourceIds,
          source_titles: ragSources
            .map((s) => String(s?.title || '').trim())
            .filter(Boolean)
            .slice(0, 50),
          timestamp: Date.now(),
          confidence: selectedTier === 'tier1'
            ? Math.max(queryIntent.confidence, RAG_FAST_HOWTO_INTENT_CONF)
            : Math.max(queryIntent.confidence, 0.6),
          intent_label: queryIntent.label,
          source_file_ids: cacheSourceIds,
          top_relax_step: topRelaxStepUsed || undefined,
          language: userLanguage,
          canonical_query: canonicalQuery,
        };
        const cacheWriteStart = Date.now();
        const writeOk = await writeAnswerCache(answerCacheKey, cacheRecord);
        cacheWriteMs = Date.now() - cacheWriteStart;
        kpiMetrics.cacheWriteTime = cacheWriteMs;
        logFilterTrace('tier0_cache_store', {
          cache_key_hash: hashShort(answerCacheKey),
          canonical_query: canonicalQuery,
          status: writeOk ? 'stored' : 'skipped',
          intent_label: queryIntent.label,
          top_relax_step: topRelaxStepUsed || null,
          source_count: cacheSourceIds.length,
          bytes: Buffer.byteLength(JSON.stringify(cacheRecord), 'utf8'),
          latency_ms: cacheWriteMs,
        });
      }
    } else if (
      RAG_ANSWER_CACHE &&
      answerCacheKey &&
      !bypassTier0Cache &&
      selectedTier !== 'tier0' &&
      isOk &&
      !!kpiMetrics.ragUsed &&
      !finalCacheHealth.ok
    ) {
      logFilterTrace('tier0_cache_store_skipped', {
        reason: finalCacheHealth.reason || 'cache_answer_unhealthy',
        canonical_query: canonicalQuery,
        intent_label: queryIntent.label,
        intent_confidence: Number(queryIntent.confidence.toFixed(3)),
      });
    }

    if (answerResolvedByFastTier) {
      const rawSourceIds = ragSources.map((s) => String(s.docId));
      await persistChatTurn({
        userId: Number(data.userId || 0) || 0,
        userName: String(data.userName || 'anonymous'),
        departmentCode,
        conversationId: String(taskId),
        outputId: Number(outputId),
        userText: originalQueryText,
        userLanguage,
        workingQuery: queryTranslationApplied ? queryForRAG : undefined,
        assistantText: finalAnswer,
        ragUsed: !!kpiMetrics.ragUsed,
        sourceIds: rawSourceIds,
        tokenInput: kpiMetrics.inputTokens,
        tokenOutput: kpiMetrics.outputTokens,
        metadata: {
          retrieval_index_language: retrievalIndexLanguage,
          query_translation_applied: queryTranslationApplied,
          final_translation_applied: false,
          tier: selectedTier,
          cache_hit: kpiMetrics.cacheHit,
        },
      }).catch((e) => console.warn('[HistoryPersistence] persistChatTurn failed:', e?.message || e));

      if (Number.isFinite(Number(data.userId)) && Number(data.userId) > 0) {
        await createNotification({
          userId: Number(data.userId),
          departmentCode,
          type: 'chat_reply_ready',
          title: 'Chat response ready',
          body: finalAnswer.length > 140 ? `${finalAnswer.slice(0, 140)}...` : finalAnswer,
          payload: {
            conversation_id: String(taskId),
            message_id: `${outputId}:assistant`,
            rag_used: !!kpiMetrics.ragUsed,
            source_ids: rawSourceIds,
            tier: selectedTier,
          },
        }).catch((e) => console.warn('[Notification] create chat_reply_ready failed:', e?.message || e));
      }
    }

    // Persist chat messages in Redis for fast history rendering & future features.
    // We store the original user query (if present) rather than any RAG-augmented prompt.
    if (data.userName && typeof data.userName === 'string' && data.userName.trim().length > 0) {
      const userText = originalQueryText.trim();
      if (userText) {
        await chatStoreRedis
          .appendMessage({ taskId, userName: data.userName, role: 'user', content: userText })
          .catch((e) => console.warn('[RedisChat] Failed to append user message:', e?.message || e));
      }
      if (finalAnswer) {
        await chatStoreRedis
          .appendMessage({
            taskId,
            userName: data.userName,
            role: 'assistant',
            content: finalAnswer,
            sources: ragSources,
          })
          .catch((e) => console.warn('[RedisChat] Failed to append assistant message:', e?.message || e));
      }
    }
    
    // Step 4: Store single-language output
    console.log(`\n[STEP 4] Single-Language Output Creation`);
    if (isOk) {
      try {
        console.log(`[STEP 4] User language: ${userLanguage}`);
        console.log(`[STEP 4] Response language will be: ${userLanguage}`);
        console.log(`[STEP 4] LLM answer length: ${finalAnswer.length}`);

        if (!finalAnswer) {
          if (kpiMetrics.ragUsed) {
            markEmptyLlmResponseFallback('legacy_step4_final_answer_empty');
            finalAnswer = generationFailureReply(userLanguage);
          } else {
            finalAnswer = content || '';
          }
        }

        content = formatSingleLanguageOutput(finalAnswer, userLanguage as LanguageCode, {
          generation_status: generationStatus,
          used_fallback: generationUsedFallback,
        });
        console.log(`[STEP 4] Formatted output created, length: ${content.length}`);
        if (config.APP_MODE === 'rag-evaluation') {
          content = `${prompt}\n\n## LLM Response\n\n${content}`;
          console.log(`[STEP 4] RAG evaluation mode - appending prompt to content`);
        }
      } catch (e) {
        console.error(`[STEP 4] Formatting error:`, e);
        const fallback = generationFailureReply(userLanguage);
        finalAnswer = finalAnswer || fallback;
        content = fallback;
        isOk = true;
      }
    }

    kpiMetrics.endTime = Date.now();
    kpiMetrics.totalTime = kpiMetrics.endTime - kpiMetrics.startTime;
    kpiMetrics.responseLength = content.length;
    if (selectedTier === 'tier2') {
      tierLatencyMs = Math.max(kpiMetrics.ragTime + kpiMetrics.llmTime, kpiMetrics.totalTime);
    }
    kpiMetrics.tierUsed = selectedTier;
    kpiMetrics.tierLatency = tierLatencyMs;
    updateLocalCacheMetrics();
    logFilterTrace('tier_selection', {
      canonical_query: canonicalQuery,
      original_query: rawCacheQuery.slice(0, 180),
      language: userLanguage,
      tier: selectedTier,
      tier_latency_ms: tierLatencyMs,
      cache_hit: kpiMetrics.cacheHit,
      intent_label: queryIntent.label,
      intent_confidence: Number(queryIntent.confidence.toFixed(3)),
      cache_lookup_ms: cacheLookupMs,
      cache_write_ms: cacheWriteMs,
      cache_hit_rate: Number(getAnswerCacheHitRate().toFixed(4)),
    });
    
    const finalStatus = isOk ? 'FINISHED' : 'FAILED';
    
    console.log(`\n[CHAT PROCESS] Storing output...`);
    console.log(`[CHAT PROCESS] Status: ${finalStatus}, Content length: ${content.length}`);
    console.log(
      `[CHAT PROCESS] Timing breakdown: dbFetchMs=${kpiMetrics.dbFetchMs}, intentMs=${kpiMetrics.intentMs}, candidateMs=${kpiMetrics.candidateMs}, solrMs=${kpiMetrics.solrMs}, translateMs=${kpiMetrics.translateMs}, rerankMs=${kpiMetrics.rerankMs}, llmMs=${kpiMetrics.llmTime}, totalMs=${kpiMetrics.totalTime}`,
    );
    console.log(
      `[CHAT PROCESS] Cache flags: answerCacheHit=${kpiMetrics.cacheHit}, fileInventoryCacheHit=${kpiMetrics.fileInventoryCacheHit}, candidateScopeCacheHit=${kpiMetrics.candidateScopeCacheHit}, solrCacheHit=${kpiMetrics.solrCacheHit}`,
    );
    console.log(
      `[CHAT PROCESS] Local cache ops: hits=${kpiMetrics.localCacheHitCount}, misses=${kpiMetrics.localCacheMissCount}, writes=${kpiMetrics.localCacheWriteCount}, evictions=${kpiMetrics.localCacheEvictionCount}, expired=${kpiMetrics.localCacheExpiredCount}`,
    );
    console.log(
      `[CHAT PROCESS] Recovery budget: calls=${kpiMetrics.recoveryBudgetCalls}/${kpiMetrics.recoveryBudgetMaxCalls}, spentMs=${kpiMetrics.recoveryBudgetSpentMs}/${kpiMetrics.recoveryBudgetMaxMs}`,
    );
    console.log(`[CHAT PROCESS] KPI metrics:`, kpiMetrics);

    try {
      await put<IGenTaskOutputSer>(
        KrdGenTaskOutput,
        { id: outputId },
        {
          content,
          status: finalStatus,
          update_by: 'JOB',
        },
      );
      await publishLive('done', { status: finalStatus, content });
    } catch (dbError) {
      console.error(`[CHAT PROCESS] Failed to update database:`, dbError);
      await publishLive('error', {
        status: 'FAILED',
        message: String((dbError as any)?.message || 'db_update_failed'),
      });
    }

    const organicRetrievalMs = computeOrganicRetrievalMs(kpiMetrics);
    try {
      await recordQueryEvent({
        taskId: String(taskId),
        taskOutputId: Number(outputId),
        userId: Number(data.userId || 0) || undefined,
        userName: String(data.userName || ''),
        departmentCode,
        status: finalStatus,
        responseMs: kpiMetrics.totalTime,
        ragUsed: !!kpiMetrics.ragUsed,
        queryText: originalQueryText,
        answerText: finalAnswer || content,
        metadata: {
          ragMs: kpiMetrics.ragTime,
          llmMs: kpiMetrics.llmTime,
          retrievalMs: organicRetrievalMs,
          translationMs: kpiMetrics.translationTime,
          queryTranslationMs: kpiMetrics.queryTranslationTime,
          dbFetchMs: kpiMetrics.dbFetchMs,
          intentMs: kpiMetrics.intentMs,
          candidateMs: kpiMetrics.candidateMs,
          solrMs: kpiMetrics.solrMs,
          translateMs: kpiMetrics.translateMs,
          rerankMs: kpiMetrics.rerankMs,
          solrCallsCount: kpiMetrics.solrCallsCount,
          translateCallsCount: kpiMetrics.translateCallsCount,
          fileInventoryCacheHit: kpiMetrics.fileInventoryCacheHit,
          candidateScopeCacheHit: kpiMetrics.candidateScopeCacheHit,
          solrCacheHit: kpiMetrics.solrCacheHit,
          titleMs: kpiMetrics.titleTime,
          inputTokens: kpiMetrics.inputTokens,
          outputTokens: kpiMetrics.outputTokens,
          userLanguage: kpiMetrics.userLanguage,
          modelUsed: kpiMetrics.modelUsed,
          localCacheHits: kpiMetrics.localCacheHitCount,
          localCacheMisses: kpiMetrics.localCacheMissCount,
          localCacheWrites: kpiMetrics.localCacheWriteCount,
          localCacheEvictions: kpiMetrics.localCacheEvictionCount,
          localCacheExpired: kpiMetrics.localCacheExpiredCount,
          recoveryBudgetCalls: kpiMetrics.recoveryBudgetCalls,
          recoveryBudgetSpentMs: kpiMetrics.recoveryBudgetSpentMs,
          recoveryBudgetMaxCalls: kpiMetrics.recoveryBudgetMaxCalls,
          recoveryBudgetMaxMs: kpiMetrics.recoveryBudgetMaxMs,
          tierUsed: selectedTier,
          tierLatencyMs: tierLatencyMs,
          cacheHit: kpiMetrics.cacheHit,
          cacheLookupMs,
          cacheWriteMs,
          cacheHitRate: Number(getAnswerCacheHitRate().toFixed(4)),
          canonicalQuery,
          intentLabel: queryIntent.label,
          intentConfidence: Number(queryIntent.confidence.toFixed(3)),
          topRelaxStepUsed: topRelaxStepUsed || null,
        },
      });
      await recordContentFlagEvent({
        taskId: String(taskId),
        taskOutputId: Number(outputId),
        userId: Number(data.userId || 0) || undefined,
        userName: String(data.userName || ''),
        departmentCode,
        queryText: originalQueryText,
        answerText: finalAnswer || content,
      });
    } catch (analyticsError) {
      console.warn('[Analytics] analytics event write failed:', (analyticsError as any)?.message || analyticsError);
    }

    console.log(`\n========== [CHAT PROCESS] Completed ==========`);
    console.log(`[CHAT PROCESS] Final status: ${finalStatus}`);
    console.log(`[CHAT PROCESS] Output ID: ${outputId}, Content length: ${content.length}`);
    console.log(`[CHAT PROCESS] Total processing time: ${kpiMetrics.totalTime}ms`);
    console.log(`[CHAT PROCESS] ===========================================\n`);

    return { outputId, isOk, content };
  };

  await execute(type, taskId, callAviary);
};
