import Router from 'koa-router';
import Joi from 'joi';
import { fail, ok } from '@/service/apiResponse';
import { requireScopedAccess } from '@/controller/auth';
import {
  deleteConversationHistory,
  getHistoryMessages,
  listHistoryConversations,
  listHistoryUsers,
} from '@/service/historyPersistenceService';
import { AccessScope, isSuperAdminRole } from '@/service/rbac';

const router = new Router({ prefix: '/api/history' });
router.use(requireScopedAccess);

router.get('/', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const userId = Number(ctx.state?.user?.userId);
  if (!Number.isFinite(userId)) {
    ctx.body = fail('UNAUTHORIZED', 'Invalid token');
    return;
  }

  const schema = Joi.object({
    pageNum: Joi.number().integer().min(1).default(1),
    pageSize: Joi.number().integer().min(1).max(100).default(20),
    userId: Joi.number().integer().min(1).optional(),
    allUsers: Joi.boolean().truthy('1').truthy('true').falsy('0').falsy('false').default(false),
  });

  const { error, value } = schema.validate(ctx.query || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const requestedUserId = Number(value.userId);
    const isSuperAdmin = isSuperAdminRole(scope.roleCode);
    const targetUserId = isSuperAdmin
      ? (value.allUsers ? undefined : (Number.isFinite(requestedUserId) ? requestedUserId : userId))
      : userId;
    const data = await listHistoryConversations(
      {
        userId: targetUserId,
        pageNum: value.pageNum,
        pageSize: value.pageSize,
        // user_id scoping is the source of truth; avoid false negatives from stale department snapshots.
        departmentCode: undefined,
      },
    );
    ctx.body = ok(data);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to list history');
  }
});

router.get('/users', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!isSuperAdminRole(scope.roleCode)) {
    ctx.body = fail('FORBIDDEN', 'Only SUPER_ADMIN can list all history users');
    return;
  }

  const schema = Joi.object({
    pageNum: Joi.number().integer().min(1).default(1),
    pageSize: Joi.number().integer().min(1).max(100).default(25),
    query: Joi.string().allow('').default(''),
  });

  const { error, value } = schema.validate(ctx.query || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const data = await listHistoryUsers({
      pageNum: value.pageNum,
      pageSize: value.pageSize,
      query: value.query,
    });
    ctx.body = ok(data);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to list history users');
  }
});

router.get('/:conversationId', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const userId = Number(ctx.state?.user?.userId);
  if (!Number.isFinite(userId)) {
    ctx.body = fail('UNAUTHORIZED', 'Invalid token');
    return;
  }

  const conversationId = String(ctx.params?.conversationId || '').trim();
  if (!conversationId) {
    ctx.body = fail('BAD_REQUEST', 'conversationId is required');
    return;
  }

  try {
    const requestedUserId = Number((ctx.query || {}).userId);
    const isSuperAdmin = isSuperAdminRole(scope.roleCode);
    const targetUserId = isSuperAdmin
      ? (Number.isFinite(requestedUserId) ? requestedUserId : undefined)
      : userId;
    const data = await getHistoryMessages({
      userId: targetUserId,
      conversationId,
      departmentCode: undefined,
    });
    if (!data) {
      ctx.body = fail('NOT_FOUND', 'Conversation not found');
      return;
    }
    ctx.body = ok(data);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to fetch conversation history');
  }
});

router.delete('/:conversationId', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const userId = Number(ctx.state?.user?.userId);
  if (!Number.isFinite(userId)) {
    ctx.body = fail('UNAUTHORIZED', 'Invalid token');
    return;
  }

  const conversationId = String(ctx.params?.conversationId || '').trim();
  if (!conversationId) {
    ctx.body = fail('BAD_REQUEST', 'conversationId is required');
    return;
  }

  try {
    const requestedUserId = Number((ctx.query || {}).userId);
    const isSuperAdmin = isSuperAdminRole(scope.roleCode);
    const targetUserId = isSuperAdmin
      ? (Number.isFinite(requestedUserId) ? requestedUserId : undefined)
      : userId;
    await deleteConversationHistory({
      userId: targetUserId,
      conversationId,
      departmentCode: undefined,
    });
    ctx.body = ok({ deleted: true });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to delete conversation history');
  }
});

export default router;
