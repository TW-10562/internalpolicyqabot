import { hasJapaneseChars } from '@/rag/language/detectLanguage';

export type DomainPrefilterRule = {
  id: string;
  keywords?: string[];
  patterns?: string[];
  metadataFilters?: Record<string, any>;
  languages?: Array<'ja' | 'en'>;
  minScore?: number;
};

export type DomainRouteInput = {
  query: string;
  userLanguage: 'ja' | 'en';
};

export type DomainRouteDecision = {
  applied: boolean;
  domainId?: string;
  confidence: number;
  reason: string;
  matchedKeywords: string[];
  metadataFilters?: Record<string, any>;
};

const readNumber = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const normalizeKeyword = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const tokenizeQuery = (query: string): string[] => {
  const text = String(query || '').trim();
  if (!text) return [];
  const asciiTerms = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const cjkTerms = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) || [])
    .map((token) => token.trim())
    .filter(Boolean);
  return Array.from(new Set([...asciiTerms, ...cjkTerms])).slice(0, 40);
};

const parseRules = (): DomainPrefilterRule[] => {
  const raw = String(process.env.RAG_DOMAIN_PREFILTER_RULES || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any): DomainPrefilterRule | null => {
        if (!item || typeof item !== 'object') return null;
        const id = String(item.id || '').trim();
        if (!id) return null;
        const metadataFilters = item.metadataFilters && typeof item.metadataFilters === 'object'
          ? item.metadataFilters
          : {};
        const keywords = Array.isArray(item.keywords)
          ? item.keywords.map((v: any) => String(v || '').trim()).filter(Boolean)
          : [];
        const patterns = Array.isArray(item.patterns)
          ? item.patterns.map((v: any) => String(v || '').trim()).filter(Boolean)
          : [];
        const languages = Array.isArray(item.languages)
          ? item.languages
            .map((v: any) => String(v || '').trim().toLowerCase())
            .filter((v: string) => v === 'ja' || v === 'en') as Array<'ja' | 'en'>
          : [];
        const minScore = Number(item.minScore);
        return {
          id,
          metadataFilters,
          keywords,
          patterns,
          languages,
          minScore: Number.isFinite(minScore) ? minScore : undefined,
        };
      })
      .filter((rule): rule is DomainPrefilterRule =>
        Boolean(rule && rule.id && rule.metadataFilters && Object.keys(rule.metadataFilters).length > 0),
      );
  } catch {
    return [];
  }
};

const ruleMatchesLanguage = (rule: DomainPrefilterRule, language: 'ja' | 'en'): boolean => {
  const allowed = Array.isArray(rule.languages) ? rule.languages : [];
  if (allowed.length === 0) return true;
  return allowed.includes(language);
};

const scoreRule = (
  rule: DomainPrefilterRule,
  query: string,
  queryTokens: string[],
): { score: number; matchedKeywords: string[]; matchedPatternCount: number } => {
  const loweredQuery = String(query || '').toLowerCase();
  const tokenSet = new Set(queryTokens.map((token) => normalizeKeyword(token)));
  const matchedKeywords: string[] = [];
  const normalizedKeywords = (rule.keywords || [])
    .map((keyword) => normalizeKeyword(keyword))
    .filter(Boolean);

  for (const keyword of normalizedKeywords) {
    if (!keyword) continue;
    if (keyword.includes(' ') || hasJapaneseChars(keyword)) {
      if (loweredQuery.includes(keyword)) matchedKeywords.push(keyword);
      continue;
    }
    if (tokenSet.has(keyword)) matchedKeywords.push(keyword);
  }

  let matchedPatternCount = 0;
  for (const rawPattern of (rule.patterns || [])) {
    try {
      if (!rawPattern) continue;
      const re = new RegExp(rawPattern, 'i');
      if (re.test(query)) matchedPatternCount += 1;
    } catch {
      continue;
    }
  }

  const keywordCoverage = normalizedKeywords.length
    ? matchedKeywords.length / normalizedKeywords.length
    : 0;
  const patternCoverage = (rule.patterns || []).length
    ? matchedPatternCount / Math.max(1, (rule.patterns || []).length)
    : 0;

  const score = clamp((keywordCoverage * 0.7) + (patternCoverage * 0.3), 0, 1);
  return { score, matchedKeywords, matchedPatternCount };
};

export const mergeMetadataFilters = (
  baseFilters?: Record<string, any>,
  extraFilters?: Record<string, any>,
): Record<string, any> | undefined => {
  const base = baseFilters && typeof baseFilters === 'object' ? baseFilters : {};
  const extra = extraFilters && typeof extraFilters === 'object' ? extraFilters : {};
  const keys = Array.from(new Set([...Object.keys(base), ...Object.keys(extra)]));
  if (!keys.length) return undefined;

  const merged: Record<string, any> = {};
  for (const key of keys) {
    const baseValue = (base as any)[key];
    const extraValue = (extra as any)[key];
    if (baseValue == null && extraValue == null) continue;
    if (baseValue == null) {
      merged[key] = extraValue;
      continue;
    }
    if (extraValue == null) {
      merged[key] = baseValue;
      continue;
    }
    if (Array.isArray(baseValue) || Array.isArray(extraValue)) {
      merged[key] = Array.from(
        new Set([
          ...(Array.isArray(baseValue) ? baseValue : [baseValue]),
          ...(Array.isArray(extraValue) ? extraValue : [extraValue]),
        ].map((value) => String(value).trim()).filter(Boolean)),
      );
      continue;
    }
    if (String(baseValue) === String(extraValue)) {
      merged[key] = baseValue;
      continue;
    }
    merged[key] = [String(baseValue), String(extraValue)];
  }
  return Object.keys(merged).length ? merged : undefined;
};

export const routeDomainPrefilter = (
  input: DomainRouteInput,
): DomainRouteDecision => {
  const rules = parseRules();
  if (!rules.length) {
    return {
      applied: false,
      confidence: 0,
      reason: 'no_rules_configured',
      matchedKeywords: [],
    };
  }

  const query = String(input.query || '').trim();
  if (!query) {
    return {
      applied: false,
      confidence: 0,
      reason: 'empty_query',
      matchedKeywords: [],
    };
  }

  const tokens = tokenizeQuery(query);
  const globalMinScore = clamp(readNumber('RAG_DOMAIN_PREFILTER_MIN_SCORE', 0.45), 0, 1);
  let best: {
    rule: DomainPrefilterRule;
    score: number;
    matchedKeywords: string[];
    matchedPatternCount: number;
  } | null = null;

  for (const rule of rules) {
    if (!ruleMatchesLanguage(rule, input.userLanguage)) continue;
    const scored = scoreRule(rule, query, tokens);
    if (!best || scored.score > best.score) {
      best = { rule, ...scored };
    }
  }

  if (!best) {
    return {
      applied: false,
      confidence: 0,
      reason: 'no_language_compatible_rule',
      matchedKeywords: [],
    };
  }

  const threshold = clamp(
    Number.isFinite(Number(best.rule.minScore)) ? Number(best.rule.minScore) : globalMinScore,
    0,
    1,
  );
  if (best.score < threshold) {
    return {
      applied: false,
      confidence: Number(best.score.toFixed(3)),
      reason: 'score_below_threshold',
      domainId: best.rule.id,
      matchedKeywords: best.matchedKeywords,
      metadataFilters: best.rule.metadataFilters,
    };
  }

  return {
    applied: true,
    domainId: best.rule.id,
    confidence: Number(best.score.toFixed(3)),
    reason: 'matched_rule',
    matchedKeywords: best.matchedKeywords,
    metadataFilters: best.rule.metadataFilters,
  };
};

