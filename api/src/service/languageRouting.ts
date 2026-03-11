import { LanguageCode } from '@/utils/translation';
import { detectLanguage as detectSharedLanguage, hasJapaneseCharacters } from '@/utils/languageDetector';

export type SupportedLanguage = 'ja' | 'en';
export type RetrievalIndexLanguage = 'ja' | 'en' | 'multi';

export type TranslationRoutingDecision = {
  userLanguage: SupportedLanguage;
  workingLanguage: SupportedLanguage;
  workingQuery: string;
  translationApplied: boolean;
};

export function detectMessageLanguage(text: string): SupportedLanguage {
  return detectSharedLanguage(text);
}

export function resolveRetrievalIndexLanguage(raw: unknown): RetrievalIndexLanguage {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'ja' || value === 'en' || value === 'multi') return value;
  return 'multi';
}

export async function buildWorkingQuery(args: {
  query: string;
  userLanguage: SupportedLanguage;
  retrievalIndexLanguage: RetrievalIndexLanguage;
}): Promise<TranslationRoutingDecision> {
  const query = String(args.query || '');
  const { userLanguage, retrievalIndexLanguage } = args;

  if (!query.trim()) {
    return {
      userLanguage,
      workingLanguage: userLanguage,
      workingQuery: query,
      translationApplied: false,
    };
  }

  if (retrievalIndexLanguage === 'multi' || retrievalIndexLanguage === userLanguage) {
    return {
      userLanguage,
      workingLanguage: userLanguage,
      workingQuery: query,
      translationApplied: false,
    };
  }

  const eagerTranslate = String(process.env.RAG_EAGER_QUERY_TRANSLATION || '0') === '1';
  if (!eagerTranslate) {
    return {
      userLanguage,
      workingLanguage: userLanguage,
      workingQuery: query,
      translationApplied: false,
    };
  }

  const targetLanguage: LanguageCode = retrievalIndexLanguage;
  const { translateText } = await import('@/utils/translation');
  const translated = await translateText(query, targetLanguage, true, 0, 6000);
  const translatedText = String(translated || '').trim();
  const originalText = String(query || '').trim();
  const translationSucceeded =
    Boolean(translatedText) &&
    translatedText.toLowerCase() !== originalText.toLowerCase() &&
    (targetLanguage !== 'ja' || hasJapaneseCharacters(translatedText));

  return {
    userLanguage,
    workingLanguage: translationSucceeded ? retrievalIndexLanguage : userLanguage,
    workingQuery: translationSucceeded ? translatedText : query,
    translationApplied: translationSucceeded,
  };
}
