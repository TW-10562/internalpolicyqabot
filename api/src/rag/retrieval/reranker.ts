import { hasJapaneseChars } from '@/rag/language/detectLanguage';
import { normalizeSearchToken, shouldKeepQueryToken } from './solrRetriever';
import { resolveDocumentImportanceWeight } from './importanceWeight';

export type CandidateFileLike = {
  filename: string;
  storage_key: string;
};

export const extractCjkTerms = (text: string): string[] => {
  const out = new Set<string>();
  const value = String(text || '');
  const mixed = value.match(/[\u30a0-\u30ffー\u3400-\u9fff]{2,}/g) || [];
  for (const token of mixed) {
    const v = String(token || '').trim();
    if (!v) continue;
    out.add(v);
    const parts = v.match(/[\u30a0-\u30ffー]{2,}|[\u3400-\u9fff]{2,}/g) || [];
    for (const p of parts) {
      const pv = String(p || '').trim();
      if (pv) out.add(pv);
    }
  }
  return [...out].slice(0, 8);
};

export const extractJapaneseKeywordTerms = (text: string): string[] => {
  const input = String(text || '').trim();
  if (!input) return [];
  const out = new Set<string>();
  const chunks = input
    .replace(/[?？!！。、,，:：;；/／「」『』【】\[\]()（）]/g, ' ')
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const normalized = chunk;
    if (!normalized) continue;

    const pieces = normalized
      .split(/[のはをにがでとへもやか]+/)
      .map((v) => v.trim())
      .filter((v) => v.length >= 2);
    for (const p of pieces) out.add(p);

    const blocks = normalized.match(/[\u4e00-\u9fff]{2,}|[\u30a0-\u30ffー]{2,}/g) || [];
    for (const block of blocks) {
      const b = String(block || '').trim();
      if (b.length >= 2) out.add(b);
    }
  }

  return [...out].slice(0, 8);
};

export const extractQueryTermsForRerank = (queryText: string): string[] => {
  const raw = String(queryText || '')
    .split(/\s+/)
    .map(normalizeSearchToken)
    .filter(shouldKeepQueryToken);
  const cjkRoots = extractCjkTerms(queryText);
  const cjkParts: string[] = [];
  for (const root of cjkRoots) {
    const v = String(root || '').trim();
    if (!v) continue;
    cjkParts.push(v);
    if (v.length >= 4) {
      cjkParts.push(v.slice(0, 2));
      cjkParts.push(v.slice(-2));
    }
  }
  return Array.from(new Set([...raw, ...cjkParts].filter(Boolean))).slice(0, 16);
};

export const buildRetrievalCandidates = (query: string): string[] => {
  const out: string[] = [];
  const push = (value: string) => {
    const v = String(value || '').trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };

  const base = String(query || '').trim();
  if (!base) return out;
  push(base);

  const latinTokens = base
    .split(/\s+/)
    .map(normalizeSearchToken)
    .map((v) => v.toLowerCase())
    .filter((v) => /^[a-z0-9_-]+$/i.test(v))
    .filter((v) => v.length >= 3)
    .slice(0, 8);
  if (latinTokens.length >= 2) {
    push(latinTokens.join(' '));
    push(latinTokens.slice(0, 3).join(' '));

    // Typo-tolerant variants: collapse repeated characters and keep as
    // alternative candidates (e.g. "overttime" -> "overtime").
    const compactedTokens = latinTokens.map((token) =>
      token.length >= 6 ? token.replace(/([a-z])\1+/gi, '$1') : token,
    );
    if (compactedTokens.some((token, i) => token !== latinTokens[i])) {
      push(compactedTokens.join(' '));
      push(compactedTokens.slice(0, 3).join(' '));
    }
  }

  const jpTerms = extractJapaneseKeywordTerms(base);
  if (jpTerms.length > 0) {
    push(jpTerms.join(' '));
    if (jpTerms.length > 1) push(jpTerms.slice(0, 2).join(' '));
  }

  const cjkTerms = extractCjkTerms(base);
  if (cjkTerms.length > 0) {
    push(cjkTerms.join(' '));
    if (cjkTerms.length > 1) push(cjkTerms.slice(0, 2).join(' '));
  }

  return out;
};

export const tokenizeQueryForFileScope = (query: string): string[] => {
  const latin = String(query || '')
    .split(/\s+/)
    .map((t) => normalizeSearchToken(t).toLowerCase())
    .filter((t) => t.length >= 4)
    .filter((t) => /^[a-z0-9_-]+$/i.test(t));
  const cjk = [
    ...extractCjkTerms(query),
    ...extractJapaneseKeywordTerms(query),
  ]
    .map((t) => String(t || '').trim())
    .filter((t) => t.length >= 2);
  return Array.from(new Set([...latin, ...cjk])).slice(0, 14);
};

export const scoreFileForQuery = (file: CandidateFileLike, queryTokens: string[]): number => {
  const name = String(file?.filename || '').toLowerCase();
  const key = String(file?.storage_key || '').toLowerCase();
  const hay = `${name} ${key}`.replace(/[_\-./\\]+/g, ' ');
  let score = 0;
  for (const token of queryTokens) {
    const t = String(token || '').toLowerCase();
    if (!t) continue;
    if (hasJapaneseChars(t)) {
      if (hay.includes(t)) score += 3;
      continue;
    }
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(hay)) score += 2;
    else if (t.length >= 5 && hay.includes(t)) score += 1;
  }

  return score;
};

export const countFileTokenHits = (file: CandidateFileLike, queryTokens: string[]): number => {
  const name = String(file?.filename || '').toLowerCase();
  const key = String(file?.storage_key || '').toLowerCase();
  const hay = `${name} ${key}`.replace(/[_\-./\\]+/g, ' ');
  let hits = 0;
  for (const token of queryTokens) {
    const t = String(token || '').toLowerCase();
    if (!t) continue;
    if (hasJapaneseChars(t)) {
      if (hay.includes(t)) hits += 1;
      continue;
    }
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(hay) || (t.length >= 5 && hay.includes(t))) hits += 1;
  }
  return hits;
};

export const countDocTermHits = (doc: any, terms: string[]): number => {
  if (!terms.length) return 0;
  const title = Array.isArray(doc?.title) ? String(doc.title[0] || '') : String(doc?.title || '');
  const content = Array.isArray(doc?.content_txt)
    ? String(doc.content_txt.join(' ') || '')
    : String(doc?.content_txt || doc?.content_txt_ja || doc?.content || '');
  const hay = `${title}\n${content}`.toLowerCase();
  const tokenAwareHay = hay.replace(/[_\-./\\]+/g, ' ');
  let hits = 0;
  for (const term of terms) {
    const t = String(term || '').trim();
    if (!t) continue;
    if (hasJapaneseChars(t)) {
      if (hay.includes(t.toLowerCase())) hits += 1;
      continue;
    }
    const lowerTerm = t.toLowerCase();
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(tokenAwareHay)) {
      hits += 1;
      continue;
    }
    if (lowerTerm.length >= 4 && hay.includes(lowerTerm)) {
      hits += 1;
    }
  }
  return hits;
};

export type RerankedDoc = {
  doc: any;
  score: number;
  termHits: number;
  lexicalScore: number;
  importanceWeight: number;
};

export type RerankResult = {
  docs: any[];
  ranked: RerankedDoc[];
  topTermHits: number;
  topScore: number;
};

export const rerankDocuments = (
  docs: any[],
  retrievalQueryUsed: string,
): RerankResult => {
  const inputDocs = Array.isArray(docs) ? docs : [];
  if (inputDocs.length <= 0) {
    return {
      docs: [],
      ranked: [],
      topTermHits: 0,
      topScore: 0,
    };
  }

  const terms = extractQueryTermsForRerank(retrievalQueryUsed);
  const uniqueQueryTerms = Array.from(new Set(terms.map((term) => String(term || '').toLowerCase()).filter(Boolean)));
  const queryTermCount = Math.max(1, uniqueQueryTerms.length);

  const computeLexicalScore = (termHits: number, baseScore: number, importanceWeight: number): number => {
    const coverage = termHits / queryTermCount;
    const multiTokenBoost = termHits >= 2 ? (termHits >= 3 ? 3.5 : 2.0) : 0;
    const partialPenalty = queryTermCount >= 3 && termHits <= 1 ? 2.5 : 0;
    return (
      (termHits * 4) +
      (coverage * 3) +
      multiTokenBoost -
      partialPenalty +
      (Math.log10(Math.max(1, baseScore + 1)) * 1.2) +
      importanceWeight
    );
  };

  const ranked = inputDocs
    .map((doc) => ({
      doc,
      score: Number(doc?.score || 0),
      termHits: countDocTermHits(doc, terms),
      lexicalScore: 0,
      importanceWeight: resolveDocumentImportanceWeight(doc),
    }))
    .map((row) => ({
      ...row,
      lexicalScore: computeLexicalScore(row.termHits, row.score, row.importanceWeight),
    }))
    .sort((a, b) => (b.lexicalScore - a.lexicalScore) || (b.termHits - a.termHits) || (b.score - a.score));

  const filtered = ranked.slice(0, 8);

  const boosted = filtered.filter((row) => row.importanceWeight > 0);
  if (boosted.length > 0) {
    console.log(
      `[RAG PIPELINE] importance_boost_applied count=${boosted.length} max_weight=${Math.max(...boosted.map((row) => row.importanceWeight)).toFixed(3)}`,
    );
  }

  const topTermHits = Number(filtered?.[0]?.termHits || 0);
  const topScore = Number(filtered?.[0]?.score || 0);

  return {
    docs: filtered.map((row) => row.doc),
    ranked: filtered,
    topTermHits,
    topScore,
  };
};
