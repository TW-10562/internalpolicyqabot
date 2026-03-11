import { AnthropicClient, OpenAIClient, SelfClient, createAnthropicClient, createOpenAIClient, createSelfClient } from "@aviary-ai/ai-gateway";
import { config } from "../config";
import { redis } from "../redis";

export const openaiClient: OpenAIClient | null = config.aiGateway.openai.apiKey
    ? createOpenAIClient({
        apiKey: config.aiGateway.openai.apiKey,
        organization: config.aiGateway.openai.organization,
        project: config.aiGateway.openai.project,
    }, {
        timeout: config.aiGateway.timeout,
    })
    : null;

export const anthropicClient: AnthropicClient | null = config.aiGateway.anthropic.apiKey
    ? createAnthropicClient({
        apiKey: config.aiGateway.anthropic.apiKey,
    }, {
        timeout: config.aiGateway.timeout,
    })
    : null;

export const selfClient: SelfClient | null = config.aiGateway.self.defaultModel
    ? createSelfClient(redis, {
        defaultModel: config.aiGateway.self.defaultModel,
        apiKey: config.aiGateway.self.apiKey,
    }, {
        timeout: config.aiGateway.timeout,
    })
    : null;

export function getDefaultOpenAIModel(): string {
    return config.aiGateway.openai.defaultModel;
}

export function getDefaultAnthropicModel(): string {
    return config.aiGateway.anthropic.defaultModel;
}

export function getDefaultSelfModel(): string {
    return config.aiGateway.self.defaultModel;
}
