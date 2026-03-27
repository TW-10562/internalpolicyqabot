import app from "./app";
import { config } from "./config/index";
import { initDatabase } from "./database/index";
import redis from "./redis/index";
import { taskQueueAdapter } from "./services/async-task";
import { processTask, getRegisteredTaskTypes } from "./services/task-types";

async function main() {
    try {
        // Force disable JSON pretty-printing (Koa defaults to 2 spaces in development)
        // This is critical to prevent breaking inline SVG strings in API responses
        (app as any).jsonSpaces = 0;

        // Initialize database
        await initDatabase();

        // Wait for Redis connection
        await new Promise<void>((resolve) => {
            if (redis.status === "ready") {
                resolve();
            } else {
                redis.once("ready", resolve);
            }
        });

        console.log("Registering task queue processors...");
        const taskTypes = getRegisteredTaskTypes();
        for (const taskType of taskTypes) {
            taskQueueAdapter.registerProcessor(taskType, processTask);
            console.log(`  - Registered processor for task type: ${taskType}`);
        }
        console.log(`Task queue processors registered successfully (${taskTypes.length} types)`);

        app.listen(config.port, config.host, () => {
            console.log(`
════════════════════════════════════════
Server started successfully!
URL: http://${config.host}:${config.port}
Env: ${process.env.NODE_ENV || "development"}
════════════════════════════════════════
            `);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
}

process.on("SIGINT", async () => {
    console.log("\nShutting down gracefully...");
    await redis.quit();
    process.exit(0);
});

main();
