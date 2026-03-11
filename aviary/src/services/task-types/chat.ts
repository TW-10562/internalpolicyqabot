import type { OutputPreparer } from "@aviary-ai/async-tasks";
import { config } from "../../config";
import { anthropicClient, getDefaultAnthropicModel, getDefaultOpenAIModel, openaiClient } from "../ai-gateway";
import { genTaskOutputService, genTaskService } from "../async-task";

export const CHAT_TASK_TYPE = 'CHAT';

// Maximum number of conversation rounds to keep in history
// Each round = 1 user message + 1 assistant response
// Default: 10 rounds = 20 messages (10 user + 10 assistant)
// This prevents token limit issues while maintaining recent context
const MAX_HISTORY_ROUNDS = 10;

export interface ChatFormData {
    prompt?: string;
    fieldSort?: number;
    taskId?: string;
    webSearchSwitch?: number;
}

export const prepareChatOutputs: OutputPreparer = (type, formData) => {
    if (type !== CHAT_TASK_TYPE) {
        return [];
    }

    const { prompt, fieldSort, webSearchSwitch = 0 } = formData as ChatFormData || {};

    // For initial empty chat, return empty array
    if (!prompt || fieldSort === undefined) {
        return [];
    }

    return [{
        metadata: JSON.stringify({ prompt, webSearchSwitch }),
        sort: fieldSort,
    }];
};

export function formatChatFormData(formData: ChatFormData): string {
    const formDataKeys = Object.keys(formData || {});
    if (formDataKeys.length === 0 || !formData) {
        return 'EMPTY CHAT';
    }
    return '新しい会話';
}

export async function processChatTask(taskId: string): Promise<void> {
    console.log(`Processing CHAT task: ${taskId}`);

    try {
        // Query all WAIT outputs for this task
        const outputs = await genTaskOutputService.getOutputList({
            taskId,
            status: 'WAIT',
            page: 1,
            pageSize: 1000,
        });

        if (outputs.rows.length === 0) {
            console.log(`No WAIT outputs found for task ${taskId}`);
            return;
        }

        // Query all outputs (to get chat history) sorted by sort field
        const allOutputs = await genTaskOutputService.getOutputList({
            taskId,
            page: 1,
            pageSize: 1000,
        });

        // Sort by sort field to get chronological order
        const sortedOutputs = allOutputs.rows.sort((a, b) => (a.sort || 0) - (b.sort || 0));

        // Build messages history from previous outputs
        const originMessages: Array<{ role: string; content: string }> = [];
        for (const op of sortedOutputs) {
            if (op.status === 'IN_PROCESS' || op.status === 'WAIT') {
                continue; // Skip current processing outputs
            }

            const meta = typeof op.metadata === 'string' ? JSON.parse(op.metadata) : op.metadata;
            if (meta && meta.prompt) {
                originMessages.push({ role: 'user', content: meta.prompt });
            }
            if (op.content) {
                originMessages.push({ role: 'assistant', content: op.content });
            }
        }

        // Apply history limit to prevent token overflow
        // Keep only the most recent MAX_HISTORY_ROUNDS rounds (user+assistant pairs)
        // This maintains conversation context while staying within token limits
        const maxMessages = MAX_HISTORY_ROUNDS * 2; // Each round has 2 messages
        const limitedMessages = originMessages.length > maxMessages
            ? originMessages.slice(-maxMessages) // Keep last N messages
            : originMessages;

        console.log(`Chat history: ${originMessages.length} total messages, using last ${limitedMessages.length} messages`);


        // Process each WAIT output
        for (const output of outputs.rows) {
            // Update status to IN_PROCESS
            await genTaskOutputService.updateOutput({
                id: output.id,
                status: 'IN_PROCESS',
            });

            try {
                // Parse metadata
                const metadata = typeof output.metadata === 'string'
                    ? JSON.parse(output.metadata)
                    : output.metadata;

                const { prompt, webSearchSwitch = 0 } = metadata;

                // Build final messages
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

                // Log the request body being sent to LLM
                console.log('='.repeat(80));
                console.log('Sending request to LLM:');
                console.log('Task ID:', taskId);
                console.log('Output ID:', output.id);
                console.log('Message count:', messages.length);
                console.log('Messages:', JSON.stringify(messages, null, 2));
                console.log('='.repeat(80));

                let result: string;

                // Use configured AI provider with fallback
                const useAnthropic = config.aiGateway.provider === 'anthropic';

                if (useAnthropic && anthropicClient) {
                    // Use Anthropic for chat
                    // Note: Streaming support will be added when ai-gateway package supports it
                    const userMessages = messages
                        .filter(m => m.role !== 'system')
                        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

                    result = await anthropicClient.generate(
                        systemContent,
                        userMessages,
                        getDefaultAnthropicModel(),
                        { max_tokens: 2048, temperature: 0.1 }
                    ) as string;
                } else if (!useAnthropic && openaiClient) {
                    // Use OpenAI for chat
                    const prompt = messages
                        .map(m => `${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                        .join('\n\n');

                    result = await openaiClient.generate(
                        prompt,
                        getDefaultOpenAIModel(),
                        { max_tokens: 2048, temperature: 0.1 }
                    ) as string;
                } else if (useAnthropic && !anthropicClient && openaiClient) {
                    // Fallback to OpenAI if Anthropic is configured but not available
                    console.warn('Anthropic client not available, falling back to OpenAI');
                    const prompt = messages
                        .map(m => `${m.role === 'system' ? 'System' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                        .join('\n\n');

                    result = await openaiClient.generate(
                        prompt,
                        getDefaultOpenAIModel(),
                        { max_tokens: 2048, temperature: 0.1 }
                    ) as string;
                } else if (!useAnthropic && !openaiClient && anthropicClient) {
                    // Fallback to Anthropic if OpenAI is configured but not available
                    console.warn('OpenAI client not available, falling back to Anthropic');
                    const userMessages = messages
                        .filter(m => m.role !== 'system')
                        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

                    result = await anthropicClient.generate(
                        systemContent,
                        userMessages,
                        getDefaultAnthropicModel(),
                        { max_tokens: 2048, temperature: 0.1 }
                    ) as string;
                } else {
                    throw new Error("No AI client is available. Please configure OPENAI_API_KEY or ANTHROPIC_API_KEY in .env");
                }

                // Update output with result
                await genTaskOutputService.updateOutput({
                    id: output.id,
                    content: result,
                    status: 'FINISHED',
                });
            } catch (error) {
                console.error(`Error processing output ${output.id}:`, error);
                await genTaskOutputService.updateOutput({
                    id: output.id,
                    content: error instanceof Error ? error.message : 'Unknown error',
                    status: 'FAILED',
                });
            }
        }

        // Update task status
        await genTaskService.updateTask({
            id: taskId,
            status: 'FINISHED',
        });

        console.log(`CHAT task ${taskId} completed successfully`);
    } catch (error) {
        console.error(`Error processing CHAT task ${taskId}:`, error);
        await genTaskService.updateTask({
            id: taskId,
            status: 'FAILED',
        });
    }
}
