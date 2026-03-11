import { RunnableLambda } from "@langchain/core/runnables";

export const inputNode = () => {
    return new RunnableLambda({
        func: async (input: any) => {
            if (typeof input === "string") {
                return { input };
            }
            if (typeof input === "object") {
                return { ...input };
            }
            if (input == null) {
                return {};
            }
            return { input };
        },
    });
};
