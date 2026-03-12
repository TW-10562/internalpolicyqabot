import User from '@/mysql/model/user.model';
import UserRole from '@/mysql/model/user_role.model';
import { detectDbMode } from '@/db/adapter';
import { pgPool } from '@/clients/postgres';
import { hashPassword } from '@/service/user';
import { createHash } from '@/utils';
import seq from '@/mysql/db/seq.db';
import fs from 'node:fs/promises';
import Papa from 'papaparse';
import { Op, Sequelize } from 'sequelize';
import {
  AccessScope,
  DepartmentCode,
  RoleCode,
  canAssignRole,
  canManageUsers,
  emitAuditLog,
  normalizeDepartmentCode,
  normalizeRoleCode,
  roleDepartmentForAdmin,
} from '@/service/rbac';
import { deleteRoleForEmail, upsertRoleForEmail } from '@/service/ssoRoleStore';

export type AdminUserInput = {
  firstName: string;
  lastName: string;
  email?: string;
  employeeId: string;
  userName?: string;
  userJobRole: string;
  areaOfWork: string;
  roleCode: RoleCode;
  departmentCode: DepartmentCode;
  password?: string;
  isActive?: boolean;
};

const normalizeJobRole = (value: string) => String(value || '').trim().toLowerCase();
const normalizeArea = (value: string) => String(value || '').trim().toLowerCase();

const buildUserName = (firstName: string, lastName: string, employeeId: string) => {
  const fullName = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim();
  return fullName || employeeId;
};

const normalizeUserName = (value: string) => String(value || '').trim().toLowerCase();

const toResponseUser = (user: any) => ({
  user_id: user.user_id,
  user_name: user.user_name,
  emp_id: user.emp_id,
  email: user.email,
  first_name: user.first_name,
  last_name: user.last_name,
  job_role_key: user.job_role_key,
  area_of_work_key: user.area_of_work_key,
  department_code: user.department_code,
  role_code: user.role_code,
  status: user.status,
  updated_at: user.updated_at,
});

function ensureCanManage(scope: AccessScope) {
  if (!canManageUsers(scope.roleCode)) {
    const err: any = new Error('forbidden_manage_users');
    err.code = 'forbidden_manage_users';
    throw err;
  }
}

function resolveRequestedDepartment(scope: AccessScope, inputDepartment: string): DepartmentCode {
  const normalized = normalizeDepartmentCode(inputDepartment);
  if (scope.roleCode === 'SUPER_ADMIN') return normalized;

  const adminDepartment = roleDepartmentForAdmin(scope.roleCode);
  if (!adminDepartment || adminDepartment !== normalized) {
    const err: any = new Error('forbidden_department');
    err.code = 'forbidden_department';
    throw err;
  }
  return normalized;
}

function ensureRoleAssignmentAllowed(scope: AccessScope, roleCode: RoleCode) {
  if (!canAssignRole(scope.roleCode, roleCode)) {
    const err: any = new Error('forbidden_role_assignment');
    err.code = 'forbidden_role_assignment';
    throw err;
  }
}

function ensureTargetUserScope(scope: AccessScope, target: any) {
  if (scope.roleCode === 'SUPER_ADMIN') return;
  const targetDepartment = normalizeDepartmentCode(target.department_code || target.department);
  if (targetDepartment !== scope.departmentCode) {
    const err: any = new Error('forbidden_department');
    err.code = 'forbidden_department';
    throw err;
  }
}

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();
const looksLikeEmail = (value: unknown) => {
  const v = normalizeEmail(value);
  return Boolean(v && v.includes('@') && v.includes('.') && !v.includes(' '));
};

async function syncSsoRoleMapping(email: string | null, roleCode: RoleCode) {
  if (!email) return;
  try {
    if (normalizeRoleCode(roleCode) === 'USER') {
      await deleteRoleForEmail(email);
    } else {
      await upsertRoleForEmail(email, roleCode);
    }
  } catch (error) {
    console.error('[adminUser.syncSsoRoleMapping] failed:', { email, roleCode, error });
  }
}

export async function listAdminUsers(scope: AccessScope, opts?: { query?: string }) {
  ensureCanManage(scope);

  const where: any = { deleted_at: null };
  if (scope.roleCode !== 'SUPER_ADMIN') {
    where.department_code = scope.departmentCode;
  }

  const mode = await detectDbMode();
  const likeOp: any = mode === 'postgres' ? Op.iLike : Op.like;

  const query = String(opts?.query || '').trim();
  if (query) {
    const tokens = query.split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
    if (tokens.length) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        ...tokens.map((token) => ({
          [Op.or]: [
            { first_name: { [likeOp]: `%${token}%` } },
            { last_name: { [likeOp]: `%${token}%` } },
            { user_name: { [likeOp]: `%${token}%` } },
            { emp_id: { [likeOp]: `%${token}%` } },
            { email: { [likeOp]: `%${token}%` } },
          ],
        })),
      ];
    }
  }

  const rows = await User.findAll({
    raw: true,
    attributes: [
      'user_id',
      'user_name',
      'emp_id',
      'email',
      'first_name',
      'last_name',
      'job_role_key',
      'area_of_work_key',
      'department_code',
      'role_code',
      'status',
      'updated_at',
    ],
    where,
    order: [['updated_at', 'DESC'], ['user_id', 'DESC']],
  }) as any[];

  return rows
    .filter((u) => !!u.email || !!u.emp_id)
    .map((u) => toResponseUser({ ...u, role_code: normalizeRoleCode(u.role_code) }));
}

export async function createAdminUser(input: AdminUserInput, actorScope: AccessScope) {
  ensureCanManage(actorScope);

  const inputEmail = String(input.email || '').trim();
  const normalizedEmail = inputEmail ? normalizeEmail(inputEmail) : null;
  const employeeId = String(input.employeeId || '').trim() || (normalizedEmail || '');
  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();
  const generatedPassword = createHash(24);
  const password = String(input.password || generatedPassword);
  const providedUserName = String(input.userName || '').trim();
  const resolvedUserName = providedUserName || buildUserName(firstName, lastName, employeeId);

  if (!employeeId || !firstName || !lastName || !resolvedUserName) {
    throw new Error('validation_error');
  }

  const roleCode = normalizeRoleCode(input.roleCode);
  ensureRoleAssignmentAllowed(actorScope, roleCode);
  const departmentCode = resolveRequestedDepartment(actorScope, input.departmentCode);

  const existing = await User.findOne({ raw: true, where: { emp_id: employeeId, deleted_at: null } }) as any;
  if (existing) {
    const err: any = new Error('duplicate_emp_id');
    err.code = 'duplicate_emp_id';
    throw err;
  }

  const existingUserName = await User.findOne({
    raw: true,
    where: {
      deleted_at: null,
      [Op.and]: [
        Sequelize.where(
          Sequelize.fn('LOWER', Sequelize.col('user_name')),
          normalizeUserName(resolvedUserName),
        ),
      ],
    } as any,
  }) as any;
  if (existingUserName) {
    const err: any = new Error('duplicate_user_name');
    err.code = 'duplicate_user_name';
    throw err;
  }

  return seq.transaction(async (transaction) => {
    const created = await User.create({
      user_name: resolvedUserName,
      emp_id: employeeId,
      first_name: firstName,
      last_name: lastName,
      job_role_key: normalizeJobRole(input.userJobRole),
      area_of_work_key: normalizeArea(input.areaOfWork),
      password: await hashPassword(password),
      email: normalizedEmail || (looksLikeEmail(employeeId) ? normalizeEmail(employeeId) : null),
      status: input.isActive === false ? '0' : '1',
      sso_bound: 1,
      create_by: actorScope.userId,
      department: departmentCode,
      department_code: departmentCode,
      role_code: roleCode,
    } as any, { transaction }) as any;

    await UserRole.destroy({ where: { user_id: Number(created.dataValues.user_id) }, transaction });

    await emitAuditLog({
      actor: actorScope,
      action: 'USER_CREATED',
      targetType: 'user',
      targetId: created.dataValues.user_id,
      details: { departmentCode, roleCode, employeeId },
    });

    return toResponseUser(created.dataValues);
  }).then(async (created) => {
    const candidateEmail = normalizedEmail || (looksLikeEmail(employeeId) ? normalizeEmail(employeeId) : null);
    await syncSsoRoleMapping(candidateEmail, roleCode);
    return created;
  });
}

export async function updateAdminUser(userId: number, input: AdminUserInput, actorScope: AccessScope) {
  ensureCanManage(actorScope);
  if (!Number.isFinite(userId)) throw new Error('validation_error');

  const inputEmail = String(input.email || '').trim();
  const normalizedEmail = inputEmail ? normalizeEmail(inputEmail) : null;
  const employeeId = String(input.employeeId || '').trim() || (normalizedEmail || '');
  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();

  if (!employeeId || !firstName || !lastName) {
    throw new Error('validation_error');
  }

  const target = await User.findOne({ raw: true, where: { user_id: userId, deleted_at: null } }) as any;
  if (!target) throw new Error('not_found');

  ensureTargetUserScope(actorScope, target);

  const requestedRole = normalizeRoleCode(input.roleCode || target.role_code || 'USER');
  ensureRoleAssignmentAllowed(actorScope, requestedRole);

  const requestedUserName = String(input.userName || '').trim();

  let resolvedDepartment = normalizeDepartmentCode(target.department_code || target.department);
  if (actorScope.roleCode === 'SUPER_ADMIN' && input.departmentCode) {
    resolvedDepartment = normalizeDepartmentCode(input.departmentCode);
  } else if (actorScope.roleCode !== 'SUPER_ADMIN') {
    resolvedDepartment = actorScope.departmentCode;
  }

  const duplicate = await User.findOne({
    raw: true,
    where: {
      emp_id: employeeId,
      deleted_at: null,
      user_id: { [Op.ne]: userId } as any,
    } as any,
  }) as any;

  if (duplicate) {
    const err: any = new Error('duplicate_emp_id');
    err.code = 'duplicate_emp_id';
    throw err;
  }

  if (requestedUserName) {
    const duplicateUserName = await User.findOne({
      raw: true,
      where: {
        deleted_at: null,
        user_id: { [Op.ne]: userId } as any,
        [Op.and]: [
          Sequelize.where(
            Sequelize.fn('LOWER', Sequelize.col('user_name')),
            normalizeUserName(requestedUserName),
          ),
        ],
      } as any,
    }) as any;
    if (duplicateUserName) {
      const err: any = new Error('duplicate_user_name');
      err.code = 'duplicate_user_name';
      throw err;
    }
  }

  return seq.transaction(async (transaction) => {
    const updateData: any = {
      user_name: requestedUserName || String(target.user_name || buildUserName(firstName, lastName, employeeId)),
      emp_id: employeeId,
      first_name: firstName,
      last_name: lastName,
      job_role_key: normalizeJobRole(input.userJobRole),
      area_of_work_key: normalizeArea(input.areaOfWork),
      email: normalizedEmail || (looksLikeEmail(employeeId) ? normalizeEmail(employeeId) : (target.email || null)),
      status: input.isActive === false ? '0' : '1',
      create_by: target.create_by || actorScope.userId,
      department: resolvedDepartment,
      department_code: resolvedDepartment,
      role_code: requestedRole,
    };

    if (input.password && String(input.password).trim()) {
      updateData.password = await hashPassword(String(input.password));
    }

    await User.update(updateData, { where: { user_id: userId }, transaction });

    await emitAuditLog({
      actor: actorScope,
      action: 'USER_UPDATED',
      targetType: 'user',
      targetId: userId,
      details: {
        departmentCode: resolvedDepartment,
        roleCode: requestedRole,
        employeeId,
      },
    });

    const updated = await User.findOne({ raw: true, where: { user_id: userId }, transaction }) as any;
    return toResponseUser(updated);
  }).then(async (updated) => {
    const candidateEmail = normalizedEmail || (looksLikeEmail(employeeId) ? normalizeEmail(employeeId) : null);
    await syncSsoRoleMapping(candidateEmail, requestedRole);
    return updated;
  });
}

export async function deleteAdminUser(userId: number, actorScope: AccessScope) {
  ensureCanManage(actorScope);
  if (!Number.isFinite(userId)) throw new Error('validation_error');

  const target = await User.findOne({ raw: true, where: { user_id: userId, deleted_at: null } }) as any;
  if (!target) throw new Error('not_found');
  ensureTargetUserScope(actorScope, target);

  await seq.transaction(async (transaction) => {
    await UserRole.destroy({ where: { user_id: userId }, transaction });
    await User.update(
      {
        deleted_at: new Date(),
        deleted_by: actorScope.userId,
      } as any,
      { where: { user_id: userId }, transaction },
    );

    await emitAuditLog({
      actor: actorScope,
      action: 'USER_DELETED',
      targetType: 'user',
      targetId: userId,
      details: { employeeId: target.emp_id },
    });
  });

  const candidateEmail = looksLikeEmail(target?.email)
    ? normalizeEmail(target.email)
    : looksLikeEmail(target?.emp_id)
      ? normalizeEmail(target.emp_id)
      : null;
  await syncSsoRoleMapping(candidateEmail, 'USER');

  return { success: true };
}

export async function bulkDeleteAdminUsers(userIds: number[], actorScope: AccessScope) {
  ensureCanManage(actorScope);

  const uniqueIds = Array.from(new Set(userIds)).filter((id) => Number.isFinite(id));
  if (!uniqueIds.length) {
    const err: any = new Error('validation_error');
    err.code = 'validation_error';
    throw err;
  }

  if (uniqueIds.includes(actorScope.userId)) {
    const err: any = new Error('cannot_delete_self');
    err.code = 'cannot_delete_self';
    throw err;
  }

  const targets = await User.findAll({
    raw: true,
    where: {
      user_id: { [Op.in]: uniqueIds } as any,
      deleted_at: null,
    },
  }) as any[];

  if (targets.length !== uniqueIds.length) {
    const err: any = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }

  const blockedRoleCodes = new Set<RoleCode>(['SUPER_ADMIN', 'GA_ADMIN']);
  const blockedTargets = targets.filter((target) => blockedRoleCodes.has(normalizeRoleCode(target.role_code)));
  if (blockedTargets.length) {
    const err: any = new Error('forbidden_role_delete');
    err.code = 'forbidden_role_delete';
    throw err;
  }

  await seq.transaction(async (transaction) => {
    await UserRole.destroy({
      where: { user_id: { [Op.in]: uniqueIds } as any },
      transaction,
    });

    await User.update(
      {
        deleted_at: new Date(),
        deleted_by: actorScope.userId,
      } as any,
      { where: { user_id: { [Op.in]: uniqueIds } as any }, transaction },
    );
 
    await emitAuditLog({
      actor: actorScope,
      action: 'USER_BULK_DELETED',
      targetType: 'user',
      details: {
        deletedIds: uniqueIds,
        deletedCount: uniqueIds.length,
      },
    });
  });

  return { success: true, deletedCount: uniqueIds.length };
}

type CsvErrorItem = {
  row: number;
  field: string;
  value?: string;
  message: string;
};

type CsvRowInput = {
  rowNumber: number;
  firstName: string;
  lastName: string;
  userName: string;
  employeeId: string;
  userJobRole: string;
  areaOfWork: string;
  roleCode: RoleCode;
  departmentCode: DepartmentCode;
};

const REQUIRED_CSV_HEADERS = ['firstName', 'lastName', 'userName', 'employeeId'];

const normalizeHeaderKey = (header: string) => {
  const cleaned = String(header || '').replace(/^\uFEFF/, '').trim().toLowerCase();
  return cleaned.replace(/[\s_-]/g, '');
};

const mapHeaderToField = (header: string) => {
  const normalized = normalizeHeaderKey(header);
  switch (normalized) {
    case 'firstname':
      return 'firstName';
    case 'lastname':
      return 'lastName';
    case 'username':
      return 'userName';
    case 'employeeid':
    case 'empid':
      return 'employeeId';
    case 'jobrole':
    case 'userjobrole':
      return 'jobRole';
    case 'department':
    case 'departmentcode':
      return 'department';
    case 'role':
    case 'rolecode':
      return 'role';
    case 'areaofwork':
      return 'areaOfWork';
    default:
      return String(header || '').trim();
  }
};

const buildCsvError = (row: number, field: string, value: string | undefined, message: string): CsvErrorItem => ({
  row,
  field,
  value,
  message,
});

function formatRowCount(rows: CsvRowInput[], errors: CsvErrorItem[]) {
  const totalRows = rows.length;
  const invalidRows = new Set(errors.map((err) => err.row)).size;
  const validRows = Math.max(totalRows - invalidRows, 0);
  return { totalRows, validRows, invalidRows };
}

export async function importAdminUsersFromCsv(filePath: string, actorScope: AccessScope) {
  ensureCanManage(actorScope);

  const rawText = await fs.readFile(filePath, 'utf8');
  const csvText = rawText.replace(/^\uFEFF/, '');

  const parsed = Papa.parse<Record<string, any>>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: mapHeaderToField,
  });

  if (parsed.errors?.length) {
    const errors = parsed.errors.map((err) =>
      buildCsvError((err.row ?? 0) + 1, 'csv', undefined, err.message || 'CSV parse error'),
    );
    const counts = formatRowCount([], errors);
    const parseError: any = new Error('csv_parse_error');
    parseError.status = 400;
    parseError.code = 'VALIDATION_ERROR';
    parseError.errors = errors;
    Object.assign(parseError, counts);
    throw parseError;
  }

  const fields = parsed.meta.fields || [];
  const missingHeaders = REQUIRED_CSV_HEADERS.filter((header) => !fields.includes(header));
  if (missingHeaders.length) {
    const errors = missingHeaders.map((header) =>
      buildCsvError(1, header, undefined, `Missing required header: ${header}`),
    );
    const counts = formatRowCount([], errors);
    const headerError: any = new Error('missing_headers');
    headerError.status = 400;
    headerError.code = 'VALIDATION_ERROR';
    headerError.errors = errors;
    Object.assign(headerError, counts);
    throw headerError;
  }

  const rows: CsvRowInput[] = [];
  const validationErrors: CsvErrorItem[] = [];
  const duplicateErrors: CsvErrorItem[] = [];
  const duplicateTracker = new Set<string>();
  const userNameMap = new Map<string, number>();
  const employeeIdMap = new Map<string, number>();

  parsed.data.forEach((row, index) => {
    const rowNumber = index + 2;
    const firstName = String(row.firstName || '').trim();
    const lastName = String(row.lastName || '').trim();
    const rawUserName = String(row.userName || '').trim();
    const userName = normalizeUserName(rawUserName);
    const employeeId = String(row.employeeId || '').trim();
    const userJobRole = String(row.jobRole || '').trim();
    const areaOfWork = String(row.areaOfWork || '').trim();
    const roleCode = normalizeRoleCode(row.role || 'USER');
    const departmentCode = normalizeDepartmentCode(row.department || 'HR');

    rows.push({
      rowNumber,
      firstName,
      lastName,
      userName,
      employeeId,
      userJobRole,
      areaOfWork,
      roleCode,
      departmentCode,
    });

    if (!firstName) validationErrors.push(buildCsvError(rowNumber, 'firstName', undefined, 'firstName is required'));
    if (!lastName) validationErrors.push(buildCsvError(rowNumber, 'lastName', undefined, 'lastName is required'));
    if (!rawUserName) validationErrors.push(buildCsvError(rowNumber, 'userName', undefined, 'userName is required'));
    if (!employeeId) validationErrors.push(buildCsvError(rowNumber, 'employeeId', undefined, 'employeeId is required'));

    if (userName) {
      const existingRow = userNameMap.get(userName);
      if (existingRow != null && existingRow !== rowNumber) {
        const key = `userName:${userName}:${rowNumber}`;
        if (!duplicateTracker.has(key)) {
          duplicateErrors.push(buildCsvError(rowNumber, 'userName', rawUserName, 'userName duplicated in CSV'));
          duplicateTracker.add(key);
        }
      } else {
        userNameMap.set(userName, rowNumber);
      }
    }

    if (employeeId) {
      const normalizedEmployeeId = employeeId.toLowerCase();
      const existingRow = employeeIdMap.get(normalizedEmployeeId);
      if (existingRow != null && existingRow !== rowNumber) {
        const key = `employeeId:${normalizedEmployeeId}:${rowNumber}`;
        if (!duplicateTracker.has(key)) {
          duplicateErrors.push(buildCsvError(rowNumber, 'employeeId', employeeId, 'employeeId duplicated in CSV'));
          duplicateTracker.add(key);
        }
      } else {
        employeeIdMap.set(normalizedEmployeeId, rowNumber);
      }
    }
  });

  if (validationErrors.length) {
    const counts = formatRowCount(rows, validationErrors);
    const validationError: any = new Error('validation_error');
    validationError.status = 400;
    validationError.code = 'VALIDATION_ERROR';
    validationError.errors = validationErrors;
    Object.assign(validationError, counts);
    throw validationError;
  }

  const employeeIds = Array.from(
    new Set(rows.map((row) => row.employeeId.toLowerCase()).filter(Boolean)),
  );
  const userNames = Array.from(new Set(rows.map((row) => row.userName).filter(Boolean)));

  if (employeeIds.length || userNames.length) {
    const orClauses: any[] = [];
    if (employeeIds.length) {
      orClauses.push(
        Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('emp_id')), { [Op.in]: employeeIds }),
      );
    }
    if (userNames.length) {
      orClauses.push(
        Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('user_name')), { [Op.in]: userNames }),
      );
    }

    if (orClauses.length) {
      const existingUsers = await User.findAll({
        raw: true,
        attributes: ['user_id', 'emp_id', 'user_name'],
        where: {
          deleted_at: null,
          [Op.or]: orClauses as any,
        },
      }) as any[];

      existingUsers.forEach((existing) => {
        const existingEmpId = String(existing.emp_id || '').trim();
        if (existingEmpId) {
          const rowNumber = employeeIdMap.get(existingEmpId.toLowerCase());
          if (rowNumber != null) {
            duplicateErrors.push(
              buildCsvError(rowNumber, 'employeeId', existingEmpId, 'employeeId already exists'),
            );
          }
        }

        const existingUserName = normalizeUserName(existing.user_name || '');
        if (existingUserName) {
          const rowNumber = userNameMap.get(existingUserName);
          if (rowNumber != null) {
            duplicateErrors.push(
              buildCsvError(rowNumber, 'userName', existing.user_name, 'userName already exists'),
            );
          }
        }
      });
    }
  }

  if (duplicateErrors.length) {
    const counts = formatRowCount(rows, duplicateErrors);
    const dupError: any = new Error('duplicate_user');
    dupError.status = 409;
    dupError.code = 'DUPLICATE_USER';
    dupError.errors = duplicateErrors;
    Object.assign(dupError, counts);
    throw dupError;
  }

  const preparedRows = await Promise.all(
    rows.map(async (row) => {
      const passwordSeed = row.userName || row.employeeId;
      const hashedPassword = await hashPassword(passwordSeed);
      return {
        user_name: row.userName,
        emp_id: row.employeeId,
        first_name: row.firstName,
        last_name: row.lastName,
        job_role_key: normalizeJobRole(row.userJobRole),
        area_of_work_key: normalizeArea(row.areaOfWork),
        password: hashedPassword,
        status: '1',
        sso_bound: 0,
        create_by: actorScope.userId,
        department: row.departmentCode,
        department_code: row.departmentCode,
        role_code: row.roleCode,
      } as any;
    }),
  );

  await seq.transaction(async (transaction) => {
    await User.bulkCreate(preparedRows, { transaction });
  });

  const counts = formatRowCount(rows, []);
  return {
    success: true,
    insertedCount: rows.length,
    ...counts,
  };
}

export async function findUserByEmpId(employeeId: string) {
  const mode = await detectDbMode();

  if (mode === 'postgres') {
    const value = String(employeeId || '').trim();
    if (!value) return null;

    const byEmpId = await pgPool.query(
      `SELECT * FROM "user" WHERE emp_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [value],
    );
    if (byEmpId.rows[0]) return byEmpId.rows[0];

    // Prefer app/legacy user rows over sys_user fallback so role_code/department_code
    // used by RBAC and file visibility remain consistent for admin dashboard users.
    const legacyByName = await pgPool.query(
      `SELECT * FROM "user" WHERE user_name = $1 AND deleted_at IS NULL LIMIT 1`,
      [value],
    );
    if (legacyByName.rows[0]) return legacyByName.rows[0];

    const byName = await pgPool.query(
      `SELECT * FROM sys_user WHERE user_name = $1 AND COALESCE(del_flag, '0') = '0' LIMIT 1`,
      [value],
    );
    if (byName.rows[0]) return byName.rows[0];

    if (/^\d+$/.test(value)) {
      const legacyById = await pgPool.query(
        `SELECT * FROM "user" WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [Number(value)],
      );
      if (legacyById.rows[0]) return legacyById.rows[0];

      const byId = await pgPool.query(
        `SELECT * FROM sys_user WHERE user_id = $1 AND COALESCE(del_flag, '0') = '0' LIMIT 1`,
        [Number(value)],
      );
      if (byId.rows[0]) return byId.rows[0];
    }

    return null;
  }

  return User.findOne({ raw: true, where: { emp_id: employeeId, deleted_at: null } }) as any;
}

export async function getPrimaryRoleForUser(userId: number): Promise<'admin' | 'user'> {
  const mode = await detectDbMode();
  let roleCode = 'USER';

  if (mode === 'postgres') {
    const res = await pgPool.query(
      `
      SELECT role_code
      FROM "user"
      WHERE user_id = $1
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [userId],
    );
    roleCode = normalizeRoleCode(res.rows[0]?.role_code || 'USER');
  } else {
    const user = await User.findOne({ raw: true, where: { user_id: userId, deleted_at: null } }) as any;
    roleCode = normalizeRoleCode(user?.role_code || 'USER');
  }

  if (roleCode === 'SUPER_ADMIN' || roleCode.endsWith('_ADMIN')) return 'admin';
  return 'user';
}
