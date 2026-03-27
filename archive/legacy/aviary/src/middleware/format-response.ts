import { Context, Next } from "koa";

export const formatResponse = () => async (ctx: Context, next: Next) => {
    await next();

    if (typeof ctx.body === "object" && ctx.body && "code" in ctx.body && "msg" in ctx.body) {
        return;
    }

    const originalBody = ctx.body;
    ctx.body = {
        code: 200,
        msg: "操作成功",
        data: originalBody,
    };
};
