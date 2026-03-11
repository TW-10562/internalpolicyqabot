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

export const normalizeQuery = (query: string): string => {
  const nfkc = normalizeUnicodeNfkc(query);
  const punctuationNormalized = normalizePunctuation(nfkc);
  // Lowercase Latin tokens while preserving Japanese text.
  const lowerCasedLatin = punctuationNormalized.replace(/[A-Z]+/g, (match) => match.toLowerCase());
  // Fold Katakana/Hiragana variants into a consistent Hiragana representation.
  const kanaNormalized = katakanaToHiragana(lowerCasedLatin);
  return kanaNormalized.replace(/\s+/g, ' ').trim();
};
