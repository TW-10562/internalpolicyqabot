import { getPermissionsForRoleIds } from '@/db/adapter';

/**
 * Resolve effective permission strings for the provided role IDs.
 *
 * RBAC chain:
 *   roles -> role_menu -> menu.perms
 *
 * Notes:
 * - menu.perms may be empty/null
 * - menu.perms may contain comma-separated permissions
 * - output is de-duplicated
 */
export const resolvePermissionsForRoleIds = async (roleIds: number[]): Promise<string[]> => {
  const ids = (roleIds || []).filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (!ids.length) return [];

  const permsList = await getPermissionsForRoleIds(ids);
  const out = new Set<string>();
  for (const rawPerms of permsList) {
    const raw = (rawPerms ?? '').trim();
    if (!raw) continue;
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((p) => out.add(p));
  }
  return Array.from(out);
};
