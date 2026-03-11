import { createDomainMetaRouters } from "@aviary-ai/domain-meta";
import { createConfigRouter } from "@aviary-ai/governance-config";
import {
    createMenuRouter,
    createRoleRouter,
    createUserRouter,
} from "@aviary-ai/identity-management";
import Router from "@koa/router";
import { Middleware } from "koa";
import {
    configService,
    deptService,
    dictDataService,
    dictTypeService,
    menuService,
    postService,
    roleService,
    systemUserService,
} from "../services/system";

const formatConfigResponse: Middleware = async (ctx, next) => {
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

const configRouter = createConfigRouter(configService, {
    formatResponse: formatConfigResponse,
});

const domainMetaRouter = createDomainMetaRouters({
    dictTypeService,
    dictDataService,
    deptService,
    postService,
});

const roleRouter = createRoleRouter(roleService);
const menuRouter = createMenuRouter(menuService);
const userRouter = createUserRouter(systemUserService);

const router = new Router();
router.use((configRouter as any).routes(), (configRouter as any).allowedMethods());
router.use(domainMetaRouter.routes(), domainMetaRouter.allowedMethods());
router.use(roleRouter.routes(), roleRouter.allowedMethods());
router.use(menuRouter.routes(), menuRouter.allowedMethods());
router.use(userRouter.routes(), userRouter.allowedMethods());

const systemRouter: Router = router;
export default systemRouter;
