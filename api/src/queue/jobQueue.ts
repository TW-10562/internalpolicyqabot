import Queue, { JobOptions } from 'bull';
import { config } from '@config/index';

export const jobQueue = new Queue('jobQueue', {
  redis: {
      port: Number(process.env.REDIS_PORT) || config.Redis.port || 6379,
      host: process.env.REDIS_HOST || config.Redis.host || '127.0.0.1',
      password: process.env.REDIS_PASSWORD || config.Redis.password || '',
      db: 11,
    },
});

export const addJob = async <T = any>(name: string, data: T, options?: JobOptions) => {
  await jobQueue.add(name, data, options);
  console.log(`[Bull] Job added: ${name}`);
};
