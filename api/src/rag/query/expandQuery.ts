import fs from 'node:fs';
import path from 'node:path';
import { translateQueryForRetrievalDetailed } from '@/utils/query_translation';
import { canonicalizeQuery } from './canonicalizeQuery';
import { normalizeQuery } from './normalizeQuery';
import { routeQuery } from './queryRouter';

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
  generatedJapaneseQueries: string[];
  intentVariants: string[];
  queryForRAG: string;
  multilingualRetrievalQueries: string[];
  queryTranslationApplied: boolean;
  queryTranslationStatus: 'termbase' | 'term_map' | 'semantic_bridge' | 'none';
  translateCallsCount: number;
  translateMs: number;
  queryType: 'procedural' | 'policy' | 'fact' | 'ambiguous';
  domainDetected: 'HR' | 'GA' | 'ACC' | 'OTHER';
  languageDetected: 'en' | 'ja' | 'mixed';
  deterministicTermMapUsed: boolean;
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
const JA_TRANSLATION_COMPOSITE_LOW_SIGNAL_TERMS = new Set([
  ...Array.from(JA_LOW_SIGNAL_TERMS),
  '残業',
  '時間外',
  '申請',
  '勤務',
  '手当',
  '規程',
  '規則',
]);
const JA_PROCEDURAL_HINT_PATTERN = /(申請|手続|手続き|手順|方法|届出|提出|承認|申告|申込み|申し込み)/;
const JA_GENERATED_ARTIFACT_PATTERN = /(報告書|フォーマット|テンプレート|様式|ひな形|雛形|ガイド|マニュアル|承認フロー|作成手順|作成方法)/;
type SemanticBridgeVariants = {
  englishVariants: string[];
  japaneseVariants: string[];
};

type SemanticBridgeRule = {
  key: 'disciplinary' | 'incident' | 'reporting' | 'procedure' | 'workplace' | 'fiscal' | 'harassment';
  pattern: RegExp;
  englishVariants: string[];
  japaneseVariants: string[];
};

const EN_SEMANTIC_BRIDGE_RULES: SemanticBridgeRule[] = [
  {
    key: 'disciplinary',
    pattern: /\bdisciplin(?:ary|e)?\b|\bmisconduct\b|\bsanction\b|\bpunish(?:ment|ive)?\b|\bviolation\b/i,
    englishVariants: ['disciplinary case', 'disciplinary action', 'employee misconduct'],
    japaneseVariants: ['懲戒', '懲戒事案', '懲戒案件', '懲戒処分', '服務規律違反'],
  },
  {
    key: 'incident',
    pattern: /\bincident(s)?\b|\bcase(s)?\b|\bmatter(s)?\b/i,
    englishVariants: ['incident case', 'case handling'],
    japaneseVariants: ['事案', '案件'],
  },
  {
    key: 'reporting',
    pattern: /\breport(?:ing)?\b|\bnotify\b|\bnotification\b|\breportable\b|\bescalat(?:e|ion)\b/i,
    englishVariants: ['reporting process', 'notification workflow', 'report submission'],
    japaneseVariants: ['報告', '報告手続き', '報告フロー', '届出', '申告'],
  },
  {
    key: 'procedure',
    pattern: /\bprocess\b|\bprocedure\b|\bworkflow\b|\bsteps?\b|\bflow\b|\bhow\s+to\b/i,
    englishVariants: ['procedure', 'workflow', 'step-by-step process'],
    japaneseVariants: ['手続き', '手順', 'フロー', '方法'],
  },
  {
    key: 'workplace',
    pattern: /\bworkplace\b|\binternal\s+(?:policy|rule|regulation)\b|\bemployee\s+(?:handbook|manual|guide)\b|\bstaff\s+(?:policy|regulation)\b/i,
    englishVariants: ['internal company process', 'employee procedure'],
    japaneseVariants: ['社内', '職場', '従業員'],
  },
  {
    key: 'fiscal',
    pattern: /\bfiscal\s+year\b|\bfinancial\s+year\b|\baccounting\s+(?:year|period)\b|\bfy\b/i,
    englishVariants: ['fiscal year', 'accounting period'],
    japaneseVariants: ['事業年度', '会計年度', '決算期', '経理規程'],
  },
  {
    key: 'harassment',
    pattern: /\bharass(?:ment|ing)?\b|\bbull(?:y|ying)\b|\bpower\s+harass/i,
    englishVariants: ['power harassment', 'harassment prevention', 'harassment policy'],
    japaneseVariants: ['パワハラ', 'ハラスメント', 'ハラスメント防止', 'パワーハラスメント', '嫌がらせ'],
  },
];

// Static Japanese concept synonym map for terms that users express differently
// from how they appear in HR policy documents.
const JA_CONCEPT_SYNONYM_MAP: Array<{ pattern: RegExp; synonyms: string[] }> = [
  { pattern: /嫌がらせ|いじめ/, synonyms: ['パワハラ', 'ハラスメント', 'ハラスメント防止'] },
  { pattern: /パワハラ/, synonyms: ['ハラスメント', 'ハラスメント防止', '嫌がらせ'] },
  { pattern: /ハラスメント/, synonyms: ['パワハラ', 'ハラスメント防止', '嫌がらせ'] },
  { pattern: /セクハラ/, synonyms: ['セクシャルハラスメント', 'ハラスメント防止'] },
  { pattern: /マタハラ/, synonyms: ['マタニティハラスメント', 'ハラスメント防止'] },
  { pattern: /有休|有給/, synonyms: ['年次有給休暇', '有給休暇'] },
  { pattern: /産休/, synonyms: ['産前産後休暇', '出産休暇'] },
  { pattern: /育休/, synonyms: ['育児休業', '育児休暇'] },
  { pattern: /残業/, synonyms: ['時間外労働', '時間外勤務'] },
];

const expandJapaneseConceptSynonyms = (query: string): string[] => {
  const text = String(query || '').trim();
  if (!text) return [];
  const synonyms: string[] = [];
  for (const rule of JA_CONCEPT_SYNONYM_MAP) {
    if (rule.pattern.test(text)) {
      synonyms.push(...rule.synonyms);
    }
  }
  return synonyms;
};

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
    .sort((left, right) => {
      const leftScore = scoreJapaneseRetrievalVariant(left);
      const rightScore = scoreJapaneseRetrievalVariant(right);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.length - right.length;
    })
    .slice(0, limit);
};

const scoreJapaneseRetrievalVariant = (variant: string): number => {
  const normalized = normalizeSpacing(variant);
  if (!normalized) return -100;
  const terms = normalized.split(/\s+/).filter(Boolean);
  const proceduralHints = (normalized.match(/申請|手続|手順|方法|届出|提出|承認|申告|報告|フロー/g) || []).length;
  const artifactPenalty = JA_GENERATED_ARTIFACT_PATTERN.test(normalized) ? 2.4 : 0;
  const longPenalty = Math.max(0, normalized.length - 16) * 0.14;
  const proceduralOverloadPenalty = Math.max(0, proceduralHints - 2) * 0.85;
  const termBonus =
    terms.length === 1 ? 0.9
      : terms.length <= 3 ? 1.8
        : 0.4;
  const proceduralBonus = proceduralHints > 0 ? 1.4 : 0;
  return termBonus + proceduralBonus - artifactPenalty - longPenalty - proceduralOverloadPenalty;
};

const prioritizeEnglishCrossLanguageQueries = (variants: string[], limit: number): string[] => {
  const japaneseVariants = prioritizeJapaneseVariants(variants, 32);
  if (!japaneseVariants.length) return [];
  return [...japaneseVariants]
    .sort((left, right) => {
      const leftProcedural = JA_PROCEDURAL_HINT_PATTERN.test(left) ? 1 : 0;
      const rightProcedural = JA_PROCEDURAL_HINT_PATTERN.test(right) ? 1 : 0;
      if (leftProcedural !== rightProcedural) return rightProcedural - leftProcedural;
      const leftComposite = left.split(/\s+/).length > 1 ? 1 : 0;
      const rightComposite = right.split(/\s+/).length > 1 ? 1 : 0;
      if (leftComposite !== rightComposite) return rightComposite - leftComposite;
      const leftScore = scoreJapaneseRetrievalVariant(left);
      const rightScore = scoreJapaneseRetrievalVariant(right);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.length - right.length;
    })
    .slice(0, limit);
};

const buildSemanticBridgeVariants = (canonicalQuery: string): SemanticBridgeVariants => {
  const canonical = normalizeSpacing(canonicalQuery.toLowerCase());
  if (!canonical || containsJapanese(canonical)) {
    return { englishVariants: [], japaneseVariants: [] };
  }

  const matchedRules = EN_SEMANTIC_BRIDGE_RULES.filter((rule) => rule.pattern.test(canonical));
  if (!matchedRules.length) {
    return { englishVariants: [], japaneseVariants: [] };
  }

  const matchedKeys = new Set(matchedRules.map((rule) => rule.key));
  const englishVariants = uniqueStringList(
    matchedRules.flatMap((rule) => rule.englishVariants),
    8,
  );
  const japaneseTerms = uniqueStringList(
    matchedRules.flatMap((rule) => rule.japaneseVariants),
    12,
  );

  const japaneseComposites: string[] = [];
  const disciplinaryTerm = japaneseTerms.find((term) => /懲戒|服務規律違反/.test(term)) || '';
  const incidentTerm = japaneseTerms.find((term) => /事案|案件/.test(term)) || '';
  const reportingTerm = japaneseTerms.find((term) => /報告|届出|申告/.test(term)) || '';
  const procedureTerm = japaneseTerms.find((term) => /手続|手順|フロー|方法/.test(term)) || '';
  const workplaceTerm = japaneseTerms.find((term) => /社内|職場|従業員/.test(term)) || '';

  if (disciplinaryTerm && reportingTerm && procedureTerm) {
    japaneseComposites.push(`${disciplinaryTerm} ${reportingTerm} ${procedureTerm}`);
  }
  if (disciplinaryTerm && incidentTerm && reportingTerm) {
    japaneseComposites.push(`${disciplinaryTerm} ${incidentTerm} ${reportingTerm}`);
  }
  if (disciplinaryTerm && incidentTerm && procedureTerm) {
    japaneseComposites.push(`${disciplinaryTerm} ${incidentTerm} ${procedureTerm}`);
  }
  if (workplaceTerm && disciplinaryTerm && reportingTerm) {
    japaneseComposites.push(`${workplaceTerm} ${disciplinaryTerm} ${reportingTerm}`);
  }

  const englishComposites: string[] = [];
  if (matchedKeys.has('disciplinary') && matchedKeys.has('reporting') && matchedKeys.has('procedure')) {
    englishComposites.push(
      'disciplinary incident reporting procedure',
      'employee misconduct reporting process',
      'disciplinary case reporting workflow',
    );
  }
  if (matchedKeys.has('disciplinary') && matchedKeys.has('incident')) {
    englishComposites.push('disciplinary incident case handling');
  }
  if (matchedKeys.has('reporting') && matchedKeys.has('procedure')) {
    englishComposites.push('incident reporting procedure');
  }

  return {
    englishVariants: uniqueStringList([...englishComposites, ...englishVariants], 6),
    japaneseVariants: prioritizeEnglishCrossLanguageQueries(
      [...japaneseComposites, ...japaneseTerms],
      6,
    ),
  };
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

type DomainProfileRule = {
  id: 'HR' | 'GA' | 'ACC';
  keywords: string[];
  patterns: RegExp[];
  languages: ('ja' | 'en')[];
  minScore: number;
};

let cachedRuleSet: QueryExpansionRuleSet | null = null;
let ruleLoadErrorLogged = false;
let cachedDomainProfileRules: DomainProfileRule[] | null = null;
let domainProfileLoadErrorLogged = false;

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

const parseDomainProfileRules = (rows: unknown[]): DomainProfileRule[] =>
  (Array.isArray(rows) ? rows : [])
    .map((row: any) => {
      const id = String(row?.id || '').toUpperCase();
      if (!['HR', 'GA', 'ACC'].includes(id)) return null;
      const keywords = uniqueStringList(row?.keywords || [], 24);
      const patterns = uniqueStringList(row?.patterns || [], 24).flatMap((pattern) => {
        try {
          return [new RegExp(pattern, 'i')];
        } catch {
          return [];
        }
      });
      const languages = uniqueStringList(row?.languages || [], 2)
        .map((value) => String(value || '').toLowerCase())
        .filter((value): value is 'ja' | 'en' => value === 'ja' || value === 'en');
      const minScore = Math.max(0, Number(row?.minScore || 0));
      if (!keywords.length && !patterns.length) return null;
      return {
        id: id as DomainProfileRule['id'],
        keywords,
        patterns,
        languages: languages.length > 0 ? languages : ['ja', 'en'],
        minScore,
      };
    })
    .filter(Boolean) as DomainProfileRule[];

const loadDomainProfileRules = (): DomainProfileRule[] => {
  if (cachedDomainProfileRules) return cachedDomainProfileRules;
  const candidatePaths = uniqueStringList([
    path.resolve(process.cwd(), 'config', 'rag_domain_rules.json'),
    path.resolve(process.cwd(), 'api', 'config', 'rag_domain_rules.json'),
    path.resolve(__dirname, '../../../../config/rag_domain_rules.json'),
    path.resolve(__dirname, '../../../config/rag_domain_rules.json'),
  ]);

  for (const rulePath of candidatePaths) {
    try {
      if (!fs.existsSync(rulePath)) continue;
      const raw = fs.readFileSync(rulePath, 'utf8');
      const parsed = JSON.parse(raw);
      cachedDomainProfileRules = parseDomainProfileRules(parsed);
      return cachedDomainProfileRules;
    } catch (error) {
      if (!domainProfileLoadErrorLogged) {
        domainProfileLoadErrorLogged = true;
        console.warn(
          `[RAG EXPAND] failed to load rag_domain_rules.json from "${rulePath}": ${(error as any)?.message || error}`,
        );
      }
    }
  }

  if (!domainProfileLoadErrorLogged) {
    domainProfileLoadErrorLogged = true;
    console.warn('[RAG EXPAND] rag_domain_rules.json not found; domain profiling is disabled.');
  }

  cachedDomainProfileRules = [];
  return cachedDomainProfileRules;
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

  const substantial = japaneseKeywords
    .map((keyword, index) => ({ keyword, index }))
    .filter(({ keyword }) => keyword.length >= 4 && !JA_TRANSLATION_COMPOSITE_LOW_SIGNAL_TERMS.has(keyword));
  const base = substantial.length >= 2
    ? substantial
    : japaneseKeywords
      .map((keyword, index) => ({ keyword, index }))
      .filter(({ keyword }) => keyword.length >= 3 && !JA_TRANSLATION_COMPOSITE_LOW_SIGNAL_TERMS.has(keyword));

  const prioritized = base
    .sort((a, b) => {
      const leftProcedural = JA_PROCEDURAL_HINT_PATTERN.test(a.keyword) ? 1 : 0;
      const rightProcedural = JA_PROCEDURAL_HINT_PATTERN.test(b.keyword) ? 1 : 0;
      if (leftProcedural !== rightProcedural) return rightProcedural - leftProcedural;
      return (b.keyword.length - a.keyword.length) || (a.index - b.index);
    })
    .map((row) => row.keyword);
  if (prioritized.length < 2) return [];

  const composites = [
    prioritized.slice(0, Math.min(3, prioritized.length)).join(' '),
    prioritized.slice(0, Math.min(2, prioritized.length)).join(' '),
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

const determineQueryType = (queryText: string, language: 'ja' | 'en'): ExpandQueryOutput['queryType'] => {
  const route = routeQuery({
    query: String(queryText || ''),
    language,
    hasHistory: false,
  });

  switch (route.klass) {
    case 'procedural':
      return 'procedural';
    case 'policy':
      return 'policy';
    case 'factual':
    case 'comparison':
      return 'fact';
    case 'follow_up':
    case 'ambiguous':
    default:
      return 'ambiguous';
  }
};

const determineLanguageProfile = (texts: string[]): ExpandQueryOutput['languageDetected'] => {
  const hasJapanese = texts.some((text) => containsJapanese(text));
  const hasLatin = texts.some((text) => /[a-z]/i.test(String(text || '')));
  if (hasJapanese && hasLatin) return 'mixed';
  if (hasJapanese) return 'ja';
  return 'en';
};

const determineDomainProfile = (texts: string[], userLanguage: 'ja' | 'en'): ExpandQueryOutput['domainDetected'] => {
  const queryTexts = uniqueStringList(texts, 12);
  if (!queryTexts.length) return 'OTHER';

  const rules = loadDomainProfileRules();
  let best: { id: ExpandQueryOutput['domainDetected']; score: number; index: number } = {
    id: 'OTHER',
    score: 0,
    index: Number.POSITIVE_INFINITY,
  };

  for (const [index, rule] of rules.entries()) {
    if (rule.languages.length > 0 && !rule.languages.includes(userLanguage)) {
      continue;
    }
    const keywordMatches = rule.keywords.filter((keyword) => queryTexts.some((text) => hasPhrase(text, keyword)));
    const patternMatches = rule.patterns.filter((pattern) => queryTexts.some((text) => pattern.test(text)));
    const keywordScore = rule.keywords.length > 0 ? keywordMatches.length / rule.keywords.length : 0;
    const patternScore = rule.patterns.length > 0 ? patternMatches.length / rule.patterns.length : 0;
    const score = Math.max(keywordScore, patternScore);
    if (score < rule.minScore) continue;
    if (score > best.score || (score === best.score && index < best.index)) {
      best = { id: rule.id, score, index };
    }
  }

  return best.id;
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
  const semanticBridgeVariants =
    input.userLanguage === 'en'
      ? buildSemanticBridgeVariants(canonical)
      : { englishVariants: [], japaneseVariants: [] };
  let translatedKeywords: string[] = [];
  let queryTranslationApplied = false;
  let translateCallsCount = 0;
  let translateMs = 0;
  let queryTranslationStatus: 'termbase' | 'term_map' | 'semantic_bridge' | 'none' = 'none';
  let generatedJapaneseQueries: string[] = [];
  let semanticEnglishVariants: string[] = [];

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

  if (translationExpansionEnabled && canonical && input.userLanguage === 'en') {
    semanticEnglishVariants = uniqueStringList(
      [
        ...semanticBridgeVariants.englishVariants,
      ],
      4,
    );
    generatedJapaneseQueries = prioritizeEnglishCrossLanguageQueries(
      [
        ...semanticBridgeVariants.japaneseVariants,
      ],
      6,
    );
    if (generatedJapaneseQueries.length > 0) {
      queryTranslationApplied = true;
      if (queryTranslationStatus === 'none') {
        queryTranslationStatus = 'semantic_bridge';
      }
    }
  }

  // Expand Japanese concept synonyms from the original query and canonical form
  const jaConceptSynonyms = containsJapanese(rawQuery)
    ? uniqueStringList([
        ...expandJapaneseConceptSynonyms(rawQuery),
        ...expandJapaneseConceptSynonyms(canonical),
      ], 6)
    : [];

  const translatedCompositeQueries = buildTranslatedCompositeQueries(translatedKeywords);
  const japaneseDomainCompositeQueries = buildJapaneseDomainCompositeQueries(canonical, domainOnly);

  const { prioritizedJapaneseKeywords, prioritizedNonJapaneseKeywords } = (() => {
    const keywords = uniqueStringList(translatedKeywords, MAX_TRANSLATED_KEYWORDS);
    const japanese = keywords.filter((keyword) => containsJapanese(keyword));
    const nonJapanese = keywords.filter((keyword) => !containsJapanese(keyword));
    const prioritizedJapaneseKeywords = [...japanese].sort((a, b) => {
      const aProcedural = JA_PROCEDURAL_HINT_PATTERN.test(a) ? 1 : 0;
      const bProcedural = JA_PROCEDURAL_HINT_PATTERN.test(b) ? 1 : 0;
      if (aProcedural !== bProcedural) return bProcedural - aProcedural;
      const aLow = JA_TRANSLATION_COMPOSITE_LOW_SIGNAL_TERMS.has(a) ? 1 : 0;
      const bLow = JA_TRANSLATION_COMPOSITE_LOW_SIGNAL_TERMS.has(b) ? 1 : 0;
      if (aLow !== bLow) return aLow - bLow;
      return (b.length - a.length);
    });
    return {
      prioritizedJapaneseKeywords: uniqueStringList(prioritizedJapaneseKeywords, MAX_TRANSLATED_KEYWORDS),
      prioritizedNonJapaneseKeywords: uniqueStringList(nonJapanese, MAX_TRANSLATED_KEYWORDS),
    };
  })();

  const expandedQueries = uniqueStringList(
    [
      canonical,
      ...jaConceptSynonyms,
      ...semanticEnglishVariants,
      ...generatedJapaneseQueries,
      ...intentOnly,
      ...emailSignatureOnly,
      ...prioritizedJapaneseKeywords,
      ...translatedCompositeQueries,
      ...prioritizedNonJapaneseKeywords,
      ...japaneseDomainCompositeQueries,
      ...domainOnly,
      ...attendanceCorrectionOnly,
    ],
    nonWildcardLimit,
  );

  const profileTexts = uniqueStringList(
    [
      rawQuery,
      normalizedQuery,
      canonical,
      ...expandedQueries,
      ...generatedJapaneseQueries,
      ...semanticEnglishVariants,
      ...translatedKeywords,
      ...domainOnly,
      ...japaneseDomainCompositeQueries,
      ...intentOnly,
      ...attendanceCorrectionOnly,
      ...emailSignatureOnly,
    ],
    32,
  );
  const queryType = determineQueryType(canonical || rawQuery, input.userLanguage);
  const domainDetected = determineDomainProfile(profileTexts, input.userLanguage);
  const languageDetected = determineLanguageProfile(profileTexts);
  const deterministicTermMapUsed = queryTranslationStatus === 'term_map';

  return {
    normalizedQuery,
    canonicalQuery: canonical,
    expandedQueries,
    generatedJapaneseQueries,
    intentVariants: uniqueStringList([canonical, ...intentOnly, ...emailSignatureOnly, ...attendanceCorrectionOnly], nonWildcardLimit),
    queryForRAG: canonical,
    multilingualRetrievalQueries: expandedQueries,
    queryTranslationApplied,
    queryTranslationStatus,
    translateCallsCount,
    translateMs,
    queryType,
    domainDetected,
    languageDetected,
    deterministicTermMapUsed,
  };
};
