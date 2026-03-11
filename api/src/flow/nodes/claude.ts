import { ChatAnthropic } from "@langchain/anthropic";
import { RunnableLambda } from "@langchain/core/runnables";

interface ClaudeNodeConfig {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    options?: Record<string, any>;
}

function mergeOptions(configOptions: any = {}, inputOptions: any = {}) {
    return { ...(configOptions || {}), ...(inputOptions || {}) };
}

export const claudeNode = (config: ClaudeNodeConfig) => {
    const {
        apiKey,
        model = "claude-3-opus-20240229",
        baseUrl,
        options = {},
    } = config;

    return new RunnableLambda({
        func: async (input: any = {}) => {
            let variables: Record<string, any> = {};
            if (typeof input === "string") {
                variables.input = input;
            } else if (input && typeof input === "object") {
                variables = { ...input };
            }
            const finalOptions = mergeOptions(options, variables.options);

            let messages = variables.messages;
            if (!messages) {
                messages = [
                    { role: "user", content: variables.input || variables.prompt }
                ];
            }

            const llm = new ChatAnthropic({
                apiKey,
                modelName: model,
                baseUrl,
                ...finalOptions,
            });
            const res = await llm.invoke(messages, finalOptions);
            return { text: res, messages, raw: res };
        },
    });
};
