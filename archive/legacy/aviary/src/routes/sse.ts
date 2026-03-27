import Router from "@koa/router";
import type { Context } from "koa";
import { genTaskOutputService } from "../services/async-task";

const router = new Router();

router.get('/stream/task/:taskId/output/:outputId', async (ctx: Context) => {
    const { taskId, outputId } = ctx.params;

    ctx.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    ctx.status = 200;

    const stream = new PassThrough();
    ctx.body = stream;

    const sendSSE = (event: string, data: any) => {
        stream.write(`event: ${event}\n`);
        stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE('connected', { taskId, outputId, timestamp: Date.now() });

    let lastContent = '';
    let pollCount = 0;
    const maxPolls = 300;

    const pollInterval = setInterval(async () => {
        try {
            pollCount++;

            const output = await genTaskOutputService.getOutputById(Number(outputId));

            if (!output) {
                sendSSE('error', { message: 'Output not found' });
                clearInterval(pollInterval);
                stream.end();
                return;
            }

            // Check if content has changed
            const currentContent = output.content || '';
            if (currentContent !== lastContent) {
                sendSSE('update', {
                    content: currentContent,
                    status: output.status,
                    timestamp: Date.now(),
                });
                lastContent = currentContent;
            }

            if (output.status === 'FINISHED' || output.status === 'FAILED') {
                sendSSE('complete', {
                    content: currentContent,
                    status: output.status,
                    timestamp: Date.now(),
                });
                clearInterval(pollInterval);
                stream.end();
                return;
            }

            if (pollCount >= maxPolls) {
                sendSSE('timeout', { message: 'Max polling time reached' });
                clearInterval(pollInterval);
                stream.end();
                return;
            }
        } catch (error) {
            console.error('SSE polling error:', error);
            sendSSE('error', { message: error instanceof Error ? error.message : 'Unknown error' });
            clearInterval(pollInterval);
            stream.end();
        }
    }, 1000);

    ctx.req.on('close', () => {
        clearInterval(pollInterval);
        stream.end();
    });
});

import { PassThrough } from 'stream';

export default router;
