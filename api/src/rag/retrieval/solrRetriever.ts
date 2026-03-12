import { config } from '@config/index';
import { hasJapaneseChars } from '@/rag/language/detectLanguage';
import { getIntentReconstructionGate, reconstructIntentQueries } from '@/rag/query/reconstructIntent';
import { generateJapaneseQueryVariants } from '@/rag/query/crossLanguageBridge';
import { retrieveWithHyDE } from '@/rag/retrieval/hydeRetriever';
import { retrieveDocumentsWithHybrid } from '@/rag/retrieval/hybridRetriever';
import { ensureSolrJapaneseAnalyzer } from '@/rag/retrieval/ensureSolrJapaneseAnalyzer';
import { mergeMetadataFilters, routeDomainPrefilter } from '@/rag/retrieval/domainRouter';
import { recordRagDecision } from '@/rag/metrics/ragDecisionMetrics';
import {
  generateQueryVariants,
  repairQueryForHrRetrieval,
} from '@/rag/query/llmQueryExpansion';

export const normalizeSearchToken = (token: string): string =>
  String(token || '')
    .replace(/[“”"'`]/g, '')
    .replace(/[?？!！。、,，]/g, ' ')
    .trim();

export const escapeLuceneWildcardTerm = (value: string): string =>
  String(value || '').replace(/[\\+\-!(){}\[\]^"~*?:/]/g, '');

export const shouldKeepQueryToken = (token: string): boolean => {
  const t = String(token || '').trim();
  if (!t) return false;
  if (hasJapaneseChars(t)) return t.length >= 2;
  return t.length >= 3 && /[a-z0-9]/i.test(t);
};

export type SolrSearchTerms = {
  rawTokens: string[];
  searchTokens: string[];
  effectiveTokens: string[];
  isMostlyJapaneseQuery: boolean;
  searchTerms: string;
};

export const buildSolrSearchTerms = (queryText: string): SolrSearchTerms => {
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

  return {
    rawTokens,
    searchTokens,
    effectiveTokens,
    isMostlyJapaneseQuery,
    searchTerms,
  };
};

const escapeTermsValue = (value: string) => String(value || '').replace(/([,\\])/g, '\\$1');

const uniqueStrings = (values: unknown[], limit = 200): string[] =>
  Array.from(
    new Set(
      (values || [])
        .map((v) => String(v || '').trim())
        .filter(Boolean),
    ),
  ).slice(0, limit);

const withTimeout = async <T>(factory: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      factory(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${timeoutMs}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const readBooleanEnv = (name: string, fallback: boolean): boolean => {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
};

const readNumberEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const PROCEDURAL_QUERY_HINT_PATTERN = /(申請|手続|手続き|手順|方法|届出|提出|承認|apply|procedure|steps?|how\s+to|workflow)/i;
const hasProceduralHint = (value: string): boolean =>
  PROCEDURAL_QUERY_HINT_PATTERN.test(String(value || '').trim());

const stableDocKey = (doc: any): string => {
  const id = String(doc?.id || '').trim();
  if (id) return id;
  const title = String(Array.isArray(doc?.title) ? doc.title[0] : doc?.title || '').trim();
  const fileName = String(doc?.file_name_s || '').trim();
  const composite = `${title}|${fileName}`.trim();
  return composite || JSON.stringify({
    title,
    fileName,
    score: Number(doc?.score || 0),
  });
};

const normalizeSolrContentDoc = (doc: any): any => {
  if (!doc || typeof doc !== 'object') return doc;
  const primaryContent = Array.isArray(doc?.content_txt)
    ? doc.content_txt
    : (doc?.content_txt ? [doc.content_txt] : []);
  const japaneseContent = Array.isArray(doc?.content_txt_ja)
    ? doc.content_txt_ja
    : (doc?.content_txt_ja ? [doc.content_txt_ja] : []);
  if (primaryContent.length > 0 || japaneseContent.length <= 0) return doc;
  return {
    ...doc,
    content_txt: japaneseContent.length === 1 ? japaneseContent[0] : japaneseContent,
  };
};

const buildFallbackWildcardQuery = (seedQuery: string): string => {
  const tokens = String(seedQuery || '')
    .split(/\s+/)
    .map(normalizeSearchToken)
    .map(escapeLuceneWildcardTerm)
    .filter(shouldKeepQueryToken)
    .slice(0, 8);
  if (!tokens.length) return String(seedQuery || '').trim();
  return tokens.map((t) => `${t}*`).join(' ');
};

const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 10;

const computeRetrievalConfidence = (topScore: number, docCount: number): number =>
  Number(topScore || 0) * Math.log(Math.max(0, Number(docCount || 0)) + 1);

const countDocTermHits = (doc: any, queryText: string): number => {
  const terms = buildSolrSearchTerms(queryText).searchTokens;
  if (!terms.length) return 0;
  const title = Array.isArray(doc?.title) ? String(doc.title[0] || '') : String(doc?.title || '');
  const content = Array.isArray(doc?.content_txt)
    ? String(doc.content_txt.join(' ') || '')
    : String(doc?.content_txt || doc?.content_txt_ja || doc?.content || '');
  const hay = `${title}\n${content}`.toLowerCase().replace(/[_\-./\\]+/g, ' ');

  let hits = 0;
  for (const term of terms) {
    const t = String(term || '').trim();
    if (!t) continue;
    if (hasJapaneseChars(t)) {
      if (hay.includes(t.toLowerCase())) hits += 1;
      continue;
    }
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(hay) || (t.length >= 4 && hay.includes(t.toLowerCase()))) {
      hits += 1;
    }
  }
  return hits;
};

const buildMetadataFq = (metadataFilters?: Record<string, any>): string[] => {
  if (!metadataFilters || typeof metadataFilters !== 'object') return [];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadataFilters)) {
    const field = String(key || '').trim();
    if (!field) continue;
    if (Array.isArray(value)) {
      const values = value.map((v) => String(v || '').trim()).filter(Boolean);
      if (!values.length) continue;
      parts.push(`{!terms f=${field}}${values.map(escapeTermsValue).join(',')}`);
      continue;
    }
    const scalar = String(value ?? '').trim();
    if (!scalar) continue;
    const escaped = scalar.replace(/([:\\])/g, '\\$1');
    parts.push(`${field}:${escaped}`);
  }
  return parts;
};

const normalizeSemanticDocs = (raw: any[], topK: number): any[] => {
  return (Array.isArray(raw) ? raw : [])
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
      const rawSimilarity = Number(item?.score ?? item?.similarity ?? item?.relevance_score ?? item?.rerank_score);
      const rawDistance = Number(item?.distance ?? item?.dist ?? item?.vector_distance);
      const semanticScore =
        Number.isFinite(rawSimilarity) && rawSimilarity > 0
          ? rawSimilarity
          : (Number.isFinite(rawDistance) && rawDistance >= 0
            ? (1 / (1 + rawDistance))
            : Math.max(0.05, (topK - idx) / Math.max(1, topK)));
      const score = Math.max(0.05, semanticScore * 30);
      return {
        id,
        title,
        content_txt: content,
        score,
        semantic_score: semanticScore,
        ...(metadata?.file_name_s ? { file_name_s: String(metadata.file_name_s) } : {}),
        ...(metadata?.department_code_s ? { department_code_s: String(metadata.department_code_s) } : {}),
      };
    })
    .filter(Boolean);
};

export type RetrieveDocumentsInput = {
  queryForRAG: string;
  multilingualRetrievalQueries: string[];
  userLanguage: 'ja' | 'en';
  retrievalIndexLanguage: 'ja' | 'en' | 'multi';
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
  onLog?: (event: string, payload?: Record<string, any>) => void;
};

export type RetrieveDocumentsResult = {
  docs: any[];
  retrievalQueryUsed: string;
  attemptedQueries: string[];
  lexicalDocsFound: boolean;
  usedSemanticFallback: boolean;
  queryTranslationApplied: boolean;
  translatedQuery: string;
  japaneseRetrievalQueries: string[];
  topScore: number;
  topTermHits: number;
  solrCallsCount: number;
  translateCallsCount: number;
  translateMs: number;
};

export const retrieveDocumentsWithSolr = async (
  input: RetrieveDocumentsInput,
): Promise<RetrieveDocumentsResult> => {
  const log = input.onLog || (() => undefined);
  const solrTimeoutMs = Math.max(1000, Number(input.solrTimeoutMs || process.env.RAG_SOLR_TIMEOUT_MS || 12000));
  const ragBackendTimeoutMs = Math.max(800, Number(input.ragBackendTimeoutMs || process.env.RAG_BACKEND_TIMEOUT_MS || 6000));
  const solrRows = Math.max(4, Number(input.solrRows || process.env.RAG_SOLR_ROWS || 20));
  const maxSolrCalls = Math.max(2, Number(input.maxSolrCalls || process.env.RAG_SOLR_MAX_CALLS || 8));
  const lowConfidenceThreshold = Math.max(
    0,
    readNumberEnv('RAG_LOW_CONFIDENCE_THRESHOLD', DEFAULT_LOW_CONFIDENCE_THRESHOLD),
  );
  const highConfidenceThreshold = Math.max(
    lowConfidenceThreshold + 0.1,
    readNumberEnv('RAG_CONFIDENCE_HIGH', 25),
  );
  const llmExpansionEnabled = readBooleanEnv('RAG_LLM_QUERY_EXPANSION_ENABLED', false);
  const queryRepairEnabled = readBooleanEnv('RAG_QUERY_REPAIR_ENABLED', false);
  const hydeEnabled = readBooleanEnv('RAG_HYDE_ENABLED', false);
  const vectorRetrievalEnabled = readBooleanEnv('RAG_VECTOR_RETRIEVAL_ENABLED', true);
  const intentReconstructionEnabled = readBooleanEnv('RAG_INTENT_RECONSTRUCTION_ENABLED', false);
  const crossLanguageBridgeEnabled = readBooleanEnv('RAG_CROSS_LANGUAGE_BRIDGE_ENABLED', false);
  const forceEnglishCrossLanguageBridge =
    input.userLanguage === 'en' &&
    input.retrievalIndexLanguage !== 'en';
  const effectiveCrossLanguageBridgeEnabled =
    crossLanguageBridgeEnabled || forceEnglishCrossLanguageBridge;
  const effectiveLlmExpansionEnabled =
    llmExpansionEnabled || forceEnglishCrossLanguageBridge;
  const effectiveQueryRepairEnabled =
    queryRepairEnabled || forceEnglishCrossLanguageBridge;
  const lexicalStrictFirst = readBooleanEnv('RAG_LEXICAL_STRICT_FIRST', true);
  const lexicalFallbackStrongBreakEnabled = readBooleanEnv('RAG_LEXICAL_FALLBACK_STRONG_BREAK_ENABLED', false);
  const domainPrefilterEnabled = readBooleanEnv('RAG_DOMAIN_PREFILTER_ENABLED', true);
  const vectorOnlyOnLexicalFail = readBooleanEnv('RAG_VECTOR_ONLY_ON_LEXICAL_FAIL', true);
  const lexicalEarlyBreakTopScore = Math.max(
    0,
    readNumberEnv('RAG_LEXICAL_EARLY_BREAK_TOP_SCORE', 60),
  );
  const lexicalEarlyBreakTopTermHits = Math.max(
    0,
    Math.round(readNumberEnv('RAG_LEXICAL_EARLY_BREAK_TOP_TERM_HITS', 3)),
  );
  const vectorTriggerConfidence = Math.max(
    0,
    readNumberEnv('RAG_VECTOR_RETRIEVAL_TRIGGER_CONFIDENCE', lowConfidenceThreshold),
  );
  const vectorTriggerMaxTermHits = Math.max(
    0,
    Math.round(readNumberEnv('RAG_VECTOR_RETRIEVAL_MAX_TERM_HITS', 1)),
  );
  const hydeConfidenceThreshold = Math.max(
    0,
    Number(process.env.RAG_HYDE_CONFIDENCE_THRESHOLD || lowConfidenceThreshold),
  );
  const domainPrefilterFallbackConfidence = Math.max(
    0,
    readNumberEnv('RAG_DOMAIN_PREFILTER_FALLBACK_CONFIDENCE', lowConfidenceThreshold),
  );
  const domainPrefilterMinDocs = Math.max(
    1,
    Math.round(readNumberEnv('RAG_DOMAIN_PREFILTER_MIN_DOCS', 2)),
  );
  log('retrieval_profile', {
    low_confidence_threshold: lowConfidenceThreshold,
    high_confidence_threshold: highConfidenceThreshold,
    vector_retrieval_enabled: vectorRetrievalEnabled,
    vector_trigger_confidence: vectorTriggerConfidence,
    vector_trigger_max_term_hits: vectorTriggerMaxTermHits,
    intent_reconstruction_enabled: intentReconstructionEnabled,
    cross_language_bridge_enabled: effectiveCrossLanguageBridgeEnabled,
    llm_query_expansion_enabled: effectiveLlmExpansionEnabled,
    llm_query_repair_enabled: effectiveQueryRepairEnabled,
    hyde_enabled: hydeEnabled,
    lexical_strict_first: lexicalStrictFirst,
    lexical_fallback_strong_break_enabled: lexicalFallbackStrongBreakEnabled,
    lexical_early_break_top_score: lexicalEarlyBreakTopScore,
    lexical_early_break_top_term_hits: lexicalEarlyBreakTopTermHits,
    vector_only_on_lexical_fail: vectorOnlyOnLexicalFail,
    domain_prefilter_enabled: domainPrefilterEnabled,
    domain_prefilter_min_docs: domainPrefilterMinDocs,
    domain_prefilter_fallback_confidence: domainPrefilterFallbackConfidence,
  });
  await ensureSolrJapaneseAnalyzer(log);


  const restrictToDepartment = Boolean(input.restrictToDepartment && input.departmentCode);
  const departmentCode = String(input.departmentCode || '').trim();
  const coreName = encodeURIComponent(config.ApacheSolr.coreName || 'mycore');
  const baseMetadataFilters = input.metadataFilters;

  let fileScopeIds = uniqueStrings(input.fileScopeIds || [], 120);
  const scopeTokenCount = buildSolrSearchTerms(input.queryForRAG).searchTokens.length;
  if (fileScopeIds.length > 0 && scopeTokenCount < 2) {
    log('prefilter_disabled', {
      reason: 'token_matches_lt_2',
      scope_count: fileScopeIds.length,
      token_count: scopeTokenCount,
    });
    fileScopeIds = [];
  }

  let solrCallsCount = 0;
  const attemptedQueries: string[] = [];
  let lexicalBestDocs: any[] = [];
  let lexicalBestQuery = String(input.queryForRAG || '').trim();
  let lexicalBestTopScore = 0;
  let lexicalBestTopTermHits = 0;
  let queryTranslationApplied = false;
  let translatedQuery = '';
  let japaneseRetrievalQueries: string[] = [];
  let translateCallsCount = 0;
  let translateMs = 0;
  log('query_language_detected', {
    detected_query_language: input.userLanguage,
    retrieval_index_language: input.retrievalIndexLanguage,
    force_cross_language_bridge: forceEnglishCrossLanguageBridge ? 1 : 0,
  });

  const runSolr = async (
    queryText: string,
    mode: 'primary' | 'fallback',
    metadataFiltersOverride?: Record<string, any>,
    phase?: string,
  ) => {
    if (solrCallsCount >= maxSolrCalls) {
      return { docs: [], numFound: 0, topScore: 0 };
    }

    const { searchTerms, isMostlyJapaneseQuery } = buildSolrSearchTerms(queryText);
    const solrQuery = encodeURIComponent(searchTerms || '*:*');

    const fqParts: string[] = [];
    if (fileScopeIds.length) {
      fqParts.push(`{!terms f=id}${fileScopeIds.map(escapeTermsValue).join(',')}`);
    }
    if (restrictToDepartment) {
      fqParts.push(`department_code_s:${departmentCode}`);
    }
    fqParts.push(...buildMetadataFq(metadataFiltersOverride ?? baseMetadataFilters));
    const fq = fqParts.map((part) => `&fq=${encodeURIComponent(part)}`).join('');

    const qf = encodeURIComponent(
      'title^4 file_name_s^3 section_title_s^3 article_number_s^2 policy_type_s^2 content_txt content_txt_ja',
    );
    const pf = encodeURIComponent(
      'title^8 file_name_s^6 section_title_s^6 article_number_s^4 policy_type_s^4 content_txt^2 content_txt_ja^2',
    );
    const mm = encodeURIComponent(isMostlyJapaneseQuery ? '2<75%' : '2<70%');
    const url = `${config.ApacheSolr.url}/solr/${coreName}/select?q=${solrQuery}${fq}&defType=edismax&qf=${qf}&pf=${pf}&q.op=OR&mm=${mm}&fl=id,title,file_name_s,content_txt,content_txt_ja,department_code_s,chunk_id_s,document_id_s,doc_id_s,section_title_s,article_number_s,page_number_i,page_i,policy_type_s,updated_at_s,last_revised_s,modified_at_s,document_last_updated_s,importance_weight_f,score&rows=${solrRows}&wt=json`;

    solrCallsCount += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), solrTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        log('solr_result', {
          mode,
          phase: String(phase || 'default'),
          query: queryText,
          status: `http_${res.status}`,
          docs: 0,
        });
        return { docs: [], numFound: 0, topScore: 0 };
      }
      const body = await res.json();
      const docs = Array.isArray(body?.response?.docs)
        ? body.response.docs.map((doc: any) => normalizeSolrContentDoc(doc))
        : [];
      const numFound = Number(body?.response?.numFound || docs.length || 0);
      const topScore = Number(docs?.[0]?.score || 0);
      log('solr_result', {
        mode,
        phase: String(phase || 'default'),
        query: queryText,
        docs: docs.length,
        num_found: numFound,
        top_score: Number(topScore.toFixed(3)),
        call: solrCallsCount,
      });
      return { docs, numFound, topScore };
    } catch (error: any) {
      log('solr_result', {
        mode,
        phase: String(phase || 'default'),
        query: queryText,
        status: String(error?.message || 'error'),
        docs: 0,
      });
      return { docs: [], numFound: 0, topScore: 0 };
    } finally {
      clearTimeout(timer);
    }
  };

  // Ordered strategy:
  // 1) canonical query
  // 2) upstream expansion/translation candidates (provided in stable order by expandQuery)
  // 3) wildcard fallback (single final attempt)
  const canonicalQuery = String(input.queryForRAG || '').trim();
  const queryIsProcedural = hasProceduralHint(canonicalQuery);
  let expandedQueries = uniqueStrings(input.multilingualRetrievalQueries || [], 9);
  let domainPrefilterMetadataFilters: Record<string, any> | undefined;
  let domainPrefilterActive = false;

  if (effectiveCrossLanguageBridgeEnabled && canonicalQuery && input.userLanguage === 'en') {
    const existingJapaneseQueries = expandedQueries.filter((query) => hasJapaneseChars(query));
    const llmGeneratedTerms =
      existingJapaneseQueries.length >= 3
        ? []
        : await generateQueryVariants(canonicalQuery, input.userLanguage);
    const heuristicGeneratedTerms = await generateJapaneseQueryVariants(canonicalQuery);
    japaneseRetrievalQueries = uniqueStrings(
      [...existingJapaneseQueries, ...llmGeneratedTerms, ...heuristicGeneratedTerms].filter((query) => hasJapaneseChars(query)),
      6,
    );
    if (japaneseRetrievalQueries.length > 0) {
      expandedQueries = uniqueStrings([canonicalQuery, ...japaneseRetrievalQueries, ...expandedQueries], 12);
      translatedQuery = japaneseRetrievalQueries[0] || translatedQuery;
      queryTranslationApplied = true;
      log('cross_language_bridge_applied', {
        query: canonicalQuery,
        generated_count: japaneseRetrievalQueries.length,
      });
      log('generated_japanese_retrieval_queries', {
        queries: japaneseRetrievalQueries,
      });
    }
    log('translation_applied', {
      applied: queryTranslationApplied ? 1 : 0,
      translated_query: translatedQuery || '',
    });
  }

  const synonymExpandedQueries = expandedQueries
    .map((query) => String(query || '').trim())
    .filter(Boolean)
    .filter((query) => query !== canonicalQuery && query !== translatedQuery);
  if (synonymExpandedQueries.length > 0) {
    log('synonym_expansion_applied', {
      base_query: canonicalQuery,
      expansion_count: synonymExpandedQueries.length,
      expansions: synonymExpandedQueries.slice(0, 6),
    });
  }

  if (domainPrefilterEnabled && canonicalQuery) {
    const domainDecision = routeDomainPrefilter({
      query: canonicalQuery,
      userLanguage: input.userLanguage,
    });
    recordRagDecision('domain_prefilter', {
      enabled: 1,
      applied: domainDecision.applied ? 1 : 0,
      reason: domainDecision.reason,
      domain_id: domainDecision.domainId || '',
      confidence: Number(domainDecision.confidence || 0),
      matched_keywords: domainDecision.matchedKeywords,
    });
    log('domain_prefilter_decision', {
      applied: domainDecision.applied,
      reason: domainDecision.reason,
      domain_id: domainDecision.domainId || null,
      confidence: Number(domainDecision.confidence || 0),
      matched_keywords: domainDecision.matchedKeywords,
    });
    if (domainDecision.applied && domainDecision.metadataFilters) {
      domainPrefilterMetadataFilters = mergeMetadataFilters(baseMetadataFilters, domainDecision.metadataFilters);
      domainPrefilterActive = true;
      const probe = await runSolr(
        canonicalQuery,
        'primary',
        domainPrefilterMetadataFilters,
        'domain_prefilter_probe',
      );
      if (probe.docs.length > 0) {
        const probeTopScore = Number(probe.topScore || 0);
        const probeTopTermHits = Math.max(
          ...probe.docs.map((doc) => countDocTermHits(doc, canonicalQuery)),
          0,
        );
        const probeConfidence = computeRetrievalConfidence(probeTopScore, probe.docs.length);
        lexicalBestDocs = probe.docs;
        lexicalBestQuery = canonicalQuery;
        lexicalBestTopScore = probeTopScore;
        lexicalBestTopTermHits = probeTopTermHits;
        const keepNarrowScope =
          probe.docs.length >= domainPrefilterMinDocs &&
          probeConfidence >= domainPrefilterFallbackConfidence;
        log('domain_prefilter_probe_result', {
          docs: probe.docs.length,
          top_score: Number(probeTopScore.toFixed(3)),
          top_term_hits: probeTopTermHits,
          retrieval_confidence: Number(probeConfidence.toFixed(3)),
          keep_narrow_scope: keepNarrowScope,
        });
        recordRagDecision('domain_prefilter', {
          enabled: 1,
          applied: keepNarrowScope ? 1 : 0,
          reason: keepNarrowScope ? 'probe_confident' : 'probe_low_confidence_fallback_global',
          domain_id: domainDecision.domainId || '',
          confidence: Number(probeConfidence.toFixed(3)),
          docs: probe.docs.length,
        });
        if (!keepNarrowScope) {
          domainPrefilterActive = false;
        }
      } else {
        log('domain_prefilter_probe_result', {
          docs: 0,
          keep_narrow_scope: false,
          reason: 'no_domain_docs',
        });
        recordRagDecision('domain_prefilter', {
          enabled: 1,
          applied: 0,
          reason: 'probe_no_docs_fallback_global',
          domain_id: domainDecision.domainId || '',
          confidence: 0,
        });
        domainPrefilterActive = false;
      }
    }
  }

  const lexicalCandidates: string[] = [];
  const intentReconstructionGate = getIntentReconstructionGate(canonicalQuery);
  const reservedSolrCallsForIntentReconstruction =
    intentReconstructionEnabled && intentReconstructionGate.shouldApply ? 2 : 0;

  if (canonicalQuery) {
    lexicalCandidates.push(canonicalQuery);
  }

  const wildcardFallback = buildFallbackWildcardQuery(canonicalQuery || expandedQueries[0] || '');
  const maxLexicalCandidates = Math.max(
    1,
    Math.min(8, Math.max(1, maxSolrCalls - reservedSolrCallsForIntentReconstruction)),
  );
  const maxNonWildcardCandidates = wildcardFallback ? Math.max(1, maxLexicalCandidates - 1) : maxLexicalCandidates;
  const prioritizedExpandedQueries = input.userLanguage === 'en'
    ? uniqueStrings([
        ...expandedQueries.filter((query) => hasJapaneseChars(query)),
        ...expandedQueries.filter((query) => !hasJapaneseChars(query)),
      ], 12)
    : expandedQueries;
  for (const candidate of prioritizedExpandedQueries) {
    if (lexicalCandidates.length >= maxNonWildcardCandidates) break;
    const value = String(candidate || '').trim();
    if (!value || lexicalCandidates.includes(value)) continue;
    lexicalCandidates.push(value);
  }

  if (wildcardFallback && !lexicalCandidates.includes(wildcardFallback) && lexicalCandidates.length < maxLexicalCandidates) {
    lexicalCandidates.push(wildcardFallback);
  }
  const preferredMetadataFilters = domainPrefilterActive
    ? domainPrefilterMetadataFilters
    : baseMetadataFilters;
  const mergedLexicalDocsById = new Map<string, any>();
  const collectMergedLexicalDocs = (rows: any[], sourceQuery: string): void => {
    const candidateRows = Array.isArray(rows) ? rows : [];
    if (!candidateRows.length) return;
    for (const row of candidateRows) {
      const key = stableDocKey(row);
      const existing = mergedLexicalDocsById.get(key);
      if (!existing) {
        mergedLexicalDocsById.set(key, row);
        continue;
      }
      const existingScore = Number(existing?.score || 0);
      const nextScore = Number(row?.score || 0);
      const existingHits = countDocTermHits(existing, sourceQuery);
      const nextHits = countDocTermHits(row, sourceQuery);
      if (nextHits > existingHits || (nextHits === existingHits && nextScore > existingScore)) {
        mergedLexicalDocsById.set(key, row);
      }
    }
  };

  for (let idx = 0; idx < lexicalCandidates.length && solrCallsCount < maxSolrCalls; idx += 1) {
    const candidate = lexicalCandidates[idx];
    attemptedQueries.push(candidate);
    const mode: 'primary' | 'fallback' = idx === 0 ? 'primary' : 'fallback';
    const found = await runSolr(
      candidate,
      mode,
      preferredMetadataFilters,
      domainPrefilterActive ? 'domain_prefilter' : 'default',
    );
    if (!found.docs.length) continue;
    collectMergedLexicalDocs(found.docs, candidate);
    const candidateTopScore = Number(found.topScore || 0);
    const candidateTopTermHits = Math.max(
      ...found.docs.map((doc) => countDocTermHits(doc, candidate)),
      0,
    );
    const candidateConfidence = computeRetrievalConfidence(candidateTopScore, found.docs.length);
    const hasBest = lexicalBestDocs.length > 0;
    const candidateHasProceduralHint = hasProceduralHint(candidate);
    const bestHasProceduralHint = hasProceduralHint(lexicalBestQuery);
    const isBetterCandidate = (() => {
      if (!hasBest) return true;
      if (queryIsProcedural && candidateHasProceduralHint !== bestHasProceduralHint) {
        return candidateHasProceduralHint;
      }
      if (candidateTopTermHits > lexicalBestTopTermHits) return true;
      if (candidateTopTermHits < lexicalBestTopTermHits) return false;
      return candidateTopScore > lexicalBestTopScore;
    })();

    log('lexical_candidate_eval', {
      query: candidate,
      docs: found.docs.length,
      top_score: Number(candidateTopScore.toFixed(3)),
      top_term_hits: candidateTopTermHits,
      retrieval_confidence: Number(candidateConfidence.toFixed(3)),
      better_than_current: isBetterCandidate,
      procedural_hint: candidateHasProceduralHint ? 1 : 0,
    });

    if (isBetterCandidate) {
      lexicalBestDocs = found.docs;
      lexicalBestQuery = candidate;
      lexicalBestTopScore = candidateTopScore;
      lexicalBestTopTermHits = candidateTopTermHits;
    }

    const strongCandidate = candidateTopTermHits >= 2 || candidateConfidence >= highConfidenceThreshold;
    const veryStrongLexicalCandidate =
      candidateTopScore >= lexicalEarlyBreakTopScore &&
      candidateTopTermHits >= lexicalEarlyBreakTopTermHits;
    const primaryCandidate = idx === 0;
    const shouldBreakOnStrongCandidate =
      primaryCandidate || lexicalFallbackStrongBreakEnabled;
    if (veryStrongLexicalCandidate) {
      log('lexical_early_break', {
        query: candidate,
        top_score: Number(candidateTopScore.toFixed(3)),
        top_term_hits: candidateTopTermHits,
        score_threshold: lexicalEarlyBreakTopScore,
        term_hits_threshold: lexicalEarlyBreakTopTermHits,
      });
      break;
    }
    if (strongCandidate && shouldBreakOnStrongCandidate) {
      break;
    }
  }

  if (mergedLexicalDocsById.size > 0) {
    const mergeSignalQuery = queryIsProcedural
      ? lexicalBestQuery
      : uniqueStrings([canonicalQuery, translatedQuery, lexicalBestQuery], 3).join(' ');
    const mergedRows = Array.from(mergedLexicalDocsById.values())
      .sort((a, b) => {
        const aHits = countDocTermHits(a, mergeSignalQuery);
        const bHits = countDocTermHits(b, mergeSignalQuery);
        if (aHits !== bHits) return bHits - aHits;
        return Number(b?.score || 0) - Number(a?.score || 0);
      })
      .slice(0, Math.max(4, solrRows));
    const mergedTopHits = Math.max(...mergedRows.map((doc) => countDocTermHits(doc, mergeSignalQuery)), 0);
    const mergedTopScore = Number(mergedRows?.[0]?.score || lexicalBestTopScore || 0);
    lexicalBestDocs = mergedRows;
    lexicalBestTopScore = mergedTopScore;
    lexicalBestTopTermHits = Math.max(lexicalBestTopTermHits, mergedTopHits);
    log('dual_retrieval_merge_applied', {
      query_count: attemptedQueries.length,
      merged_doc_count: mergedRows.length,
      top_score: Number(mergedTopScore.toFixed(3)),
      top_term_hits: lexicalBestTopTermHits,
      query_translation_applied: queryTranslationApplied,
      merge_signal_query: mergeSignalQuery,
    });
  }

  if (
    intentReconstructionEnabled &&
    lexicalBestDocs.length === 0 &&
    intentReconstructionGate.shouldApply &&
    solrCallsCount < maxSolrCalls
  ) {
    const reconstructedQueries = await reconstructIntentQueries(canonicalQuery, input.userLanguage);
    if (reconstructedQueries.length > 0) {
      log('intent_reconstruction_applied', {
        query: canonicalQuery,
        token_count: intentReconstructionGate.tokenCount,
        query_length: intentReconstructionGate.queryLength,
      });
      log('reconstructed_queries', {
        queries: reconstructedQueries,
      });

      expandedQueries = uniqueStrings(
        [canonicalQuery, ...expandedQueries, ...reconstructedQueries],
        9,
      );
      const reconstructionCandidates = expandedQueries
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .filter((value) => !attemptedQueries.includes(value))
        .slice(0, 9);

      const reconstructionWildcard = buildFallbackWildcardQuery(canonicalQuery || expandedQueries[0] || '');
      if (
        reconstructionWildcard &&
        !reconstructionCandidates.includes(reconstructionWildcard) &&
        !attemptedQueries.includes(reconstructionWildcard)
      ) {
        reconstructionCandidates.push(reconstructionWildcard);
      }

      for (const candidate of reconstructionCandidates) {
        if (solrCallsCount >= maxSolrCalls) break;
        attemptedQueries.push(candidate);
        const found = await runSolr(
          candidate,
          'fallback',
          preferredMetadataFilters,
          domainPrefilterActive ? 'domain_prefilter' : 'default',
        );
        if (!found.docs.length) continue;
        const candidateTopScore = Number(found.topScore || 0);
        const candidateTopTermHits = Math.max(
          ...found.docs.map((doc) => countDocTermHits(doc, candidate)),
          0,
        );
        const candidateConfidence = computeRetrievalConfidence(candidateTopScore, found.docs.length);
        const hasBest = lexicalBestDocs.length > 0;
        const isBetterCandidate =
          !hasBest ||
          candidateTopTermHits > lexicalBestTopTermHits ||
          (
            candidateTopTermHits === lexicalBestTopTermHits &&
            candidateTopScore > lexicalBestTopScore
          );

        log('lexical_candidate_eval', {
          query: candidate,
          docs: found.docs.length,
          top_score: Number(candidateTopScore.toFixed(3)),
          top_term_hits: candidateTopTermHits,
          retrieval_confidence: Number(candidateConfidence.toFixed(3)),
          better_than_current: isBetterCandidate,
        });

        if (isBetterCandidate) {
          lexicalBestDocs = found.docs;
          lexicalBestQuery = candidate;
          lexicalBestTopScore = candidateTopScore;
          lexicalBestTopTermHits = candidateTopTermHits;
        }

        const strongCandidate = candidateTopTermHits >= 2 || candidateConfidence >= highConfidenceThreshold;
        if (strongCandidate) break;
      }
    }
  }

  let initialConfidence = computeRetrievalConfidence(lexicalBestTopScore, lexicalBestDocs.length);
  log('retrieval_confidence_score', { score: Number(initialConfidence.toFixed(3)) });
  const lexicalHasStrongEvidence =
    lexicalBestDocs.length > 0 &&
    (
      initialConfidence >= highConfidenceThreshold ||
      lexicalBestTopTermHits >= 2
    );
  if (lexicalStrictFirst && lexicalHasStrongEvidence) {
    log('lexical_lock_applied', {
      top_score: Number(lexicalBestTopScore.toFixed(3)),
      top_term_hits: lexicalBestTopTermHits,
      retrieval_confidence: Number(initialConfidence.toFixed(3)),
    });
    return {
      docs: lexicalBestDocs,
      retrievalQueryUsed: lexicalBestQuery,
      attemptedQueries,
      lexicalDocsFound: true,
      usedSemanticFallback: false,
      queryTranslationApplied,
      translatedQuery,
      japaneseRetrievalQueries,
      topScore: lexicalBestTopScore,
      topTermHits: lexicalBestTopTermHits,
      solrCallsCount,
      translateCallsCount,
      translateMs,
    };
  }

  const shouldApplyVectorRetrieval =
    vectorRetrievalEnabled &&
    Boolean(canonicalQuery) &&
    (
      vectorOnlyOnLexicalFail
        ? lexicalBestDocs.length === 0
        : (
          lexicalBestDocs.length === 0 ||
          initialConfidence < vectorTriggerConfidence ||
          lexicalBestTopTermHits <= vectorTriggerMaxTermHits
        )
    );
  if (shouldApplyVectorRetrieval) {
    const lexicalBeforeMerge = lexicalBestDocs;
    const lexicalBeforeTopScore = lexicalBestTopScore;
    const lexicalBeforeTopTermHits = lexicalBestTopTermHits;

    const hybridResult = await retrieveDocumentsWithHybrid({
      query: canonicalQuery,
      queries: uniqueStrings(
        input.userLanguage === 'en'
          ? [
              canonicalQuery,
              translatedQuery,
              ...japaneseRetrievalQueries,
              ...expandedQueries.filter((query) => hasJapaneseChars(query)),
            ]
          : [canonicalQuery, lexicalBestQuery, ...expandedQueries],
        4,
      ),
      solrDocs: lexicalBestDocs,
      ragBackendUrl: input.ragBackendUrl,
      ragBackendCollectionName: input.ragBackendCollectionName,
      fileScopeIds,
      metadataFilters: input.metadataFilters,
      onLog: log,
    });

    log('vector_retrieval_applied', {
      query: canonicalQuery,
      vector_docs: hybridResult.vectorDocs.length,
      solr_docs: lexicalBestDocs.length,
    });
    log('vector_similarity_scores', {
      scores: hybridResult.vectorSimilarityScores.slice(0, 10),
    });

    if (hybridResult.docs.length > 0 || lexicalBestDocs.length > 0) {
      const mergedDocs = hybridResult.docs.length > 0 ? hybridResult.docs : lexicalBestDocs;
      const mergedTopScore = Number(mergedDocs[0]?.score || lexicalBestTopScore || 0);
      const mergedTopTermHits = Math.max(
        ...mergedDocs.map((doc) => countDocTermHits(doc, lexicalBestQuery || canonicalQuery)),
        0,
      );
      const shouldRejectMerge =
        lexicalBeforeMerge.length > 0 &&
        lexicalBeforeTopTermHits >= 2 &&
        mergedTopTermHits < lexicalBeforeTopTermHits &&
        mergedTopScore < lexicalBeforeTopScore;

      if (shouldRejectMerge) {
        log('vector_merge_rejected', {
          lexical_top_score: Number(lexicalBeforeTopScore.toFixed(3)),
          merged_top_score: Number(mergedTopScore.toFixed(3)),
          lexical_top_term_hits: lexicalBeforeTopTermHits,
          merged_top_term_hits: mergedTopTermHits,
        });
      } else {
        lexicalBestDocs = mergedDocs;
        lexicalBestTopScore = mergedTopScore;
        lexicalBestTopTermHits = mergedTopTermHits;
        const boostedDocs = lexicalBestDocs.filter(
          (doc) => Number(doc?.importance_weight || doc?.importance_weight_f || 0) > 0,
        ).length;
        if (boostedDocs > 0) {
          log('importance_boost_applied', {
            boosted_docs: boostedDocs,
          });
        }
      }
      initialConfidence = computeRetrievalConfidence(lexicalBestTopScore, lexicalBestDocs.length);
      log('retrieval_confidence_score', {
        score: Number(initialConfidence.toFixed(3)),
      });
      log('merged_doc_count', { count: lexicalBestDocs.length });
    } else {
      log('merged_doc_count', { count: 0 });
    }
  }

  let confidenceForExpansion = initialConfidence;
  const shouldApplyHyde =
    hydeEnabled &&
    Boolean(canonicalQuery) &&
    (scopeTokenCount > 3 || initialConfidence < hydeConfidenceThreshold);
  if (shouldApplyHyde) {
    log('hyde_enabled', {
      query: canonicalQuery,
      query_tokens: scopeTokenCount,
      retrieval_confidence: Number(initialConfidence.toFixed(3)),
      threshold: Number(hydeConfidenceThreshold.toFixed(3)),
      reason: scopeTokenCount > 3 ? 'query_length' : 'low_confidence',
    });
    const hydeResult = await retrieveWithHyDE({
      query: canonicalQuery,
      language: input.userLanguage,
      solrDocs: lexicalBestDocs,
      ragBackendUrl: input.ragBackendUrl,
      ragBackendCollectionName: input.ragBackendCollectionName,
      fileScopeIds,
      metadataFilters: input.metadataFilters,
      onLog: log,
    });
    if (hydeResult.hypotheticalAnswer) {
      log('hypothetical_answer', { text: hydeResult.hypotheticalAnswer });
    }
    if (!hydeResult.similarityScores.length) {
      log('hyde_similarity_scores', { scores: [] });
    }
    if (hydeResult.docs.length > 0) {
      lexicalBestDocs = hydeResult.docs;
      lexicalBestTopScore = Number(lexicalBestDocs[0]?.score || lexicalBestTopScore || 0);
      lexicalBestTopTermHits = Math.max(
        ...lexicalBestDocs.map((doc) => countDocTermHits(doc, lexicalBestQuery || canonicalQuery)),
        0,
      );
      confidenceForExpansion = computeRetrievalConfidence(lexicalBestTopScore, lexicalBestDocs.length);
    }
  }

  const shouldApplyLlmExpansion =
    effectiveLlmExpansionEnabled &&
    (lexicalBestDocs.length === 0 || confidenceForExpansion < lowConfidenceThreshold);
  let llmExpansionApplied = false;
  if (shouldApplyLlmExpansion) {
    const llmQuerySeed = String(canonicalQuery || expandedQueries[0] || '').trim();
    const generatedQueries = await generateQueryVariants(llmQuerySeed, input.userLanguage);
    if (generatedQueries.length > 0) {
      llmExpansionApplied = true;
      log('llm_expansion_applied', {
        query: llmQuerySeed,
        reason: lexicalBestDocs.length === 0 ? 'no_results' : 'low_score',
        top_score: Number(lexicalBestTopScore.toFixed(3)),
        retrieval_confidence: Number(confidenceForExpansion.toFixed(3)),
      });
      log('generated_queries', { queries: generatedQueries });

      const mergedExpandedQueries = uniqueStrings(
        [...expandedQueries, ...generatedQueries],
        8,
      );
      const retryCandidates = mergedExpandedQueries
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .filter((value) => !attemptedQueries.includes(value));

      const retryWildcard = buildFallbackWildcardQuery(mergedExpandedQueries[0] || llmQuerySeed);
      if (
        retryWildcard &&
        !attemptedQueries.includes(retryWildcard) &&
        !retryCandidates.includes(retryWildcard)
      ) {
        retryCandidates.push(retryWildcard);
      }

      for (const candidate of retryCandidates) {
        if (solrCallsCount >= maxSolrCalls) break;
        attemptedQueries.push(candidate);
        const found = await runSolr(
          candidate,
          'fallback',
          preferredMetadataFilters,
          domainPrefilterActive ? 'domain_prefilter' : 'default',
        );
        if (!found.docs.length) continue;
        collectMergedLexicalDocs(found.docs, candidate);

        lexicalBestDocs = found.docs;
        lexicalBestQuery = candidate;
        lexicalBestTopScore = Number(found.topScore || 0);
        lexicalBestTopTermHits = Math.max(
          ...found.docs.map((doc) => countDocTermHits(doc, candidate)),
          0,
        );
        break;
      }
    }
  }

  if (
    effectiveQueryRepairEnabled &&
    lexicalBestDocs.length === 0 &&
    llmExpansionApplied &&
    solrCallsCount < maxSolrCalls
  ) {
    const repairSeed = String(canonicalQuery || expandedQueries[0] || '').trim();
    const repairedQuery = await repairQueryForHrRetrieval(repairSeed);
    const repaired = String(repairedQuery || '').trim();
    if (repaired && !attemptedQueries.includes(repaired)) {
      log('query_repair_applied', {
        original_query: repairSeed,
        repaired_query: repaired,
      });
      attemptedQueries.push(repaired);
      const repairedResult = await runSolr(
        repaired,
        'fallback',
        preferredMetadataFilters,
        domainPrefilterActive ? 'domain_prefilter' : 'default',
      );
      if (repairedResult.docs.length > 0) {
        lexicalBestDocs = repairedResult.docs;
        lexicalBestQuery = repaired;
        lexicalBestTopScore = Number(repairedResult.topScore || 0);
        lexicalBestTopTermHits = Math.max(
          ...repairedResult.docs.map((doc) => countDocTermHits(doc, repaired)),
          0,
        );
      }
    }
  }

  if (lexicalBestDocs.length > 0) {
    return {
      docs: lexicalBestDocs,
      retrievalQueryUsed: lexicalBestQuery,
      attemptedQueries,
      lexicalDocsFound: true,
      usedSemanticFallback: false,
      queryTranslationApplied,
      translatedQuery,
      japaneseRetrievalQueries,
      topScore: lexicalBestTopScore,
      topTermHits: lexicalBestTopTermHits,
      solrCallsCount,
      translateCallsCount,
      translateMs,
    };
  }

  const backendUrl = String(input.ragBackendUrl || config?.RAG?.Backend?.url || process.env.RAG_BACKEND_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!backendUrl) {
    return {
      docs: [],
      retrievalQueryUsed: lexicalBestQuery,
      attemptedQueries,
      lexicalDocsFound: lexicalBestDocs.length > 0,
      usedSemanticFallback: false,
      queryTranslationApplied,
      translatedQuery,
      japaneseRetrievalQueries,
      topScore: lexicalBestTopScore,
      topTermHits: lexicalBestTopTermHits,
      solrCallsCount,
      translateCallsCount,
      translateMs,
    };
  }

  log('semantic_fallback_start', {
    reason: lexicalBestDocs.length === 0 ? 'no_lexical_hits' : 'low_relevance',
    lexical_top_score: Number(lexicalBestTopScore.toFixed(3)),
    lexical_top_hits: lexicalBestTopTermHits,
  });

  // Keep semantic/vector fallback anchored to the original user-language query.
  // This avoids drifting into unrelated translated terms.
  const semanticQueryCandidates = uniqueStrings(
    input.userLanguage === 'en'
      ? [translatedQuery, ...japaneseRetrievalQueries, canonicalQuery, input.queryForRAG]
      : [canonicalQuery, input.queryForRAG, translatedQuery, ...japaneseRetrievalQueries],
    4,
  );
  let semanticQuery = String(semanticQueryCandidates[0] || '').trim();
  if (!semanticQuery && queryTranslationApplied && translatedQuery) {
    semanticQuery = translatedQuery;
  }
  log('semantic_fallback_queries', {
    queries: semanticQueryCandidates,
  });

  const semanticVectorOnly = readBooleanEnv(
    'RAG_SEMANTIC_VECTOR_ONLY',
    Boolean(config?.RAG?.Retrieval?.HybridSearch?.vector_only ?? true),
  );
  const semanticBm25OnlyRaw = readBooleanEnv(
    'RAG_SEMANTIC_BM25_ONLY',
    Boolean(config?.RAG?.Retrieval?.HybridSearch?.bm25_only ?? false),
  );
  const semanticBm25Only = semanticVectorOnly ? false : semanticBm25OnlyRaw;
  const semanticVectorWeightRaw = Math.max(
    0,
    readNumberEnv('RAG_SEMANTIC_VECTOR_WEIGHT', Number(config?.RAG?.Retrieval?.HybridSearch?.vector_weight ?? 0.5)),
  );
  const semanticBm25WeightRaw = Math.max(
    0,
    readNumberEnv('RAG_SEMANTIC_BM25_WEIGHT', Number(config?.RAG?.Retrieval?.HybridSearch?.bm25_weight ?? 0.5)),
  );
  const semanticWeightTotal = Math.max(0.0001, semanticVectorWeightRaw + semanticBm25WeightRaw);
  const semanticVectorWeight = Number((semanticVectorWeightRaw / semanticWeightTotal).toFixed(4));
  const semanticBm25Weight = Number((semanticBm25WeightRaw / semanticWeightTotal).toFixed(4));

  const payload = {
    collection_name:
      String(input.ragBackendCollectionName || config?.RAG?.PreProcess?.PDF?.splitByArticle?.collectionName || 'splitByArticleWithHybridSearch'),
    query: semanticQuery,
    top_k: Number(config?.RAG?.Retrieval?.topK || 10),
    vector_only: semanticVectorOnly,
    bm25_only: semanticBm25Only,
    vector_weight: semanticVectorWeight,
    bm25_weight: semanticBm25Weight,
    bm25_params: config?.RAG?.Retrieval?.HybridSearch?.bm25_params || { k1: 1.8, b: 0.75 },
    ...(fileScopeIds.length ? { candidate_file_ids: fileScopeIds } : {}),
    ...(input.metadataFilters ? { metadata_filters: input.metadataFilters } : {}),
  };

  try {
    const res = await withTimeout(
      () => fetch(`${backendUrl}/search/hybrid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      ragBackendTimeoutMs,
    );

    if (!res.ok) {
      log('semantic_fallback_result', {
        status: `http_${res.status}`,
        docs: 0,
        query: semanticQuery,
      });
      return {
        docs: [],
        retrievalQueryUsed: semanticQuery || lexicalBestQuery,
        attemptedQueries,
        lexicalDocsFound: lexicalBestDocs.length > 0,
        usedSemanticFallback: true,
        queryTranslationApplied,
        translatedQuery,
        japaneseRetrievalQueries,
        topScore: lexicalBestTopScore,
        topTermHits: lexicalBestTopTermHits,
        solrCallsCount,
        translateCallsCount,
        translateMs,
      };
    }

    const body = await res.json();
    const docs = normalizeSemanticDocs(body, Number(payload.top_k || 10));
    const topScore = Number(docs?.[0]?.score || 0);
    const topTermHits = Math.max(...docs.map((doc) => countDocTermHits(doc, semanticQuery)), 0);
    log('semantic_fallback_result', {
      query: semanticQuery,
      docs: docs.length,
      top_score: Number(topScore.toFixed(3)),
      top_term_hits: topTermHits,
      translated_query_applied: queryTranslationApplied,
    });

    return {
      docs,
      retrievalQueryUsed: semanticQuery || lexicalBestQuery,
      attemptedQueries,
      lexicalDocsFound: lexicalBestDocs.length > 0,
      usedSemanticFallback: true,
      queryTranslationApplied,
      translatedQuery,
      japaneseRetrievalQueries,
      topScore,
      topTermHits,
      solrCallsCount,
      translateCallsCount,
      translateMs,
    };
  } catch (error: any) {
    log('semantic_fallback_result', {
      status: String(error?.message || 'error'),
      docs: 0,
      query: semanticQuery,
    });
    return {
      docs: [],
      retrievalQueryUsed: semanticQuery || lexicalBestQuery,
      attemptedQueries,
      lexicalDocsFound: lexicalBestDocs.length > 0,
      usedSemanticFallback: true,
      queryTranslationApplied,
      translatedQuery,
      japaneseRetrievalQueries,
      topScore: lexicalBestTopScore,
      topTermHits: lexicalBestTopTermHits,
      solrCallsCount,
      translateCallsCount,
      translateMs,
    };
  }
};
