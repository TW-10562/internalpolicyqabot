type SparseVector = Map<string, number>;

export type DeduplicateChunk = {
  text: string;
  metadata?: Record<string, any>;
};

export type DeduplicateContextInput = {
  chunks: DeduplicateChunk[];
  similarityThreshold?: number;
  maxChunks?: number;
};

export type DeduplicateContextOutput = {
  chunks: DeduplicateChunk[];
  removedCount: number;
};

const normalizeForVector = (value: string): string => {
  const text = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”‘’"'`]/g, ' ')
    .replace(/[、。・，,；;：:！？!?（）()[\]{}<>＜＞]/g, ' ')
    .replace(/[\s\t\r\n]+/g, ' ')
    .trim();
  return text;
};

const tokenize = (value: string): string[] => {
  const text = normalizeForVector(value);
  if (!text) return [];

  const latinTokens = text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => /[a-z0-9]/.test(token));

  const cjkRuns = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fffー]{2,}/g) || [];
  const cjkBigrams: string[] = [];
  for (const run of cjkRuns) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length - 1; i += 1) {
      cjkBigrams.push(`${chars[i]}${chars[i + 1]}`);
    }
    cjkBigrams.push(run);
  }

  return [...latinTokens, ...cjkBigrams].slice(0, 500);
};

const toSparseVector = (tokens: string[]): SparseVector => {
  const vector: SparseVector = new Map<string, number>();
  for (const token of tokens) {
    const key = String(token || '').trim();
    if (!key) continue;
    vector.set(key, Number(vector.get(key) || 0) + 1);
  }

  let norm = 0;
  for (const value of vector.values()) {
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;

  for (const [key, value] of vector.entries()) {
    vector.set(key, value / norm);
  }
  return vector;
};

const cosineSimilarity = (left: SparseVector, right: SparseVector): number => {
  if (!left.size || !right.size) return 0;
  let dot = 0;
  const iterate = left.size <= right.size ? left : right;
  const lookup = left.size <= right.size ? right : left;
  for (const [key, value] of iterate.entries()) {
    dot += value * Number(lookup.get(key) || 0);
  }
  return Number(dot.toFixed(6));
};

export const deduplicateContext = (input: DeduplicateContextInput): DeduplicateContextOutput => {
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  const threshold = Math.min(0.99, Math.max(0.5, Number(input.similarityThreshold || 0.9)));
  const maxChunks = Math.max(1, Number(input.maxChunks || 8));

  const kept: DeduplicateChunk[] = [];
  const keptVectors: SparseVector[] = [];
  let removedCount = 0;

  for (const chunk of chunks) {
    if (kept.length >= maxChunks) break;

    const text = String(chunk?.text || '').trim();
    if (!text) continue;

    const vector = toSparseVector(tokenize(text));
    let isDuplicate = false;

    for (let idx = 0; idx < keptVectors.length; idx += 1) {
      const similarity = cosineSimilarity(vector, keptVectors[idx]);
      if (similarity >= threshold) {
        isDuplicate = true;
        removedCount += 1;
        break;
      }
    }

    if (isDuplicate) continue;

    kept.push({
      text,
      metadata: chunk?.metadata,
    });
    keptVectors.push(vector);
  }

  return {
    chunks: kept,
    removedCount,
  };
};
