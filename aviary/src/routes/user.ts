import {
    downloadAvatar,
    getInfo,
    profile,
    updatePassword,
    updateProfile,
    uploadAvatar
} from "@aviary-ai/identity-access";
import Router from "@koa/router";
import { identityDeps } from "../services/identity";
import { menuService } from "../services/system";

const router = new Router({ prefix: "/user" });

router.get("/getInfo", getInfo(identityDeps));
router.get("/getRouters", async (ctx) => {
    const userId = ctx.state.user?.userId as number | undefined;
    if (!userId) {
        ctx.status = 401;
        ctx.body = { code: 401, msg: "未登录" };
        return;
    }
    const data = await menuService.getRouters(userId);
    ctx.body = { code: 200, msg: "操作成功", data };
});
router.get("/profile", profile(identityDeps));
router.put("/profile/updatePwd", updatePassword(identityDeps));
router.put("/profile", updateProfile(identityDeps));
router.post("/profile/avatar", uploadAvatar(identityDeps));
router.post("/profile/downloadAvatar", downloadAvatar(identityDeps));

const userRouter: Router = router;
export default userRouter;
