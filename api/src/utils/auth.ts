import redis from '@/clients/redis';
import { IUserInfoType } from '@/types/user';
import { recordNum, redisType } from '@/utils/redis';

export const addSession = async (key: string, data: IUserInfoType, time = 60) => {
  await redis.sadd('login_tokens', key);
  await redis.set(key, JSON.stringify(data));
  recordNum(redisType.set);
  recordNum(redisType.sadd);
  redis.expire(key, time * 60);
  recordNum(redisType.expire);
};

export const resetTime = (key: string, time = 60) => {
  redis.expire(key, time * 60);
  recordNum(redisType.expire);
};

export const judgeKeyOverdue = async (key: string) => {
  recordNum(redisType.exists);
  const res = await redis.exists(key);
  return res;
};

export const removeListKey = async (keys: string[]) => {
  await redis.srem('login_tokens', keys);
  recordNum(redisType.srem);
};

export const removeKey = async (keys: string[]) => {
  await redis.del(...keys);
  recordNum(redisType.del);
};

export const queryKeyValue = async (key: string) => {
  recordNum(redisType.get);
  return JSON.parse(await redis.get(key)) as IUserInfoType;
};
