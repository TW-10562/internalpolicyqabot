import Router from 'koa-router';
import Joi from 'joi';
import { ok, fail } from '@/service/apiResponse';
import { requireScopedAccess } from '@/controller/auth';
import { AccessScope, isSuperAdminRole } from '@/service/rbac';
import { listFaqItems } from '@/service/historyPersistenceService';

const router = new Router({ prefix: '/api/faq' });
router.use(requireScopedAccess);

router.get('/', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const defaultMinCountRaw = Number(process.env.FAQ_MIN_COUNT_DEFAULT || 1);
  const defaultMinCount = Number.isFinite(defaultMinCountRaw)
    ? Math.max(1, Math.min(10, defaultMinCountRaw))
    : 1;

  const schema = Joi.object({
    limit: Joi.number().integer().min(1).max(50).default(10),
    minCount: Joi.number().integer().min(1).max(10).default(defaultMinCount),
    sampleSize: Joi.number().integer().min(200).max(5000).default(1200),
  });

  const { error, value } = schema.validate(ctx.query || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const data = await listFaqItems({
      limit: value.limit,
      minCount: value.minCount,
      sampleSize: value.sampleSize,
      departmentCode: isSuperAdminRole(scope.roleCode) ? undefined : scope.departmentCode,
      roleCode: scope.roleCode,
    });
    ctx.body = ok(data);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to load FAQ');
  }
});

export default router;
