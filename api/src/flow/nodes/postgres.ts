import { pgPool } from "@/clients/postgres";
import { RunnableLambda } from "@langchain/core/runnables";

interface PostgresNodeConfig {
    sql: string;
    values?: any[];
}

export const postgresNode = (config: PostgresNodeConfig) => {
    return new RunnableLambda({
        func: async (input: any) => {
            const { sql, values = [] } = config;
            let client;
            try {
                client = await pgPool.connect();
                const res = await client.query(sql, values.length ? values : input?.values || []);
                return res.rows;
            } catch (e) {
                return { error: e?.toString() || "postgres error" };
            } finally {
                if (client) client.release();
            }
        }
    });
};
