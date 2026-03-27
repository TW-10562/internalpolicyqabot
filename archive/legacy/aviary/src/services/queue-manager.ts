import type { Context } from 'koa';
import { genTaskService } from './async-task';

export async function estimateQueueWaitTime(): Promise<number> {
    try {
        const pendingTasks = await genTaskService.getTaskList({
            status: 'WAIT',
            type: 'CHAT',
            page: 1,
            pageSize: 1,
        });

        const inProgressTasks = await genTaskService.getTaskList({
            status: 'IN_PROCESS',
            type: 'CHAT',
            page: 1,
            pageSize: 1,
        });

        const queueLength = (pendingTasks.total || 0) + (inProgressTasks.total || 0);

        const avgTaskDuration = 30 * 1000; // 30 seconds
        const estimatedWait = queueLength * avgTaskDuration;

        console.log(`[Queue Estimate] Queue length: ${queueLength}, Estimated wait: ${estimatedWait}ms`);

        return estimatedWait;
    } catch (error) {
        console.error('[Queue Estimate] Error estimating wait time:', error);
        return 0;
    }
}

export async function shouldUseStreamingMode(ctx: Context): Promise<{
    useStreaming: boolean;
    estimatedWait: number;
    queuePosition?: number;
}> {
    const estimatedWait = await estimateQueueWaitTime();

    const streamingThreshold = parseInt(process.env.STREAMING_THRESHOLD || "120000", 10);

    const useStreaming = estimatedWait < streamingThreshold;

    if (!useStreaming) {
        console.log(`[Mode Selection] Queue wait ${estimatedWait}ms exceeds threshold ${streamingThreshold}ms, using async mode`);
    }

    return {
        useStreaming,
        estimatedWait,
        queuePosition: Math.ceil(estimatedWait / 30000),
    };
}

export function sendQueueStatus(ctx: Context, position: number, estimatedWait: number): void {
    const minutes = Math.ceil(estimatedWait / 60000);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    let waitMessage = '';
    if (hours > 0) {
        waitMessage = `約${hours}時間${remainingMinutes}分`;
    } else {
        waitMessage = `約${minutes}分`;
    }

    const statusData = {
        type: 'queue_status',
        position,
        estimatedWaitMs: estimatedWait,
        estimatedWaitDisplay: waitMessage,
    };

    ctx.res.write(`data: ${JSON.stringify(statusData)}\n\n`);
}
