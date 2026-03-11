import { config } from "../../config";
import { anthropicClient, getDefaultAnthropicModel, getDefaultOpenAIModel, getDefaultSelfModel, openaiClient, selfClient } from "../ai-gateway";
import { genTaskOutputService, genTaskService } from "../async-task";

const MAX_HISTORY_ROUNDS = 10;

interface ChatStreamMetadata {
    prompt: string;
    webSearchSwitch?: number;
}

export async function processChatTaskStream(
    taskId: string,
    streamCollector: (chunk: string) => void
): Promise<{ isOk: boolean; content?: string; error?: string }> {
    console.log(`[processChatTaskStream] Starting task ${taskId}`);

    try {
        const outputs = await genTaskOutputService.getOutputList({
            taskId,
            status: 'WAIT',
            page: 1,
            pageSize: 1000,
        });

        if (outputs.rows.length === 0) {
            console.log(`No WAIT outputs found for task ${taskId}`);
            return { isOk: false, error: 'No outputs to process' };
        }

        const output = outputs.rows[0];
        const outputId = output.id;

        await genTaskOutputService.updateOutput({
            id: outputId,
            status: 'IN_PROCESS',
        });

        const allOutputs = await genTaskOutputService.getOutputList({
            taskId,
            page: 1,
            pageSize: 1000,
        });

        const sortedOutputs = allOutputs.rows.sort((a, b) => (a.sort || 0) - (b.sort || 0));

        const originMessages: Array<{ role: string; content: string }> = [];
        for (const op of sortedOutputs) {
            if (op.status === 'IN_PROCESS' || op.status === 'WAIT') {
                continue;
            }

            const meta = typeof op.metadata === 'string' ? JSON.parse(op.metadata) : op.metadata;
            if (meta && meta.prompt) {
                originMessages.push({ role: 'user', content: meta.prompt });
            }
            if (op.content) {
                originMessages.push({ role: 'assistant', content: op.content });
            }
        }

        const maxMessages = MAX_HISTORY_ROUNDS * 2;
        const limitedMessages = originMessages.length > maxMessages
            ? originMessages.slice(-maxMessages)
            : originMessages;

        console.log(`Chat history: ${originMessages.length} total messages, using last ${limitedMessages.length} messages`);

        const metadata: ChatStreamMetadata = typeof output.metadata === 'string'
            ? JSON.parse(output.metadata)
            : output.metadata;

        const { prompt } = metadata;

        const systemContent = `You are a helpful, friendly, and knowledgeable AI assistant. Your goal is to provide accurate, clear, and helpful responses to user questions in a conversational manner.

Key guidelines:
- Respond in the same language as the user's question
- Provide clear and concise answers
- Be respectful and professional
- If you're unsure about something, acknowledge it honestly
- Break down complex topics into understandable explanations
- Use examples when helpful to illustrate your points`;

        const messages = [
            { role: 'system', content: systemContent },
            ...limitedMessages,
            { role: 'user', content: prompt },
        ];

        let fullContent = '';
        let firstChunk = true;

        const provider = config.aiGateway.provider;

        if (provider === 'self' && selfClient) {
            const prompt = messages
                .map(m => `${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                .join('\n\n');

            const stream = selfClient.generateStream(
                prompt,
                getDefaultSelfModel(),
                { temperature: 0.1 }
            );

            for await (const chunk of stream) {
                if (firstChunk) {
                    streamCollector('\r');
                    firstChunk = false;
                }
                fullContent += chunk;
                streamCollector(chunk);
                console.log('[Self Stream] chunk:', chunk);
            }
        } else if (provider === 'anthropic' && anthropicClient) {
            const userMessages = messages
                .filter(m => m.role !== 'system')
                .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

            const stream = anthropicClient.generateStream(
                systemContent,
                userMessages,
                getDefaultAnthropicModel(),
                { max_tokens: 2048, temperature: 0.1 }
            );

            for await (const chunk of stream) {
                if (firstChunk) {
                    streamCollector('\r');
                    firstChunk = false;
                }
                fullContent += chunk;
                streamCollector(chunk);
                console.log('[Anthropic Stream] chunk:', chunk);
            }
        } else if (provider === 'openai' && openaiClient) {
            const prompt = messages
                .map(m => `${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                .join('\n\n');

            const stream = openaiClient.generateStream(
                prompt,
                getDefaultOpenAIModel(),
                { temperature: 0.1 }
            );

            for await (const chunk of stream) {
                if (firstChunk) {
                    streamCollector('\r');
                    firstChunk = false;
                }
                fullContent += chunk;
                streamCollector(chunk);
                console.log('[OpenAI Stream] chunk:', chunk);
            }
        } else if (anthropicClient) {
            console.warn(`Provider ${provider} not available, falling back to Anthropic`);
            const userMessages = messages
                .filter(m => m.role !== 'system')
                .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

            const stream = anthropicClient.generateStream(
                systemContent,
                userMessages,
                getDefaultAnthropicModel(),
                { max_tokens: 2048, temperature: 0.1 }
            );

            for await (const chunk of stream) {
                fullContent += chunk;
                streamCollector(chunk);
            }
        } else if (openaiClient) {
            console.warn(`Provider ${provider} not available, falling back to OpenAI`);
            const prompt = messages
                .map(m => `${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                .join('\n\n');

            const stream = openaiClient.generateStream(
                prompt,
                getDefaultOpenAIModel(),
                { temperature: 0.1 }
            );

            for await (const chunk of stream) {
                fullContent += chunk;
                streamCollector(chunk);
            }
        } else if (selfClient) {
            console.warn(`Provider ${provider} not available, falling back to Self`);
            const prompt = messages
                .map(m => `${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                .join('\n\n');

            const stream = selfClient.generateStream(
                prompt,
                getDefaultSelfModel(),
                { temperature: 0.1 }
            );

            for await (const chunk of stream) {
                fullContent += chunk;
                streamCollector(chunk);
            }
        } else {
            throw new Error("No AI client is available. Please configure AI_PROVIDER and corresponding API keys in .env");
        }

        await genTaskOutputService.updateOutput({
            id: outputId,
            content: fullContent,
            status: 'FINISHED',
        });

        await genTaskService.updateTask({
            id: taskId,
            status: 'FINISHED',
        });

        console.log(`[processChatTaskStream] Task ${taskId} completed successfully`);
        return { isOk: true, content: fullContent };

    } catch (error) {
        console.error(`[processChatTaskStream] Error:`, error);

        try {
            await genTaskService.updateTask({
                id: taskId,
                status: 'FAILED',
            });
        } catch (updateError) {
            console.error(`[processChatTaskStream] Failed to update task status:`, updateError);
        }

        return {
            isOk: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}
