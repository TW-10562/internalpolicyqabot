const normalizeUnicodeNfkc = (value: string): string => {
  try {
    return String(value || '').normalize('NFKC');
  } catch {
    return String(value || '');
  }
};

const normalizePunctuation = (value: string): string =>
  String(value || '')
    .replace(/["\u201c\u201d'\u2018\u2019`]/g, ' ')
    .replace(/[\u3001\u3002\u30fb\uff0c,\uff1b;\uff1a:\uff01\uff1f!?(\uff08\uff09)[\]{}<>\uff1c\uff1e]/g, ' ')
    .replace(/[\uff0f/\\|]/g, ' ')
    .replace(/[-\u2010\u2011\u2012\u2013\u2014\u2015]+/g, '-')
    .replace(/[\u3000\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Collapse repeated identical characters that are likely emphasis noise.
 * Preserves intentional doubles in Japanese (e.g. おおさか) by only collapsing
 * runs of 3+ for CJK punctuation and symbols.
 */
const collapseRepeatedChars = (value: string): string =>
  String(value || '')
    // Collapse 3+ identical punctuation/symbol chars into one
    .replace(/([\u3000-\u303f\uff00-\uffef!?.,:;~\-\u30fc])\1{2,}/g, '$1')
    // Collapse 2+ prolonged sound marks into one
    .replace(/\u30fc{2,}/g, '\u30fc');

/**
 * Normalize Japanese long vowel mark variants.
 * Maps common mis-typed or OCR-garbled dashes to the standard katakana prolonged sound mark.
 */
const normalizeLongVowelMark = (value: string): string =>
  String(value || '')
    // Map fullwidth hyphen, em-dash, en-dash, horizontal bar
    // that appear between kana to the standard choon
    .replace(/([\u3040-\u30ff])[\uff0d\u2014\u2013\u2015]([\u3040-\u30ff])/g, '$1\u30fc$2');

/**
 * Convert katakana to hiragana for consistent matching.
 * Covers standard katakana U+30A1 through U+30F6.
 */
const katakanaToHiragana = (value: string): string =>
  Array.from(String(value || ''))
    .map((char) => {
      const code = char.charCodeAt(0);
      // Standard katakana through small kana
      if (code >= 0x30a1 && code <= 0x30f6) {
        return String.fromCharCode(code - 0x60);
      }
      return char;
    })
    .join('');

const splitRunOnEnglishTokens = (value: string): string =>
  String(value || '').replace(/\bto([a-z]{5,})\b/g, (match, suffix) => {
    const normalizedSuffix = String(suffix || '').toLowerCase();
    if (/(?:apply|approve|request|report|submit|update|reset|check|view|edit|contact|use|know|find|open|read|write|start|finish|create|inform|notify|review|claim|clock|complete|confirm|get)(?:s|ed|ing)?$/.test(normalizedSuffix)) {
      return 'to ' + normalizedSuffix;
    }
    if (/(ing|ed|ize|ise|fy|ate|en)$/.test(normalizedSuffix)) {
      return 'to ' + normalizedSuffix;
    }
    return match;
  });

export const normalizeQuery = (query: string): string => {
  const nfkc = normalizeUnicodeNfkc(query);
  const longVowelNormalized = normalizeLongVowelMark(nfkc);
  const punctuationNormalized = normalizePunctuation(longVowelNormalized);
  const repeatsCollapsed = collapseRepeatedChars(punctuationNormalized);
  // Lowercase Latin tokens while preserving Japanese text.
  const lowerCasedLatin = repeatsCollapsed.replace(/[A-Z]+/g, (match) => match.toLowerCase());
  const runOnEnglishNormalized = splitRunOnEnglishTokens(lowerCasedLatin);
  // Fold Katakana/Hiragana variants into a consistent Hiragana representation.
  const kanaNormalized = katakanaToHiragana(runOnEnglishNormalized);
  return kanaNormalized.replace(/\s+/g, ' ').trim();
};
