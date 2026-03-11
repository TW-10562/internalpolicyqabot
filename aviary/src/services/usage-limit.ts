import { Redis } from 'ioredis';
import type { UsageLimitService, UsageLimitConfig, TaskType } from '@aviary-ai/async-tasks';

export interface UsageLimitTokenBucketConfig {
    [key: string]: {
        limit: number; // System-wide limit per duration
        limitByAccount?: number; // Per-user limit per duration
        limitDuration: number; // Duration in seconds
        limitUnit?: 'Month' | 'Year' | 'Second';
        limitConcurrent: number; // Per-user concurrent tasks
        limitConcurrentInAllTask: number; // System-wide concurrent tasks
    };
}

export class RedisUsageLimitService implements UsageLimitService {
    private redis: Redis;
    private config: UsageLimitTokenBucketConfig;

    constructor(redis: Redis, config: UsageLimitTokenBucketConfig) {
        this.redis = redis;
        this.config = config;
    }

    private formatKey(type: TaskType, userName?: string): string {
        return userName ? `ULTB:${type}:${userName}` : `ULTB:${type}`;
    }

    private async initializeBucket(type: TaskType, userName?: string): Promise<void> {
        const key = this.formatKey(type, userName);
        const taskConfig = this.config[type];
        if (!taskConfig) {
            throw new Error(`No configuration found for task type: ${type}`);
        }

        const now = new Date();
        let expireSeconds = taskConfig.limitDuration;

        if (taskConfig.limitUnit === 'Month') {
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
            expireSeconds = Math.floor((endOfMonth.getTime() - now.getTime()) / 1000);
        } else if (taskConfig.limitUnit === 'Year') {
            const endOfYear = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
            expireSeconds = Math.floor((endOfYear.getTime() - now.getTime()) / 1000);
        }

        const initialValue = userName ? (taskConfig.limitByAccount ?? taskConfig.limit) : taskConfig.limit;
        await this.redis.set(key, initialValue, 'EX', expireSeconds, 'NX');
    }

    async checkLimit(type: TaskType, userName: string): Promise<{ allowed: boolean; message?: string }> {
        const taskConfig = this.config[type];
        if (!taskConfig) {
            return { allowed: false, message: 'Task type not configured' };
        }

        // Check if bucket exists, initialize if not
        const key = this.formatKey(type, userName);
        const exists = await this.redis.exists(key);
        if (!exists) {
            await this.initializeBucket(type, userName);
        }

        // Check remaining quota
        const remaining = await this.redis.get(key);
        if (!remaining || parseInt(remaining) <= 0) {
            return {
                allowed: false,
                message: '今月のご利用回数が上限に達しました。',
            };
        }

        return { allowed: true };
    }

    async consumeToken(type: TaskType, userName?: string): Promise<{ status: boolean; message?: string }> {
        const key = this.formatKey(type, userName);
        const taskConfig = this.config[type];

        if (!taskConfig) {
            return { status: false, message: 'Task type not configured' };
        }

        // Ensure bucket exists
        const exists = await this.redis.exists(key);
        if (!exists) {
            await this.initializeBucket(type, userName);
        }

        // Decrement token
        const value = await this.redis.decr(key);
        if (value >= 0) {
            return { status: true };
        }

        // Exhausted, reset to 0
        await this.redis.set(key, 0, 'KEEPTTL');
        return {
            status: false,
            message: userName
                ? '今月のご利用回数が上限に達しました。'
                : '本機能のサービスは一時的に停止しております。ご迷惑をお掛けして申し訳ございません。',
        };
    }

    async getRemainingQuota(type: TaskType, userName: string): Promise<number> {
        const key = this.formatKey(type, userName);
        const value = await this.redis.get(key);

        if (!value) {
            // Initialize and return initial value
            await this.initializeBucket(type, userName);
            const taskConfig = this.config[type];
            return taskConfig.limitByAccount ?? taskConfig.limit;
        }

        const remaining = parseInt(value);
        return isNaN(remaining) || remaining < 0 ? 0 : remaining;
    }

    getConfig(type: TaskType): UsageLimitConfig | undefined {
        const taskConfig = this.config[type];
        if (!taskConfig) {
            return undefined;
        }

        return {
            limitConcurrent: taskConfig.limitConcurrent,
            limitConcurrentInAllTask: taskConfig.limitConcurrentInAllTask,
            limitPerMonth: taskConfig.limitByAccount,
        };
    }

    async increaseToken(type: TaskType, userName?: string): Promise<void> {
        const key = this.formatKey(type, userName);
        await this.redis.incr(key);
    }

    async removeBucket(type: TaskType, userName?: string): Promise<void> {
        const key = this.formatKey(type, userName);
        await this.redis.del(key);
    }
}
