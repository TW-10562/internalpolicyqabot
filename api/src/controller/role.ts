import FileRole from '@/mysql/model/file_role.model';
import Role from '@/mysql/model/role.model';
import RoleMenu from '@/mysql/model/role_menu.model';
import UserRole from '@/mysql/model/user_role.model';
import { userType } from '@/types';
import { IaddFileRoleType, IaddUserRoleType, Irole, IroleMenuType, IroleQuerySerType, IroleQueryType, IroleSer } from '@/types/role';
import { formatHumpLineTransfer } from '@/utils';
import { getDetail as getDetailMapper, add as addMapper, addAll as addAllMapper, del as delMapper, put as putMapper, queryPage as queryPageMapper, queryConditionsData as queryConditionsDataMapper, queryConditionsData } from '@/utils/mapper';
import { Context } from 'koa';
import { Op } from 'sequelize';
import { updateUserInfo } from '@/utils/redis';

export const getList = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const { pageNum, pageSize, ...params } = ctx.query as unknown as IroleQueryType;
    const newParams = { pageNum, pageSize, del_flag: '0' } as IroleQuerySerType;
    if (params.userIds) {
      const userIds = params.userIds.split(',').map((id) => Number(id));
      const userRoles = (await UserRole.findAll({
        attributes: ['role_id'],
        where: { user_id: { [Op.in]: userIds } },
      })) as any;

      ctx.state.formatData = userRoles.map((item: any) => item.role_id);
      await next();
      return;
    }

    if (params.fileIds) {
      const fileIds = params.fileIds.split(',').map((id) => Number(id));
      const fileRoles = (await FileRole.findAll({
        attributes: ['role_id'],
        where: { file_id: { [Op.in]: fileIds } },
      })) as any;
      ctx.state.formatData = fileRoles.map((item: any) => item.role_id);
      await next();
      return;
    }

    const res = await queryPageMapper<IroleQuerySerType>(Role, newParams);

    ctx.state.formatData = res;
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'リストの取得に失敗しました',
      },
      ctx,
    );
  }
};

export const add = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const { userName } = ctx.state.user as userType;
    const addContent = ctx.request.body as Irole;
    const addContent2 = { ...addContent, createBy: userName };
    const newAddContent = formatHumpLineTransfer(addContent2, 'line') as IroleSer;

    const res = await addMapper<IroleSer>(Role, newAddContent);

    const rm = [];
    addContent.menuIds.forEach((menuId) => {
      rm.push({
        role_id: res.role_id,
        menu_id: menuId,
      });
    });
    await addAllMapper(RoleMenu, rm);
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit('error', {
      code: '400',
      message: 'アップロードパラメータを確認してください',
    }, ctx);
  }
};

export const del = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const ids = ctx.state.ids as string[];
    const { userName } = ctx.state.user as userType;

    const res = await queryConditionsDataMapper(UserRole, { role_id: ids });

    if (res.length > 0) {
      const relaIds = res.map((item: { user_id: number; role_id: number }) => {
        if (ids.includes(String(item.role_id))) {
          return item.role_id;
        }
        return undefined;
      });
      const roles = await queryConditionsDataMapper(Role, { role_id: relaIds });
      let roleMessage = '';

      roles.forEach((role) => {
        roleMessage += `${role.role_name},`;
      });
      ctx.body = {
        code: 500,
        message: `${roleMessage}割り当てられたため、削除できません`,
      };
    } else {
      await putMapper<IroleSer>(Role, { role_id: ids }, { del_flag: '1', update_by: userName });
      await next();
    }
  } catch (error) {
    return ctx.app.emit('error', {
      code: '500',
      message: '削除に失敗しました',
    }, ctx);
  }
};

export const getDetail = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const res = await getDetailMapper<IroleSer>(Role, { role_id: ctx.state.ids });

    const roleMenus = await getRoleMenuIdSer(ctx.state.ids);
    const ids = [] as number[];
    roleMenus.forEach((item) => {
      ids.push(item.menu_id);
    });

    ctx.state.formatData = { ...res, menuIds: ids };
  } catch (error) {
    return ctx.app.emit('error', {
      code: '500',
      message: '詳細の取得に失敗しました',
    }, ctx);
  }

  await next();
};

export const put = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const { userName } = ctx.state.user as userType;
    const res = ctx.request.body as Irole;
    const lineData = formatHumpLineTransfer(res, 'line') as IroleSer;
    const { role_id, ...data } = lineData;

    await putMapper<IroleSer>(Role, { role_id }, { ...data, update_by: userName });

    const roleMenus = await getRoleMenuIdSer(role_id);
    const ids = [] as number[];
    roleMenus.forEach((item) => {
      ids.push(item.id);
    });
    await delMapper(RoleMenu, { id: ids });

    const rm = [];
    res.menuIds.forEach((menuId) => {
      rm.push({
        role_id,
        menu_id: menuId,
      });
    });
    await addAllMapper(RoleMenu, rm);
    await next();
    const userIds = (await queryConditionsData(UserRole, { role_id })).map((item) => item.user_id);

    updateUserInfo('update_userInfo', userIds);
  } catch (error) {
    console.error(error);
    return ctx.app.emit('error', {
      code: '500',
      message: '更新に失敗しました',
    }, ctx);
  }
};

export const updateRoleStatus = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const { userName } = ctx.state.user as userType;
    const { id, status } = ctx.request.body as { status: string; id: number };

    await putMapper<IroleSer>(Role, { role_id: id }, { status, update_by: userName });

    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit('error', {
      code: '500',
      message: '更新に失敗しました',
    }, ctx);
  }
};

export const getRoleMenuIdSer = async (role_id: number) => {
  const res = (await RoleMenu.findAll({
    raw: true,
    where: { role_id },
  })) as unknown as IroleMenuType[];

  return res;
};

export const roleBindUser = async (queryParams: {
  pageNum: number;
  pageSize: number;
  role_id: string;
}) => {
  const obj = {};
  const { pageNum = 1, pageSize = 10, ...params } = queryParams;

  if (queryParams.pageNum)
    Object.assign(obj, {
      offset: (Number(pageNum) - 1) * Number(pageSize),
      limit: Number(pageSize),
    });

  const res = await UserRole.findAll({
    raw: true,
    ...obj,
    where: { ...params },
  });

  return res;
};

export const addUserRole = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const data = ctx.request.body as IaddUserRoleType;

    const addRoleUser = [];
    addRoleUser.push({
      role_id: data.roleId,
      user_id: data.userId,
    });

    await addAllMapper(UserRole, addRoleUser);
    // Ensure the affected user refreshes roles/permissions in their Redis session
    await updateUserInfo('update_userInfo', [data.userId]);
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '400',
        message: 'アップロードパラメータを確認してください',
      },
      ctx,
    );
  }
};

export const addFileRole = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const data = ctx.request.body as IaddFileRoleType;

    const addRoleFile = [];
    addRoleFile.push({
      role_id: data.roleId,
      file_id: data.fileId,
    });

    await addAllMapper(FileRole, addRoleFile);
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '400',
        message: 'アップロードパラメータを確認してください',
      },
      ctx,
    );
  }
};
