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

export const loginWithMicrosoftMock = async (ctx: Context, next: () => Promise<void>) => {
  // NOTE: This is a temporary "mock" SSO endpoint so the UI can be switched to
  // "Sign in via Microsoft" before Entra ID details are ready.
  //
  // TODO(EntraID): Replace this with a real OAuth2/OIDC flow using Microsoft Entra ID:
  // - Start auth: redirect to the /authorize endpoint
  // - Callback: exchange code for tokens, read the user's email from the ID token
  // - Then call the same "email -> role -> session" logic below.
  const rawEmail = (ctx.request.body as any)?.email ?? (ctx.query as any)?.email ?? process.env.SSO_MOCK_EMAIL;
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return ctx.app.emit('error', { code: '400', message: 'email is required for mock SSO login' }, ctx);
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
      first_name: '',
      last_name: '',
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
    roleCode,
    departmentCode,
  };

  await next();
};

