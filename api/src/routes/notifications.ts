import Router from 'koa-router';
import Joi from 'joi';
import { fail, ok } from '@/service/apiResponse';
import { requireScopedAccess } from '@/controller/auth';
import {
  createNotification,
  listNotifications,
  markNotificationAsRead,
  NotificationType,
  purgeUserNotifications,
} from '@/service/notificationService';
import {
  AccessScope,
  isDepartmentAdminRole,
  isSuperAdminRole,
  normalizeDepartmentCode,
} from '@/service/rbac';

const router = new Router({ prefix: '/api/notifications' });
router.use(requireScopedAccess);

router.get('/', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const requestedUserId = Number(ctx.query?.userId);
  const userId = (isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode)) && Number.isFinite(requestedUserId)
    ? requestedUserId
    : Number(ctx.state?.user?.userId);
  if (!Number.isFinite(userId)) {
    ctx.body = fail('UNAUTHORIZED', 'Invalid token');
    return;
  }

  const schema = Joi.object({
    pageNum: Joi.number().integer().min(1).default(1),
    pageSize: Joi.number().integer().min(1).max(100).default(20),
  });
  const { error, value } = schema.validate(ctx.query || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const includeDepartmentBroadcast = isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode);
    const data = await listNotifications(
      userId,
      value.pageNum,
      value.pageSize,
      isSuperAdminRole(scope.roleCode) ? undefined : scope.departmentCode,
      includeDepartmentBroadcast,
    );
    ctx.body = ok(data);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to list notifications');
  }
});

router.post('/', async (ctx: any) => {
  const schema = Joi.object({
    userId: Joi.number().integer().min(1).optional(),
    departmentCode: Joi.string().valid('HR', 'GA', 'ACC', 'OTHER').optional(),
    type: Joi.string()
      .valid(
        'system_alert',
        'meeting_summary_ready',
        'translation_completed',
        'file_processed',
        'chat_reply_ready',
        'custom',
      )
      .required(),
    title: Joi.string().trim().max(255).required(),
    body: Joi.string().trim().required(),
    payload: Joi.object().optional(),
  });
  const { error, value } = schema.validate(ctx.request.body || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  const actorUserId = Number(ctx.state?.user?.userId);
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const targetUserId = value.userId == null ? null : Number(value.userId);
  const targetDepartment = isSuperAdminRole(scope.roleCode)
    ? normalizeDepartmentCode(value.departmentCode || scope.departmentCode)
    : scope.departmentCode;

  try {
    const created = await createNotification({
      userId: Number.isFinite(targetUserId as number)
        ? targetUserId
        : (isSuperAdminRole(scope.roleCode) ? null : actorUserId),
      departmentCode: targetDepartment,
      type: value.type as NotificationType,
      title: value.title,
      body: value.body,
      payload: value.payload,
    });
    ctx.body = ok(created);
  } catch (e: any) {
    if (e?.message === 'validation_error') {
      ctx.body = fail('BAD_REQUEST', 'Invalid notification payload');
      return;
    }
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to create notification');
  }
});

router.patch('/:id/read', async (ctx: any) => {
  const userId = Number(ctx.state?.user?.userId);
  if (!Number.isFinite(userId)) {
    ctx.body = fail('UNAUTHORIZED', 'Invalid token');
    return;
  }

  const id = Number(ctx.params?.id);
  if (!Number.isFinite(id)) {
    ctx.body = fail('BAD_REQUEST', 'Invalid notification id');
    return;
  }

  try {
    const updated = await markNotificationAsRead(userId, id);
    if (!updated) {
      ctx.body = fail('NOT_FOUND', 'Notification not found');
      return;
    }
    ctx.body = ok({ id, is_read: true });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to mark notification as read');
  }
});

router.delete('/purge-users', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!isSuperAdminRole(scope.roleCode) && !isDepartmentAdminRole(scope.roleCode)) {
    ctx.body = fail('FORBIDDEN', 'Only admins can purge notifications');
    return;
  }

  const departmentCode = isSuperAdminRole(scope.roleCode) ? undefined : scope.departmentCode;

  try {
    const result = await purgeUserNotifications({ departmentCode });
    ctx.body = ok({
      ...result,
      scope: departmentCode || 'ALL',
    });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to purge notifications');
  }
});

export default router;
