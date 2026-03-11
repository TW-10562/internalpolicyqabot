import redis from '@/clients/redis';
import { config } from '@/config';
import { RouteType } from '@/types';
import { formatHumpLineTransfer } from '@/utils';
import dayjs from 'dayjs';

export const redisType = {
  set: 'set',
  sadd: 'sadd',
  expire: 'expire',
  smembers: 'smembers',
  srem: 'srem',
  del: 'del',
  get: 'get',
  mget: 'mget',
  info: 'info',
  keys: 'keys',
  type: 'type',
  exists: 'exists',
};

export const saveMenuMes = async (menus: RouteType[]) => {
  const res = formatHumpLineTransfer(menus);
  redis.set('menu_message', JSON.stringify(res));
  recordNum(redisType.set);
};

/* eslint-disable no-await-in-loop */
export const initializeZSet = async () => {
  // NOTE: As of the LLM gateway migration, we no longer use Redis-based load balancing for Ollama.
  // The application now uses openaiClient which connects directly to the OpenAI-compatible gateway.
  // We keep this function for backward compatibility and clean up stale Ollama references.

  const llmBaseUrl = process.env.LLM_BASE_URL || 'http://localhost:9080/v1';
  const llmModel = process.env.LLM_MODEL || 'openai/gpt-oss-20b';
  
  // Clean up legacy Ollama ZSET if it exists
  try {
    const exists = await redis.exists('ollama_api_weight_set');
    if (exists) {
      await redis.del('ollama_api_weight_set');
      console.info(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] 🧹 Removed legacy Ollama API ZSET (ollama_api_weight_set)`);
    }
  } catch (e) {
    console.warn(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] ⚠️  Could not clean up legacy Ollama ZSET, but continuing:`, e);
  }
  
  // Log LLM gateway configuration
  console.info(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}] 🚀 LLM Gateway Configuration`);
  console.info(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}]   Base URL: ${llmBaseUrl}`);
  console.info(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}]   Model: ${llmModel}`);
  console.info(`[${dayjs().format('YYYY-MM-DD HH:mm:ss')}]   Auth: ${process.env.LLM_API_KEY ? 'Bearer token set' : 'No auth'}`);
};
/* eslint-disable no-await-in-loop */


export const getNextApiUrl = async (modelName: string) => {
  // DEPRECATED: This function was used for Ollama load balancing.
  // For new code, use openaiClient from @/service/openai_client instead.
  
  if (modelName === 'ollama') {
    console.warn('[getNextApiUrl] ⚠️  Ollama endpoint requested but application has migrated to OpenAI-compatible gateway.');
    console.warn('[getNextApiUrl] Please update code to use openaiClient from @/service/openai_client');
    
    // For backward compatibility, return the LLM gateway URL
    // (some existing code may still call this)
    const llmBaseUrl = process.env.LLM_BASE_URL || 'http://localhost:9080/v1';
    return llmBaseUrl.replace(/\/v1\/?$/, ''); // Remove /v1 suffix to match expected format
  }

  // If called with other model names, try to get from Redis (legacy behavior)
  const key = modelName ? `${modelName}_api_weight_set` : 'ollama_api_weight_set';
  try {
    const result = await redis.zrange(key, 0, 0);
    if (result.length === 0) {
      throw new Error(`No available endpoint for model: ${modelName}`);
    }
    const api = result[0];
    await redis.zincrby(key, 1, api);
    return api;
  } catch (error) {
    throw new Error(`Failed to get endpoint for model ${modelName}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const updateUserInfo = async (key: string, ids: number[]) => {
  await redis.sadd(key, ids);
};

export const recordNum = async (type: string) => {
  redis.incr(type);
};

export const getSetsValue = async (key: string) => {
  recordNum(redisType.smembers);
  return (await redis.smembers(key)) as string[];
};

export const removeSetKeys = async (setName: string, keys: string[]) => {
  await redis.srem(setName, keys);
  recordNum(redisType.srem);
};

export const setKeyValue = async (key: string, value: string, expireIn: number) => {
  await redis.set(key, value);
  if (expireIn) {
    await redis.expire(key, expireIn);
  }
  recordNum(redisType.set);
};

export const getKeyValue = async (key: string) => {
  recordNum(redisType.get);
  return await redis.get(key);
};
