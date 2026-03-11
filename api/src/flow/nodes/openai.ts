import { RunnableLambda } from "@langchain/core/runnables";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import axios from "axios";
import FormData from "form-data";

type NodeType = "chat" | "embedding" | "audio";

interface OpenaiNodeConfig {
    type?: NodeType;
    apiKey: string;
    model?: string;
    audioFormat?: string;  // audio only
    options?: Record<string, any>;
}

// 工具函数：合并配置和输入参数，input 优先级更高
function mergeOptions(configOptions: any = {}, inputOptions: any = {}) {
    return { ...(configOptions || {}), ...(inputOptions || {}) };
}

export const openaiNode = (config: OpenaiNodeConfig) => {
    const {
        type = "chat",
        apiKey,
        model = "gpt-4o",
        audioFormat = "mp3",
        options = {},
    } = config;

    return new RunnableLambda({
        func: async (input: any = {}) => {
            // input/input.input/input.prompt/input.options
            let variables: Record<string, any> = {};
            if (typeof input === "string") {
                variables.input = input;
            } else if (input && typeof input === "object") {
                variables = { ...input };
            }
            const finalOptions = mergeOptions(options, variables.options);

            switch (type) {
                case "chat": {
                    const llm = new ChatOpenAI({
                        modelName: model,
                        openAIApiKey: apiKey,
                        ...finalOptions,
                    });

                    let messages = variables.messages;
                    if (!messages) {
                        messages = [
                            { role: "user", content: variables.input || variables.prompt }
                        ];
                    }

                    const res = await llm.invoke(messages, finalOptions);
                    return { text: res.content, ...res };
                }
                case "embedding": {
                    const embedder = new OpenAIEmbeddings({
                        openAIApiKey: apiKey,
                        modelName: model,
                        ...finalOptions,
                    });
                    const texts = Array.isArray(variables.input) ? variables.input : [variables.input];
                    const embeddings = await embedder.embedDocuments(texts);
                    return { embeddings };
                }
                case "audio": {
                    const audioBuffer: Buffer = variables.audioBuffer;
                    if (!audioBuffer) throw new Error("audioBuffer is required for audio type");

                    const formData = new FormData();
                    formData.append("file", audioBuffer, `audio.${audioFormat}`);
                    formData.append("model", "whisper-1");
                    Object.entries(finalOptions).forEach(([k, v]) => {
                        if (typeof v === "string") formData.append(k, v);
                    });

                    const response = await axios.post(
                        "https://api.openai.com/v1/audio/transcriptions",
                        formData,
                        {
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                ...formData.getHeaders(),
                            },
                        }
                    );
                    return { text: response.data.text, ...response.data };
                }
                default:
                    throw new Error(`Unknown openai type: ${type}`);
            }
        },
    });
};
