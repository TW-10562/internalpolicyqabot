import { AccessScope, normalizeDepartmentCode, normalizeRoleCode, RoleCode } from '@/service/rbac';
import { Context } from 'koa';

import {
  createAdminUser,
  deleteAdminUser,
  permanentlyDeleteAdminUser,
  bulkDeleteAdminUsers,
  importAdminUsersFromCsv,
  listAdminUsers,
  updateAdminUser,
  restoreAdminUser,
} from '@/service/adminUser';

const emitError = (ctx: Context, code: string, message: string) =>
  ctx.app.emit('error', { code, message }, ctx);

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
  const status = String((ctx.query as any)?.status || '').trim().toUpperCase();
  const users = await listAdminUsers(
    scope,
    q || status ? { query: q, statusFilter: status as any } : undefined,
  );
  ctx.state.formatData = users;
  await next();
};

export const createAdminUserController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const payload = parsePayload(ctx.request.body);
    if (!payload.firstName || !payload.lastName || !payload.email) {
      return emitError(ctx, '400', '必須項目が不足しています');
    }

    const scope = (ctx.state as any).accessScope as AccessScope;
    const created = await createAdminUser(payload, scope);
    ctx.state.formatData = created;
    await next();
  } catch (error: any) {
    if (error?.code === 'duplicate_user_name') {
      return emitError(ctx, '409', 'userName は既に使用されています');
    }
    if (error?.code === 'duplicate_emp_id' || error?.name === 'SequelizeUniqueConstraintError') {
      return emitError(ctx, '409', 'employeeId は既に使用されています');
    }
    if (error?.code === 'forbidden_department' || error?.code === 'forbidden_role_assignment') {
      return emitError(ctx, '403', 'アクセス権限がありません');
    }
    if (error?.message === 'validation_error') {
      return emitError(ctx, '400', '入力値が不正です');
    }
    return emitError(ctx, '500', 'ユーザー作成に失敗しました');
  }
};

export const updateAdminUserController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const userId = Number(ctx.params.userId);
    const payload = parsePayload(ctx.request.body);
    if (!payload.firstName || !payload.lastName || !payload.email) {
      return emitError(ctx, '400', '必須項目が不足しています');
    }

    const scope = (ctx.state as any).accessScope as AccessScope;
    const updated = await updateAdminUser(userId, payload, scope);
    ctx.state.formatData = updated;
    await next();
  } catch (error: any) {
    if (error?.code === 'duplicate_user_name') {
      return emitError(ctx, '409', 'userName は既に使用されています');
    }
    if (error?.code === 'duplicate_emp_id' || error?.name === 'SequelizeUniqueConstraintError') {
      return emitError(ctx, '409', 'employeeId は既に使用されています');
    }
    if (error?.message === 'not_found') {
      return emitError(ctx, '400', 'ユーザーが存在しません');
    }
    if (error?.code === 'forbidden_department' || error?.code === 'forbidden_role_assignment') {
      return emitError(ctx, '403', 'アクセス権限がありません');
    }
    if (error?.message === 'validation_error') {
      return emitError(ctx, '400', '入力値が不正です');
    }
    return emitError(ctx, '500', 'ユーザー更新に失敗しました');
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
      return emitError(ctx, '403', 'アクセス権限がありません');
    }
    return emitError(ctx, '500', 'ユーザー削除に失敗しました');
  }
};

export const restoreAdminUserController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const userId = Number(ctx.params.userId);
    const scope = (ctx.state as any).accessScope as AccessScope;
    await restoreAdminUser(userId, scope);
    ctx.state.formatData = { success: true };
    await next();
  } catch (error: any) {
    if (error?.code === 'validation_error') {
      return emitError(ctx, '400', 'userId が不正です');
    }
    if (error?.code === 'not_found') {
      return emitError(ctx, '404', 'ユーザーが存在しません');
    }
    if (error?.code === 'not_deleted') {
      return emitError(ctx, '409', 'このユーザーは削除されていないため復元できません');
    }
    if (error?.code === 'forbidden_department') {
      return emitError(ctx, '403', 'アクセス権限がありません');
    }
    return emitError(ctx, '500', 'ユーザーの復元に失敗しました');
  }
};

export const permanentlyDeleteAdminUserController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const userId = Number(ctx.params.userId);
    const scope = (ctx.state as any).accessScope as AccessScope;
    await permanentlyDeleteAdminUser(userId, scope);
    ctx.state.formatData = { success: true };
    await next();
  } catch (error: any) {
    if (error?.code === 'validation_error') {
      return emitError(ctx, '400', 'userId が不正です');
    }
    if (error?.code === 'not_found') {
      return emitError(ctx, '404', 'ユーザーが存在しません');
    }
    if (error?.code === 'not_deleted') {
      return emitError(ctx, '409', '削除済みユーザーのみ完全削除できます');
    }
    if (error?.code === 'forbidden_department') {
      return emitError(ctx, '403', 'アクセス権限がありません');
    }
    return emitError(ctx, '500', 'ユーザーの完全削除に失敗しました');
  }
};

export const bulkDeleteAdminUsersController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const rawIds = (ctx.request.body as any)?.userIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return emitError(ctx, '400', 'userIds が必要です');
    }

    const userIds = rawIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id));
    if (userIds.length !== rawIds.length) {
      return emitError(ctx, '400', 'userIds が不正です');
    }

    const scope = (ctx.state as any).accessScope as AccessScope;
    const result = await bulkDeleteAdminUsers(userIds, scope);
    ctx.state.formatData = result;
    await next();
  } catch (error: any) {
    if (error?.code === 'validation_error') {
      return emitError(ctx, '400', 'userIds が不正です');
    }
    if (error?.code === 'cannot_delete_self') {
      return emitError(ctx, '400', '自分自身は削除できません');
    }
    if (error?.code === 'not_found') {
      return emitError(ctx, '404', '指定したユーザーが存在しません');
    }
    if (error?.code === 'forbidden_role_delete') {
      return emitError(ctx, '403', '削除できないロールが含まれています');
    }
    if (error?.code === 'forbidden_manage_users') {
      return emitError(ctx, '403', 'アクセス権限がありません');
    }
    return emitError(ctx, '500', 'ユーザー削除に失敗しました');
  }
};

export const importAdminUsersCsvController = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const files = (ctx.request as any).files || {};
    const fileCandidate = files.file || files.csv || Object.values(files)[0];
    const file = Array.isArray(fileCandidate) ? fileCandidate[0] : fileCandidate;

    if (!file?.filepath) {
      return emitError(ctx, '400', 'CSV ファイルが必要です');
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
    return emitError(ctx, '400', error?.message || 'CSV 取込に失敗しました');
  }
};
