import { AccessScope, normalizeDepartmentCode, normalizeRoleCode, RoleCode } from '@/service/rbac';
import { Context } from 'koa';

import {
  createAdminUser,
  deleteAdminUser,
  bulkDeleteAdminUsers,
  importAdminUsersFromCsv,
  listAdminUsers,
  updateAdminUser,
} from '@/service/adminUser';

const looksLikeEmail = (value: unknown) => {
  const v = String(value || '').trim();
  return Boolean(v && v.includes('@') && v.includes('.') && !v.includes(' '));
};

const parsePayload = (body: any) => {
  const legacyEmployeeId = String(body?.employeeId || '').trim();
  const employeeCode = String(body?.employeeCode || body?.empCode || '').trim();
  const rawEmail = String(body?.email || body?.mail || '').trim();
  const email = rawEmail || (looksLikeEmail(legacyEmployeeId) ? legacyEmployeeId : '');

  // Backward-compatible mapping:
  // - Prefer explicit employeeCode for emp_id
  // - Otherwise fall back to legacy employeeId when it isn't an email
  // - Otherwise fall back to email (so existing deployments keep working)
  const employeeId =
    employeeCode ||
    (!looksLikeEmail(legacyEmployeeId) ? legacyEmployeeId : '') ||
    email ||
    legacyEmployeeId ||
    '';

  return {
    userName: String(body?.userName || body?.user_name || '').trim() || undefined,
    firstName: String(body?.firstName || '').trim(),
    lastName: String(body?.lastName || '').trim(),
    email: email || undefined,
    employeeId,
    userJobRole: String(body?.userJobRole || '').trim(),
    areaOfWork: String(body?.areaOfWork || '').trim(),
    roleCode: normalizeRoleCode(body?.roleCode || body?.role || 'USER') as RoleCode,
    departmentCode: normalizeDepartmentCode(body?.departmentCode || body?.department || 'HR'),
    password: body?.password ? String(body.password) : undefined,
    isActive: body?.isActive == null ? true : Boolean(body.isActive),
  };
};

export const getAdminUsers = async (ctx: Context, next: () => Promise<void>) => {
  const scope = (ctx.state as any).accessScope as AccessScope;
  const q = String((ctx.query as any)?.q || (ctx.query as any)?.search || '').trim();
  const users = await listAdminUsers(scope, q ? { query: q } : undefined);
  ctx.state.formatData = users;
  await next();
};

export const createAdminUserController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const payload = parsePayload(ctx.request.body);
    if (!payload.firstName || !payload.lastName || !payload.email) {
      return ctx.app.emit('error', { code: '400', message: '必須項目が不足しています' }, ctx);
    }

    const scope = (ctx.state as any).accessScope as AccessScope;
    const created = await createAdminUser(payload, scope);
    ctx.state.formatData = created;
    await next();
  } catch (error: any) {
    if (error?.code === 'duplicate_user_name') {
      return ctx.app.emit('error', { code: '409', message: 'userName は既に使用されています' }, ctx);
    }
    if (error?.code === 'duplicate_emp_id' || error?.name === 'SequelizeUniqueConstraintError') {
      return ctx.app.emit('error', { code: '409', message: 'employeeId は既に使用されています' }, ctx);
    }
    if (error?.code === 'forbidden_department' || error?.code === 'forbidden_role_assignment') {
      return ctx.app.emit('error', { code: '403', message: 'アクセス権限がありません' }, ctx);
    }
    if (error?.message === 'validation_error') {
      return ctx.app.emit('error', { code: '400', message: '入力値が不正です' }, ctx);
    }
    return ctx.app.emit('error', { code: '500', message: 'ユーザー作成に失敗しました' }, ctx);
  }
};

export const updateAdminUserController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const userId = Number(ctx.params.userId);
    const payload = parsePayload(ctx.request.body);
    if (!payload.firstName || !payload.lastName || !payload.email) {
      return ctx.app.emit('error', { code: '400', message: '必須項目が不足しています' }, ctx);
    }

    const scope = (ctx.state as any).accessScope as AccessScope;
    const updated = await updateAdminUser(userId, payload, scope);
    ctx.state.formatData = updated;
    await next();
  } catch (error: any) {
    if (error?.code === 'duplicate_user_name') {
      return ctx.app.emit('error', { code: '409', message: 'userName は既に使用されています' }, ctx);
    }
    if (error?.code === 'duplicate_emp_id' || error?.name === 'SequelizeUniqueConstraintError') {
      return ctx.app.emit('error', { code: '409', message: 'employeeId は既に使用されています' }, ctx);
    }
    if (error?.message === 'not_found') {
      return ctx.app.emit('error', { code: '400', message: 'ユーザーが存在しません' }, ctx);
    }
    if (error?.code === 'forbidden_department' || error?.code === 'forbidden_role_assignment') {
      return ctx.app.emit('error', { code: '403', message: 'アクセス権限がありません' }, ctx);
    }
    if (error?.message === 'validation_error') {
      return ctx.app.emit('error', { code: '400', message: '入力値が不正です' }, ctx);
    }
    return ctx.app.emit('error', { code: '500', message: 'ユーザー更新に失敗しました' }, ctx);
  }
};

export const deleteAdminUserController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const userId = Number(ctx.params.userId);
    const scope = (ctx.state as any).accessScope as AccessScope;
    await deleteAdminUser(userId, scope);
    ctx.state.formatData = { success: true };
    await next();
  } catch (error: any) {
    if (error?.code === 'forbidden_department') {
      return ctx.app.emit('error', { code: '403', message: 'アクセス権限がありません' }, ctx);
    }
    return ctx.app.emit('error', { code: '500', message: 'ユーザー削除に失敗しました' }, ctx);
  }
};

export const bulkDeleteAdminUsersController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const rawIds = (ctx.request.body as any)?.userIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return ctx.app.emit('error', { code: '400', message: 'userIds が必要です' }, ctx);
    }

    const userIds = rawIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id));
    if (userIds.length !== rawIds.length) {
      return ctx.app.emit('error', { code: '400', message: 'userIds が不正です' }, ctx);
    }

    const scope = (ctx.state as any).accessScope as AccessScope;
    const result = await bulkDeleteAdminUsers(userIds, scope);
    ctx.state.formatData = result;
    await next();
  } catch (error: any) {
    if (error?.code === 'validation_error') {
      return ctx.app.emit('error', { code: '400', message: 'userIds が不正です' }, ctx);
    }
    if (error?.code === 'cannot_delete_self') {
      return ctx.app.emit('error', { code: '400', message: '自分自身は削除できません' }, ctx);
    }
    if (error?.code === 'not_found') {
      return ctx.app.emit('error', { code: '404', message: '指定したユーザーが存在しません' }, ctx);
    }
    if (error?.code === 'forbidden_role_delete') {
      return ctx.app.emit('error', { code: '403', message: '削除できないロールが含まれています' }, ctx);
    }
    if (error?.code === 'forbidden_manage_users') {
      return ctx.app.emit('error', { code: '403', message: 'アクセス権限がありません' }, ctx);
    }
    return ctx.app.emit('error', { code: '500', message: 'ユーザー削除に失敗しました' }, ctx);
  }
};

export const importAdminUsersCsvController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const files = (ctx.request as any).files || {};
    const fileCandidate = files.file || files.csv || Object.values(files)[0];
    const file = Array.isArray(fileCandidate) ? fileCandidate[0] : fileCandidate;

    if (!file?.filepath) {
      return ctx.app.emit('error', { code: '400', message: 'CSV ファイルが必要です' }, ctx);
    }

    const scope = (ctx.state as any).accessScope as AccessScope;
    const report = await importAdminUsersFromCsv(file.filepath, scope);
    ctx.state.formatData = report;
    await next();
  } catch (error: any) {
    if (error?.status && error?.errors) {
      ctx.status = Number(error.status) || 400;
      ctx.body = {
        success: false,
        code: error.code || 'VALIDATION_ERROR',
        message: error.message || 'CSV 取込に失敗しました',
        errors: error.errors,
        totalRows: error.totalRows ?? 0,
        validRows: error.validRows ?? 0,
        invalidRows: error.invalidRows ?? 0,
      };
      return;
    }
    return ctx.app.emit('error', { code: '400', message: error?.message || 'CSV 取込に失敗しました' }, ctx);
  }
};
