import { Sequelize } from "sequelize";
import { config } from "../config/index";
import { runPostgresMigrations } from "./migrations";

export const sequelize = config.database.url
    ? new Sequelize(config.database.url, {
        dialect: "postgres",
        logging: process.env.NODE_ENV === "development" ? console.log : false,
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000,
        },
        dialectOptions: {
            ssl: config.database.ssl ? { require: true, rejectUnauthorized: false } : undefined,
        },
    })
    : new Sequelize({
        dialect: "postgres",
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        username: config.database.user,
        password: config.database.password,
        logging: process.env.NODE_ENV === "development" ? console.log : false,
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000,
        },
        dialectOptions: {
            ssl: config.database.ssl ? { require: true, rejectUnauthorized: false } : undefined,
        },
    });

export async function initDatabase() {
    try {
        await runPostgresMigrations();
        await sequelize.authenticate();
        console.log("PostgreSQL connection established successfully");
    } catch (error) {
        console.error("Unable to connect to PostgreSQL:", error);
        throw error;
    }
}
