import { IuserTokenType } from '@/types';
import { addSession, judgeKeyOverdue, queryKeyValue, removeListKey, resetTime } from '@/utils/auth';
import { getSetsValue, removeSetKeys } from '@/utils/redis';
import { getFullUserInfo } from '@/utils/userInfo';
import Role from '@/mysql/model/role.model';
import UserRole from '@/mysql/model/user_role.model';
import { detectDbMode } from '@/db/adapter';
import { pgPool } from '@/clients/postgres';
import {
  AccessScope,
  RoleCode,
  getAccessScopeByUserId,
  isDepartmentAdminRole,
  isSuperAdminRole,
  canManageUsers,
} from '@/service/rbac';
import jwt from 'jsonwebtoken';
import { Context } from 'koa';
import { config } from '@config/index'
import { finishRagTrace, startRagTrace, withStage } from '@/service/ragPerf';

export const authWhites = [
  '/health',
  '/api/aviary/v1/health',
  '/api/aviary/v1/auth/login',
  '/user/login',
  '/user/logout',
  '/user/register',
  '/user/captchaImage',
  '/system/config/configKey',
  '/system/menu/list',
  '/group/list',
  '/group/populate-test-data',
  '/api/files/extract-text',
  '/user/auth/callback',
  '/user/auth/exchange',
  '/api/auth/login',
  '/api/auth/sso/microsoft/mock',
];

export const auth = async (ctx: Context, next: () => Promise<void>) => {
  const perf = startRagTrace('auth_middleware', {
    path: ctx.path,
    method: ctx.method,
  });
  const { authorization = '' } = ctx.request.header;
  const token = authorization.replace('Bearer ', '');

  const uri = ctx.request.url.split('?')[0];

  if (!authWhites.includes(uri)) {
    // TODO: Not all of the config values is using the new config management system
    //       We need refactor the whole project to use the new config management system
    if (!token) {
      finishRagTrace(perf, { ok: false, reason: 'missing_token' });
      return ctx.app.emit(
        'error',
        {
          code: '401',
          message: '無効なトークン',
        },
        ctx,
      );
    }

    try {
      const user = await withStage(
        perf,
        'auth.jwt_verify',
        async () => jwt.verify(token, config.Backend.jwtSecret) as IuserTokenType,
      );

      const sessionAlive = await withStage(
        perf,
        'auth.session_check',
        async () => Boolean(await judgeKeyOverdue(user.session)),
      );
      if (!sessionAlive) {
        removeListKey([user.session]);
        finishRagTrace(perf, { ok: false, reason: 'session_expired' });
        return ctx.app.emit(
          'error',
          {
            code: '401',
            message: '無効なトークン',
          },
          ctx,
        );
      }

      await withStage(perf, 'auth.session_touch', async () => {
        resetTime(user.session);
      });

      const updateSet = await withStage(perf, 'auth.user_refresh_check', async () => getSetsValue('update_userInfo'));
      if (updateSet.includes(String(user.userId))) {
        const userData = await queryKeyValue(user.session);

        const data = await getFullUserInfo(user.userId);

        await addSession(user.session, {
          ...userData,
          loginTime: new Date().toLocaleString(config.Backend.logTime),
          ...data
        });

        removeSetKeys('update_userInfo', [String(user.userId)]);
      }

      ctx.state.user = user;
    } catch (error) {
      const name = String((error as any)?.name || '');
      const message = String((error as any)?.message || '');
      if (!(name === 'JsonWebTokenError' || name === 'TokenExpiredError' || message.includes('jwt'))) {
        console.error('Auth error:', error);
      }
      finishRagTrace(perf, { ok: false, reason: 'auth_exception' });
      return ctx.app.emit(
        'error',
        {
          code: '401',
          message: '無効なトークン',
        },
        ctx,
      );
    }
  } else {
    // For whitelisted endpoints, try to use token if provided
    if (token) {
      try {
        const user = jwt.verify(token, config.Backend.jwtSecret) as IuserTokenType;
        ctx.state.user = user;
      } catch {
        // Token invalid, use test user
        ctx.state.user = {
          userId: 1,
          userName: 'test_user',
          session: 'test_session',
          permissions: ['*|*'],
        } as any;
      }
    } else {
      // No token provided, use test user
      ctx.state.user = {
        userId: 1,
        userName: 'test_user',
        session: 'test_session',
        permissions: ['*|*'],
      } as any;
    }
  }

  await next();
  finishRagTrace(perf, { ok: true });
};

export const usePermission = (permission: string) => async (ctx: Context, next: () => Promise<void>) => {
  const { session } = ctx.state.user;

  const { permissions } = await queryKeyValue(session);

  if (permissions[0] !== '*|*') {
    const type = ctx.request.method === 'POST' ? ctx.request.body.type : ctx.query.type;
    if (type) {
      if (!permissions.includes(`${permission}|${type}`)) {
        return ctx.app.emit(
          'error',
          {
            code: '403',
            message: 'アクセス権限がありません',
          },
          ctx,
        );
      }
    } else if (!permissions.includes(permission)) {
      return ctx.app.emit(
        'error',
        {
          code: '403',
          message: 'アクセス権限がありません',
        },
        ctx,
      );
    }
  }

  await next();
};

export const requireAdmin = async (ctx: Context, next: () => Promise<void>) => {
  const userId = Number(ctx.state.user?.userId);
  if (!Number.isFinite(userId)) {
    return ctx.app.emit(
      'error',
      {
        code: '401',
        message: '無効なトークン',
      },
      ctx,
    );
  }

  // New RBAC path: if scope is already resolved, trust role_code directly.
  const scope = (ctx.state as any)?.accessScope as AccessScope | undefined;
  if (scope && (isSuperAdminRole(scope.roleCode) || isDepartmentAdminRole(scope.roleCode))) {
    await next();
    return;
  }

  // Session already marked as full-access admin.
  const tokenPerms = (ctx.state.user as any)?.permissions;
  if (Array.isArray(tokenPerms) && tokenPerms.includes('*|*')) {
    await next();
    return;
  }

  const dbMode = await detectDbMode();
  if (dbMode === 'postgres') {
    try {
      const res = await pgPool.query(
        `
        SELECT 1
        FROM role r
        INNER JOIN user_role ur ON ur.role_id = r.role_id
        WHERE ur.user_id = $1
          AND r.role_key = 'admin'
          AND COALESCE(r.del_flag, '0') = '0'
        LIMIT 1
        `,
        [userId],
      );

      if (res.rowCount && res.rowCount > 0) {
        await next();
        return;
      }

      const sysRes = await pgPool.query(
        `
        SELECT 1
        FROM sys_role r
        INNER JOIN sys_user_role ur ON ur.role_id = r.role_id
        WHERE ur.user_id = $1
          AND r.role_key = 'admin'
          AND COALESCE(r.del_flag, '0') = '0'
        LIMIT 1
        `,
        [userId],
      );

      if (sysRes.rowCount && sysRes.rowCount > 0) {
        await next();
        return;
      }
    } catch (error) {
      console.error('[requireAdmin] postgres role check failed:', error);
    }
  }

  if (dbMode === 'mysql') {
    const adminRole = await Role.findOne({
      raw: true,
      attributes: ['role_id'],
      where: { role_key: 'admin', del_flag: '0' },
    }) as any;

    if (!adminRole?.role_id) {
      return ctx.app.emit(
        'error',
        {
          code: '403',
          message: 'アクセス権限がありません',
        },
        ctx,
      );
    }

    const userAdmin = await UserRole.findOne({
      raw: true,
      where: { user_id: userId, role_id: adminRole.role_id },
    }) as any;

    if (!userAdmin) {
      return ctx.app.emit(
        'error',
        {
          code: '403',
          message: 'アクセス権限がありません',
        },
        ctx,
      );
    }
  } else {
    return ctx.app.emit(
      'error',
      {
        code: '403',
        message: 'アクセス権限がありません',
      },
      ctx,
    );
  }

  await next();
};

export const requireScopedAccess = async (ctx: Context, next: () => Promise<void>) => {
  const perf = startRagTrace('rbac_scope_resolution', {
    path: ctx.path,
    method: ctx.method,
  });
  const userId = Number(ctx.state.user?.userId);
  if (!Number.isFinite(userId)) {
    finishRagTrace(perf, { ok: false, reason: 'invalid_user_id' });
    return ctx.app.emit(
      'error',
      {
        code: '401',
        message: '無効なトークン',
      },
      ctx,
    );
  }

  try {
    const scope = await withStage(
      perf,
      'rbac.get_access_scope',
      async () => getAccessScopeByUserId(userId, String(ctx.state.user?.userName || '')),
    );
    (ctx.state as any).accessScope = scope;
    (ctx.state.user as any).roleCode = scope.roleCode;
    (ctx.state.user as any).departmentCode = scope.departmentCode;
    (ctx.state.user as any).isSuperAdmin = isSuperAdminRole(scope.roleCode);
    await next();
    finishRagTrace(perf, {
      ok: true,
      role: scope.roleCode,
      department: scope.departmentCode,
    });
  } catch (error: any) {
    finishRagTrace(perf, { ok: false, reason: error?.code || 'rbac_error' });
    return ctx.app.emit(
      'error',
      {
        code: '403',
        message: error?.code === 'unauthorized' ? '認証に失敗しました' : 'アクセス権限がありません',
      },
      ctx,
    );
  }
};

export const requireUserManager = async (ctx: Context, next: () => Promise<void>) => {
  const scope = (ctx.state as any).accessScope as AccessScope | undefined;
  if (!scope) {
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'アクセススコープが解決されていません',
      },
      ctx,
    );
  }

  if (!canManageUsers(scope.roleCode)) {
    return ctx.app.emit(
      'error',
      {
        code: '403',
        message: 'アクセス権限がありません',
      },
      ctx,
    );
  }
  await next();
};

export const requireRole = (roles: RoleCode | RoleCode[]) => async (ctx: Context, next: () => Promise<void>) => {
  const scope = (ctx.state as any).accessScope as AccessScope | undefined;
  if (!scope) {
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'アクセススコープが解決されていません',
      },
      ctx,
    );
  }

  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(scope.roleCode)) {
    return ctx.app.emit(
      'error',
      {
        code: '403',
        message: 'アクセス権限がありません',
      },
      ctx,
    );
  }

  await next();
};
