type SchedulerWorkContext = {
  signal: AbortSignal;
  queueMs: number;
};

type SchedulerMetrics = {
  requestId: string;
  traceId?: string;
  taskId: string;
  outputId: number;
  userId?: number;
  userName?: string;
  enqueuedAt: number;
  admittedAt?: number;
  streamStartedAt?: number;
  finishedAt?: number;
  queueMs?: number;
  generationMs?: number;
  ttftMs?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  cancelled?: boolean;
  failureReason?: string;
  maxTokens: number;
};

type SchedulerRequest<T> = SchedulerMetrics & {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  controller: AbortController;
  timeoutMs: number;
  work: (ctx: SchedulerWorkContext) => Promise<T>;
  userKey: string;
  seq: number;
  timeoutHandle?: NodeJS.Timeout;
  started: boolean;
};

export class InferenceQueueOverloadedError extends Error {
  queueDepth: number;

  constructor(message: string, queueDepth: number) {
    super(message);
    this.name = 'InferenceQueueOverloadedError';
    this.queueDepth = queueDepth;
  }
}

export class InferenceCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InferenceCancelledError';
  }
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const MAX_IN_FLIGHT = parsePositiveInt(process.env.VLLM_MAX_IN_FLIGHT, 4);
const MAX_PENDING = parsePositiveInt(process.env.VLLM_MAX_PENDING_REQUESTS, 128);
const MAX_PER_USER = parsePositiveInt(process.env.VLLM_MAX_IN_FLIGHT_PER_USER, 1);
const DEFAULT_TIMEOUT_MS = parsePositiveInt(process.env.VLLM_REQUEST_TIMEOUT_MS, 120000);
const COMPLETED_METRICS_LIMIT = parsePositiveInt(process.env.VLLM_COMPLETED_METRICS_LIMIT, 1000);

class InferenceScheduler {
  private activeCount = 0;

  private peakActiveCount = 0;

  private pendingCount = 0;

  private peakPendingCount = 0;

  private rrCursor = 0;

  private seq = 0;

  private cancellationCount = 0;

  private startedCount = 0;

  private finishedCount = 0;

  private failedCount = 0;

  private activeByUser = new Map<string, number>();

  private pendingByUser = new Map<string, SchedulerRequest<any>[]>();

  private activeByOutputId = new Map<number, SchedulerRequest<any>>();

  private pendingByOutputId = new Map<number, SchedulerRequest<any>>();

  private metricsByOutputId = new Map<number, SchedulerMetrics>();

  private userOrder: string[] = [];

  private enqueue<T>(request: SchedulerRequest<T>) {
    const queue = this.pendingByUser.get(request.userKey) || [];
    queue.push(request);
    queue.sort((a, b) => (a.maxTokens - b.maxTokens) || (a.seq - b.seq));
    this.pendingByUser.set(request.userKey, queue);
    this.pendingByOutputId.set(request.outputId, request);
    if (!this.userOrder.includes(request.userKey)) {
      this.userOrder.push(request.userKey);
    }
    this.pendingCount += 1;
    this.peakPendingCount = Math.max(this.peakPendingCount, this.pendingCount);
    this.metricsByOutputId.set(request.outputId, {
      requestId: request.requestId,
      traceId: request.traceId,
      taskId: request.taskId,
      outputId: request.outputId,
      userId: request.userId,
      userName: request.userName,
      enqueuedAt: request.enqueuedAt,
      maxTokens: request.maxTokens,
    });
  }

  private dequeueForUser(userKey: string): SchedulerRequest<any> | null {
    const queue = this.pendingByUser.get(userKey) || [];
    if (!queue.length) {
      this.pendingByUser.delete(userKey);
      this.userOrder = this.userOrder.filter((key) => key !== userKey);
      if (this.rrCursor >= this.userOrder.length) this.rrCursor = 0;
      return null;
    }
    const request = queue.shift() || null;
    if (!queue.length) {
      this.pendingByUser.delete(userKey);
      this.userOrder = this.userOrder.filter((key) => key !== userKey);
      if (this.rrCursor >= this.userOrder.length) this.rrCursor = 0;
    } else {
      this.pendingByUser.set(userKey, queue);
    }
    if (request) {
      this.pendingByOutputId.delete(request.outputId);
      this.pendingCount = Math.max(0, this.pendingCount - 1);
    }
    return request;
  }

  private pickNext(): SchedulerRequest<any> | null {
    if (!this.userOrder.length) return null;

    for (let scanned = 0; scanned < this.userOrder.length; scanned += 1) {
      const idx = (this.rrCursor + scanned) % this.userOrder.length;
      const userKey = this.userOrder[idx];
      const activeForUser = this.activeByUser.get(userKey) || 0;
      if (activeForUser >= MAX_PER_USER) continue;

      const next = this.dequeueForUser(userKey);
      if (!next) continue;
      this.rrCursor = this.userOrder.length === 0 ? 0 : idx % this.userOrder.length;
      return next;
    }

    return null;
  }

  private finalizeRequest<T>(
    request: SchedulerRequest<T>,
    patch: Partial<SchedulerMetrics>,
  ) {
    if (request.timeoutHandle) clearTimeout(request.timeoutHandle);
    this.activeByOutputId.delete(request.outputId);
    const nextActiveCount = Math.max(0, (this.activeByUser.get(request.userKey) || 0) - 1);
    if (nextActiveCount > 0) this.activeByUser.set(request.userKey, nextActiveCount);
    else this.activeByUser.delete(request.userKey);
    this.activeCount = Math.max(0, this.activeCount - 1);

    const existing = this.metricsByOutputId.get(request.outputId) || {
      requestId: request.requestId,
      traceId: request.traceId,
      taskId: request.taskId,
      outputId: request.outputId,
      userId: request.userId,
      userName: request.userName,
      enqueuedAt: request.enqueuedAt,
      maxTokens: request.maxTokens,
    };
    const merged = {
      ...existing,
      ...patch,
    } satisfies SchedulerMetrics;
    this.metricsByOutputId.set(request.outputId, merged);
    this.trimMetrics();
    this.drain();
  }

  private trimMetrics() {
    if (this.metricsByOutputId.size <= COMPLETED_METRICS_LIMIT) return;
    const keys = [...this.metricsByOutputId.keys()];
    const trimCount = this.metricsByOutputId.size - COMPLETED_METRICS_LIMIT;
    for (let i = 0; i < trimCount; i += 1) {
      this.metricsByOutputId.delete(keys[i]);
    }
  }

  private start<T>(request: SchedulerRequest<T>) {
    request.started = true;
    request.admittedAt = Date.now();
    request.queueMs = Math.max(0, request.admittedAt - request.enqueuedAt);
    this.activeCount += 1;
    this.startedCount += 1;
    this.peakActiveCount = Math.max(this.peakActiveCount, this.activeCount);
    this.activeByUser.set(request.userKey, (this.activeByUser.get(request.userKey) || 0) + 1);
    this.activeByOutputId.set(request.outputId, request);
    this.metricsByOutputId.set(request.outputId, {
      requestId: request.requestId,
      traceId: request.traceId,
      taskId: request.taskId,
      outputId: request.outputId,
      userId: request.userId,
      userName: request.userName,
      enqueuedAt: request.enqueuedAt,
      admittedAt: request.admittedAt,
      queueMs: request.queueMs,
      maxTokens: request.maxTokens,
    });

    request.timeoutHandle = setTimeout(() => {
      request.controller.abort(
        new Error(`Inference request timed out after ${request.timeoutMs}ms`),
      );
    }, request.timeoutMs);

    Promise.resolve(request.work({
      signal: request.controller.signal,
      queueMs: request.queueMs,
    }))
      .then((result) => {
        this.finishedCount += 1;
        this.finalizeRequest(request, {
          admittedAt: request.admittedAt,
          finishedAt: Date.now(),
          queueMs: request.queueMs,
          generationMs: Math.max(0, Date.now() - Number(request.admittedAt || Date.now())),
        });
        request.resolve(result);
      })
      .catch((error) => {
        const cancelled = request.controller.signal.aborted || error instanceof InferenceCancelledError;
        if (cancelled) {
          this.cancellationCount += 1;
        } else {
          this.failedCount += 1;
        }
        this.finalizeRequest(request, {
          admittedAt: request.admittedAt,
          finishedAt: Date.now(),
          queueMs: request.queueMs,
          generationMs: Math.max(0, Date.now() - Number(request.admittedAt || Date.now())),
          cancelled,
          failureReason: cancelled ? undefined : String((error as any)?.message || error || 'inference_failed'),
        });
        request.reject(error);
      });
  }

  private drain() {
    while (this.activeCount < MAX_IN_FLIGHT) {
      const next = this.pickNext();
      if (!next) break;
      this.start(next);
    }
  }

  schedule<T>(input: {
    requestId: string;
    traceId?: string;
    taskId: string;
    outputId: number;
    userId?: number;
    userName?: string;
    maxTokens: number;
    timeoutMs?: number;
    work: (ctx: SchedulerWorkContext) => Promise<T>;
  }): Promise<T> {
    const queueDepth = this.pendingCount + this.activeCount;
    if (queueDepth >= MAX_PENDING) {
      throw new InferenceQueueOverloadedError(
        `Inference scheduler overloaded (queueDepth=${queueDepth}, maxPending=${MAX_PENDING})`,
        queueDepth,
      );
    }

    return new Promise<T>((resolve, reject) => {
      const userKey = String(input.userId || input.userName || 'anonymous');
      const request: SchedulerRequest<T> = {
        requestId: input.requestId,
        traceId: input.traceId,
        taskId: input.taskId,
        outputId: input.outputId,
        userId: input.userId,
        userName: input.userName,
        enqueuedAt: Date.now(),
        maxTokens: Math.max(1, Number(input.maxTokens || 1)),
        resolve,
        reject,
        controller: new AbortController(),
        timeoutMs: Math.max(1000, Number(input.timeoutMs || DEFAULT_TIMEOUT_MS)),
        work: input.work,
        userKey,
        seq: this.seq,
        started: false,
      };
      this.seq += 1;
      this.enqueue(request);
      this.drain();
    });
  }

  cancel(outputId: number, reason = 'cancelled_by_user'): boolean {
    const pending = this.pendingByOutputId.get(outputId);
    if (pending) {
      const queue = this.pendingByUser.get(pending.userKey) || [];
      const nextQueue = queue.filter((item) => item.outputId !== outputId);
      if (nextQueue.length > 0) {
        this.pendingByUser.set(pending.userKey, nextQueue);
      } else {
        this.pendingByUser.delete(pending.userKey);
        this.userOrder = this.userOrder.filter((key) => key !== pending.userKey);
        if (this.rrCursor >= this.userOrder.length) this.rrCursor = 0;
      }
      this.pendingByOutputId.delete(outputId);
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.cancellationCount += 1;
      this.metricsByOutputId.set(outputId, {
        requestId: pending.requestId,
        traceId: pending.traceId,
        taskId: pending.taskId,
        outputId: pending.outputId,
        userId: pending.userId,
        userName: pending.userName,
        enqueuedAt: pending.enqueuedAt,
        finishedAt: Date.now(),
        queueMs: Math.max(0, Date.now() - pending.enqueuedAt),
        cancelled: true,
        failureReason: reason,
        maxTokens: pending.maxTokens,
      });
      pending.reject(new InferenceCancelledError(reason));
      this.trimMetrics();
      return true;
    }

    const active = this.activeByOutputId.get(outputId);
    if (active) {
      active.controller.abort(new InferenceCancelledError(reason));
      return true;
    }
    return false;
  }

  markStreamStarted(outputId: number) {
    const active = this.activeByOutputId.get(outputId);
    const now = Date.now();
    const base = this.metricsByOutputId.get(outputId);
    if (active && active.streamStartedAt == null) {
      active.streamStartedAt = now;
      if (active.admittedAt) {
        active.ttftMs = Math.max(0, now - active.admittedAt);
      }
    }
    if (base) {
      this.metricsByOutputId.set(outputId, {
        ...base,
        streamStartedAt: base.streamStartedAt || now,
        ttftMs: base.ttftMs ?? (
          base.admittedAt != null ? Math.max(0, now - base.admittedAt) : undefined
        ),
      });
    }
  }

  updateResult(outputId: number, patch: Partial<SchedulerMetrics>) {
    const existing = this.metricsByOutputId.get(outputId);
    if (!existing) return;
    this.metricsByOutputId.set(outputId, { ...existing, ...patch });
    this.trimMetrics();
  }

  consumeMetrics(outputId: number): SchedulerMetrics | null {
    const metrics = this.metricsByOutputId.get(outputId) || null;
    if (metrics) this.metricsByOutputId.delete(outputId);
    return metrics;
  }

  snapshot() {
    const queueDepth = this.pendingCount + this.activeCount;
    return {
      maxInFlight: MAX_IN_FLIGHT,
      maxPending: MAX_PENDING,
      maxPerUser: MAX_PER_USER,
      activeRequests: this.activeCount,
      pendingRequests: this.pendingCount,
      queueDepth,
      peakActiveRequests: this.peakActiveCount,
      peakPendingRequests: this.peakPendingCount,
      startedCount: this.startedCount,
      finishedCount: this.finishedCount,
      failedCount: this.failedCount,
      cancellationCount: this.cancellationCount,
      pendingUsers: this.userOrder.length,
      activeByUser: Object.fromEntries(this.activeByUser.entries()),
    };
  }
}

const scheduler = new InferenceScheduler();

export const scheduleInference = <T>(input: {
  requestId: string;
  traceId?: string;
  taskId: string;
  outputId: number;
  userId?: number;
  userName?: string;
  maxTokens: number;
  timeoutMs?: number;
  work: (ctx: SchedulerWorkContext) => Promise<T>;
}) => scheduler.schedule<T>(input);

export const cancelScheduledInference = (outputId: number, reason?: string) =>
  scheduler.cancel(outputId, reason);

export const markInferenceStreamStarted = (outputId: number) =>
  scheduler.markStreamStarted(outputId);

export const updateInferenceResultMetrics = (
  outputId: number,
  patch: Partial<SchedulerMetrics>,
) => scheduler.updateResult(outputId, patch);

export const consumeInferenceMetrics = (outputId: number) =>
  scheduler.consumeMetrics(outputId);

export const getInferenceSchedulerSnapshot = () => scheduler.snapshot();
