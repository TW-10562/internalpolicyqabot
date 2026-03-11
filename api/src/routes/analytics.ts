import Router from 'koa-router';
import { requireAdmin, requireScopedAccess } from '@/controller/auth';
import { getAnalyticsOverview } from '@/service/analyticsService';
import { AccessScope, isSuperAdminRole } from '@/service/rbac';

const router = new Router({ prefix: '/api/admin' });

router.get('/analytics', requireScopedAccess, requireAdmin, async (ctx: any) => {
  try {
    const rangeRaw = String(ctx.query?.range || '7d');
    const range = (rangeRaw === '30d' || rangeRaw === '90d' || rangeRaw === '7d' ? rangeRaw : '7d') as
      | '7d'
      | '30d'
      | '90d';
    const scope = (ctx.state?.accessScope || {}) as AccessScope;
    const departmentCode = isSuperAdminRole(scope.roleCode) ? undefined : scope.departmentCode;
    const data = await getAnalyticsOverview(range, departmentCode);
    ctx.body = {
      code: 200,
      message: 'Success',
      result: data,
    };
  } catch (error: any) {
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: error?.message || 'Failed to load analytics',
      },
      ctx,
    );
  }
});

export default router;
