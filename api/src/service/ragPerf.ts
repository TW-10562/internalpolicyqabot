import crypto from 'node:crypto';

type StageMetric = {
  name: string;
  ms: number;
  ok?: boolean;
  meta?: Record<string, unknown>;
};

export type RagTrace = {
  enabled: boolean;
  sampled: boolean;
  traceId: string;
  name: string;
  startAt: number;
  stages: StageMetric[];
  ttftMs?: number;
  totalMs?: number;
  meta?: Record<string, unknown>;
};

type RagPerfConfig = {
  enabled: boolean;
  sampleRate: number;
  maxTraces: number;
  logMinMs: number;
};

type StoredTrace = {
  traceId: string;
  name: string;
  totalMs: number;
  ttftMs?: number;
  startedAt: string;
  meta?: Record<string, unknown>;
  stages: StageMetric[];
};

const parseNum = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const cfg: RagPerfConfig = {
  enabled: process.env.RAG_PERF_ENABLED === '1',
  sampleRate: Math.min(1, Math.max(0, parseNum(process.env.RAG_PERF_SAMPLE_RATE, 1))),
  maxTraces: Math.max(10, parseNum(process.env.RAG_PERF_MAX_TRACES, 500)),
  logMinMs: Math.max(0, parseNum(process.env.RAG_PERF_LOG_MIN_MS, 120)),
};

const traces: StoredTrace[] = [];

export type RagPerfStoredTrace = StoredTrace;

const nowMs = () => Date.now();
const monotonicMs = () => Number(process.hrtime.bigint() / BigInt(1_000_000));

const percentile = (vals: number[], p: number): number => {
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const shouldSample = () => {
  if (!cfg.enabled) return false;
  if (cfg.sampleRate >= 1) return true;
  return Math.random() < cfg.sampleRate;
};

export const ragPerfConfig = cfg;

export function startRagTrace(name: string, meta?: Record<string, unknown>): RagTrace {
  const sampled = shouldSample();
  return {
    enabled: cfg.enabled,
    sampled,
    traceId: crypto.randomUUID(),
    name,
    startAt: monotonicMs(),
    stages: [],
    meta,
  };
}

export function stageMs(trace: RagTrace, stageName: string, ms: number, meta?: Record<string, unknown>, ok = true) {
  if (!trace.enabled || !trace.sampled) return;
  trace.stages.push({ name: stageName, ms, ok, meta });
}

export async function withStage<T>(
  trace: RagTrace,
  stageName: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const s = monotonicMs();
  try {
    const out = await fn();
    stageMs(trace, stageName, monotonicMs() - s, meta, true);
    return out;
  } catch (e) {
    stageMs(trace, stageName, monotonicMs() - s, meta, false);
    throw e;
  }
}

export function markTtft(trace: RagTrace) {
  if (!trace.enabled || !trace.sampled || trace.ttftMs != null) return;
  trace.ttftMs = monotonicMs() - trace.startAt;
}

export function finishRagTrace(trace: RagTrace, meta?: Record<string, unknown>) {
  if (!trace.enabled || !trace.sampled) return;

  trace.totalMs = monotonicMs() - trace.startAt;

  const item: StoredTrace = {
    traceId: trace.traceId,
    name: trace.name,
    totalMs: trace.totalMs,
    ttftMs: trace.ttftMs,
    startedAt: new Date(nowMs()).toISOString(),
    meta: { ...(trace.meta || {}), ...(meta || {}) },
    stages: trace.stages,
  };

  traces.push(item);
  if (traces.length > cfg.maxTraces) traces.splice(0, traces.length - cfg.maxTraces);

  const path = String(item.meta?.path || '');
  const noisyPath =
    path === '/api/messages/inbox'
    || path === '/api/notifications'
    || path === '/api/gen-task-output/list'
    || path === '/api/gen-task/list'
    || path === '/api/rag/trace'
    || path === '/api/rag/metrics'
    || path === '/api/rag/kpi';
  const noisyName = item.name === 'auth_middleware' || item.name === 'rbac_scope_resolution';
  const isImportant = item.name === 'rag_chat_pipeline' || item.totalMs >= cfg.logMinMs;
  if (noisyName && noisyPath && !isImportant) {
    return;
  }

  // Structured JSON log (no prompt/content).
  console.log(
    JSON.stringify({
      type: 'rag_perf_trace',
      trace_id: item.traceId,
      name: item.name,
      total_ms: item.totalMs,
      ttft_ms: item.ttftMs,
      stages: item.stages,
      meta: item.meta,
      ts: item.startedAt,
    }),
  );
}

export function getRagPerfSummary() {
  const totals = traces.map((t) => t.totalMs);
  const ttfts = traces
    .map((t) => t.ttftMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  const stageAgg = new Map<string, number[]>();
  for (const t of traces) {
    for (const s of t.stages) {
      const arr = stageAgg.get(s.name) || [];
      arr.push(s.ms);
      stageAgg.set(s.name, arr);
    }
  }

  const stages = Array.from(stageAgg.entries()).map(([name, vals]) => ({
    name,
    count: vals.length,
    avg_ms: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
    p95_ms: percentile(vals, 95),
  }));

  return {
    enabled: cfg.enabled,
    sample_rate: cfg.sampleRate,
    traces_count: traces.length,
    total_ms: {
      avg: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0,
      p50: percentile(totals, 50),
      p95: percentile(totals, 95),
    },
    ttft_ms: {
      avg: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0,
      p50: percentile(ttfts, 50),
      p95: percentile(ttfts, 95),
      count: ttfts.length,
    },
    stages,
    recent: traces.slice(-20),
  };
}

export function findRagTraceByTaskOutput(taskId: string, outputId: number): RagPerfStoredTrace | null {
  const t = String(taskId || '');
  const o = String(outputId || '');
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const item = traces[i];
    if (item?.name !== 'rag_chat_pipeline') continue;
    const metaTask = String(item?.meta?.task_id || '');
    const metaOutput = String(item?.meta?.output_id || '');
    if (metaTask === t && metaOutput === o) {
      return item;
    }
  }
  return null;
}
