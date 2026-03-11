/**
 * Query Classification Service
 * Dynamic language + query-shape analysis without fixed domain keyword lists.
 */

import { detectLanguage as detectSharedLanguage } from '@/utils/languageDetector';
import { classifyQueryIntent } from '@/utils/queryIntentClassifier';

export interface ClassificationResult {
  isCompanyQuery: boolean;
  language: 'en' | 'ja';
  confidence: number;
  detectedKeywords: string[];
  reason: string;
  queryType: 'company' | 'general';
}

const QUERY_CLASSIFICATION_VERBOSE = process.env.QUERY_CLASSIFICATION_VERBOSE === '1';
const qcLog = (...args: any[]) => {
  if (QUERY_CLASSIFICATION_VERBOSE) console.log(...args);
};

const countVisibleTokens = (query: string): number => {
  const tokens = String(query || '')
    .normalize('NFKC')
    .replace(/[“”"'`]/g, ' ')
    .replace(/[?？!！,，.:;；/／\\()[\]{}<>「」『』【】]/g, ' ')
    .split(/\s+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 2);
  return tokens.length;
};

/**
 * Detect language of the query
 * Returns 'en' for English, 'ja' for Japanese
 */
export function detectLanguage(query: string): 'en' | 'ja' {
  const text = String(query || '');
  const language = detectSharedLanguage(text);

  qcLog('🔤 [Language Detection]', {
    query: text.substring(0, 80),
    language,
  });

  return language;
}

/**
 * Classify query as company-related or general.
 * This system defaults to RAG-company mode for non-empty user queries.
 */
export function classifyQuery(query: string): ClassificationResult {
  const text = String(query || '').trim();
  const language = detectLanguage(text);
  const tokenCount = countVisibleTokens(text);
  const questionLike = /[?？]$/.test(text) || /[?？]/.test(text);
  const intent = classifyQueryIntent(text);

  const isCompanyQuery = intent.intent === 'rag_query';
  const confidence = text.length === 0
    ? 0
    : Math.max(0.5, Math.min(0.95, 0.58 + (Math.log2(Math.max(2, tokenCount + 1)) * 0.09) + (questionLike ? 0.05 : 0)));
  const queryType: 'company' | 'general' = isCompanyQuery ? 'company' : 'general';
  const reason = isCompanyQuery
    ? 'Query intent requires company-document retrieval.'
    : `Query intent routed to ${intent.intent}.`;

  const result: ClassificationResult = {
    isCompanyQuery,
    language,
    confidence,
    detectedKeywords: [],
    reason,
    queryType,
  };

  qcLog('📊 [Query Classification]', result);
  return result;
}

/**
 * Compatibility shim for old callers.
 */
export function getCompanyKeywords(_language: 'en' | 'ja'): string[] {
  return [];
}
