import { pgPool } from '@/clients/postgres';
import redis from '@/clients/redis';
import { AccessScope, isSuperAdminRole } from '@/service/rbac';
import { hashPassword, verifyPassword } from '@/service/user';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';
import { config } from '@/config/index';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const RESET_CONFIRMATION_TEXT = 'CONFIRM AND PROCEED DELETION';
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'password';
const DEFAULT_ADMIN_USER_ID = 1;

const TABLES_TO_WIPE = [
  'triage_payload',
  'triage_tickets',
  'app_notifications',
  'notifications',
  'messages',
  'support_tickets',
  'analytics_event',
  'chat_history_messages',
  'chat_history_conversations',
  'krd_gen_task_output',
  'krd_gen_task',
  'file_role',
  'file',
  'file_tag',
  'document_metadata',
  'flow_definitions',
  'user_group',
  'group',
  'sso_user_bind',
  'audit_logs',
  'user_role',
  'sys_user_role',
  'user',
  'sys_user',
] as const;

const quoteIdentifier = (name: string): string => `"${String(name || '').replace(/"/g, '""')}"`;

async function wipeUploadedDocumentsFromDisk() {
  const uploadRoot = path.resolve(String(FILE_UPLOAD_DIR || '').trim());
  if (!uploadRoot || uploadRoot === '/' || uploadRoot.length < 5) {
    throw new Error(`Unsafe upload root path: ${uploadRoot}`);
  }

  await fs.promises.mkdir(uploadRoot, { recursive: true });
  const entries = await fs.promises.readdir(uploadRoot, { withFileTypes: true });

  let removedEntries = 0;
  for (const entry of entries) {
    const targetPath = path.join(uploadRoot, entry.name);
    if (entry.isDirectory()) {
      // Keep the department folder itself, remove only its contents.
      // eslint-disable-next-line no-await-in-loop
      const children = await fs.promises.readdir(targetPath, { withFileTypes: true });
      for (const child of children) {
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.rm(path.join(targetPath, child.name), { recursive: true, force: true });
        removedEntries += 1;
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    removedEntries += 1;
  }

  const standardDepartmentFolders = ['HR', 'GA', 'ACC', 'OTHER', 'SYSTEMS'] as const;
  for (const folder of standardDepartmentFolders) {
    // eslint-disable-next-line no-await-in-loop
    await fs.promises.mkdir(path.join(uploadRoot, folder), { recursive: true });
  }

  return {
    uploadRoot,
    removedEntries,
  };
}

async function validateSuperAdminPassword(
  scope: AccessScope,
  accountPassword: string,
  client: { query: (...args: any[]) => Promise<any> },
) {
  if (!isSuperAdminRole(scope.roleCode)) {
    throw new Error('FORBIDDEN');
  }

  const password = String(accountPassword || '').trim();
  if (!password) {
    throw new Error('Account password is required');
  }

  const [userRes, sysUserRes] = await Promise.all([
    client.query(
      `
      SELECT password
      FROM "user"
      WHERE user_id = $1
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [scope.userId],
    ),
    client.query(
      `
      SELECT password
      FROM sys_user
      WHERE user_id = $1
        AND COALESCE(del_flag, '0') = '0'
      LIMIT 1
      `,
      [scope.userId],
    ),
  ]);

  const passwordCandidates = [userRes.rows?.[0]?.password, sysUserRes.rows?.[0]?.password]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (passwordCandidates.length === 0) {
    throw new Error('Account not found');
  }

  for (const candidate of passwordCandidates) {
    // Accept either auth source password (`user` or `sys_user`) to avoid false
    // negatives when one table is stale but the active login source is valid.
    // eslint-disable-next-line no-await-in-loop
    const ok = await verifyPassword(password, candidate);
    if (ok) return;
  }

  throw new Error('Invalid account password');
}

async function truncateRuntimeTables(client: { query: (...args: any[]) => Promise<any> }) {
  const tableNameList = [...TABLES_TO_WIPE];
  const existingRes = await client.query(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    `,
    [tableNameList],
  );

  const existingTables = (existingRes.rows || [])
    .map((row: any) => String(row.table_name || ''))
    .filter(Boolean);

  const deletedByTable: Record<string, number> = {};
  for (const tableName of existingTables) {
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(tableName)}`,
    );
    deletedByTable[tableName] = Number(countRes.rows?.[0]?.count || 0);
  }

  if (existingTables.length > 0) {
    const sql = existingTables.map((t) => quoteIdentifier(t)).join(', ');
    await client.query(`TRUNCATE TABLE ${sql} RESTART IDENTITY CASCADE`);
  }

  return {
    tables: existingTables,
    deletedByTable,
  };
}

async function ensureBaseRolesAndDepartments(client: { query: (...args: any[]) => Promise<any> }) {
  const baseDepartments = [
    { code: 'HR', name: 'Human Resources' },
    { code: 'GA', name: 'General Affairs' },
    { code: 'ACC', name: 'Accounting' },
    { code: 'OTHER', name: 'Other' },
    { code: 'SYSTEMS', name: 'Systems' },
  ] as const;

  for (const department of baseDepartments) {
    // Use update-then-insert to avoid relying on DB-level unique constraints.
    // Some deployments have legacy schemas where ON CONFLICT targets are missing.
    // eslint-disable-next-line no-await-in-loop
    const updated = await client.query(
      `
      UPDATE departments
      SET name = $1
      WHERE code = $2
      `,
      [department.name, department.code],
    );

    if ((updated.rowCount || 0) === 0) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `
        INSERT INTO departments (code, name)
        SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1
          FROM departments
          WHERE code = $1
        )
        `,
        [department.code, department.name],
      );
    }
  }

  const ensureRole = async (
    tableName: 'role' | 'sys_role',
    roleName: string,
    roleKey: string,
    roleSort: number,
  ) => {
    const quotedTable = quoteIdentifier(tableName);
    const updated = await client.query(
      `
      UPDATE ${quotedTable}
      SET role_name = $1,
          role_sort = $2,
          status = '0',
          del_flag = '0'
      WHERE role_key = $3
      `,
      [roleName, roleSort, roleKey],
    );

    if ((updated.rowCount || 0) === 0) {
      await client.query(
        `
        INSERT INTO ${quotedTable} (role_name, role_key, role_sort, status, del_flag, create_by)
        SELECT $1, $2, $3, '0', '0', 'system'
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${quotedTable}
          WHERE role_key = $2
        )
        `,
        [roleName, roleKey, roleSort],
      );
    }
  };

  await ensureRole('role', 'admin', 'admin', 0);
  await ensureRole('role', 'user', 'user', 1);
  await ensureRole('sys_role', 'admin', 'admin', 0);
  await ensureRole('sys_role', 'user', 'user', 1);
}

async function seedDefaultAdmin(client: { query: (...args: any[]) => Promise<any> }) {
  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);

  const updatedSysUser = await client.query(
    `
    UPDATE sys_user
    SET user_name = $2,
        password = $3,
        email = 'admin@admin.co.jp',
        phonenumber = '117',
        status = '1',
        del_flag = '0',
        sso_bound = 0,
        department = 'Human Resources',
        department_code = 'HR',
        role_code = 'SUPER_ADMIN',
        create_by = NULL,
        deleted_by = NULL,
        deleted_at = NULL,
        updated_at = NOW(),
        update_time = NOW(),
        last_updated = NOW()
    WHERE user_id = $1
    `,
    [DEFAULT_ADMIN_USER_ID, DEFAULT_ADMIN_USERNAME, passwordHash],
  );

  if ((updatedSysUser.rowCount || 0) === 0) {
    await client.query(
      `
      INSERT INTO sys_user (
        user_id,
        user_name,
        password,
        email,
        phonenumber,
        status,
        del_flag,
        sso_bound,
        department,
        department_code,
        role_code,
        create_by,
        deleted_by,
        deleted_at,
        created_at,
        updated_at,
        create_time,
        update_time,
        last_updated,
        last_login_at
      )
      SELECT
        $1,
        $2,
        $3,
        'admin@admin.co.jp',
        '117',
        '1',
        '0',
        0,
        'Human Resources',
        'HR',
        'SUPER_ADMIN',
        NULL,
        NULL,
        NULL,
        NOW(),
        NOW(),
        NOW(),
        NOW(),
        NOW(),
        NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM sys_user
        WHERE user_id = $1
      )
      `,
      [DEFAULT_ADMIN_USER_ID, DEFAULT_ADMIN_USERNAME, passwordHash],
    );
  }

  const updatedLegacyUser = await client.query(
    `
    UPDATE "user"
    SET user_name = $2,
        emp_id = $2,
        first_name = 'SUPER',
        last_name = 'ADMIN',
        job_role_key = 'itManager',
        area_of_work_key = 'headOffice',
        password = $3,
        status = '1',
        sso_bound = 0,
        department = 'Human Resources',
        department_code = 'HR',
        role_code = 'SUPER_ADMIN',
        create_by = NULL,
        deleted_by = NULL,
        deleted_at = NULL,
        last_login_at = NULL,
        updated_at = NOW()
    WHERE user_id = $1
    `,
    [DEFAULT_ADMIN_USER_ID, DEFAULT_ADMIN_USERNAME, passwordHash],
  );

  if ((updatedLegacyUser.rowCount || 0) === 0) {
    await client.query(
      `
      INSERT INTO "user" (
        user_id,
        user_name,
        emp_id,
        first_name,
        last_name,
        job_role_key,
        area_of_work_key,
        password,
        status,
        sso_bound,
        department,
        department_code,
        role_code,
        create_by,
        deleted_by,
        deleted_at,
        last_login_at,
        created_at,
        updated_at
      )
      SELECT
        $1,
        $2,
        $2,
        'SUPER',
        'ADMIN',
        'itManager',
        'headOffice',
        $3,
        '1',
        0,
        'Human Resources',
        'HR',
        'SUPER_ADMIN',
        NULL,
        NULL,
        NULL,
        NULL,
        NOW(),
        NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM "user"
        WHERE user_id = $1
      )
      `,
      [DEFAULT_ADMIN_USER_ID, DEFAULT_ADMIN_USERNAME, passwordHash],
    );
  }

  const legacyRoleRes = await client.query(
    `SELECT role_id FROM role WHERE role_key = 'admin' ORDER BY role_id ASC LIMIT 1`,
  );
  const sysRoleRes = await client.query(
    `SELECT role_id FROM sys_role WHERE role_key = 'admin' ORDER BY role_id ASC LIMIT 1`,
  );

  const legacyAdminRoleId = Number(legacyRoleRes.rows?.[0]?.role_id || 0);
  const sysAdminRoleId = Number(sysRoleRes.rows?.[0]?.role_id || 0);

  if (legacyAdminRoleId > 0) {
    await client.query(
      `
      INSERT INTO user_role (user_id, role_id)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1
        FROM user_role
        WHERE user_id = $1
          AND role_id = $2
      )
      `,
      [DEFAULT_ADMIN_USER_ID, legacyAdminRoleId],
    );
  }

  if (sysAdminRoleId > 0) {
    await client.query(
      `
      INSERT INTO sys_user_role (user_id, role_id)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1
        FROM sys_user_role
        WHERE user_id = $1
          AND role_id = $2
      )
      `,
      [DEFAULT_ADMIN_USER_ID, sysAdminRoleId],
    );
  }
}

async function clearAllLoginSessions() {
  try {
    const sessions = await redis.smembers('login_tokens');
    if (sessions.length > 0) {
      await redis.del(...sessions);
    }
    await redis.del('login_tokens');
    return sessions.length;
  } catch {
    return 0;
  }
}

async function wipeSolrIndex() {
  const solrUrl = String(config?.ApacheSolr?.url || '').trim().replace(/\/+$/, '');
  const coreName = String(config?.ApacheSolr?.coreName || 'mycore').trim();
  if (!solrUrl || !coreName) {
    return { attempted: false, ok: false, reason: 'solr_not_configured' };
  }

  try {
    const res = await axios.post(
      `${solrUrl}/solr/${encodeURIComponent(coreName)}/update?commit=true`,
      { delete: { query: '*:*' } },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: Math.max(2000, Number(process.env.SOLR_RESET_TIMEOUT_MS || 15000)),
        validateStatus: () => true,
      },
    );
    if (Number(res.status) !== 200) {
      return { attempted: true, ok: false, reason: `solr_http_${res.status}` };
    }
    return { attempted: true, ok: true };
  } catch (error: any) {
    return { attempted: true, ok: false, reason: String(error?.message || error) };
  }
}

async function wipeHybridCollection() {
  const backendUrl = String(config?.RAG?.Backend?.url || '').trim().replace(/\/+$/, '');
  const collectionName = String(
    config?.RAG?.PreProcess?.PDF?.splitByArticle?.collectionName || 'splitByArticleWithHybridSearch',
  ).trim();
  if (!backendUrl || !collectionName) {
    return { attempted: false, ok: false, reason: 'rag_backend_not_configured' };
  }

  try {
    const res = await axios.delete(`${backendUrl}/collection`, {
      data: { collection_name: collectionName },
      headers: { 'Content-Type': 'application/json' },
      timeout: Math.max(2000, Number(process.env.RAG_RESET_TIMEOUT_MS || 15000)),
      validateStatus: () => true,
    });
    if (Number(res.status) !== 200) {
      return { attempted: true, ok: false, reason: `rag_http_${res.status}` };
    }
    return { attempted: true, ok: true, status: String(res.data?.status || 'ok') };
  } catch (error: any) {
    return { attempted: true, ok: false, reason: String(error?.message || error) };
  }
}

async function wipeExternalIndexesAfterReset() {
  const [solr, rag] = await Promise.all([wipeSolrIndex(), wipeHybridCollection()]);
  return {
    solr,
    rag,
  };
}

export async function resetSystemPermanently(
  scope: AccessScope,
  accountPassword: string,
  confirmationText: string,
) {
  const normalizedConfirmation = String(confirmationText || '').trim().toUpperCase();
  if (normalizedConfirmation !== RESET_CONFIRMATION_TEXT) {
    throw new Error(`Please type "${RESET_CONFIRMATION_TEXT}" to confirm reset`);
  }

  if (!isSuperAdminRole(scope.roleCode)) {
    throw new Error('FORBIDDEN');
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    await validateSuperAdminPassword(scope, accountPassword, client);
    const diskWipeResult = await wipeUploadedDocumentsFromDisk();
    console.info(
      `[SystemReset] upload_root_wiped path=${diskWipeResult.uploadRoot} removed_entries=${diskWipeResult.removedEntries}`,
    );
    const truncated = await truncateRuntimeTables(client);
    console.info(
      `[SystemReset] tables_truncated count=${truncated.tables.length}`,
    );
    await ensureBaseRolesAndDepartments(client);
    await seedDefaultAdmin(client);

    await client.query('COMMIT');

    const externalIndexWipe = await wipeExternalIndexesAfterReset();
    console.info(`[SystemReset] external_index_wipe solr=${JSON.stringify(externalIndexWipe.solr)} rag=${JSON.stringify(externalIndexWipe.rag)}`);

    const invalidatedSessions = await clearAllLoginSessions();
    return {
      confirmationText: RESET_CONFIRMATION_TEXT,
      adminUserName: DEFAULT_ADMIN_USERNAME,
      adminPassword: DEFAULT_ADMIN_PASSWORD,
      tablesTruncated: truncated.tables,
      deletedByTable: truncated.deletedByTable,
      invalidatedSessions,
      uploadRoot: diskWipeResult.uploadRoot,
      removedUploadEntries: diskWipeResult.removedEntries,
      externalIndexWipe,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const systemResetConfirmationText = RESET_CONFIRMATION_TEXT;
