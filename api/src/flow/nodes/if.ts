import { RunnableLambda } from "@langchain/core/runnables";

interface IfNodeConfig {
    condition:
    | ((input: any) => boolean | Promise<boolean>)
    | string
    | { field: string; equals?: any; not?: boolean };
    trueBranch: string;
    falseBranch: string;
}

function isFn(x: any): x is (input: any) => boolean | Promise<boolean> {
    return typeof x === "function";
}

export const ifNode = (config: IfNodeConfig) => {
    const { condition, trueBranch, falseBranch } = config;

    async function check(input: any): Promise<boolean> {
        if (isFn(condition)) return await condition(input);
        if (typeof condition === "string") {
            if (/^[a-zA-Z0-9_$.]+$/.test(condition)) {
                const value = condition.split('.').reduce((o, k) => o?.[k], input);
                return Boolean(value);
            } else {
                // eslint-disable-next-line no-new-func
                const fn = new Function("input", `return (${condition});`);
                return !!fn(input);
            }
        }
        if (typeof condition === "object" && condition.field) {
            const value = condition.field.split('.').reduce((o, k) => o?.[k], input);
            if ("equals" in condition) return value === condition.equals;
            if (condition.not) return !Boolean(value);
            return Boolean(value);
        }
        throw new Error("ifNode: condition 不合法");
    }

    return new RunnableLambda({
        func: async (input: any) => {
            const matched = await check(input);
            return {
                next: matched ? trueBranch : falseBranch,
                output: input,
            };
        },
    });
};
