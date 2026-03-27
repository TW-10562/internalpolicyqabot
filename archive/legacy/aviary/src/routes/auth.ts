import {
    captcha,
    login,
    logout,
    register,
    updatePassword
} from "@aviary-ai/identity-access";
import Router from "@koa/router";
import { identityDeps } from "../services/identity";
import { auditLogService } from "../services/audit";

const router = new Router({ prefix: "/auth" });

router.get("/captcha", captcha(identityDeps));
router.post("/login", async (ctx, next) => {
    try {
        await login(identityDeps)(ctx, next);

        const body = ctx.body as any;
        const userName = (ctx.request as any).body?.userName || "";
        const isError = body && body.code && String(body.code) !== "200";

        await auditLogService.logLogin(ctx, isError ? "1" : "0", {
            userName,
            message: isError ? body.msg || "登录失败" : "登录成功",
        });
    } catch (error: any) {
        const userName = (ctx.request as any).body?.userName || "";
        await auditLogService.logLogin(ctx, "1", {
            userName,
            message: error.message || "登录失败",
        });
        throw error;
    }
});
router.post("/logout", logout(identityDeps));
router.post("/register", register(identityDeps));
router.post("/password", updatePassword(identityDeps));

const authRouter: Router = router;
export default authRouter;
