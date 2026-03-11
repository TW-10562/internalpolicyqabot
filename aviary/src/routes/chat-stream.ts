import Router from '@koa/router';
import type { Context } from 'koa';
import { config } from '../config';
import { genTaskOutputService, genTaskService } from '../services/async-task';
import { sendQueueStatus, shouldUseStreamingMode } from '../services/queue-manager';
import { CHAT_TASK_TYPE, formatChatFormData, prepareChatOutputs } from '../services/task-types/chat';
import { processChatTaskStream } from '../services/task-types/chat-stream';

const router = new Router({ prefix: '/chat-stream' });

router.post('/', async (ctx: Context) => {
    try {
        const payload = ctx.request.body as any;

        if (!payload.type || payload.type !== CHAT_TASK_TYPE) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid type, must be CHAT' };
            return;
        }

        if (!payload.formData) {
            ctx.status = 400;
            ctx.body = { error: 'Missing formData' };
            return;
        }

        const formData = payload.formData;
        const taskId = formData.taskId;

        const queueStatus = await shouldUseStreamingMode(ctx);

        if (!queueStatus.useStreaming) {
            ctx.status = 503;
            ctx.body = {
                error: 'QUEUE_TOO_LONG',
                message: 'キューが混雑しています。非同期タスクモードをご利用ください。',
                estimatedWaitMs: queueStatus.estimatedWait,
                queuePosition: queueStatus.queuePosition,
                recommendation: 'ASYNC_MODE',
            };
            return;
        }

        let task;
        if (taskId) {
            task = await genTaskService.getTaskById(taskId);
            if (!task) {
                ctx.status = 404;
                ctx.body = { error: `Task ${taskId} not found` };
                return;
            }

            if (task.status === 'FINISHED' || task.status === 'FAILED' || task.status === 'CANCEL') {
                await genTaskService.updateTask({
                    id: taskId,
                    status: 'WAIT',
                });
            }

            const outputs = prepareChatOutputs(CHAT_TASK_TYPE, formData);
            for (const output of outputs) {
                await genTaskOutputService.createOutput(
                    taskId,
                    output.metadata,
                    output.sort
                );
            }

        } else {
            const result = await genTaskService.createTask({
                type: CHAT_TASK_TYPE,
                formData,
            });

            if (result.code !== '200' || !result.task) {
                ctx.status = 500;
                ctx.body = { error: result.message || 'Failed to create task' };
                return;
            }

            task = result.task;
        }

        const finalTaskId = task.id;

        ctx.set('Content-Type', 'text/event-stream');
        ctx.set('Cache-Control', 'no-cache');
        ctx.set('Connection', 'keep-alive');
        ctx.set('X-Accel-Buffering', 'no');
        ctx.status = 200;

        ctx.req.setTimeout(0);
        ctx.res.setTimeout(0);

        ctx.res.flushHeaders?.();

        ctx.res.write(': connected\n\n');

        if (queueStatus.estimatedWait > 0) {
            sendQueueStatus(ctx, queueStatus.queuePosition || 0, queueStatus.estimatedWait);
        }

        let lastActivity = Date.now();
        const heartbeatMs = config.aiGateway.heartbeatInterval;
        const heartbeatInterval = setInterval(() => {
            const now = Date.now();
            if (now - lastActivity > heartbeatMs) {
                ctx.res.write(': heartbeat\n\n');
                lastActivity = now;
            }
        }, heartbeatMs);

        try {
            const writeChunk = (chunk: string) => {
                const escaped = JSON.stringify(chunk);
                ctx.res.write(`data: ${escaped}\n\n`);
                lastActivity = Date.now();
            };

            await processChatTaskStream(finalTaskId, writeChunk);

            ctx.res.write('data: [DONE]\n\n');
        } finally {
            clearInterval(heartbeatInterval);
            ctx.res.end();
        }

    } catch (error) {
        console.error('[POST /chat-stream] Exception:', error);

        if (!ctx.res.headersSent) {
            ctx.status = 500;
            ctx.body = {
                error: error instanceof Error ? error.message : 'Internal server error'
            };
        } else {
            ctx.res.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : 'Error' })}\n\n`);
            ctx.res.end();
        }
    }
});

export default router;
