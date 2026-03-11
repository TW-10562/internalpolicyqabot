import { pgPool } from '@/clients/postgres';
import { detectDbMode } from '@/db/adapter';
import { normalizeRoleCode, roleDepartmentForAdmin, RoleCode } from '@/service/rbac';

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();

export async function getRoleForEmail(email: string): Promise<RoleCode> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return 'USER';

  const mode = await detectDbMode();
  if (mode !== 'postgres') return 'USER';

  try {
    const res = await pgPool.query(
      `
      SELECT role_code
      FROM sso_user_roles
      WHERE email = $1
      LIMIT 1
      `,
      [normalizedEmail],
    );
    return normalizeRoleCode(res.rows?.[0]?.role_code || 'USER');
  } catch (error) {
    console.error('[ssoRoleStore.getRoleForEmail] failed:', error);
    return 'USER';
  }
}

export async function upsertRoleForEmail(email: string, roleCode: RoleCode): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;

  const mode = await detectDbMode();
  if (mode !== 'postgres') return;

  const normalizedRole = normalizeRoleCode(roleCode);
  await pgPool.query(
    `
    INSERT INTO sso_user_roles (email, role_code, created_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (email) DO UPDATE SET
      role_code = EXCLUDED.role_code,
      updated_at = NOW()
    `,
    [normalizedEmail, normalizedRole],
  );
}

export async function deleteRoleForEmail(email: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;

  const mode = await detectDbMode();
  if (mode !== 'postgres') return;

  await pgPool.query(`DELETE FROM sso_user_roles WHERE email = $1`, [normalizedEmail]);
}

export function inferDepartmentCodeFromRole(roleCode: RoleCode) {
  return roleDepartmentForAdmin(roleCode) || 'HR';
}

