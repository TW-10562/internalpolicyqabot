import { GenTaskOutputService, GenTaskService } from "@aviary-ai/async-tasks";
import { MySQLGenTaskOutputRepository, MySQLGenTaskRepository } from "@aviary-ai/async-tasks-mysql";
import { createMultiQueueManager } from "@aviary-ai/infra-queue";
import { config } from "../config";
import { sequelize } from "../database";
import { redis } from "../redis";
import { TaskQueueAdapter } from "./queue";
import { RedisUsageLimitService } from "./usage-limit";
import { getOutputPreparer } from "./task-types";

const multiQueueManager = createMultiQueueManager({
    redis: {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
    },
});

const taskQueueAdapter = new TaskQueueAdapter(multiQueueManager, config.taskQueue);

const usageLimitService = new RedisUsageLimitService(redis, config.usageLimit);

const queryInterface = sequelize.getQueryInterface();
const genTaskRepo = new MySQLGenTaskRepository({ queryInterface });
const genTaskOutputRepo = new MySQLGenTaskOutputRepository({ queryInterface });

export const genTaskService = new GenTaskService(
    genTaskRepo,
    genTaskOutputRepo,
    taskQueueAdapter,
    usageLimitService,
    getOutputPreparer()
);

export const genTaskOutputService = new GenTaskOutputService(genTaskOutputRepo);

export { multiQueueManager, taskQueueAdapter, usageLimitService };
