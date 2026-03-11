import fs from 'node:fs';
import path from 'node:path';
import { hasJapaneseChars } from '@/rag/language/detectLanguage';

const QUERY_TRANSLATION_CACHE_TTL_MS = Math.max(
  30_000,
  Number(process.env.RAG_QUERY_TRANSLATION_CACHE_TTL_MS || 5 * 60 * 1000),
);
const MAX_TRANSLATED_KEYWORDS = Math.min(
  9,
  Math.max(1, Number(process.env.RAG_QUERY_TRANSLATION_MAX_KEYWORDS || 8)),
);

type TranslationSource = 'termbase' | 'term_map' | 'none';

const queryTranslationCache = new Map<string, { value: string[]; expiresAt: number; source: TranslationSource }>();
let cachedTermbase: Record<string, string[]> | null = null;
let termbaseLoadWarningLogged = false;
type CrossLangRule = { regex: RegExp; keywords: string[] };
type DomainRule = { phrase: string; keywords: string[]; language: 'en' | 'ja' | 'any' };
type RetrievalRuleMap = { crossLangRules: CrossLangRule[]; domainRules: DomainRule[] };
let cachedRuleMap: RetrievalRuleMap | null = null;
let ruleMapLoadWarningLogged = false;

const normalizeSpacing = (value: string): string =>
  String(value || '').replace(/\s+/g, ' ').trim();

const normalizeKeyword = (value: string): string =>
  normalizeSpacing(
    String(value || '')
      .replace(/^[\s"'`([{<]+/, '')
      .replace(/[\s"'`)\]}>.,;:!?]+$/, ''),
  );

const uniqueKeywords = (values: unknown[], limit = MAX_TRANSLATED_KEYWORDS): string[] =>
  Array.from(
    new Set(
      (values || [])
        .map((value) => normalizeKeyword(String(value || '')))
        .filter(Boolean),
    ),
  ).slice(0, limit);

const shouldKeepKeyword = (value: string): boolean => {
  const keyword = normalizeKeyword(value);
  if (!keyword) return false;
  if (hasJapaneseChars(keyword)) return keyword.length >= 2;
  return keyword.length >= 3 && /[a-z0-9]/i.test(keyword);
};

const uniquePaths = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const loadRetrievalTermbase = (): Record<string, string[]> => {
  if (cachedTermbase) return cachedTermbase;

  const candidatePaths = uniquePaths([
    path.resolve(process.cwd(), 'config', 'rag_termbase.json'),
    path.resolve(process.cwd(), 'api', 'config', 'rag_termbase.json'),
    path.resolve(__dirname, '../../../config/rag_termbase.json'),
  ]);

  for (const termbasePath of candidatePaths) {
    try {
      if (!fs.existsSync(termbasePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(termbasePath, 'utf8'));
      cachedTermbase = Object.fromEntries(
        Object.entries(parsed || {}).map(([key, values]) => [
          normalizeSpacing(key),
          uniqueKeywords(Array.isArray(values) ? values : []),
        ]),
      );
      return cachedTermbase;
    } catch (error) {
      if (!termbaseLoadWarningLogged) {
        termbaseLoadWarningLogged = true;
        console.warn(
          `[RAG] failed to load rag_termbase.json from "${termbasePath}": ${(error as any)?.message || error}`,
        );
      }
    }
  }

  if (!termbaseLoadWarningLogged) {
    termbaseLoadWarningLogged = true;
    console.warn('[RAG] rag_termbase.json not found; retrieval translation is disabled.');
  }

  cachedTermbase = {};
  return cachedTermbase;
};

const loadRetrievalRuleMap = (): RetrievalRuleMap => {
  if (cachedRuleMap) return cachedRuleMap;

  const candidatePaths = uniquePaths([
    path.resolve(process.cwd(), 'config', 'rag_term_map.json'),
    path.resolve(process.cwd(), 'api', 'config', 'rag_term_map.json'),
    path.resolve(__dirname, '../../../config/rag_term_map.json'),
    path.resolve(__dirname, '../../../../config/rag_term_map.json'),
  ]);

  for (const rulePath of candidatePaths) {
    try {
      if (!fs.existsSync(rulePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(rulePath, 'utf8'));
      const crossLangRules: CrossLangRule[] = Array.isArray(parsed?.cross_lang)
        ? parsed.cross_lang
            .map((row: any) => {
              const pattern = String(row?.en || '').trim();
              const keywords = uniqueKeywords(Array.isArray(row?.ja) ? row.ja : [], MAX_TRANSLATED_KEYWORDS * 2)
                .filter(shouldKeepKeyword);
              if (!pattern || keywords.length === 0) return null;
              try {
                return {
                  regex: new RegExp(pattern, 'i'),
                  keywords,
                };
              } catch {
                return null;
              }
            })
            .filter(Boolean) as CrossLangRule[]
        : [];
      const domainRules: DomainRule[] = Array.isArray(parsed?.domain_synonyms)
        ? parsed.domain_synonyms
            .map((row: any) => {
              const phrase = normalizeSpacing(String(row?.phrase || ''));
              const keywords = uniqueKeywords(Array.isArray(row?.variants) ? row.variants : [], MAX_TRANSLATED_KEYWORDS * 2)
                .filter(shouldKeepKeyword);
              const language = ['en', 'ja', 'any'].includes(String(row?.language || '').toLowerCase())
                ? String(row?.language || '').toLowerCase() as 'en' | 'ja' | 'any'
                : 'any';
              if (!phrase || keywords.length === 0) return null;
              return {
                phrase,
                keywords,
                language,
              };
            })
            .filter(Boolean) as DomainRule[]
        : [];
      cachedRuleMap = { crossLangRules, domainRules };
      return cachedRuleMap;
    } catch (error) {
      if (!ruleMapLoadWarningLogged) {
        ruleMapLoadWarningLogged = true;
        console.warn(
          `[RAG] failed to load rag_term_map.json from "${rulePath}": ${(error as any)?.message || error}`,
        );
      }
    }
  }

  if (!ruleMapLoadWarningLogged) {
    ruleMapLoadWarningLogged = true;
    console.warn('[RAG] rag_term_map.json not found; retrieval rule-map translation is disabled.');
  }

  cachedRuleMap = { crossLangRules: [], domainRules: [] };
  return cachedRuleMap;
};

const matchesPhrase = (query: string, phrase: string): boolean => {
  const normalizedQuery = normalizeSpacing(query).toLowerCase();
  const normalizedPhrase = normalizeSpacing(phrase).toLowerCase();
  if (!normalizedQuery || !normalizedPhrase) return false;
  if (hasJapaneseChars(normalizedPhrase)) return normalizedQuery.includes(normalizedPhrase);
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedQuery);
};

const findTermbaseKeywords = (query: string): string[] => {
  const source = normalizeSpacing(query);
  if (!source) return [];

  const out: string[] = [];
  const termbase = loadRetrievalTermbase();
  for (const [canonical, synonyms] of Object.entries(termbase)) {
    const candidates = uniqueKeywords([canonical, ...synonyms], MAX_TRANSLATED_KEYWORDS * 2);
    if (!candidates.some((candidate) => matchesPhrase(source, candidate))) continue;
    out.push(...candidates);
  }

  const sourceLower = source.toLowerCase();
  return uniqueKeywords(
    out
      .filter(shouldKeepKeyword)
      .filter((keyword) => keyword.toLowerCase() !== sourceLower)
      .filter((keyword) => !matchesPhrase(source, keyword)),
    MAX_TRANSLATED_KEYWORDS,
  );
};

const findRuleMapKeywords = (query: string): string[] => {
  const source = normalizeSpacing(query);
  if (!source) return [];

  const sourceLower = source.toLowerCase();
  const out: string[] = [];
  const { crossLangRules, domainRules } = loadRetrievalRuleMap();

  const matchedDomainRules = domainRules
    .filter((rule) => rule.language !== 'ja')
    .filter((rule) => matchesPhrase(source, rule.phrase))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  const selectedDomainPhrases: string[] = [];
  for (const rule of matchedDomainRules) {
    if (selectedDomainPhrases.some((phrase) => phrase.includes(rule.phrase))) continue;
    out.push(...rule.keywords.slice(0, 3));
    selectedDomainPhrases.push(rule.phrase);
    if (out.length >= MAX_TRANSLATED_KEYWORDS) break;
  }

  if (out.length < MAX_TRANSLATED_KEYWORDS) {
    for (const rule of crossLangRules) {
      try {
        rule.regex.lastIndex = 0;
      } catch {
        // Ignore regexes without mutable lastIndex.
      }
      if (!rule.regex.test(source)) continue;
      out.push(...rule.keywords.slice(0, 3));
      if (out.length >= MAX_TRANSLATED_KEYWORDS) break;
    }
  }

  return uniqueKeywords(
    out
      .filter(shouldKeepKeyword)
      .filter((keyword) => keyword.toLowerCase() !== sourceLower)
      .filter((keyword) => !matchesPhrase(source, keyword)),
    MAX_TRANSLATED_KEYWORDS,
  );
};

const readCache = (key: string): { keywords: string[]; source: TranslationSource } | null => {
  const entry = queryTranslationCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    queryTranslationCache.delete(key);
    return null;
  }
  return {
    keywords: Array.isArray(entry.value) ? entry.value.slice() : [],
    source: entry.source || 'none',
  };
};

const writeCache = (key: string, value: string[], source: TranslationSource): string[] => {
  const normalized = uniqueKeywords(value, MAX_TRANSLATED_KEYWORDS);
  queryTranslationCache.set(key, {
    value: normalized,
    expiresAt: Date.now() + QUERY_TRANSLATION_CACHE_TTL_MS,
    source,
  });
  return normalized.slice();
};

export type QueryTranslationResult = {
  keywords: string[];
  source: TranslationSource;
  llmCalls: number;
};

export async function translateQueryForRetrievalDetailed(query: string): Promise<QueryTranslationResult> {
  const source = normalizeSpacing(query);
  if (!source) return { keywords: [], source: 'none', llmCalls: 0 };

  const cacheKey = source.toLowerCase();
  const cached = readCache(cacheKey);
  if (cached) {
    return {
      keywords: cached.keywords,
      source: cached.source,
      llmCalls: 0,
    };
  }

  const termbaseKeywords = findTermbaseKeywords(source);
  const ruleMapKeywords = findRuleMapKeywords(source);
  const combinedKeywords = uniqueKeywords(
    [...termbaseKeywords, ...ruleMapKeywords],
    MAX_TRANSLATED_KEYWORDS,
  );
  if (combinedKeywords.length > 0) {
    const keywords = writeCache(
      cacheKey,
      combinedKeywords,
      termbaseKeywords.length > 0 ? 'termbase' : 'term_map',
    );
    return {
      keywords,
      source: termbaseKeywords.length > 0 ? 'termbase' : 'term_map',
      llmCalls: 0,
    };
  }

  const keywords = writeCache(cacheKey, [], 'none');
  return {
    keywords: keywords.slice(),
    source: 'none',
    llmCalls: 0,
  };
}

export async function translateQueryForRetrieval(query: string): Promise<string[]> {
  return (await translateQueryForRetrievalDetailed(query)).keywords;
}
