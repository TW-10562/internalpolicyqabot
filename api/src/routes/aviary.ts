import Router from 'koa-router';
import Joi from 'joi';
import { loginByEmployeeId } from '@/controller/apiAuth';
import { requireScopedAccess } from '@/controller/auth';
import { detectDbMode, getDbStatus } from '@/db/adapter';
import { ok, fail } from '@/service/apiResponse';
import { AccessScope, isSuperAdminRole } from '@/service/rbac';
import { getAviaryPackageStatuses, summarizeAviaryStatuses } from '@/service/aviaryLinkage';
import { getFullUserInfo } from '@/utils/userInfo';
import { handleAddGenTask } from '@/service/genTaskService';
import KrdGenTask from '@/mysql/model/gen_task.model';
import KrdGenTaskOutput from '@/mysql/model/gen_task_output.model';
import { formatHumpLineTransfer } from '@/utils';
import { pgPool } from '@/clients/postgres';

const router = new Router({ prefix: '/api/aviary/v1' });

const taskSchema = Joi.object({
  type: Joi.string().valid('CHAT', 'SUMMARY', 'TRANSLATE', 'FILEUPLOAD').required(),
  formData: Joi.object().required(),
});

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

router.get('/health', async (ctx) => {
  const db = await getDbStatus();
  ctx.body = ok({
    status: 'ok',
    db,
    timestamp: new Date().toISOString(),
  });
});

router.get('/integration/packages', requireScopedAccess, async (ctx) => {
  const dbMode = await detectDbMode();
  const rows = getAviaryPackageStatuses();
  const summary = summarizeAviaryStatuses(rows, dbMode);

  ctx.body = ok({
    dbMode,
    activeProfile: summary.required.profile,
    ready: summary.required.ready,
    summary,
    rows,
  });
});

router.post('/auth/login', loginByEmployeeId, async (ctx: any) => {
  const result = ctx.state?.formatData || {};
  ctx.body = ok({
    accessToken: result.token,
    tokenType: 'Bearer',
    user: {
      userId: result.userId,
      empId: result.empId,
      roleCode: result.roleCode,
      departmentCode: result.departmentCode,
    },
  });
});

router.get('/auth/me', requireScopedAccess, async (ctx: any) => {
  const userId = Number(ctx.state?.user?.userId);
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  if (!Number.isFinite(userId)) {
    ctx.body = fail('UNAUTHORIZED', 'Invalid token');
    return;
  }

  try {
    const fullUser = await getFullUserInfo(userId);
    ctx.body = ok({
      user: {
        userId,
        userName: scope.userName || ctx.state?.user?.userName || null,
        empId: ctx.state?.user?.empId || null,
        roleCode: scope.roleCode,
        departmentCode: scope.departmentCode,
      },
      roles: fullUser.roles || [],
      permissions: fullUser.permissions || [],
    });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to fetch current user');
  }
});

router.post('/tasks', requireScopedAccess, async (ctx: any) => {
  const { error, value } = taskSchema.validate(ctx.request.body || {});
  if (error) {
    ctx.body = fail('BAD_REQUEST', error.details[0].message);
    return;
  }

  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const userName = String(ctx.state?.user?.userName || scope.userName || 'system');
  const userId = Number(ctx.state?.user?.userId);

  try {
    const created = await handleAddGenTask(
      value,
      userName,
      Number.isFinite(userId) ? userId : undefined,
      scope.departmentCode,
    );
    const taskRow = await KrdGenTask.findOne({ raw: true, where: { id: created.taskId } });
    ctx.body = ok({
      id: created.taskId,
      status: (taskRow as any)?.status || created.task?.status || 'WAIT',
      task: taskRow ? formatHumpLineTransfer(taskRow) : (created.task || null),
    });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to create task');
  }
});

router.get('/tasks/:id', requireScopedAccess, async (ctx: any) => {
  const taskId = String(ctx.params?.id || '').trim();
  if (!taskId) {
    ctx.body = fail('BAD_REQUEST', 'Task id is required');
    return;
  }

  const scope = (ctx.state?.accessScope || {}) as AccessScope;

  try {
    const taskRow = await KrdGenTask.findOne({ raw: true, where: { id: taskId } });
    if (!taskRow) {
      ctx.body = fail('NOT_FOUND', 'Task not found');
      return;
    }

    const taskDepartment = String((taskRow as any).department_code || scope.departmentCode || '').toUpperCase();
    if (!isSuperAdminRole(scope.roleCode) && taskDepartment !== scope.departmentCode) {
      ctx.body = fail('FORBIDDEN', 'アクセス権限がありません');
      return;
    }

    const outputs = await KrdGenTaskOutput.findAll({
      raw: true,
      where: { task_id: taskId },
      order: [['sort', 'ASC'], ['id', 'ASC']],
    });

    const visibleOutputs = isSuperAdminRole(scope.roleCode)
      ? outputs
      : outputs.filter((row: any) => {
        const outputDepartment = String(row.department_code || taskDepartment).toUpperCase();
        return outputDepartment === scope.departmentCode;
      });

    ctx.body = ok({
      task: formatHumpLineTransfer(taskRow),
      outputs: formatHumpLineTransfer(visibleOutputs),
    });
  } catch (e: any) {
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to fetch task');
  }
});

router.get('/audit/events', requireScopedAccess, async (ctx: any) => {
  const scope = (ctx.state?.accessScope || {}) as AccessScope;
  const pageNum = toPositiveInt(ctx.query?.pageNum, 1);
  const pageSize = Math.min(toPositiveInt(ctx.query?.pageSize, 20), 100);
  const action = String(ctx.query?.action || '').trim();
  const targetType = String(ctx.query?.targetType || '').trim();

  const whereParts: string[] = [];
  const whereParams: any[] = [];
  if (!isSuperAdminRole(scope.roleCode)) {
    whereParams.push(scope.departmentCode);
    whereParts.push(`actor_department_code = $${whereParams.length}`);
  }
  if (action) {
    whereParams.push(action);
    whereParts.push(`action = $${whereParams.length}`);
  }
  if (targetType) {
    whereParams.push(targetType);
    whereParts.push(`target_type = $${whereParams.length}`);
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*)::int AS count FROM audit_logs ${whereSql}`;
  const listParams = [...whereParams, pageSize, (pageNum - 1) * pageSize];
  const listSql = `
    SELECT
      id,
      actor_user_id,
      actor_role_code,
      actor_department_code,
      action,
      target_type,
      target_id,
      details_json,
      created_at
    FROM audit_logs
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT $${whereParams.length + 1}
    OFFSET $${whereParams.length + 2}
  `;

  try {
    const [countRes, rowsRes] = await Promise.all([
      pgPool.query(countSql, whereParams),
      pgPool.query(listSql, listParams),
    ]);

    const rows = rowsRes.rows.map((row: any) => ({
      id: Number(row.id),
      actorUserId: Number(row.actor_user_id),
      actorRoleCode: row.actor_role_code,
      actorDepartmentCode: row.actor_department_code,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details_json || {},
      createdAt: row.created_at,
    }));

    ctx.body = ok({
      pageNum,
      pageSize,
      count: Number(countRes.rows?.[0]?.count || 0),
      rows,
    });
  } catch (e: any) {
    if (String(e?.code || '') === '42P01') {
      ctx.body = ok({ pageNum, pageSize, count: 0, rows: [] });
      return;
    }
    ctx.body = fail('INTERNAL_ERROR', e?.message || 'Failed to fetch audit events');
  }
});

export default router;
