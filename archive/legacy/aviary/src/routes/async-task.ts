import { createGenTaskRouter } from "@aviary-ai/async-tasks";
import Router from "@koa/router";
import type { Middleware } from "koa";
import { genTaskOutputService, genTaskService } from "../services/async-task";

const formatResponse: Middleware = async (ctx, next) => {
    await next();
    const data = ctx.state.formatData ?? ctx.body;
    if (!ctx.body || (typeof ctx.body === "object" && !("code" in ctx.body))) {
        ctx.body = {
            code: 200,
            msg: "操作成功",
            data: data,
        };
    }
};

const genTaskRouter = createGenTaskRouter(genTaskService, genTaskOutputService, {
    prefix: "/async-task/gen-task",
    formatResponse,
    // storageService will be added later
});

const router = new Router();
router.use(genTaskRouter.routes(), genTaskRouter.allowedMethods());

const asyncTaskRouter: Router = router;
export default asyncTaskRouter;

