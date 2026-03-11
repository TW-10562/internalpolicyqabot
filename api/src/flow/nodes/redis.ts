import redisClient from '@/clients/redis';
import { RunnableLambda } from "@langchain/core/runnables";

interface RedisNodeConfig {
    cmd: "get" | "set" | "del" | "hget" | "hset";
    key: string;
    value?: any;
    field?: string;
}

export const redisNode = (config: RedisNodeConfig) => {
    return new RunnableLambda({
        func: async (input: any) => {
            const { cmd, key, value, field } = config;
            try {
                switch (cmd) {
                    case "get":
                        return await redisClient.get(key);
                    case "set":
                        return await redisClient.set(key, value ?? input?.value ?? "");
                    case "del":
                        return await redisClient.del(key);
                    case "hget":
                        return await redisClient.hget(key, field ?? input?.field ?? "");
                    case "hset":
                        return await redisClient.hset(key, field ?? input?.field ?? "", value ?? input?.value ?? "");
                    default:
                        throw new Error("unsupported redis cmd");
                }
            } catch (e) {
                return { error: e?.toString() || "redis error" };
            }
        }
    });
}
