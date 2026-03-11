import { RunnableLambda } from "@langchain/core/runnables";

export const outputNode = () => {
    return new RunnableLambda({
        func: async (input: any) => {
            return input;
        },
    });
};
