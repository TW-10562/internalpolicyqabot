/* eslint-disable object-curly-newline */
import Queue from 'bull';
import { config } from '@config/index';

const commonQueueOptions = {
  redis: {
    port: config.Redis.port || Number(process.env.REDIS_PORT) || 6379,
    host: config.Redis.host || process.env.REDIS_HOST || '127.0.0.1',
    password: config.Redis.password || process.env.REDIS_PASSWORD || '',
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

const addChatGenTask = async (taskId: string) => {
  await chatGenQueue.add({ taskId });
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
