import { pgPool } from '@/clients/postgres';

export const DEPARTMENTS = ['HR', 'GA', 'ACC', 'OTHER', 'SYSTEMS'] as const;
export type DepartmentCode = (typeof DEPARTMENTS)[number];

export const ROLES = ['USER', 'HR_ADMIN', 'GA_ADMIN', 'ACC_ADMIN', 'SUPER_ADMIN'] as const;
export type RoleCode = (typeof ROLES)[number];

export type AccessScope = {
  userId: number;
  userName: string;
  departmentCode: DepartmentCode;
  roleCode: RoleCode;
};

const isRole = (value: unknown): value is RoleCode => ROLES.includes(String(value || '').toUpperCase() as RoleCode);
const isDepartment = (value: unknown): value is DepartmentCode => DEPARTMENTS.includes(String(value || '').toUpperCase() as DepartmentCode);

const normalizeDepartmentAlias = (value: unknown): string =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s_\-\\/]+/g, '');

export const normalizeDepartmentCode = (value: unknown): DepartmentCode => {
  const normalized = normalizeDepartmentAlias(value);
  if (!normalized) return 'HR';
  if (isDepartment(normalized)) return normalized;

  if (normalized === 'HUMANRESOURCES' || normalized === 'HUMANRESOURCE' || normalized === '人事') {
    return 'HR';
  }
  if (normalized === 'GENERALAFFAIRS' || normalized === '総務') {
    return 'GA';
  }
  if (normalized === 'ACCOUNTING' || normalized === 'ACCOUNTS' || normalized === 'FINANCE' || normalized === '経理' || normalized === '会計') {
    return 'ACC';
  }
  if (normalized === 'OTHERS' || normalized === 'その他') {
    return 'OTHER';
  }
  if (normalized === 'IT' || normalized === 'ITSUPPORT' || normalized === 'SYSTEM') {
    return 'SYSTEMS';
  }
  return 'HR';
};

export const normalizeRoleCode = (value: unknown): RoleCode => {
  const normalized = String(value || '').toUpperCase();
  if (isRole(normalized)) return normalized;
  return 'USER';
};

export const isSuperAdminRole = (roleCode: RoleCode) => roleCode === 'SUPER_ADMIN';
export const isDepartmentAdminRole = (roleCode: RoleCode) =>
  roleCode === 'HR_ADMIN' || roleCode === 'GA_ADMIN' || roleCode === 'ACC_ADMIN';

export const roleDepartmentForAdmin = (roleCode: RoleCode): DepartmentCode | null => {
  if (roleCode === 'HR_ADMIN') return 'HR';
  if (roleCode === 'GA_ADMIN') return 'GA';
  if (roleCode === 'ACC_ADMIN') return 'ACC';
  return null;
};

export const canAssignRole = (actorRole: RoleCode, newRole: RoleCode): boolean => {
  if (actorRole === 'SUPER_ADMIN') return true;
  if (newRole === 'SUPER_ADMIN') return false;
  return isDepartmentAdminRole(actorRole);
};

export const canManageUsers = (actorRole: RoleCode): boolean => actorRole === 'SUPER_ADMIN';

export const canAccessDepartment = (scope: AccessScope, departmentCode: DepartmentCode): boolean => {
  if (scope.roleCode === 'SUPER_ADMIN') return true;
  return scope.departmentCode === departmentCode;
};

export const assertDepartmentAccess = (scope: AccessScope, departmentCode: DepartmentCode): void => {
  if (!canAccessDepartment(scope, departmentCode)) {
    const err: any = new Error('forbidden_department');
    err.code = 'forbidden_department';
    throw err;
  }
};

export const resolveScopeDepartmentFilter = (scope: AccessScope): DepartmentCode[] => {
  if (scope.roleCode === 'SUPER_ADMIN') return [...DEPARTMENTS];
  return [scope.departmentCode];
};

function normalizeLegacyRole(roleKey: string | null, userName: string): RoleCode {
  const key = String(roleKey || '').toLowerCase();
  if (key === 'admin' && String(userName || '').toLowerCase() === 'admin') return 'SUPER_ADMIN';
  if (key === 'admin') return 'HR_ADMIN';
  return 'USER';
}

export async function getAccessScopeByUserId(userId: number, fallbackUserName = ''): Promise<AccessScope> {
  const appUserRes = await pgPool.query(
    `
    SELECT
      u.user_id,
      COALESCE(NULLIF(u.user_name, ''), CAST(u.user_id AS TEXT)) AS user_name,
      COALESCE(NULLIF(u.department_code, ''), NULLIF(u.department, ''), 'HR') AS department_code,
      NULLIF(u.role_code, '') AS role_code,
      (
        SELECT r.role_key
        FROM user_role ur
        INNER JOIN role r ON r.role_id = ur.role_id
        WHERE ur.user_id = u.user_id
        ORDER BY CASE WHEN r.role_key = 'admin' THEN 0 ELSE 1 END
        LIMIT 1
      ) AS legacy_role_key
    FROM "user" u
    WHERE u.user_id = $1
      AND u.deleted_at IS NULL
    LIMIT 1
    `,
    [userId],
  );

  const row = appUserRes.rows[0] || (await pgPool.query(
    `
    SELECT
      su.user_id,
      COALESCE(NULLIF(su.user_name, ''), CAST(su.user_id AS TEXT)) AS user_name,
      COALESCE(NULLIF(su.department_code, ''), NULLIF(su.department, ''), 'HR') AS department_code,
      NULLIF(su.role_code, '') AS role_code,
      (
        SELECT sr.role_key
        FROM sys_user_role sur
        INNER JOIN sys_role sr ON sr.role_id = sur.role_id
        WHERE sur.user_id = su.user_id
        ORDER BY CASE WHEN sr.role_key = 'admin' THEN 0 ELSE 1 END
        LIMIT 1
      ) AS legacy_role_key
    FROM sys_user su
    WHERE su.user_id = $1
      AND COALESCE(su.del_flag, '0') = '0'
    LIMIT 1
    `,
    [userId],
  )).rows[0];

  if (!row) {
    const err: any = new Error('unauthorized');
    err.code = 'unauthorized';
    throw err;
  }

  const departmentCode = normalizeDepartmentCode(row.department_code);
  const normalizedRoleCode = row.role_code ? normalizeRoleCode(row.role_code) : null;
  const legacyDerivedRole = normalizeLegacyRole(row.legacy_role_key || null, row.user_name || fallbackUserName);
  const resolvedRole = normalizedRoleCode == null
    ? legacyDerivedRole
    : (normalizedRoleCode === 'USER' && legacyDerivedRole !== 'USER')
      ? legacyDerivedRole
      : normalizedRoleCode;
  const adminDepartment = roleDepartmentForAdmin(resolvedRole);
  const effectiveDepartment = adminDepartment || departmentCode;

  return {
    userId: Number(row.user_id),
    userName: String(row.user_name || fallbackUserName || row.user_id),
    departmentCode: effectiveDepartment,
    roleCode: resolvedRole,
  };
}

export async function emitAuditLog(input: {
  actor: AccessScope;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  details?: Record<string, unknown>;
}) {
  await pgPool.query(
    `
    INSERT INTO audit_logs (
      actor_user_id,
      actor_role_code,
      actor_department_code,
      action,
      target_type,
      target_id,
      details_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    `,
    [
      input.actor.userId,
      input.actor.roleCode,
      input.actor.departmentCode,
      input.action,
      input.targetType,
      input.targetId == null ? null : String(input.targetId),
      JSON.stringify(input.details || {}),
    ],
  );
}
