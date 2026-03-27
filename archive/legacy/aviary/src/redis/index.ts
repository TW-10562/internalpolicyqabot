import Redis from "ioredis";
import { config } from "../config/index";

export const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
});

redis.on("connect", () => {
    console.log("Redis connection established successfully");
});

redis.on("error", (err) => {
    console.error("Redis connection error:", err);
});

export default redis;
