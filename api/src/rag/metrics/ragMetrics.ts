import fs from 'node:fs';
import path from 'node:path';

export type RagMetricEvent = {
  retrievalHit: boolean;
  usedFallback: boolean;
  groundedAnswer: boolean;
  latencyMs: number;
};

type RagMetricsState = {
  totalRequests: number;
  retrievalHits: number;
  fallbackUsed: number;
  groundedAnswers: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  retrievalHitRate: number;
  fallbackRate: number;
  groundedAnswerRate: number;
  updatedAt: string;
};

const defaultState = (): RagMetricsState => ({
  totalRequests: 0,
  retrievalHits: 0,
  fallbackUsed: 0,
  groundedAnswers: 0,
  totalLatencyMs: 0,
  averageLatencyMs: 0,
  retrievalHitRate: 0,
  fallbackRate: 0,
  groundedAnswerRate: 0,
  updatedAt: new Date().toISOString(),
});

const metricsFilePath = path.resolve(
  process.cwd(),
  process.env.RAG_METRICS_FILE || 'rag_metrics.json',
);

let state: RagMetricsState | null = null;

const computeRates = (input: RagMetricsState): RagMetricsState => {
  const total = Math.max(1, input.totalRequests);
  return {
    ...input,
    averageLatencyMs: Number((input.totalLatencyMs / total).toFixed(3)),
    retrievalHitRate: Number((input.retrievalHits / total).toFixed(6)),
    fallbackRate: Number((input.fallbackUsed / total).toFixed(6)),
    groundedAnswerRate: Number((input.groundedAnswers / total).toFixed(6)),
    updatedAt: new Date().toISOString(),
  };
};

const loadState = (): RagMetricsState => {
  if (state) return state;
  try {
    if (fs.existsSync(metricsFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(metricsFilePath, 'utf8'));
      state = {
        ...defaultState(),
        ...parsed,
      };
      return state;
    }
  } catch {
    // Fall back to fresh state when file is invalid or unreadable.
  }
  state = defaultState();
  return state;
};

const flushState = (current: RagMetricsState) => {
  try {
    fs.writeFileSync(metricsFilePath, JSON.stringify(current, null, 2), 'utf8');
  } catch (error: any) {
    console.warn('[RAG METRICS] Failed to write rag_metrics.json:', error?.message || error);
  }
};

export const recordRagMetricEvent = (event: RagMetricEvent): RagMetricsState => {
  const current = loadState();
  const next: RagMetricsState = {
    ...current,
    totalRequests: current.totalRequests + 1,
    retrievalHits: current.retrievalHits + (event.retrievalHit ? 1 : 0),
    fallbackUsed: current.fallbackUsed + (event.usedFallback ? 1 : 0),
    groundedAnswers: current.groundedAnswers + (event.groundedAnswer ? 1 : 0),
    totalLatencyMs: Number((current.totalLatencyMs + Math.max(0, Number(event.latencyMs || 0))).toFixed(3)),
  };

  const computed = computeRates(next);
  state = computed;
  flushState(computed);
  return computed;
};

export const readRagMetrics = (): RagMetricsState => {
  return computeRates(loadState());
};
