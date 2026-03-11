import { pgPool } from '@/clients/postgres';
import Menu from '@/mysql/model/menu.model';
import Role from '@/mysql/model/role.model';
import RoleMenu from '@/mysql/model/role_menu.model';
import User from '@/mysql/model/user.model';
import UserRole from '@/mysql/model/user_role.model';

export type DbMode = 'postgres' | 'mysql';

const REQUIRED_PG_TABLES = ['sys_user', 'sys_role', 'sys_menu', 'sys_user_role', 'sys_role_menu'];
const MODE_TTL_MS = 10_000;

let cachedMode: DbMode | null = null;
let cachedAt = 0;

const getConfiguredDbMode = (): DbMode | null => {
  const raw = String(process.env.DB_MODE || '')
    .trim()
    .toLowerCase();
  if (raw === 'postgres') return 'postgres';
  if (raw === 'mysql') return 'mysql';
  return null;
};

const hasPgConfig = () => {
  return Boolean(
    process.env.DATABASE_URL ||
    process.env.PG_HOST ||
    process.env.PG_PORT ||
    process.env.PG_USER ||
    process.env.PG_DATABASE,
  );
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withPgClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < 2; i += 1) {
    try {
      const client = await pgPool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    } catch (err) {
      lastError = err;
      await sleep(200 * (i + 1));
    }
  }
  throw lastError;
}

export async function pgHasTables(tableNames: string[] = REQUIRED_PG_TABLES): Promise<boolean> {
  return withPgClient(async (client) => {
    const res = await client.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
      `,
      [tableNames],
    );
    const found = new Set(res.rows.map((r: any) => r.table_name));
    return tableNames.every((t) => found.has(t));
  });
}

export async function detectDbMode(force: boolean = false): Promise<DbMode> {
  const configured = getConfiguredDbMode();
  if (configured) {
    cachedMode = configured;
    cachedAt = Date.now();
    return configured;
  }

  const now = Date.now();
  if (!force && cachedMode && now - cachedAt < MODE_TTL_MS) return cachedMode;

  try {
    const ok = await pgHasTables();
    cachedMode = ok ? 'postgres' : 'mysql';
  } catch {
    cachedMode = 'mysql';
  }
  cachedAt = now;
  return cachedMode;
}

export async function getDbStatus() {
  const configured = getConfiguredDbMode();
  if (configured) {
    if (configured === 'mysql') {
      return {
        mode: 'mysql' as DbMode,
        pgConfigured: false,
        pgAvailable: false,
        pgTablesOk: false,
      };
    }

    try {
      const pgTablesOk = await pgHasTables();
      return {
        mode: 'postgres' as DbMode,
        pgConfigured: true,
        pgAvailable: true,
        pgTablesOk,
      };
    } catch {
      return {
        mode: 'postgres' as DbMode,
        pgConfigured: true,
        pgAvailable: false,
        pgTablesOk: false,
      };
    }
  }

  const pgConfigured = hasPgConfig();
  try {
    const pgTablesOk = await pgHasTables();
    return {
      mode: pgTablesOk ? ('postgres' as DbMode) : ('mysql' as DbMode),
      pgConfigured: pgConfigured || pgTablesOk,
      pgAvailable: true,
      pgTablesOk,
    };
  } catch {
    return {
      mode: 'mysql' as DbMode,
      pgConfigured,
      pgAvailable: false,
      pgTablesOk: false,
    };
  }
}

export async function getUserById(userId: number) {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    return withPgClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM sys_user WHERE user_id = $1 AND COALESCE(del_flag, '0') = '0' LIMIT 1`,
        [userId],
      );
      if (res.rows[0]) return res.rows[0];

      const legacy = await client.query(
        `SELECT * FROM "user" WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [userId],
      );
      return legacy.rows[0] || null;
    });
  }
  return User.findOne({ where: { user_id: userId }, raw: true });
}

export async function getUserByName(userName: string) {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    return withPgClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM sys_user WHERE user_name = $1 AND COALESCE(del_flag, '0') = '0' LIMIT 1`,
        [userName],
      );
      if (res.rows[0]) return res.rows[0];

      const legacy = await client.query(
        `SELECT * FROM "user" WHERE user_name = $1 AND deleted_at IS NULL LIMIT 1`,
        [userName],
      );
      return legacy.rows[0] || null;
    });
  }
  return User.findOne({ where: { user_name: userName, deleted_at: null }, raw: true });
}

export async function getRolesForUserId(userId: number) {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    return withPgClient(async (client) => {
      const res = await client.query(
        `
        SELECT DISTINCT r.*
        FROM sys_role r
        INNER JOIN sys_user_role ur ON ur.role_id = r.role_id
        WHERE ur.user_id = $1
        `,
        [userId],
      );
      const legacyRes = await client.query(
        `
        SELECT DISTINCT r.*
        FROM role r
        INNER JOIN user_role ur ON ur.role_id = r.role_id
        WHERE ur.user_id = $1
        `,
        [userId],
      );

      if (!res.rows.length) return legacyRes.rows;
      if (!legacyRes.rows.length) return res.rows;

      const merged = [...res.rows];
      const seen = new Set(res.rows.map((r: any) => `${r.role_id}`));
      for (const role of legacyRes.rows) {
        const id = `${(role as any).role_id}`;
        if (!seen.has(id)) merged.push(role);
      }
      return merged;
    });
  }
  const roleIds = (await UserRole.findAll({ raw: true, attributes: ['role_id'], where: { user_id: userId } }))
    .map((r: any) => r.role_id)
    .filter((x: any) => typeof x === 'number');
  if (!roleIds.length) return [];
  return Role.findAll({ raw: true, where: { role_id: roleIds } });
}

export async function getRoleMenus(roleIds: number[]) {
  const ids = (roleIds || []).filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (!ids.length) return [];
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    return withPgClient(async (client) => {
      const res = await client.query(
        `SELECT role_id, menu_id FROM sys_role_menu WHERE role_id = ANY($1)`,
        [ids],
      );
      const legacy = await client.query(
        `SELECT role_id, menu_id FROM role_menu WHERE role_id = ANY($1)`,
        [ids],
      );
      if (!res.rows.length) return legacy.rows;
      if (!legacy.rows.length) return res.rows;

      const merged = [...res.rows];
      const seen = new Set(res.rows.map((r: any) => `${r.role_id}:${r.menu_id}`));
      for (const row of legacy.rows) {
        const key = `${(row as any).role_id}:${(row as any).menu_id}`;
        if (!seen.has(key)) merged.push(row);
      }
      return merged;
    });
  }
  return RoleMenu.findAll({ raw: true, attributes: ['role_id', 'menu_id'], where: { role_id: ids } });
}

export async function getMenus(menuIds: number[]) {
  const ids = (menuIds || []).filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (!ids.length) return [];
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    return withPgClient(async (client) => {
      const res = await client.query(
        `SELECT * FROM sys_menu WHERE menu_id = ANY($1)`,
        [ids],
      );
      const legacy = await client.query(
        `SELECT * FROM menu WHERE menu_id = ANY($1)`,
        [ids],
      );
      if (!res.rows.length) return legacy.rows;
      if (!legacy.rows.length) return res.rows;

      const merged = [...res.rows];
      const seen = new Set(res.rows.map((r: any) => `${r.menu_id}`));
      for (const menu of legacy.rows) {
        const id = `${(menu as any).menu_id}`;
        if (!seen.has(id)) merged.push(menu);
      }
      return merged;
    });
  }
  return Menu.findAll({ raw: true, where: { menu_id: ids } });
}

export async function getPermissionsForRoleIds(roleIds: number[]) {
  const roleMenus = await getRoleMenus(roleIds);
  const menuIds: number[] = Array.from(new Set(roleMenus.map((rm: any) => rm.menu_id)))
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x));

const menus = await getMenus(menuIds);
  return menus.map((m: any) => m.perms).filter(Boolean) as string[];
}
