export type RagIntentLabel =
  | 'HR_PAYROLL_ATTENDANCE'
  | 'FINANCE_ACCOUNTING'
  | 'COMMUTING_ALLOWANCE'
  | 'IT_SUPPORT'
  | 'GENERAL_POLICY'
  | 'UNKNOWN';

export type StrongIntentRoute = {
  label: RagIntentLabel;
  confidence: number;
  matchedTerms: string[];
};

const JA_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff]/;
const EN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'the',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'would',
  'you',
  'your',
]);

const normalizeUnicode = (value: string): string => {
  try {
    return String(value || '').normalize('NFKC');
  } catch {
    return String(value || '');
  }
};

const normalizeToken = (token: string): string => {
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (JA_CHAR_RE.test(raw)) return raw;
  return raw.toLowerCase();
};

const shouldKeepEnglishToken = (token: string): boolean => {
  const v = String(token || '').trim().toLowerCase();
  if (!v) return false;
  if (v.length <= 2) return false;
  if (EN_STOPWORDS.has(v)) return false;
  return /^[a-z0-9][a-z0-9_-]*$/.test(v);
};

const splitNormalizedTokens = (query: string): string[] => {
  const normalized = normalizeUnicode(query)
    .replace(/[“”"'`]/g, ' ')
    .replace(/[?？!！,，.:;；/／\\()[\]{}<>「」『』【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];

  const out: string[] = [];
  for (const raw of normalized.split(/\s+/)) {
    if (JA_CHAR_RE.test(raw)) {
      const blocks = String(raw || '').match(/[\u30a0-\u30ffー]{2,}|[\u3400-\u9fff]{2,}/g) || [];
      for (const block of blocks) {
        const token = normalizeToken(block);
        if (token && token.length >= 2) out.push(token);
      }
      continue;
    }
    const token = normalizeToken(raw);
    if (!shouldKeepEnglishToken(token)) continue;
    out.push(token);
  }
  return out;
};

const dedupeStable = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

export const canonicalizeRagQuery = (query: string): string =>
  dedupeStable(splitNormalizedTokens(query)).join(' ').trim();

export const rewriteRagQueryWithSynonyms = (query: string): string =>
  canonicalizeRagQuery(query);

const toWildcardToken = (token: string): string => {
  const value = String(token || '').trim();
  if (!value) return '';
  if (JA_CHAR_RE.test(value)) return value;
  const safe = value.replace(/[^a-z0-9_-]/gi, '');
  if (!safe) return '';
  if (safe.length <= 3) return safe;
  return `${safe}*`;
};

export const buildFallbackWildcardQuery = (query: string, _intentLabel: RagIntentLabel): string => {
  const base = canonicalizeRagQuery(query);
  if (!base) return '';
  const fallback = dedupeStable(base.split(/\s+/).map((t) => toWildcardToken(t)).filter(Boolean))
    .slice(0, 12)
    .join(' ');
  return fallback || base;
};

export const routeStrongIntent = (query: string): StrongIntentRoute => {
  const canonical = canonicalizeRagQuery(query);
  return {
    label: 'UNKNOWN',
    confidence: canonical ? 0.4 : 0,
    matchedTerms: canonical ? canonical.split(/\s+/).slice(0, 6) : [],
  };
};

export const resolveBucketCorpusLanguage = (_intentLabel: RagIntentLabel): 'ja' | 'en' | 'multi' => {
  const raw = String(process.env.RAG_BUCKET_CORPUS_LANGUAGE || 'ja').trim().toLowerCase();
  if (raw === 'ja' || raw === 'en' || raw === 'multi') return raw;
  return 'ja';
};
