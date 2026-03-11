export type SolrCallMode = 'primary' | 'fallback';

export type SolrSearchResult = {
  docs: any[];
  numFound: number;
  topScore: number;
};

export type BoundedRetrievalInput = {
  query: string;
  intentLabel: string;
  userLanguage: 'ja' | 'en';
  bucketCorpusLanguage: 'ja' | 'en' | 'multi';
  translationTimeoutMs: number;
  runSolr: (query: string, mode: SolrCallMode) => Promise<SolrSearchResult>;
  buildFallbackQuery: (seedQuery: string, intentLabel: string) => string;
  translateQuery?: (query: string, targetLang: 'ja' | 'en') => Promise<string>;
};

export type BoundedRetrievalOutput = {
  primaryQuery: string;
  retrievalQueryUsed: string;
  translatedQuery: string;
  queryTranslationApplied: boolean;
  result: SolrSearchResult;
  solrCallsCount: number;
  translateCallsCount: number;
  translateMs: number;
};

const emptyResult = (): SolrSearchResult => ({ docs: [], numFound: 0, topScore: 0 });

const withTimeout = async <T>(
  factory: () => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
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

export const runBoundedSolrRetrieval = async (
  input: BoundedRetrievalInput,
): Promise<BoundedRetrievalOutput> => {
  const primaryQuery = String(input.query || '').trim();
  let retrievalQueryUsed = primaryQuery;
  let translatedQuery = '';
  let queryTranslationApplied = false;
  let solrCallsCount = 0;
  let translateCallsCount = 0;
  let translateMs = 0;

  const runSolrBounded = async (query: string, mode: SolrCallMode): Promise<SolrSearchResult> => {
    if (solrCallsCount >= 2) return emptyResult();
    solrCallsCount += 1;
    return await input.runSolr(query, mode);
  };

  const primary = await runSolrBounded(primaryQuery, 'primary');
  if (Array.isArray(primary.docs) && primary.docs.length > 0) {
    return {
      primaryQuery,
      retrievalQueryUsed,
      translatedQuery,
      queryTranslationApplied,
      result: primary,
      solrCallsCount,
      translateCallsCount,
      translateMs,
    };
  }

  let fallbackSeed = primaryQuery;
  const languageMismatch =
    input.bucketCorpusLanguage !== 'multi' &&
    input.bucketCorpusLanguage !== input.userLanguage;
  if (languageMismatch && input.translateQuery) {
    translateCallsCount += 1;
    const translateStart = Date.now();
    try {
      const target: 'ja' | 'en' = input.bucketCorpusLanguage === 'ja' ? 'ja' : 'en';
      const translated = String(
        await withTimeout(
          () => input.translateQuery!(primaryQuery, target),
          Math.max(1200, Math.min(8000, Number(input.translationTimeoutMs || 2500))),
        ),
      ).trim();
      if (translated && translated.toLowerCase() !== primaryQuery.toLowerCase()) {
        fallbackSeed = translated;
        translatedQuery = translated;
        queryTranslationApplied = true;
      }
    } catch {
      // Timeout/errors should not block retrieval.
    } finally {
      translateMs += Date.now() - translateStart;
    }
  }

  const fallbackQuery = String(input.buildFallbackQuery(fallbackSeed, input.intentLabel) || primaryQuery).trim();
  const fallback = await runSolrBounded(fallbackQuery, 'fallback');
  retrievalQueryUsed = fallbackQuery || retrievalQueryUsed;

  return {
    primaryQuery,
    retrievalQueryUsed,
    translatedQuery,
    queryTranslationApplied,
    result: fallback,
    solrCallsCount,
    translateCallsCount,
    translateMs,
  };
};
