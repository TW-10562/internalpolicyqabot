import { RunnableLambda } from "@langchain/core/runnables";
import axios from "axios";

interface HttpNodeConfig {
    url: string;
    method?: "get" | "post" | "put" | "delete";
    headers?: Record<string, string>;
    params?: Record<string, any>;   // query参数
    data?: Record<string, any>;     // body参数
    timeout?: number;
}

export const httpNode = (config: HttpNodeConfig) => {
    return new RunnableLambda({
        func: async (input: any) => {
            const {
                url,
                method = "get",
                headers = {},
                params = {},
                data: bodyData = {},
                timeout = 10000,
            } = config;

            try {
                const res = await axios.request({
                    url,
                    method,
                    headers,
                    params: params || input?.params,
                    data: bodyData || input?.data,
                    timeout,
                });
                return res.data;
            } catch (e) {
                return { error: e?.toString() || "http error" };
            }
        }
    });
}
