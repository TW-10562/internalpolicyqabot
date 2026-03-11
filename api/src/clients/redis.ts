import Redis from 'ioredis';
import { config } from '@config/index';

export default new Redis({
  port: config.Redis.port || Number(process.env.REDIS_PORT) || 6379,
  host: config.Redis.host || process.env.REDIS_HOST || '127.0.0.1',
  password: config.Redis.password || process.env.REDIS_PASSWORD || '',
  db: config.Redis.database || Number(process.env.REDIS_DB) || 0
});
