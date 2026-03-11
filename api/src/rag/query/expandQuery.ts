import fs from 'node:fs';
import path from 'node:path';
import { translateQueryForRetrievalDetailed } from '@/utils/query_translation';
import { canonicalizeQuery } from './canonicalizeQuery';
import { normalizeQuery } from './normalizeQuery';

export type ExpandQueryInput = {
  originalQueryText: string;
  promptText: string;
  userLanguage: 'ja' | 'en';
  maxVariants?: number;
  enableTranslationExpansion?: boolean;
};

export type ExpandQueryOutput = {
  normalizedQuery: string;
  canonicalQuery: string;
  expandedQueries: string[];
  intentVariants: string[];
  queryForRAG: string;
  multilingualRetrievalQueries: string[];
  queryTranslationApplied: boolean;
  queryTranslationStatus: 'termbase' | 'term_map' | 'none';
  translateCallsCount: number;
  translateMs: number;
};

const MAX_TOTAL_QUERIES = 10;
const MAX_NON_WILDCARD_QUERIES = MAX_TOTAL_QUERIES - 1;
const INTENT_TOKEN_LIMIT = 3;
const MIN_TOTAL_QUERIES_WITH_TRANSLATION = 8;
const MAX_TRANSLATED_KEYWORDS = 8;
const JA_LOW_SIGNAL_TERMS = new Set([
  'いくら',
  '何',
  'どこ',
  'いつ',
  'どう',
  '社員',
  '従業員',
  '会社',
]);

const prioritizeJapaneseVariants = (variants: string[], limit: number): string[] => {
  const unique = uniqueStringList(
    variants
      .filter((variant) => containsJapanese(variant))
      .map((variant) => normalizeSpacing(variant))
      .filter(Boolean),
    32,
  );
  if (!unique.length) return [];

  const substantial = unique.filter((variant) => variant.length >= 4);
  const source = substantial.length > 0 ? substantial : unique;
  return [...source]
    .sort((left, right) => right.length - left.length)
    .slice(0, limit);
};

const normalizeSpacing = (value: string): string =>
  String(value || '').replace(/\s+/g, ' ').trim();

const uniqueStringList = (values: unknown[], limit = 200): string[] =>
  Array.from(
    new Set(
      (values || [])
        .map((value) => normalizeSpacing(String(value || '')))
        .filter(Boolean),
    ),
  ).slice(0, limit);

const containsJapanese = (value: string): boolean =>
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(String(value || ''));

const isKanaDominant = (value: string): boolean => {
  const text = String(value || '');
  const kanaChars = (text.match(/[\u3040-\u30ffー]/g) || []).length;
  const jpChars = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fffー]/g) || []).length;
  return kanaChars >= 4 && jpChars > 0 && kanaChars >= Math.ceil(jpChars * 0.7);
};

const normalizeJapaneseLooseMatch = (value: string): string =>
  normalizeSpacing(normalizeQuery(String(value || ''))).replace(/\s+/g, '');

const commonPrefixLength = (left: string, right: string): number => {
  const a = Array.from(String(left || ''));
  const b = Array.from(String(right || ''));
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
};

const hasPhrase = (text: string, phrase: string): boolean => {
  const target = normalizeSpacing(text.toLowerCase());
  const p = normalizeSpacing(phrase.toLowerCase());
  if (!target || !p) return false;
  if (containsJapanese(p)) return target.includes(p);
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(target);
};

const extractJapaneseTerms = (...sources: string[]): string[] =>
  uniqueStringList(
    sources.flatMap((source) =>
      String(source || '')
        .match(/[\u3040-\u30ffー]{2,}|[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) || [],
    ),
    24,
  );

const matchesJapaneseVariantLoosely = (
  queryTerms: string[],
  queryTexts: string[],
  candidate: string,
): boolean => {
  const variant = normalizeSpacing(candidate);
  if (!variant || !containsJapanese(variant)) return false;

  if (queryTexts.some((text) => hasPhrase(text, variant))) return true;

  const variantLoose = normalizeJapaneseLooseMatch(variant);
  if (!variantLoose || variantLoose.length < 4) return false;

  for (const term of queryTerms) {
    const looseTerm = normalizeJapaneseLooseMatch(term);
    if (!looseTerm || looseTerm.length < 4) continue;
    if (looseTerm === variantLoose) return true;
    if (looseTerm.includes(variantLoose) || variantLoose.includes(looseTerm)) return true;
    if (!isKanaDominant(term) || !isKanaDominant(variant)) continue;
    const prefix = commonPrefixLength(looseTerm, variantLoose);
    const minLen = Math.min(looseTerm.length, variantLoose.length);
    if (prefix >= 4 && prefix >= minLen - 2) return true;
  }
  return false;
};

type ExpansionRule = {
  phrase: string;
  variants: string[];
};

type DomainRule = ExpansionRule & { language?: 'en' | 'ja' | 'any' };
type QueryExpansionRuleSet = {
  shortIntentRules: ExpansionRule[];
  domainRules: DomainRule[];
};

let cachedRuleSet: QueryExpansionRuleSet | null = null;
let ruleLoadErrorLogged = false;

const parseRuleList = (rows: unknown[]): ExpansionRule[] =>
  (Array.isArray(rows) ? rows : [])
    .map((row: any) => ({
      phrase: normalizeSpacing(String(row?.phrase || '')).toLowerCase(),
      variants: uniqueStringList(row?.variants || [], 16),
    }))
    .filter((row) => row.phrase.length > 0 && row.variants.length > 0);

const parseDomainRuleList = (rows: unknown[]): DomainRule[] =>
  (Array.isArray(rows) ? rows : [])
    .map((row: any) => ({
      phrase: normalizeSpacing(String(row?.phrase || '')).toLowerCase(),
      variants: uniqueStringList(row?.variants || [], 16),
      language: ['en', 'ja', 'any'].includes(String(row?.language || '').toLowerCase())
        ? String(row?.language || '').toLowerCase() as 'en' | 'ja' | 'any'
        : 'any',
    }))
    .filter((row) => row.phrase.length > 0 && row.variants.length > 0);

const loadRuleSet = (): QueryExpansionRuleSet => {
  if (cachedRuleSet) return cachedRuleSet;
  const candidatePaths = uniqueStringList([
    path.resolve(process.cwd(), 'config', 'rag_term_map.json'),
    path.resolve(process.cwd(), 'api', 'config', 'rag_term_map.json'),
    path.resolve(__dirname, '../../../../config/rag_term_map.json'),
    path.resolve(__dirname, '../../../config/rag_term_map.json'),
  ]);

  for (const rulePath of candidatePaths) {
    try {
      if (!fs.existsSync(rulePath)) continue;
      const raw = fs.readFileSync(rulePath, 'utf8');
      const parsed = JSON.parse(raw);
      cachedRuleSet = {
        shortIntentRules: parseRuleList(parsed?.short_intent_expansions || []),
        domainRules: parseDomainRuleList(parsed?.domain_synonyms || []),
      };
      return cachedRuleSet;
    } catch (error) {
      if (!ruleLoadErrorLogged) {
        ruleLoadErrorLogged = true;
        console.warn(
          `[RAG EXPAND] failed to load rag_term_map.json from "${rulePath}": ${(error as any)?.message || error}`,
        );
      }
    }
  }

  if (!ruleLoadErrorLogged) {
    ruleLoadErrorLogged = true;
    console.warn('[RAG EXPAND] rag_term_map.json not found; using empty expansion rules.');
  }
  cachedRuleSet = { shortIntentRules: [], domainRules: [] };
  return cachedRuleSet;
};

const buildIntentVariants = (canonicalQuery: string): string[] => {
  const canonical = normalizeSpacing(canonicalQuery.toLowerCase());
  const tokens = canonical.split(/\s+/).filter(Boolean);
  if (!canonical || tokens.length <= 0 || tokens.length > INTENT_TOKEN_LIMIT || containsJapanese(canonical)) {
    return [];
  }

  const out: string[] = [];
  const { shortIntentRules } = loadRuleSet();
  for (const rule of shortIntentRules) {
    if (!hasPhrase(canonical, rule.phrase)) continue;
    out.push(...rule.variants);
  }
  return uniqueStringList(out, MAX_NON_WILDCARD_QUERIES);
};

const buildDomainVariants = (
  rawQuery: string,
  normalizedQuery: string,
  canonicalQuery: string,
  userLanguage: 'ja' | 'en',
): string[] => {
  const raw = normalizeSpacing(rawQuery);
  const normalized = normalizeSpacing(normalizedQuery);
  const canonical = normalizeSpacing(canonicalQuery);
  const queryTexts = uniqueStringList([raw, normalized, canonical], 6);
  if (!queryTexts.length) return [];

  const containsJapaneseQuery = queryTexts.some((text) => containsJapanese(text));
  const languageBucket: 'ja' | 'en' = (userLanguage === 'ja' || containsJapaneseQuery) ? 'ja' : 'en';
  const { domainRules } = loadRuleSet();
  const queryTerms = containsJapaneseQuery
    ? extractJapaneseTerms(...queryTexts)
    : [];

  const out: string[] = [];
  const matchedRules = domainRules
    .filter((rule) => {
      const phraseMatched =
        (rule.language === 'any' || rule.language === languageBucket) &&
        queryTexts.some((text) => hasPhrase(text, rule.phrase));
      if (phraseMatched) return true;
      if (!containsJapaneseQuery) return false;
      return rule.variants.some((variant) => matchesJapaneseVariantLoosely(queryTerms, queryTexts, variant));
    })
    .sort((a, b) => b.phrase.length - a.phrase.length);

  const selectedPhrases: string[] = [];
  for (const rule of matchedRules) {
    if (selectedPhrases.some((phrase) => phrase.includes(rule.phrase))) continue;
    const reverseCanonicalMatch =
      containsJapaneseQuery &&
      (rule.language === 'en' || rule.language === 'any') &&
      !queryTexts.some((text) => hasPhrase(text, rule.phrase)) &&
      rule.variants.some((variant) => matchesJapaneseVariantLoosely(queryTerms, queryTexts, variant));
    if (reverseCanonicalMatch) {
      out.push(rule.phrase);
    }
    out.push(...rule.variants.slice(0, 3));
    selectedPhrases.push(rule.phrase);
  }
  return uniqueStringList(out, MAX_NON_WILDCARD_QUERIES);
};

const buildAttendanceCorrectionVariants = (canonicalQuery: string): string[] => {
  const canonical = normalizeSpacing(canonicalQuery.toLowerCase());
  if (!canonical) return [];

  const hasClockIn =
    /\b(clock[\s-]?in|clock[\s-]?out|time\s*card|timecard|timesheet)\b/.test(canonical);
  const hasAttendance =
    /\b(attendance|attendance\s+record|attendance\s+report|work\s+report)\b/.test(canonical);
  const hasCorrection =
    /\b(correct(?:ion)?|adjust(?:ment)?|edit|update|fix|miss(?:ed)?|missing|forgot(?:ten)?|forgot)\b/.test(canonical);

  if (!hasClockIn && !(hasAttendance && hasCorrection)) return [];

  const variants = [
    'missed clock-in',
    'clock-in correction',
    'attendance correction',
    'attendance record correction',
    '打刻漏れ',
    '勤怠修正',
    '修正申請',
    '出勤簿',
  ];

  if (hasAttendance) {
    variants.push('attendance report correction', '勤務報告');
  }

  return uniqueStringList(variants, MAX_NON_WILDCARD_QUERIES);
};

const buildEmailSignatureVariants = (canonicalQuery: string): string[] => {
  const canonical = normalizeSpacing(canonicalQuery.toLowerCase());
  if (!canonical) return [];

  const hasEmailSignature =
    /\b(e-?mail\s+signature|mail\s+signature|email\s+disclaimer|signature\s+footer)\b/.test(canonical);
  if (!hasEmailSignature) return [];

  return uniqueStringList([
    // Keep the highest-signal Japanese variants first so they survive the Solr call cap.
    '秘密情報保持のお願い',
    'E-mail署名についてのルール',
    'メール署名',
    'E-mail署名',
    '送信した電子メール',
    'email signature',
    'e-mail signature',
  ], MAX_NON_WILDCARD_QUERIES);
};

const buildTranslatedCompositeQueries = (translatedKeywords: string[]): string[] => {
  const japaneseKeywords = uniqueStringList(
    translatedKeywords.filter((keyword) => containsJapanese(keyword)),
    MAX_TRANSLATED_KEYWORDS,
  );
  if (japaneseKeywords.length < 2) return [];

  const prioritized = japaneseKeywords
    .map((keyword, index) => ({ keyword, index }))
    .sort((a, b) => (b.keyword.length - a.keyword.length) || (a.index - b.index))
    .map((row) => row.keyword);

  const composites = [
    prioritized.slice(0, Math.min(6, prioritized.length)).join(' '),
    prioritized.slice(0, Math.min(3, prioritized.length)).join(' '),
  ];
  return uniqueStringList(composites, 2).filter((query) => query.split(/\s+/).length >= 2);
};

const buildJapaneseDomainCompositeQueries = (
  canonicalQuery: string,
  domainVariants: string[],
): string[] => {
  const canonical = normalizeSpacing(canonicalQuery);
  const japaneseVariants = prioritizeJapaneseVariants(domainVariants, 3);
  if (!containsJapanese(canonical) || japaneseVariants.length === 0) return [];

  const canonicalTerms = uniqueStringList(
    canonical
      .split(/\s+/)
      .map((term) => normalizeSpacing(term))
      .filter(Boolean)
      .filter((term) => containsJapanese(term))
      .filter((term) => term.length >= 2)
      .filter((term) => !JA_LOW_SIGNAL_TERMS.has(term))
      .filter((term) => !japaneseVariants.some((variant) => variant.includes(term) || term.includes(variant))),
    4,
  );
  if (!canonicalTerms.length) return [];

  return uniqueStringList([
    [...japaneseVariants, ...canonicalTerms.slice(0, 2)].join(' '),
    [...japaneseVariants.slice(0, 2), ...canonicalTerms.slice(0, 3)].join(' '),
  ], 2).filter((query) => query.split(/\s+/).length >= 2);
};

export const expandQuery = async (input: ExpandQueryInput): Promise<ExpandQueryOutput> => {
  const translationExpansionEnabled = input.enableTranslationExpansion !== false;
  const requestedTotalLimit = Number(input.maxVariants || MAX_TOTAL_QUERIES);
  const totalQueryLimit = Math.max(
    1,
    Math.min(
      MAX_TOTAL_QUERIES,
      Math.max(
        translationExpansionEnabled ? MIN_TOTAL_QUERIES_WITH_TRANSLATION : 1,
        requestedTotalLimit,
      ),
    ),
  );
  const nonWildcardLimit = Math.max(1, Math.min(MAX_NON_WILDCARD_QUERIES, totalQueryLimit - 1));

  const rawQuery = String(input.originalQueryText || input.promptText || '');
  const normalizedQuery = normalizeQuery(rawQuery);
  const canonicalQuery = canonicalizeQuery(rawQuery)
    || canonicalizeQuery(normalizedQuery)
    || normalizeSpacing(normalizedQuery)
    || normalizeSpacing(rawQuery);
  const canonical = normalizeSpacing(canonicalQuery);

  const intentOnly = buildIntentVariants(canonical);
  const emailSignatureOnly = buildEmailSignatureVariants(canonical);
  const domainOnly = buildDomainVariants(rawQuery, normalizedQuery, canonical, input.userLanguage);
  const attendanceCorrectionOnly = buildAttendanceCorrectionVariants(canonical);
  let translatedKeywords: string[] = [];
  let queryTranslationApplied = false;
  let translateCallsCount = 0;
  let translateMs = 0;
  let queryTranslationStatus: 'termbase' | 'term_map' | 'none' = 'none';

  if (translationExpansionEnabled && canonical) {
    const translateStart = Date.now();
    try {
      const translationSeed = normalizeSpacing(normalizedQuery || canonical);
      const translated = await translateQueryForRetrievalDetailed(translationSeed);
      translatedKeywords = uniqueStringList(
        translated.keywords,
        MAX_TRANSLATED_KEYWORDS,
      ).filter((keyword) => keyword.toLowerCase() !== canonical.toLowerCase());
      translateCallsCount = translated.llmCalls;
      queryTranslationStatus = translated.keywords.length > 0 ? translated.source : 'none';
      queryTranslationApplied = translatedKeywords.length > 0;
    } catch {
      translatedKeywords = [];
      queryTranslationStatus = 'none';
    } finally {
      translateMs = Date.now() - translateStart;
    }
  }

  const translatedCompositeQueries = buildTranslatedCompositeQueries(translatedKeywords);
  const japaneseDomainCompositeQueries = buildJapaneseDomainCompositeQueries(canonical, domainOnly);

  const expandedQueries = uniqueStringList(
    [
      canonical,
      ...intentOnly,
      ...emailSignatureOnly,
      ...translatedCompositeQueries,
      ...japaneseDomainCompositeQueries,
      ...domainOnly,
      ...attendanceCorrectionOnly,
      ...translatedKeywords,
    ],
    nonWildcardLimit,
  );

  return {
    normalizedQuery,
    canonicalQuery: canonical,
    expandedQueries,
    intentVariants: uniqueStringList([canonical, ...intentOnly, ...emailSignatureOnly, ...attendanceCorrectionOnly], nonWildcardLimit),
    queryForRAG: canonical,
    multilingualRetrievalQueries: expandedQueries,
    queryTranslationApplied,
    queryTranslationStatus,
    translateCallsCount,
    translateMs,
  };
};
