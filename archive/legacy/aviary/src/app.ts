import { createAuthMiddleware, errors } from "@aviary-ai/identity-access";
import cors from "@koa/cors";
import fs from "fs";
import Koa from "koa";
import koaBody from "koa-body";
import koaStatic from "koa-static";
import { config } from "./config/index";
import { auditLogMiddleware } from "./middleware/audit-log";
import { formatResponse } from "./middleware/format-response";
import { compactJson } from "./middleware/json-stringify";
import router from "./routes/index";
import { identityDeps } from "./services/identity";

const app = new Koa();

// Ensure upload directory exists
if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
}

app.use(cors());

app.use(
    koaBody({
        multipart: true,
        formidable: {
            uploadDir: config.uploadDir,
            maxFileSize: 100 * 1024 * 1024, // 100MB
            keepExtensions: true,
        },
    }),
);

app.use(koaStatic(config.uploadDir));

app.use(async (ctx, next) => {
    await next();
});

app.use(
    createAuthMiddleware(identityDeps.tokenService, identityDeps.sessionStore, {
        whitelist: [
            "/health",
            "/auth/login",
            "/auth/register",
            "/auth/captcha"
        ],
        ttlSeconds: 60 * 60 * 12, // 12 hours
    }),
);

app.use(auditLogMiddleware());

app.use(compactJson());

app.use(router.routes());
app.use(router.allowedMethods());

app.use(formatResponse());

app.on("error", (err, ctx) => {
    console.error("Server error:", err);
    const payload = typeof err.code === "string" ? err : errors.invalidToken;
    ctx.status = Number(payload.code) || 500;
    ctx.body = payload;
});

export default app;
