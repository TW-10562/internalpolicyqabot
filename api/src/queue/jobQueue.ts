import Queue, { JobOptions } from 'bull';
import { config } from '@config/index';

export const jobQueue = new Queue('jobQueue', {
  redis: {
      port: config.Redis.port || Number(process.env.REDIS_PORT) || 6379,
      host: config.Redis.host || process.env.REDIS_HOST || '127.0.0.1',
      password: config.Redis.password || process.env.REDIS_PASSWORD || '',
      db: 11,
    },
});

export const addJob = async <T = any>(name: string, data: T, options?: JobOptions) => {
  await jobQueue.add(name, data, options);
  console.log(`[Bull] Job added: ${name}`);
};
