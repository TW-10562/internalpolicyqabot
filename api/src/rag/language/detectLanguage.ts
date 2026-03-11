import {
  detectLanguage as detectSharedLanguage,
  hasJapaneseCharacters,
  japaneseCharRatio as getJapaneseCharRatio,
} from '@/utils/languageDetector';

export type RagLanguage = 'ja' | 'en';

export const detectRagLanguage = (query: string): RagLanguage => detectSharedLanguage(query);

export const hasJapaneseChars = (value: string): boolean =>
  hasJapaneseCharacters(value);

export const looksMostlyEnglish = (text: string): boolean => {
  const value = String(text || '');
  const latinCount = (value.match(/[A-Za-z]/g) || []).length;
  const jaCount = (value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  if (!value.trim()) return false;
  return latinCount >= 40 && latinCount >= jaCount * 4;
};

export const japaneseCharRatio = (text: string): number => {
  return getJapaneseCharRatio(text);
};
