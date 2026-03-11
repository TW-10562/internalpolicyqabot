import Router from 'koa-router';
import Joi from 'joi';
import { fail, ok } from '@/service/apiResponse';
import { requireScopedAccess } from '@/controller/auth';
import { AccessScope, isSuperAdminRole } from '@/service/rbac';
import { resetSystemPermanently, systemResetConfirmationText } from '@/service/systemResetService';

const router = new Router({ prefix: '/api/system-reset' });
router.use(requireScopedAccess);

router.post('/execute', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;

  if (!isSuperAdminRole(scope.roleCode)) {
    ctx.body = fail('FORBIDDEN', 'Only SUPER_ADMIN can perform a full system reset');
    return;
  }

  const schema = Joi.object({
    accountPassword: Joi.string().trim().min(1).required(),
    confirmationText: Joi.string().trim().required(),
  });

  const { error, value } = schema.validate(ctx.request.body || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const result = await resetSystemPermanently(scope, value.accountPassword, value.confirmationText);
    ctx.body = ok(result);
  } catch (e: any) {
    const message = String(e?.message || 'Failed to reset system');
    if (message === 'FORBIDDEN') {
      ctx.body = fail('FORBIDDEN', 'Only SUPER_ADMIN can perform a full system reset');
      return;
    }
    if (
      message.includes('password') ||
      message.includes('confirm') ||
      message.includes(systemResetConfirmationText)
    ) {
      ctx.body = fail('BAD_REQUEST', message);
      return;
    }
    ctx.body = fail('INTERNAL_ERROR', message);
  }
});

export default router;
