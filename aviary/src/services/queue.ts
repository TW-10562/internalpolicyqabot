import type { TaskQueueService, TaskType } from '@aviary-ai/async-tasks';
import { MultiQueueManager } from '@aviary-ai/infra-queue';

export interface TaskQueueConfig {
    questionGen?: { db?: number; concurrency?: number };
    longTextGen?: { db?: number; concurrency?: number };
    chat?: { db?: number; concurrency?: number };
    voiceGen?: { db?: number; concurrency?: number };
    imageGen?: { db?: number; concurrency?: number };
    search?: { db?: number; concurrency?: number };
}

export class TaskQueueAdapter implements TaskQueueService {
    private multiQueue: MultiQueueManager;
    private config: TaskQueueConfig;

    constructor(multiQueue: MultiQueueManager, config: TaskQueueConfig = {}) {
        this.multiQueue = multiQueue;
        this.config = config;
    }

    private getQueueName(type: TaskType): string {
        return type.toLowerCase().replace(/-/g, '_');
    }

    private getQueueConfig(type: TaskType): { db?: number; concurrency?: number } {
        const configKeyMap: Record<string, keyof TaskQueueConfig> = {
            'CHAT': 'chat'
        };
        const configKey = configKeyMap[type];
        return configKey ? this.config[configKey] || {} : {};
    }

    async enqueue(type: TaskType, taskId: string): Promise<void> {
        const queueName = this.getQueueName(type);
        const queueConfig = this.getQueueConfig(type);

        // Pass both taskId and taskType to the processor
        await this.multiQueue.addTask(queueName, { taskId, taskType: type }, {
            // You can add job options here
            // attempts: 3,
            // backoff: { type: 'exponential', delay: 2000 }
        });
    }

    registerProcessor(
        type: TaskType,
        processor: (job: any) => Promise<any>
    ): void {
        const queueName = this.getQueueName(type);
        const queueConfig = this.getQueueConfig(type);

        this.multiQueue.register(
            queueName,
            processor,
            {
                concurrency: queueConfig.concurrency || 1,
                db: queueConfig.db,
            }
        );
    }

    getMultiQueue(): MultiQueueManager {
        return this.multiQueue;
    }
}
