import { getAllGroupsSer, buildGroupTree, createGroupSer, updateGroupSer, deleteGroupSer, getGroupByIdSer } from '../service/group';
import { Context } from 'koa';

export const getAllGroups = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const groups = await getAllGroupsSer();
    const groupTree = buildGroupTree(groups);
    ctx.state.formatData = groupTree;
    await next();
  } catch (error) {
    console.error('Error in getAllGroups:', error);
    return ctx.app.emit('error', {
      code: '400',
      message: 'グループ一覧の取得に失敗しました',
    }, ctx);
  }
};

export const createGroup = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const { groupName, parentId, colorCode, useGroupColor, attributes } = ctx.request.body as any;
    
    if (!groupName) {
      return ctx.app.emit('error', {
        code: '400',
        message: 'グループ名は必須です',
      }, ctx);
    }

    const groupData = {
      group_name: groupName,
      parent_id: parentId || null,
      color_code: colorCode || '#409EFF',
      use_group_color: useGroupColor ? 1 : 0,
      attributes: attributes || '',
      create_by: ctx.state.user?.userId,
      updated_by: ctx.state.user?.userId
    };

    const newGroup = await createGroupSer(groupData);
    ctx.state.formatData = newGroup;
    await next();
  } catch (error) {
    console.error('Error in createGroup:', error);
    return ctx.app.emit('error', {
      code: '500',
      message: 'グループの作成に失敗しました',
    }, ctx);
  }
};

export const updateGroup = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const groupId = ctx.params.id;
    const { groupName, parentId, colorCode, useGroupColor, attributes } = ctx.request.body as any;    
    if (!groupName) {
      return ctx.app.emit('error', {
        code: '400',
        message: 'グループ名は必須です',
      }, ctx);
    }

    const updateData = {
      group_name: groupName,
      parent_id: parentId || null,
      color_code: colorCode || '#409EFF',
      use_group_color: useGroupColor ? 1 : 0,
      attributes: attributes || '',
      updated_by: ctx.state.user?.userId
    };

    const success = await updateGroupSer(groupId, updateData);
    if (success) {
      const updatedGroup = await getGroupByIdSer(groupId);
      ctx.state.formatData = updatedGroup;
      await next();
    } else {
      return ctx.app.emit('error', {
        code: '404',
        message: 'グループが見つかりません',
      }, ctx);
    }
  } catch (error) {
    console.error('Error in updateGroup:', error);
    return ctx.app.emit('error', {
      code: '500',
      message: 'グループの更新に失敗しました',
    }, ctx);
  }
};

export const deleteGroup = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const groupId = ctx.params.id;
    const currentUserId = ctx.state.user?.userId;
    
    const success = await deleteGroupSer(groupId, currentUserId);
    if (success) {
      ctx.state.formatData = { success: true, message: 'グループを削除しました' };
      await next();
    } else {
      return ctx.app.emit('error', {
        code: '404',
        message: 'グループが見つかりません',
      }, ctx);
    }
  } catch (error) {
    console.error('Error in deleteGroup:', error);
    return ctx.app.emit('error', {
      code: '500',
      message: 'グループの削除に失敗しました',
    }, ctx);
  }
};

export const populateTestData = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const testGroups = [
      { group_name: '開発部', parent_id: null },
      { group_name: '営業部', parent_id: null },
      { group_name: '管理部', parent_id: null },
      { group_name: 'フロントエンドチーム', parent_id: 1 },
      { group_name: 'バックエンドチーム', parent_id: 1 },
      { group_name: '国内営業チーム', parent_id: 2 },
      { group_name: '海外営業チーム', parent_id: 2 },
      { group_name: '人事チーム', parent_id: 3 }
    ];

    for (const groupData of testGroups) {
      await createGroupSer(groupData);
    }

    ctx.state.formatData = { success: true, message: 'テストデータを作成しました' };
    await next();
  } catch (error) {
    console.error('Error in populateTestData:', error);
    return ctx.app.emit('error', {
      code: '500',
      message: 'テストデータの作成に失敗しました',
    }, ctx);
  }
};
