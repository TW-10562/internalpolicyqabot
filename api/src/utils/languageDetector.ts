export type SupportedLanguage = 'ja' | 'en';

const JA_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g;
const VISIBLE_CHAR_PATTERN = /[A-Za-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g;
const JAPANESE_RATIO_THRESHOLD = 0.2;

export const japaneseCharRatio = (text: string): number => {
  const value = String(text || '');
  const japaneseChars = (value.match(JA_CHAR_PATTERN) || []).length;
  const visibleChars = (value.match(VISIBLE_CHAR_PATTERN) || []).length;
  if (visibleChars <= 0) return 0;
  return japaneseChars / visibleChars;
};

export const hasJapaneseCharacters = (text: string): boolean =>
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(String(text || ''));

export const detectLanguage = (text: string): SupportedLanguage =>
  japaneseCharRatio(text) >= JAPANESE_RATIO_THRESHOLD ? 'ja' : 'en';

export default detectLanguage;
