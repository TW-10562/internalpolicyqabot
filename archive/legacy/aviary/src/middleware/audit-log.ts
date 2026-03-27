import { Context, Next } from 'koa';
import { RouteInfo } from '@aviary-ai/audit-log';
import { auditLogService } from '../services/audit';
import { menuService } from '../services/system';
import { RouteType } from '@aviary-ai/identity-management';

const normalizeRoutes = (routes?: RouteType[]): RouteInfo[] | undefined => {
    if (!routes) {
        return undefined;
    }

    return routes.map((route) => ({
        element: route.element || route.path,
        meta: {
            title: route.meta?.title || '通用模块',
        },
        children: normalizeRoutes(route.children),
    }));
};

export function auditLogMiddleware() {
    return async (ctx: Context, next: Next) => {
        try {
            await next();

            if (ctx.state.user) {
                const machineInfo = await auditLogService.getMachineInfo(ctx);
                const routes = ctx.state.user?.userId
                    ? normalizeRoutes(await menuService.getRouters(ctx.state.user.userId))
                    : undefined;

                await auditLogService.logOperation(ctx, '0', {
                    userInfo: {
                        userName: ctx.state.user.userName,
                        dept: ctx.state.user.dept,
                    },
                    machineInfo,
                    result: ctx.body,
                    routes,
                });
            }
        } catch (error: any) {
            if (ctx.state.user) {
                const machineInfo = await auditLogService.getMachineInfo(ctx);
                const routes = ctx.state.user?.userId
                    ? normalizeRoutes(await menuService.getRouters(ctx.state.user.userId))
                    : undefined;

                await auditLogService.logOperation(ctx, '1', {
                    userInfo: {
                        userName: ctx.state.user.userName,
                        dept: ctx.state.user.dept,
                    },
                    machineInfo,
                    errorMessage: error.message,
                    routes,
                });
            }

            throw error;
        }
    };
}
