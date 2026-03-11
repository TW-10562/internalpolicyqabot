import Router from "@koa/router";
import asyncTaskRouter from "./async-task";
import authRouter from "./auth";
import chatStreamRouter from "./chat-stream";
import commonRouter from "./common";
import monitorRouter from "./monitor";
import sseRouter from "./sse";
import systemRouter from "./system";
import userRouter from "./user";

const router: Router = new Router();

router.get("/health", (ctx) => {
    ctx.body = {
        status: "ok",
        timestamp: new Date().toISOString(),
    };
});

router.use(commonRouter.routes());
router.use(commonRouter.allowedMethods());

router.use(authRouter.routes());
router.use(authRouter.allowedMethods());

router.use(userRouter.routes());
router.use(userRouter.allowedMethods());

router.use(systemRouter.routes());
router.use(systemRouter.allowedMethods());

router.use(monitorRouter.routes());
router.use(monitorRouter.allowedMethods());

router.use(asyncTaskRouter.routes());
router.use(asyncTaskRouter.allowedMethods());

router.use(chatStreamRouter.routes());
router.use(chatStreamRouter.allowedMethods());

router.use(sseRouter.routes());
router.use(sseRouter.allowedMethods());

export default router;
