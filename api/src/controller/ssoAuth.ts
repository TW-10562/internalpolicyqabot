import { Context } from 'koa';
import jwt from 'jsonwebtoken';
import dayjs from 'dayjs';
import { Op } from 'sequelize';

import { config } from '@config/index';
import { createHash } from '@/utils';
import { addSession } from '@/utils/auth';
import { getFullUserInfo } from '@/utils/userInfo';
import User from '@/mysql/model/user.model';
import { hashPassword } from '@/service/user';
import { getRoleForEmail } from '@/service/ssoRoleStore';
import {
  departmentNameForCode,
  DepartmentCode,
  RoleCode,
  roleDepartmentForAdmin,
  tryNormalizeDepartmentCode,
} from '@/service/rbac';

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();
const splitDisplayName = (value: string) => {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return {
      firstName: parts[0] || '',
      lastName: '',
    };
  }

  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts.slice(-1).join(' '),
  };
};

type MicrosoftGraphUserInfo = {
  displayName?: string;
  department?: string | null;
  employeeId?: string | null;
  mailNickname?: string | null;
  mail?: string | null;
  onPremisesSamAccountName?: string | null;
  userPrincipalName?: string;
  id?: string;
};

const normalizeText = (value: unknown) => String(value || '').trim();
const extractEmailLocalPart = (value: unknown) => {
  const normalized = normalizeEmail(value);
  if (!normalized || !normalized.includes('@')) return '';
  return normalized.split('@')[0] || '';
};
const looksLikeEmail = (value: unknown) => {
  const normalized = String(value || '').trim();
  return Boolean(normalized && normalized.includes('@') && normalized.includes('.') && !normalized.includes(' '));
};

const resolveSsoDepartment = (params: {
  roleCode: RoleCode;
  microsoftDepartment?: string | null;
  existingDepartment?: string | null;
  existingDepartmentCode?: string | null;
}): { department: string; departmentCode: DepartmentCode; source: 'admin_role' | 'microsoft' | 'existing' | 'fallback' } => {
  const adminDepartment = roleDepartmentForAdmin(params.roleCode);
  if (adminDepartment) {
    return {
      department: departmentNameForCode(adminDepartment),
      departmentCode: adminDepartment,
      source: 'admin_role',
    };
  }

  const microsoftDepartment = normalizeText(params.microsoftDepartment);
  if (microsoftDepartment) {
    return {
      department: microsoftDepartment,
      departmentCode: tryNormalizeDepartmentCode(microsoftDepartment) || 'OTHER',
      source: 'microsoft',
    };
  }

  const existingDepartmentCode =
    tryNormalizeDepartmentCode(params.existingDepartmentCode) ||
    tryNormalizeDepartmentCode(params.existingDepartment);
  if (existingDepartmentCode) {
    return {
      department: normalizeText(params.existingDepartment) || departmentNameForCode(existingDepartmentCode),
      departmentCode: existingDepartmentCode,
      source: 'existing',
    };
  }

  const fallbackDepartmentCode: DepartmentCode = params.roleCode === 'SUPER_ADMIN' ? 'HR' : 'OTHER';
  return {
    department: departmentNameForCode(fallbackDepartmentCode),
    departmentCode: fallbackDepartmentCode,
    source: 'fallback',
  };
};

const resolveSsoEmployeeId = (params: {
  email: string;
  microsoftEmployeeId?: string | null;
  microsoftMailNickname?: string | null;
  microsoftSamAccountName?: string | null;
  existingEmployeeId?: string | null;
}): {
  employeeId: string;
  source:
    | 'microsoft_employeeId'
    | 'existing_non_email'
    | 'microsoft_samAccountName'
    | 'microsoft_mailNickname'
    | 'fallback_email_local_part'
    | 'existing'
    | 'fallback_email';
} => {
  const microsoftEmployeeId = normalizeText(params.microsoftEmployeeId);
  if (microsoftEmployeeId) {
    return {
      employeeId: microsoftEmployeeId,
      source: 'microsoft_employeeId',
    };
  }

  const existingEmployeeId = normalizeText(params.existingEmployeeId);
  if (existingEmployeeId && !looksLikeEmail(existingEmployeeId)) {
    return {
      employeeId: existingEmployeeId,
      source: 'existing_non_email',
    };
  }

  const microsoftSamAccountName = normalizeText(params.microsoftSamAccountName);
  if (microsoftSamAccountName) {
    return {
      employeeId: microsoftSamAccountName,
      source: 'microsoft_samAccountName',
    };
  }

  const microsoftMailNickname = normalizeText(params.microsoftMailNickname);
  if (microsoftMailNickname) {
    return {
      employeeId: microsoftMailNickname,
      source: 'microsoft_mailNickname',
    };
  }

  const emailLocalPart = extractEmailLocalPart(params.email);
  if (emailLocalPart) {
    return {
      employeeId: emailLocalPart,
      source: 'fallback_email_local_part',
    };
  }

  if (existingEmployeeId) {
    return {
      employeeId: existingEmployeeId,
      source: 'existing',
    };
  }

  return {
    employeeId: normalizeText(params.email),
    source: 'fallback_email',
  };
};

const issueSessionForMicrosoftEmail = async (
  ctx: Context,
  next: () => Promise<void>,
  params: {
    email: string;
    displayName?: string | null;
    department?: string | null;
    employeeId?: string | null;
    mailNickname?: string | null;
    onPremisesSamAccountName?: string | null;
  },
) => {
  const email = normalizeEmail(params.email);
  const displayName = String(params.displayName || '').trim();
  const requestedEmployeeId = normalizeText(params.employeeId);
  const lookupEmployeeId =
    requestedEmployeeId ||
    normalizeText((params as any).onPremisesSamAccountName) ||
    normalizeText((params as any).mailNickname);
  const { firstName, lastName } = splitDisplayName(displayName);

  if (!email) {
    return ctx.app.emit('error', { code: '400', message: 'email is required for Microsoft SSO login' }, ctx);
  }

  const roleCode = await getRoleForEmail(email);
  const activeEmployeeMatch =
    lookupEmployeeId && lookupEmployeeId !== email
      ? ((await User.findOne({
          raw: true,
          where: {
            deleted_at: null,
            emp_id: lookupEmployeeId,
          } as any,
          order: [['updated_at', 'DESC'], ['user_id', 'DESC']],
        })) as any)
      : null;
  const activeEmailMatch = (await User.findOne({
    raw: true,
    where: {
      deleted_at: null,
      [Op.or]: [{ email }, { emp_id: email }, { user_name: email }] as any,
    } as any,
      order: [['sso_bound', 'DESC'], ['updated_at', 'DESC'], ['user_id', 'DESC']],
  })) as any;
  const existing = activeEmployeeMatch || activeEmailMatch;
  if (activeEmployeeMatch && activeEmailMatch && Number(activeEmployeeMatch.user_id) !== Number(activeEmailMatch.user_id)) {
    console.warn('[sso.account_probe] employee/email conflict resolved in favor of employee match', {
      email,
      lookupEmployeeId,
      employeeUserId: Number(activeEmployeeMatch.user_id),
      emailUserId: Number(activeEmailMatch.user_id),
    });
  }
  const deletedMatch = existing
    ? null
    : (((lookupEmployeeId && lookupEmployeeId !== email
        ? ((await User.findOne({
            raw: true,
            where: {
              deleted_at: { [Op.ne]: null } as any,
              emp_id: lookupEmployeeId,
            } as any,
            order: [['updated_at', 'DESC'], ['user_id', 'DESC']],
          })) as any)
        : null) ||
        ((await User.findOne({
          raw: true,
          where: {
            deleted_at: { [Op.ne]: null } as any,
            [Op.or]: [{ email }, { emp_id: email }, { user_name: email }] as any,
          } as any,
          order: [['updated_at', 'DESC'], ['user_id', 'DESC']],
        })) as any)) as any);
  const { department, departmentCode, source } = resolveSsoDepartment({
    roleCode,
    microsoftDepartment: params.department,
    existingDepartment: existing?.department || deletedMatch?.department,
    existingDepartmentCode: existing?.department_code || deletedMatch?.department_code,
  });
  console.info('[sso.department_probe] resolved', {
    email,
    roleCode,
    source,
    microsoftDepartment: normalizeText(params.department) || null,
    existingDepartment: normalizeText(existing?.department || deletedMatch?.department) || null,
    existingDepartmentCode: normalizeText(existing?.department_code || deletedMatch?.department_code) || null,
    department,
    departmentCode,
  });
  const { employeeId, source: employeeSource } = resolveSsoEmployeeId({
    email,
    microsoftEmployeeId: requestedEmployeeId,
    microsoftMailNickname: (params as any).mailNickname,
    microsoftSamAccountName: (params as any).onPremisesSamAccountName,
    existingEmployeeId: existing?.emp_id || deletedMatch?.emp_id,
  });
  console.info('[sso.employee_probe] resolved', {
    email,
    employeeSource,
    microsoftEmployeeId: requestedEmployeeId || null,
    microsoftMailNickname: normalizeText((params as any).mailNickname) || null,
    microsoftSamAccountName: normalizeText((params as any).onPremisesSamAccountName) || null,
    existingEmployeeId: normalizeText(existing?.emp_id || deletedMatch?.emp_id) || null,
    employeeId,
  });

  let userId: number;
  let userName: string;
  let empId: string;
  const selectedUserId = existing
    ? Number(existing.user_id)
    : deletedMatch
      ? Number(deletedMatch.user_id)
      : null;
  const employeeConflict =
    employeeId && employeeId !== email
      ? ((await User.findOne({
          raw: true,
          where: {
            emp_id: employeeId,
            ...(selectedUserId ? { user_id: { [Op.ne]: selectedUserId } } : {}),
          } as any,
          order: [['deleted_at', 'ASC'], ['updated_at', 'DESC'], ['user_id', 'DESC']],
        })) as any)
      : null;
  const safeEmployeeId =
    employeeConflict && selectedUserId !== Number(employeeConflict.user_id)
      ? normalizeText(existing?.emp_id || deletedMatch?.emp_id) || email
      : employeeId || email;
  if (employeeConflict && selectedUserId !== Number(employeeConflict.user_id)) {
    console.warn('[sso.employee_conflict] preserving current emp_id to avoid unique collision', {
      email,
      requestedEmployeeId: employeeId,
      selectedUserId,
      conflictingUserId: Number(employeeConflict.user_id),
      conflictingDeletedAt: employeeConflict.deleted_at || null,
      persistedEmpId: safeEmployeeId,
    });
  }

  if (existing && String(existing.status) === '0') {
    // User account is disabled – do NOT auto-reactivate via SSO.
    // Only an admin can re-enable access through the dashboard.
    console.warn('[sso.login_blocked] disabled user attempted SSO login', {
      email,
      userId: Number(existing.user_id),
      status: existing.status,
    });
    return ctx.app.emit(
      'error',
      {
        code: '403',
        message: 'account_deactivated',
      },
      ctx,
    );
  } else if (existing) {
    userId = Number(existing.user_id);
    userName = String(existing.user_name || email);
    empId = safeEmployeeId;

    // Keep the primary app user table aligned with Microsoft profile data.
    await User.update(
      {
        email,
        emp_id: empId,
        first_name: firstName || existing.first_name || '',
        last_name: lastName || existing.last_name || '',
        status: '1',
        sso_bound: 1,
        department,
        department_code: departmentCode,
        role_code: roleCode,
        last_login_at: new Date(),
      } as any,
      { where: { user_id: userId } },
    );
  } else if (deletedMatch) {
    // User was deleted by an admin – do NOT auto-restore.
    // Treat this the same as a revoked account: reject the login.
    console.warn('[sso.login_blocked] deleted user attempted SSO login', {
      email,
      userId: Number(deletedMatch.user_id),
      deletedAt: deletedMatch.deleted_at,
      deletedBy: deletedMatch.deleted_by,
    });
    return ctx.app.emit(
      'error',
      {
        code: '403',
        message: 'account_deactivated',
      },
      ctx,
    );
  } else {
    const created = (await User.create({
      user_name: email,
      emp_id: safeEmployeeId,
      first_name: firstName,
      last_name: lastName,
      job_role_key: '',
      area_of_work_key: '',
      password: await hashPassword(createHash()),
      email,
      phonenumber: null,
      status: '1',
      sso_bound: 1,
      department,
      department_code: departmentCode,
      role_code: roleCode,
      create_by: 1,
    } as any)) as any;

    userId = Number(created.dataValues.user_id);
    userName = String(created.dataValues.user_name || email);
    empId = String(created.dataValues.emp_id || safeEmployeeId || email);
  }

  const session = createHash();
  const token = jwt.sign(
    {
      userId,
      userName,
      empId,
      roleCode,
      departmentCode,
      session,
      exp: dayjs().add(100, 'y').valueOf(),
    },
    config.Backend.jwtSecret,
  );

  const fullUser = await getFullUserInfo(userId);
  await addSession(session, {
    loginTime: new Date().toLocaleString(config.Backend.logTime),
    ...fullUser,
  });

  ctx.state.formatData = {
    token,
    userId,
    empId,
    email,
    displayName,
    roleCode,
    department,
    departmentCode,
  };

  await next();
};

export const loginWithMicrosoft = async (ctx: Context, next: () => Promise<void>) => {
  const accessToken = String((ctx.request.body as any)?.accessToken || '').trim();
  const clientDepartment = normalizeText((ctx.request.body as any)?.department);
  const clientEmployeeId = normalizeText((ctx.request.body as any)?.employeeId || (ctx.request.body as any)?.employeeCode);
  if (!accessToken) {
    return ctx.app.emit('error', { code: '400', message: 'accessToken is required for Microsoft SSO login' }, ctx);
  }

  const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,department,employeeId,mailNickname,mail,onPremisesSamAccountName,userPrincipalName,id', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!graphResponse.ok) {
    const errorBody = await graphResponse.text();
    console.error('[loginWithMicrosoft] graph profile lookup failed:', graphResponse.status, errorBody);
    return ctx.app.emit('error', { code: '401', message: 'Unable to validate Microsoft account' }, ctx);
  }

  const profile = (await graphResponse.json()) as MicrosoftGraphUserInfo;
  const email = normalizeEmail(profile.mail || profile.userPrincipalName);
  console.info('[loginWithMicrosoft] graph_profile', {
    email,
    graphDepartment: normalizeText(profile.department) || null,
    graphEmployeeId: normalizeText(profile.employeeId) || null,
    graphMailNickname: normalizeText(profile.mailNickname) || null,
    graphSamAccountName: normalizeText(profile.onPremisesSamAccountName) || null,
    clientDepartment: clientDepartment || null,
    clientEmployeeId: clientEmployeeId || null,
    displayName: normalizeText(profile.displayName) || null,
  });

  return issueSessionForMicrosoftEmail(ctx, next, {
    email,
    department: normalizeText(profile.department) || clientDepartment,
    employeeId: normalizeText(profile.employeeId) || clientEmployeeId,
    mailNickname: normalizeText(profile.mailNickname),
    onPremisesSamAccountName: normalizeText(profile.onPremisesSamAccountName),
    displayName: profile.displayName || email,
  });
};

export const loginWithMicrosoftMock = async (ctx: Context, next: () => Promise<void>) => {
  const rawEmail = (ctx.request.body as any)?.email ?? (ctx.query as any)?.email ?? process.env.SSO_MOCK_EMAIL;
  const rawDepartment =
    (ctx.request.body as any)?.department ??
    (ctx.query as any)?.department ??
    process.env.SSO_MOCK_DEPARTMENT;
  const rawEmployeeId =
    (ctx.request.body as any)?.employeeId ??
    (ctx.query as any)?.employeeId ??
    process.env.SSO_MOCK_EMPLOYEE_ID;
  return issueSessionForMicrosoftEmail(ctx, next, {
    email: normalizeEmail(rawEmail),
    department: normalizeText(rawDepartment),
    employeeId: normalizeText(rawEmployeeId),
    displayName: normalizeEmail(rawEmail),
  });
};
