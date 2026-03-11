import { RunnableLambda } from "@langchain/core/runnables";
import { Ollama, OllamaEmbeddings } from "@langchain/ollama";

type NodeType = "chat" | "embedding";

interface OllamaNodeConfig {
    type?: NodeType;
    baseUrl?: string;
    model: string;
    options?: Record<string, any>;
}

function mergeOptions(configOptions: any = {}, inputOptions: any = {}) {
    return { ...(configOptions || {}), ...(inputOptions || {}) };
}

export const ollamaNode = (config: OllamaNodeConfig) => {
    const {
        type = "chat",
        baseUrl = "http://127.0.0.1:11435",
        model,
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

            switch (type) {
                case "chat": {
                    let messages = variables.messages;
                    if (!messages) {
                        messages = [
                            { role: "user", content: variables.input || variables.prompt }
                        ];
                    }
                    const llm = new Ollama({
                        model,
                        baseUrl,
                        ...finalOptions,
                    });
                    const res = await llm.invoke(messages, finalOptions);
                    return { text: res, messages, raw: res };
                }

                case "embedding": {
                    const embedder = new OllamaEmbeddings({
                        model,
                        baseUrl,
                        ...finalOptions,
                    });
                    const texts = Array.isArray(variables.input) ? variables.input : [variables.input];
                    const embeddings = await embedder.embedDocuments(texts);
                    return { embeddings, input: texts };
                }
                default:
                    throw new Error(`Unknown ollama type: ${type}`);
            }
        },
    });
};
