const EN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'about',
  'be',
  'been',
  'being',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'how',
  'if',
  'is',
  'me',
  'please',
  'should',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'they',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
]);

const EN_GENERIC_ACTOR_WORDS = new Set([
  'employee',
  'employees',
  'person',
  'people',
  'someone',
  'somebody',
  'anyone',
  'anybody',
  'user',
  'users',
]);

const EN_VERB_HINTS = new Set([
  'apply',
  'ask',
  'approve',
  'check',
  'claim',
  'clock',
  'complete',
  'confirm',
  'contact',
  'create',
  'edit',
  'escalate',
  'end',
  'finish',
  'find',
  'forget',
  'get',
  'inform',
  'know',
  'notify',
  'open',
  'read',
  'report',
  'request',
  'reset',
  'review',
  'see',
  'start',
  'submit',
  'tell',
  'update',
  'use',
  'view',
  'write',
]);

const JP_STOPWORDS = new Set([
  'です',
  'ます',
  'ください',
  '下さい',
  '教えて',
  '詳しく',
  '具体的',
  '具体',
  'どう',
  'よう',
  'どの',
  'どこ',
  'いつ',
  'なに',
  '何',
  'どれ',
  'それ',
  'これ',
  'あれ',
  '場合',
]);

const normalizeUnicode = (value: string): string => {
  try {
    return String(value || '').normalize('NFKC');
  } catch {
    return String(value || '');
  }
};

const JA_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

const hasJapanese = (value: string): boolean => JA_CHAR_RE.test(String(value || ''));
const hasHiragana = (value: string): boolean => /[\u3040-\u309f]/.test(String(value || ''));
const hasKanji = (value: string): boolean => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(value || ''));

const stableUnique = (tokens: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const t = String(token || '').trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
};

const englishTokenize = (query: string): string[] =>
  normalizeUnicode(query)
    .toLowerCase()
    .replace(/[“”"'`]/g, ' ')
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);

const isLikelyVerb = (token: string): boolean => {
  if (EN_VERB_HINTS.has(token)) return true;
  return /(ing|ed|ize|ise|fy|ate|en)$/.test(token);
};

const scoreEnglishToken = (token: string, index: number, total: number): number => {
  const lenScore = Math.min(1, token.length / 10);
  const posScore = total > 1 ? index / (total - 1) : 0.5;
  const verbBoost = isLikelyVerb(token) ? 1.3 : 0.9;
  const actorPenalty = EN_GENERIC_ACTOR_WORDS.has(token) ? 0.6 : 0;
  return (lenScore * 0.9) + (posScore * 1.0) + verbBoost - actorPenalty;
};

const canonicalizeSpecialEnglishQuery = (query: string): string => {
  const normalized = normalizeUnicode(query)
    .toLowerCase()
    .replace(/[“”"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';

  const hasClockIn =
    /\b(clock[\s-]?in|clock[\s-]?out|time\s*card|timecard|timesheet)\b/.test(normalized);
  const hasAttendance =
    /\b(attendance|attendance\s+record(?:s)?|attendance\s+report|work\s+report)\b/.test(normalized);
  const hasCorrection =
    /\b(correct(?:ion)?|adjust(?:ment)?|edit|update|fix|miss(?:ed)?|missing|forgot(?:ten)?|forgot)\b/.test(normalized);

  if (hasClockIn && hasCorrection) {
    return 'missed clock-in attendance correction';
  }
  if (hasClockIn && hasAttendance) {
    return 'clock-in attendance report';
  }
  if (hasAttendance && hasCorrection) {
    return 'attendance correction';
  }
  return '';
};

const canonicalizeEnglish = (query: string): string => {
  const special = canonicalizeSpecialEnglishQuery(query);
  if (special) return special;

  const tokens = englishTokenize(query);
  if (!tokens.length) return '';

  const filtered = tokens.filter((token) => {
    if (token.length <= 1) return false;
    if (EN_STOPWORDS.has(token)) return false;
    if (EN_GENERIC_ACTOR_WORDS.has(token)) return false;
    if (/^\d+$/.test(token)) return false;
    return true;
  });

  const source = filtered.length ? filtered : tokens;
  // Short queries are often already concise; aggressive score-thresholding can
  // drop action tokens (e.g. "report harassment" -> "harassment").
  if (source.length <= 4) {
    return stableUnique(source).join(' ').trim();
  }

  const scored = source.map((token, index) => ({
    token,
    index,
    score: scoreEnglishToken(token, index, source.length),
  }));
  const maxScore = Math.max(...scored.map((row) => row.score), 0);
  const threshold = Math.max(0.95, maxScore - 1.2);
  const kept = scored
    .filter((row) => row.score >= threshold)
    .map((row) => row.token);
  const minKeep = Math.min(3, source.length);
  const keptSet = new Set(kept);
  if (keptSet.size < minKeep) {
    const ranked = [...scored].sort((a, b) => (b.score - a.score) || (a.index - b.index));
    for (const row of ranked) {
      if (keptSet.size >= minKeep) break;
      keptSet.add(row.token);
    }
  }
  const prioritized = source.filter((token) => keptSet.has(token));
  const selected = prioritized.length ? prioritized : source;
  const finalTokens = stableUnique(selected);

  if (!finalTokens.length) {
    const fallback = stableUnique(tokens).slice(-3);
    return fallback.join(' ').trim();
  }
  return finalTokens.join(' ').trim();
};

const normalizeJapaneseToken = (token: string): string => {
  let value = String(token || '').trim();
  if (!value) return '';
  value = value
    .replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
    .replace(/[「」『』【】（）()、。！？!?]/g, '');

  value = value
    .replace(/(でした|ですか|ますか|ます|です|ました|ません|でしょうか|でしょう)$/g, '')
    .replace(/(ください|下さい)$/g, '')
    .replace(/(た場合|場合|とき|時)$/g, '')
    .replace(/(する|した|して|される|された|できる|できた)$/g, '')
    .replace(/(ない|なかった|たい|れば|なら)$/g, '')
    .replace(/([\u3400-\u4dbf\u4e00-\u9fff]{2,})し$/g, '$1');

  return value.trim();
};

const isJapaneseQuestionPhrase = (token: string): boolean => {
  const value = String(token || '').trim();
  if (!value) return false;
  if (/^(どう|どのよう|どの様|なぜ|なんで|いつ|どこ|なに|何|どれ|どちら)/.test(value)) return true;
  if (/すれば(よい|いい)?$/.test(value)) return true;
  return false;
};

const canonicalizeJapanese = (query: string): string => {
  const text = normalizeUnicode(query).trim();
  if (!text) return '';

  const chunks = text
    .replace(/[?？!！。、,，:：;；/／「」『』【】\[\]()（）]/g, ' ')
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);

  const candidates: string[] = [];
  for (const chunk of chunks) {
    const pieces = String(chunk)
      .split(/[をはがにでとへもやかの]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    for (const piece of pieces) {
      const normalized = normalizeJapaneseToken(piece);
      if (!normalized) continue;
      if (JP_STOPWORDS.has(normalized)) continue;
      if (isJapaneseQuestionPhrase(normalized)) continue;
      if (hasHiragana(normalized) && hasKanji(normalized) && normalized.length >= 6) continue;
      if (!hasJapanese(normalized)) continue;
      if (normalized.length >= 2) {
        candidates.push(normalized);
      }
    }

    const blocks = String(chunk).match(/[\u4e00-\u9fff]{2,}|[\u30a0-\u30ffー]{2,}/g) || [];
    for (const block of blocks) {
      const normalized = normalizeJapaneseToken(block);
      if (!normalized) continue;
      if (JP_STOPWORDS.has(normalized)) continue;
      if (isJapaneseQuestionPhrase(normalized)) continue;
      if (normalized.length >= 2) candidates.push(normalized);
    }
  }

  const unique = stableUnique(candidates);
  if (unique.length > 0) return unique.join(' ').trim();

  const fallbackBlocks = text.match(/[\u3040-\u30ff\u4e00-\u9fffー]{2,}/g) || [];
  const fallback = stableUnique(fallbackBlocks.map((v) => normalizeJapaneseToken(v)).filter((v) => v.length >= 2));
  if (fallback.length > 0) return fallback.join(' ').trim();

  return text;
};

export const canonicalizeQuery = (query: string): string => {
  const raw = String(query || '').trim();
  if (!raw) return '';

  const canonical = hasJapanese(raw)
    ? canonicalizeJapanese(raw)
    : canonicalizeEnglish(raw);

  const value = String(canonical || '').trim();
  if (value) return value;

  return normalizeUnicode(raw)
    .replace(/\s+/g, ' ')
    .trim();
};
