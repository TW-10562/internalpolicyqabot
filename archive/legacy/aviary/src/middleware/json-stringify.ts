import { Context, Next } from "koa";

export const compactJson = () => async (ctx: Context, next: Next) => {
    await next();

    const body: any = ctx.body;
    if (body &&
        typeof body === "object" &&
        !Buffer.isBuffer(body) &&
        !(body instanceof String) &&
        typeof body.pipe !== "function") {
        const json = JSON.stringify(body);
        ctx.body = json;
        ctx.length = Buffer.byteLength(json);
        ctx.type = "application/json; charset=utf-8";
    }
};
