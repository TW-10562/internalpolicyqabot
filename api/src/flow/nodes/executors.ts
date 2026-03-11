import { RunnableLambda } from "@langchain/core/runnables";
import { claudeNode } from "./claude";
import { httpNode } from "./http";
import { ifNode } from "./if";
import { inputNode } from "./input";
import { mysqlNode } from "./mysql";
import { ollamaNode } from "./ollama";
import { openaiNode } from "./openai";
import { outputNode } from "./output";
import { postgresNode } from "./postgres";
import { redisNode } from "./redis";

export function buildNodeExecutor(node: any): RunnableLambda<any, any> {
    const { type, data = {} } = node;

    switch (type) {
        case "input":
            return inputNode();
        case 'output':
            return outputNode();
        case "if":
            return ifNode(data);
        case "http":
            return httpNode(data);
        case "openai":
            return openaiNode(data);
        case "claude":
            return claudeNode(data);
        case "ollama":
            return ollamaNode(data);
        case "redis":
            return redisNode(data);
        case "mysql":
            return mysqlNode(data);
        case "postgres":
            return postgresNode(data);
        default:
            return new RunnableLambda({ func: async () => "UNSUPPORTED NODE" });
    }
}
