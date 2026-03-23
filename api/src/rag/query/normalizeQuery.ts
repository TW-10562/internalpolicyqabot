const normalizeUnicodeNfkc = (value: string): string => {
  try {
    return String(value || '').normalize('NFKC');
  } catch {
    return String(value || '');
  }
};

const normalizePunctuation = (value: string): string =>
  String(value || '')
    .replace(/[“”‘’"'`]/g, ' ')
    .replace(/[、。・，,；;：:！？!?（）()[\]{}<>＜＞]/g, ' ')
    .replace(/[／/\\|]/g, ' ')
    .replace(/[-‐‑‒–—―]+/g, '-')
    .replace(/[　\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const katakanaToHiragana = (value: string): string =>
  Array.from(String(value || ''))
    .map((char) => {
      const code = char.charCodeAt(0);
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
      return `to ${normalizedSuffix}`;
    }
    if (/(ing|ed|ize|ise|fy|ate|en)$/.test(normalizedSuffix)) {
      return `to ${normalizedSuffix}`;
    }
    return match;
  });

export const normalizeQuery = (query: string): string => {
  const nfkc = normalizeUnicodeNfkc(query);
  const punctuationNormalized = normalizePunctuation(nfkc);
  // Lowercase Latin tokens while preserving Japanese text.
  const lowerCasedLatin = punctuationNormalized.replace(/[A-Z]+/g, (match) => match.toLowerCase());
  const runOnEnglishNormalized = splitRunOnEnglishTokens(lowerCasedLatin);
  // Fold Katakana/Hiragana variants into a consistent Hiragana representation.
  const kanaNormalized = katakanaToHiragana(runOnEnglishNormalized);
  return kanaNormalized.replace(/\s+/g, ' ').trim();
};
