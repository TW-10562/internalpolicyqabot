import { createHash } from 'node:crypto';

type TranslationCacheEntry = {
  value: string;
  expiresAt: number;
};

const CACHE = new Map<string, TranslationCacheEntry>();

const readNumber = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const CACHE_TTL_MS = Math.max(10_000, readNumber('TRANSLATION_CACHE_TTL_MS', 600_000));
const CACHE_MAX_ENTRIES = Math.max(64, readNumber('TRANSLATION_CACHE_MAX_ENTRIES', 2000));

const normalizeBody = (text: string): string =>
  String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const evictExpired = (): void => {
  const now = Date.now();
  for (const [key, entry] of CACHE.entries()) {
    if (entry.expiresAt <= now) CACHE.delete(key);
  }
};

const enforceMaxEntries = (): void => {
  while (CACHE.size > CACHE_MAX_ENTRIES) {
    const oldestKey = CACHE.keys().next().value;
    if (!oldestKey) break;
    CACHE.delete(oldestKey);
  }
};

export const buildTranslationCacheKey = (params: {
  body: string;
  sourceLanguage: string;
  targetLanguage: string;
  model: string;
  promptVersion: string;
}): string => {
  const normalizedBody = normalizeBody(params.body);
  const bodyHash = createHash('sha256').update(normalizedBody).digest('hex');
  return [
    'translation',
    String(params.sourceLanguage || 'unknown'),
    String(params.targetLanguage || 'unknown'),
    String(params.model || 'unknown'),
    String(params.promptVersion || 'v1'),
    bodyHash,
  ].join(':');
};

export const getCachedTranslation = (key: string): string | null => {
  evictExpired();
  const hit = CACHE.get(String(key || ''));
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    CACHE.delete(String(key || ''));
    return null;
  }
  return hit.value;
};

export const setCachedTranslation = (key: string, value: string): void => {
  if (!String(key || '').trim()) return;
  const normalized = normalizeBody(value);
  if (!normalized) return;
  evictExpired();
  CACHE.set(String(key), {
    value: normalized,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  enforceMaxEntries();
};

