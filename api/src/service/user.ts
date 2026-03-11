import User from '@/mysql/model/user.model';
import UserRole from '@/mysql/model/user_role.model';
import { userQuerySerType, userType } from '@/types';
import { detectDbMode, getUserById, getUserByName } from '@/db/adapter';
import { pgPool } from '@/clients/postgres';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';

const BCRYPT_ROUNDS = 10;

const isBcryptHash = (value?: string) => typeof value === 'string' && value.startsWith('$2');
const DEFAULT_PG_STATUS = '0';

const parseLikePattern = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const maybeLike = (value as any)[Op.like];
    if (typeof maybeLike === 'string') return maybeLike;
  }
  return null;
};

const updatePgUserTimestampColumns = async (userId: number) => {
  try {
    const res = await pgPool.query(
      `UPDATE sys_user SET update_time = NOW(), last_updated = NOW() WHERE user_id = $1`,
      [userId],
    );
    return (res.rowCount || 0) > 0;
  } catch {
    try {
      const fallback = await pgPool.query(`UPDATE sys_user SET update_time = NOW() WHERE user_id = $1`, [userId]);
      return (fallback.rowCount || 0) > 0;
    } catch {
      const fallback2 = await pgPool.query(`UPDATE sys_user SET updated_at = NOW() WHERE user_id = $1`, [userId]);
      return (fallback2.rowCount || 0) > 0;
    }
  }
};

export const hashPassword = async (password: string) => {
  if (isBcryptHash(password)) return password;
  return bcrypt.hash(password, BCRYPT_ROUNDS);
};

export const verifyPassword = async (plain: string, stored: string) => {
  if (!stored) return false;
  if (isBcryptHash(stored)) return bcrypt.compare(plain, stored);
  // Backward compatibility for legacy plain-text records.
  return plain === stored;
};

export const getUserInfo = async ({ userId, userName, password }: userType) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const res = userId ? await getUserById(Number(userId)) : await getUserByName(String(userName || ''));
    if (!res) return null;
    if (password && res.password !== password) return null;
    return res as any;
  }

  const whereOpt = {};
  if (userId) Object.assign(whereOpt, { user_id: userId });
  if (userName) Object.assign(whereOpt, { user_name: userName, deleted_at: null });
  if (password) Object.assign(whereOpt, { password });

  const res = (await User.findOne({
    attributes: ['user_id', 'user_name', 'password'],
    where: whereOpt,
  })) as any;

  return res ? res.dataValues : null;
};

export const getAllUserInfoSer = async ({ userId }) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    return (await getUserById(Number(userId))) as any;
  }

  const res = (await User.findOne({
    where: { user_id: userId },
  })) as any;

  return res ? res.dataValues : null;
};

export const getUserList = async (queryParams: userQuerySerType) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const { pageNum, pageSize, beginTime, endTime, ...params } = queryParams;
    const where: string[] = [`COALESCE(del_flag, '0') = '0'`];
    const values: unknown[] = [];

    const userNamePattern = parseLikePattern(params.user_name);
    if (userNamePattern) {
      values.push(userNamePattern);
      where.push(`user_name LIKE $${values.length}`);
    }

    if (params.status) {
      values.push(params.status);
      where.push(`status = $${values.length}`);
    }

    if (beginTime && endTime) {
      values.push(beginTime);
      where.push(`create_time >= $${values.length}`);
      values.push(endTime);
      where.push(`create_time <= $${values.length}`);
    }

    const pageNumVal = Math.max(1, Number(pageNum) || 1);
    const pageSizeVal = Math.max(1, Number(pageSize) || 10);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await pgPool.query(
      `SELECT COUNT(*)::int AS count FROM sys_user ${whereSql}`,
      values,
    );

    const rowsRes = await pgPool.query(
      `
      SELECT
        user_id,
        user_name,
        email,
        phonenumber,
        status,
        create_time AS created_at,
        last_updated AS last_login_at
      FROM sys_user
      ${whereSql}
      ORDER BY user_id DESC
      OFFSET $${values.length + 1}
      LIMIT $${values.length + 2}
      `,
      [...values, (pageNumVal - 1) * pageSizeVal, pageSizeVal],
    );

    return {
      count: Number(countRes.rows[0]?.count || 0),
      rows: rowsRes.rows || [],
    };
  }

  const { pageNum, pageSize, beginTime, endTime, ...params } = queryParams;
  if (beginTime) {
    params.created_at = { [Op.between]: [beginTime, endTime] };
  }

  const res = await User.findAndCountAll({
    attributes: ['user_id', 'user_name', 'email', 'phonenumber', 'status', 'created_at', 'last_login_at'],
    offset: (Number(pageNum) - 1) * Number(pageSize),
    limit: Number(pageSize),
    where: {
      deleted_at: null,
      ...params,
    },
  });

  const list = {
    count: res.count,
    rows: res.rows || {},
  };
  return list;
};

export const deleteUser = async (userId, deleteBy) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const ids = (Array.isArray(userId) ? userId : [userId])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (!ids.length) return null;

    try {
      const res = await pgPool.query(
        `UPDATE sys_user SET del_flag = '1', update_time = NOW(), last_updated = NOW() WHERE user_id = ANY($1::bigint[])`,
        [ids],
      );
      return [res.rowCount || 0];
    } catch {
      const fallback = await pgPool.query(
        `UPDATE sys_user SET del_flag = '1' WHERE user_id = ANY($1::bigint[])`,
        [ids],
      );
      return [fallback.rowCount || 0];
    }
  }

  const res = await User.update({ deleted_at: new Date(), deleted_by: deleteBy }, { where: { user_id: userId } });

  return res || null;
};

export const updateUserStatus = async (user) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const userId = Number(user?.userId);
    const status = String(user?.status ?? DEFAULT_PG_STATUS);
    if (!Number.isFinite(userId)) return false;

    try {
      const res = await pgPool.query(
        `UPDATE sys_user SET status = $1, update_time = NOW(), last_updated = NOW() WHERE user_id = $2 AND COALESCE(del_flag, '0') = '0'`,
        [status, userId],
      );
      return (res.rowCount || 0) > 0;
    } catch {
      const fallback = await pgPool.query(
        `UPDATE sys_user SET status = $1 WHERE user_id = $2`,
        [status, userId],
      );
      return (fallback.rowCount || 0) > 0;
    }
  }

  const { userId, ...data } = user;
  const res = await User.update(data, { where: { user_id: userId } });

  return res[0] > 0;
};

export const getAllUsersSer = async () => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const res = await pgPool.query(
      `
      SELECT
        user_id,
        user_name,
        email,
        phonenumber,
        status,
        create_time AS created_at,
        last_updated AS last_login_at
      FROM sys_user
      WHERE COALESCE(del_flag, '0') = '0'
      ORDER BY user_id DESC
      `,
    );
    return res.rows || [];
  }

  const res = await User.findAll({
    attributes: ['user_id', 'user_name', 'email', 'phonenumber', 'status', 'created_at', 'last_login_at'],
    where: { deleted_at: null, sso_bound: 0 },
    order: [['created_at', 'DESC']]
  }) as any;

  return res ? res.map(user => user.dataValues) : [];
};

export const createUserSer = async ({ userName, password, department, email, phonenumber, createBy, groupIds = [], ssoBound = 0 }) => {
  if(password === undefined) {
    password = userName;
    if (password.length <= 3) {
      password = password.padStart(4, '0');
    }
  }

  const hashedPassword = await hashPassword(password);
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nextIdRes = await pgPool.query(`SELECT COALESCE(MAX(user_id), 0) + 1 AS next_id FROM sys_user`);
      const nextId = Number(nextIdRes.rows[0]?.next_id || 1);
      try {
        const insertRes = await pgPool.query(
          `
          INSERT INTO sys_user (
            user_id,
            user_name,
            password,
            email,
            phonenumber,
            status
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
          `,
          [nextId, userName, hashedPassword, email || null, phonenumber || null, DEFAULT_PG_STATUS],
        );
        return insertRes.rows[0] || null;
      } catch (error: any) {
        if (error?.code === '23505') continue;
        throw error;
      }
    }
    throw new Error('Failed to allocate a unique user_id for sys_user');
  }

  const userData = {
    user_name: userName,
    emp_id: `LEGACY_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    first_name: userName || '',
    last_name: '',
    job_role_key: '',
    area_of_work_key: '',
    password: hashedPassword,
    department: department,
    email: email || null,
    phonenumber: phonenumber || null,
    sso_bound: ssoBound,
    status: '0', // デフォルトで無効
    create_by: createBy || null
  };

  const res = await User.create(userData) as any;

  if (res && groupIds.length > 0) {
    const { createUserGroupRelations } = await import('./group');
    await createUserGroupRelations(res.dataValues.user_id, groupIds);
  }

  return res ? res.dataValues : null;
};

export const updateLastLoginSer = async (userId: number) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    return updatePgUserTimestampColumns(userId);
  }

  const res = await User.update(
    { last_login_at: new Date() },
    { where: { user_id: userId } }
  );
  return res[0] > 0;
};

export const updateUserSer = async ({ userId, userName, email, phonenumber, updatedBy, groupIds = [] }) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const userIdNum = Number(userId);
    if (!Number.isFinite(userIdNum)) return false;

    try {
      const res = await pgPool.query(
        `
        UPDATE sys_user
        SET
          user_name = $1,
          email = $2,
          phonenumber = $3,
          update_time = NOW(),
          last_updated = NOW()
        WHERE user_id = $4
          AND COALESCE(del_flag, '0') = '0'
        `,
        [userName, email || null, phonenumber || null, userIdNum],
      );
      return (res.rowCount || 0) > 0;
    } catch {
      const fallback = await pgPool.query(
        `UPDATE sys_user SET user_name = $1, email = $2, phonenumber = $3 WHERE user_id = $4`,
        [userName, email || null, phonenumber || null, userIdNum],
      );
      return (fallback.rowCount || 0) > 0;
    }
  }

  const userData = {
    user_name: userName,
    email: email || null,
    phonenumber: phonenumber || null,
    updated_by: updatedBy || null,
    updated_at: new Date()
  };

  const res = await User.update(userData, {
    where: { user_id: userId, deleted_at: null }
  });

  if (res[0] > 0 && groupIds.length >= 0) {
    const { updateUserGroupRelations } = await import('./group');
    await updateUserGroupRelations(userId, groupIds);
  }

  return res[0] > 0;
};

export const getUserRoleSer = async (userId) => {
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const res = await pgPool.query(
      `SELECT role_id FROM sys_user_role WHERE user_id = $1`,
      [Number(userId)],
    );
    return res.rows || [];
  }

  const res = await UserRole.findAll({
    raw: true,
    attributes: ['role_id'],
    where: { user_id: userId },
  });
  return res || [];
};

export const changePasswordSer = async ( {userId, password} ) => {
  const hashedPassword = await hashPassword(password);
  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const userIdNum = Number(userId);
    if (!Number.isFinite(userIdNum)) return false;

    try {
      const res = await pgPool.query(
        `
        UPDATE sys_user
        SET
          password = $1,
          update_time = NOW(),
          last_updated = NOW()
        WHERE user_id = $2
          AND COALESCE(del_flag, '0') = '0'
        `,
        [hashedPassword, userIdNum],
      );
      return (res.rowCount || 0) > 0;
    } catch {
      const fallback = await pgPool.query(
        `UPDATE sys_user SET password = $1 WHERE user_id = $2`,
        [hashedPassword, userIdNum],
      );
      return (fallback.rowCount || 0) > 0;
    }
  }

  const userData = {
    password: hashedPassword,
  };

  const res = await User.update(userData, {
    where: { user_id: userId, deleted_at: null }
  });

  return res[0] > 0;
};
