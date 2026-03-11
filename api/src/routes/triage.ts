import Router from 'koa-router';
import Joi from 'joi';
import { fail, ok } from '@/service/apiResponse';
import { requireScopedAccess } from '@/controller/auth';
import { AccessScope, isDepartmentAdminRole, isSuperAdminRole } from '@/service/rbac';
import {
  createTriageTicket,
  getTriageSummary,
  listTriageAssignees,
  listTriageTickets,
  purgeTriageTickets,
  sendTriageReply,
  updateTriageStatus,
} from '@/service/triageService';
import { emitAuditLog } from '@/service/rbac';

const router = new Router({ prefix: '/api/triage' });
router.use(requireScopedAccess);

router.post('/tickets', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const schema = Joi.object({
    conversationId: Joi.string().allow('', null).optional(),
    messageId: Joi.string().allow('', null).optional(),
    userQueryOriginal: Joi.string().required(),
    assistantAnswer: Joi.string().required(),
    issueType: Joi.string().required(),
    userComment: Joi.string().required(),
    expectedAnswer: Joi.string().allow('', null).optional(),
    retrievedSourceIds: Joi.array().items(Joi.string()).optional(),
    retrievalQueryUsed: Joi.string().allow('', null).optional(),
    modelName: Joi.string().allow('', null).optional(),
    departmentCode: Joi.string().valid('HR', 'GA', 'ACC', 'OTHER').optional(),
    routingMode: Joi.string().valid('AUTO', 'MANUAL').optional(),
    assignedToUserId: Joi.number().integer().min(1).allow(null).optional(),
    targetRoleCode: Joi.string().valid('SUPER_ADMIN', 'HR_ADMIN', 'GA_ADMIN', 'ACC_ADMIN').optional(),
  });
  const { error, value } = schema.validate(ctx.request.body || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const ticket = await createTriageTicket(scope, value);
    const deduplicated = Boolean((ticket as any)?.deduplicated);
    await emitAuditLog({
      actor: scope,
      action: deduplicated ? 'TRIAGE_TICKET_REUSED' : 'TRIAGE_TICKET_CREATED',
      targetType: 'triage_ticket',
      targetId: ticket.id,
      details: {
        issueType: value.issueType,
        routingMode: value.routingMode || 'AUTO',
        departmentCode: ticket.department_code,
        assignedTo: ticket.assigned_to || null,
        routingSource: ticket.routing_source || null,
        routingAnalysis: ticket.routing_analysis || null,
        deduplicated,
      },
    });
    ctx.body = ok(ticket);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to create triage ticket');
  }
});

router.get('/assignees', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const departmentCode = String(ctx.query?.departmentCode || '').trim();
  try {
    const rows = await listTriageAssignees(scope, departmentCode || undefined);
    ctx.body = ok({ rows });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to list triage assignees');
  }
});

router.get('/tickets', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!(isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    ctx.body = fail('FORBIDDEN', 'アクセス権限がありません');
    return;
  }
  const pageNum = Number(ctx.query?.pageNum || 1);
  const pageSize = Number(ctx.query?.pageSize || 20);
  try {
    const rows = await listTriageTickets(scope, pageNum, pageSize);
    // Defensive strictness: never leak cross-department tickets to department admins.
    const strictRows = isDepartmentAdminRole(scope.roleCode)
      ? rows.filter((r: any) => {
        const dept = String(r?.department_code || '').toUpperCase();
        if (scope.roleCode === 'HR_ADMIN') return dept === 'HR';
        if (scope.roleCode === 'GA_ADMIN') return dept === 'GA';
        if (scope.roleCode === 'ACC_ADMIN') return dept === 'ACC';
        return false;
      })
      : rows;
    ctx.body = ok({ rows: strictRows, pageNum, pageSize });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to list triage tickets');
  }
});

router.get('/summary', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!(isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    ctx.body = fail('FORBIDDEN', 'アクセス権限がありません');
    return;
  }
  try {
    const summary = await getTriageSummary(scope);
    ctx.body = ok(summary);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to load triage summary');
  }
});

router.patch('/tickets/:id/status', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!(isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    ctx.body = fail('FORBIDDEN', 'アクセス権限がありません');
    return;
  }
  const id = Number(ctx.params?.id);
  const schema = Joi.object({
    status: Joi.string().valid('OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED').required(),
    assignedTo: Joi.number().integer().min(1).allow(null).optional(),
    adminReply: Joi.string().allow('', null).optional(),
  });
  const { error, value } = schema.validate(ctx.request.body || {});
  if (!Number.isFinite(id)) {
    ctx.body = fail('BAD_REQUEST', 'Invalid ticket id');
    return;
  }
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const hasAssignedTo = Object.prototype.hasOwnProperty.call(value, 'assignedTo');
    const assignedTo = hasAssignedTo
      ? (value.assignedTo == null ? null : Number(value.assignedTo))
      : undefined;
    const updated = await updateTriageStatus(scope, id, value.status, assignedTo, value.adminReply || null);
    if (!updated) {
      ctx.body = fail('NOT_FOUND', 'Ticket not found');
      return;
    }
    await emitAuditLog({
      actor: scope,
      action: 'TRIAGE_STATUS_CHANGED',
      targetType: 'triage_ticket',
      targetId: id,
      details: { status: value.status, assignedTo: assignedTo ?? null, adminReply: value.adminReply || null },
    });
    ctx.body = ok(updated);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to update triage ticket');
  }
});

router.post('/tickets/:id/reply', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!(isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    ctx.body = fail('FORBIDDEN', 'アクセス権限がありません');
    return;
  }

  const id = Number(ctx.params?.id);
  const schema = Joi.object({
    reply: Joi.string().trim().min(1).required(),
  });
  const { error, value } = schema.validate(ctx.request.body || {});
  if (!Number.isFinite(id)) {
    ctx.body = fail('BAD_REQUEST', 'Invalid ticket id');
    return;
  }
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  try {
    const result = await sendTriageReply(scope, id, value.reply);
    if (!result) {
      ctx.body = fail('NOT_FOUND', 'Ticket not found');
      return;
    }
    await emitAuditLog({
      actor: scope,
      action: 'TRIAGE_REPLY_SENT',
      targetType: 'triage_ticket',
      targetId: id,
      details: { reply: value.reply },
    });
    ctx.body = ok(result);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to send triage reply');
  }
});

router.delete('/tickets/purge', async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!(isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    ctx.body = fail('FORBIDDEN', 'アクセス権限がありません');
    return;
  }
  const schema = Joi.object({
    adminPassword: Joi.string().trim().min(1).required(),
  });
  const { error, value } = schema.validate(ctx.request.body || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }
  try {
    const result = await purgeTriageTickets(scope, value.adminPassword);
    await emitAuditLog({
      actor: scope,
      action: 'TRIAGE_TICKETS_PURGED',
      targetType: 'triage_ticket',
      targetId: null,
      details: result,
    });
    ctx.body = ok(result);
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to purge triage tickets');
  }
});

export default router;
