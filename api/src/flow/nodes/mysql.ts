import sequelize from "@/mysql/db/seq.db";
import { RunnableLambda } from "@langchain/core/runnables";
import { QueryTypes } from "sequelize";

interface MysqlNodeConfig {
    sql: string;
    replacements?: Record<string, any> | any[];
    type?: "SELECT" | "UPDATE" | "INSERT" | "DELETE";
}

export const mysqlNode = (config: MysqlNodeConfig) => {
    return new RunnableLambda({
        func: async (input: any) => {
            const { sql, replacements = {}, type } = config;

            const realType =
                type ||
                (sql.trim().toUpperCase().startsWith("SELECT")
                    ? "SELECT"
                    : sql.trim().toUpperCase().startsWith("INSERT")
                        ? "INSERT"
                        : sql.trim().toUpperCase().startsWith("UPDATE")
                            ? "UPDATE"
                            : sql.trim().toUpperCase().startsWith("DELETE")
                                ? "DELETE"
                                : "RAW");
            try {
                const result = await sequelize.query(sql, {
                    replacements: Array.isArray(replacements)
                        ? replacements
                        : { ...replacements, ...input },
                    type: QueryTypes[realType] || QueryTypes.RAW,
                });
                return { result };
            } catch (e) {
                return { error: e?.toString() || "mysql error" };
            }
        },
    });
};
