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
import { inferDepartmentCodeFromRole, getRoleForEmail } from '@/service/ssoRoleStore';

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
  mail?: string | null;
  userPrincipalName?: string;
  id?: string;
};

const issueSessionForMicrosoftEmail = async (
  ctx: Context,
  next: () => Promise<void>,
  params: { email: string; displayName?: string | null },
) => {
  const email = normalizeEmail(params.email);
  const displayName = String(params.displayName || '').trim();
  const { firstName, lastName } = splitDisplayName(displayName);

  if (!email) {
    return ctx.app.emit('error', { code: '400', message: 'email is required for Microsoft SSO login' }, ctx);
  }

  const roleCode = await getRoleForEmail(email);
  const departmentCode = inferDepartmentCodeFromRole(roleCode);

  const existing = (await User.findOne({
    raw: true,
    where: {
      deleted_at: null,
      [Op.or]: [{ email }, { emp_id: email }],
    } as any,
  })) as any;

  let userId: number;
  let userName: string;
  let empId: string;

  if (!existing) {
    const created = (await User.create({
      user_name: email,
      emp_id: email,
      first_name: firstName,
      last_name: lastName,
      job_role_key: '',
      area_of_work_key: '',
      password: await hashPassword(createHash()),
      email,
      phonenumber: null,
      status: '1',
      sso_bound: 1,
      department: departmentCode,
      department_code: departmentCode,
      role_code: roleCode,
      create_by: 1,
    } as any)) as any;

    userId = Number(created.dataValues.user_id);
    userName = String(created.dataValues.user_name || email);
    empId = String(created.dataValues.emp_id || email);
  } else {
    userId = Number(existing.user_id);
    userName = String(existing.user_name || email);
    empId = String(existing.emp_id || email);

    // Keep the primary app user table aligned with the SQLite mapping.
    await User.update(
      {
        email,
        emp_id: empId || email,
        first_name: firstName || existing.first_name || '',
        last_name: lastName || existing.last_name || '',
        status: '1',
        sso_bound: 1,
        department: departmentCode,
        department_code: departmentCode,
        role_code: roleCode,
        last_login_at: new Date(),
      } as any,
      { where: { user_id: userId } },
    );
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
    departmentCode,
  };

  await next();
};

export const loginWithMicrosoft = async (ctx: Context, next: () => Promise<void>) => {
  const accessToken = String((ctx.request.body as any)?.accessToken || '').trim();
  if (!accessToken) {
    return ctx.app.emit('error', { code: '400', message: 'accessToken is required for Microsoft SSO login' }, ctx);
  }

  const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName,id', {
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

  return issueSessionForMicrosoftEmail(ctx, next, {
    email,
    displayName: profile.displayName || email,
  });
};

export const loginWithMicrosoftMock = async (ctx: Context, next: () => Promise<void>) => {
  const rawEmail = (ctx.request.body as any)?.email ?? (ctx.query as any)?.email ?? process.env.SSO_MOCK_EMAIL;
  return issueSessionForMicrosoftEmail(ctx, next, {
    email: normalizeEmail(rawEmail),
    displayName: normalizeEmail(rawEmail),
  });
};
