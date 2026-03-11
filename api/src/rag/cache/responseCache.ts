import { createHash } from 'node:crypto';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  touchedAt: number;
};

const RESPONSE_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.RAG_RESPONSE_CACHE_TTL_MS || 600_000), // 10 minutes
);
const RESPONSE_CACHE_MAX_ENTRIES = Math.max(
  32,
  Number(process.env.RAG_RESPONSE_CACHE_MAX_ENTRIES || 500),
);
const RESPONSE_CACHE_SCHEMA_VERSION = String(
  process.env.RAG_RESPONSE_CACHE_SCHEMA_VERSION || 'v2',
).trim();

const responseCache = new Map<string, CacheEntry<any>>();

const pruneExpired = () => {
  const now = Date.now();
  for (const [key, entry] of responseCache.entries()) {
    if (now >= entry.expiresAt) {
      responseCache.delete(key);
    }
  }
};

const evictIfNeeded = () => {
  if (responseCache.size <= RESPONSE_CACHE_MAX_ENTRIES) return;
  const over = responseCache.size - RESPONSE_CACHE_MAX_ENTRIES;
  const items = [...responseCache.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (let i = 0; i < over; i += 1) {
    const key = items[i]?.[0];
    if (key) responseCache.delete(key);
  }
};

export const buildResponseCacheKey = (args: {
  query?: string;
  canonicalQuery?: string;
  language?: string;
  departmentCode?: string;
  docIds?: string[];
  chunkIds?: string[];
  indexVersion?: string;
  pipelineVersion?: string;
  documentLastUpdated?: string | string[];
}): string => {
  const normalize = (value: string): string =>
    String(value || '').trim().toLowerCase();
  const normalizeList = (values?: string[]): string[] =>
    Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => normalize(String(value || '')))
          .filter(Boolean),
      ),
    ).sort();

  const payload = {
    schemaVersion: normalize(RESPONSE_CACHE_SCHEMA_VERSION),
    query: normalize(String(args.query || '')),
    canonicalQuery: normalize(String(args.canonicalQuery || '')),
    language: normalize(String(args.language || '')),
    departmentCode: normalize(String(args.departmentCode || '')),
    indexVersion: normalize(String(args.indexVersion || '')),
    pipelineVersion: normalize(String(args.pipelineVersion || '')),
    docIds: normalizeList(args.docIds),
    chunkIds: normalizeList(args.chunkIds),
    documentLastUpdated: normalizeList(
      Array.isArray(args.documentLastUpdated)
        ? args.documentLastUpdated
        : [String(args.documentLastUpdated || '')],
    ),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

export const getCachedResponse = <T>(key: string): T | null => {
  if (!key) return null;
  pruneExpired();
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  entry.touchedAt = Date.now();
  return entry.value as T;
};

export const setCachedResponse = <T>(
  key: string,
  value: T,
  ttlMs: number = RESPONSE_CACHE_TTL_MS,
): void => {
  if (!key) return;
  const now = Date.now();
  responseCache.set(key, {
    value,
    expiresAt: now + Math.max(10_000, ttlMs),
    touchedAt: now,
  });
  evictIfNeeded();
};

export const getResponseCacheStats = () => {
  pruneExpired();
  return {
    size: responseCache.size,
    ttlMs: RESPONSE_CACHE_TTL_MS,
    maxEntries: RESPONSE_CACHE_MAX_ENTRIES,
  };
};
