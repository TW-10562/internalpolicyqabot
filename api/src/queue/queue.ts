/* eslint-disable object-curly-newline */
import Queue from 'bull';
import { config } from '@config/index';

export type ChatQueueJobPayload = {
  taskId: string;
  outputId: number;
  sort?: number;
  userId?: number;
  userName?: string;
  requestId: string;
  traceId?: string;
  enqueuedAt: number;
  maxTokens: number;
};

export class ChatQueueOverloadedError extends Error {
  queueDepth: number;

  constructor(message: string, queueDepth: number) {
    super(message);
    this.name = 'ChatQueueOverloadedError';
    this.queueDepth = queueDepth;
  }
}

const commonQueueOptions = {
  redis: {
    port: Number(process.env.REDIS_PORT) || config.Redis.port || 6379,
    host: process.env.REDIS_HOST || config.Redis.host || '127.0.0.1',
    password: process.env.REDIS_PASSWORD || config.Redis.password || '',
    db: 6,
  },
  defaultJobOptions: {
    attempts: Math.max(1, Number(process.env.QUEUE_JOB_ATTEMPTS || 3)),
    backoff: {
      type: 'exponential' as const,
      delay: Math.max(200, Number(process.env.QUEUE_JOB_BACKOFF_MS || 1000)),
    },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
};

const chatGenQueue = new Queue('chat', {
  ...commonQueueOptions,
});

const summaryGenQueue = new Queue('summary', {
  ...commonQueueOptions,
});

const translateGenQueue = new Queue('translate', {
  ...commonQueueOptions,
});

const fileUploadQueue = new Queue('fileUpload', {
  ...commonQueueOptions,
});

const CHAT_QUEUE_MAX_DEPTH = Math.max(0, Number(process.env.CHAT_QUEUE_MAX_DEPTH || 256));

export const getChatQueueStats = async () => {
  const counts = await chatGenQueue.getJobCounts();
  return {
    waiting: Number(counts.waiting || 0),
    active: Number(counts.active || 0),
    delayed: Number(counts.delayed || 0),
    completed: Number(counts.completed || 0),
    failed: Number(counts.failed || 0),
    queueDepth:
      Number(counts.waiting || 0) +
      Number(counts.active || 0) +
      Number(counts.delayed || 0),
  };
};

const addChatGenTask = async (payload: ChatQueueJobPayload) => {
  const stats = await getChatQueueStats();
  if (CHAT_QUEUE_MAX_DEPTH > 0 && stats.queueDepth >= CHAT_QUEUE_MAX_DEPTH) {
    throw new ChatQueueOverloadedError(
      `Chat queue overloaded (queueDepth=${stats.queueDepth}, maxDepth=${CHAT_QUEUE_MAX_DEPTH})`,
      stats.queueDepth,
    );
  }
  const priority = payload.maxTokens <= 384 ? 1 : payload.maxTokens <= 768 ? 3 : 6;
  await chatGenQueue.add(payload, {
    jobId: `${payload.taskId}:${payload.outputId}:${payload.requestId}`,
    priority,
  });
};

const addSummaryGenTask = async (taskId: string) => {
  await summaryGenQueue.add({ taskId, type: 'SUMMARY' });
};

const addTranslateGenTask = async (taskId: string) => {
  await translateGenQueue.add({ taskId, type: 'TRANSLATE' });
};

const addFileUploadTask = async (taskId: string) => {
  await fileUploadQueue.add({ taskId, type: 'FILEUPLOAD' });
};

console.log(`[QUEUE] Producers initialized in PID ${process.pid} (Redis DB 6)`);

export {
  chatGenQueue,
  summaryGenQueue,
  translateGenQueue,
  fileUploadQueue,
  addChatGenTask,
  addSummaryGenTask,
  addTranslateGenTask,
  addFileUploadTask,
};
