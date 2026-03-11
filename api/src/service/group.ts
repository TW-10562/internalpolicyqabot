import Group from '@/mysql/model/group.model';
import User from '@/mysql/model/user.model';
import UserGroup from '@/mysql/model/user_group.model';
import { formatHumpLineTransfer } from '@/utils/index';

export const getAllGroupsSer = async () => {
  const res = await Group.findAll({
    attributes: [
      'group_id', 'group_name', 'parent_id', 'attributes', 
      'color_code', 'use_group_color', 'create_by', 'created_at', 
      'updated_by', 'updated_at'
    ],
    include: [
      {
        model: User,
        as: 'creator',
        attributes: ['user_name'],
        required: false,
        foreignKey: 'create_by'
      },
      {
        model: User,
        as: 'updater', 
        attributes: ['user_name'],
        required: false,
        foreignKey: 'updated_by'
      }
    ],
    where: { deleted_at: null },
    order: [['group_id', 'ASC']]
  }) as any;

  const groups = res ? res.map(group => {
    const groupData = group.dataValues;
    return {
      ...groupData,
      create_by_name: group.creator?.user_name || '削除されたユーザー',
      updated_by_name: group.updater?.user_name || '削除されたユーザー'
    };
  }) : [];
  return groups;
};

export const buildGroupTree = (groups: any[]) => {
  const groupMap = new Map();
  const rootGroups = [];

  groups.forEach(group => {
    groupMap.set(group.group_id, {
      id: `group-${group.group_id}`,
      label: group.group_name,
      children: [],
      level: 0,
      group_id: group.group_id,
      parent_id: group.parent_id,
      attributes: group.attributes || '',
      color_code: group.color_code || '#409EFF',
      use_group_color: group.use_group_color || 0,
      create_by: group.create_by,
      create_by_name: group.create_by_name,
      created_at: group.created_at,
      updated_by: group.updated_by,
      updated_by_name: group.updated_by_name,
      updated_at: group.updated_at
    });
  });

  groups.forEach(group => {
    const groupNode = groupMap.get(group.group_id);  
    if (group.parent_id === null || group.parent_id === undefined) {
      groupNode.level = 1;
      rootGroups.push(groupNode);
    } else {
      const parentNode = groupMap.get(group.parent_id);
      if (parentNode) {
        groupNode.level = parentNode.level + 1;
        parentNode.children.push(groupNode);
      } else {
        groupNode.level = 1;
        rootGroups.push(groupNode);
      }
    }
  });
  return formatHumpLineTransfer(rootGroups);
};

export const createGroupSer = async (groupData) => {
  const now = new Date();
  const dataWithTimestamps = {
    ...groupData,
    created_at: now,
    updated_at: now
  };
  const res = await Group.create(dataWithTimestamps) as any;
  return res ? formatHumpLineTransfer(res.dataValues) : null;
};

export const updateGroupSer = async (groupId, updateData) => {
  const dataWithTimestamps = {
    ...updateData,
    updated_at: new Date()
  };
  const res = await Group.update(dataWithTimestamps, {
    where: { group_id: groupId, deleted_at: null }
  });
  return res[0] > 0;
};

export const deleteGroupSer = async (groupId, deletedBy) => {
  const res = await Group.update(
    { deleted_at: new Date(), deleted_by: deletedBy },
    { where: { group_id: groupId } }
  );
  return res[0] > 0;
};

export const getGroupByIdSer = async (groupId) => {
  const res = await Group.findOne({
    attributes: [
      'group_id', 'group_name', 'parent_id', 'attributes', 
      'color_code', 'use_group_color', 'create_by', 'created_at', 
      'updated_by', 'updated_at'
    ],
    include: [
      {
        model: User,
        as: 'creator',
        attributes: ['user_name'],
        required: false,
        foreignKey: 'create_by'
      },
      {
        model: User,
        as: 'updater', 
        attributes: ['user_name'],
        required: false,
        foreignKey: 'updated_by'
      }
    ],
    where: { group_id: groupId, deleted_at: null }
  }) as any;
  
  if (!res) return null;
  
  const groupData = res.dataValues;
  return formatHumpLineTransfer({
    ...groupData,
    create_by_name: res.creator?.user_name || '削除されたユーザー',
    updated_by_name: res.updater?.user_name || '削除されたユーザー'
  });
};

export const createUserGroupRelations = async (userId: number, groupIds: string[]) => {
  const numericGroupIds = groupIds
    .filter(id => id.startsWith('group-'))
    .map(id => parseInt(id.replace('group-', '')));

  const relations = numericGroupIds.map(groupId => ({
    user_id: userId,
    group_id: groupId
  }));

  if (relations.length > 0) {
    await UserGroup.bulkCreate(relations);
  }
};

export const updateUserGroupRelations = async (userId: number, groupIds: string[]) => {
  const currentGroupIds = await getUserGroupsSer(userId);
  
  const newNumericGroupIds = groupIds
    .filter(id => id.startsWith('group-'))
    .map(id => parseInt(id.replace('group-', '')));
  
  const currentNumericGroupIds = currentGroupIds
    .filter(id => id.startsWith('group-'))
    .map(id => parseInt(id.replace('group-', '')));
  
  const groupsToRemove = currentNumericGroupIds.filter(
    groupId => !newNumericGroupIds.includes(groupId)
  );
  
  const groupsToAdd = newNumericGroupIds.filter(
    groupId => !currentNumericGroupIds.includes(groupId)
  );
  
  if (groupsToRemove.length > 0) {
    await UserGroup.update(
      { deleted_at: new Date() },
      { 
        where: { 
          user_id: userId, 
          group_id: groupsToRemove,
          deleted_at: null 
        } 
      }
    );
  }
  
  if (groupsToAdd.length > 0) {
    const existingDeletedRelations = await UserGroup.findAll({
      where: {
        user_id: userId,
        group_id: groupsToAdd,
        deleted_at: { [require('sequelize').Op.not]: null }
      },
      attributes: ['group_id']
    }) as any;
    
    const existingDeletedGroupIds = existingDeletedRelations.map(rel => rel.dataValues.group_id);
    
    if (existingDeletedGroupIds.length > 0) {
      await UserGroup.update(
        { deleted_at: null },
        {
          where: {
            user_id: userId,
            group_id: existingDeletedGroupIds
          }
        }
      );
    }
    
    const newGroupIds = groupsToAdd.filter(groupId => !existingDeletedGroupIds.includes(groupId));
    if (newGroupIds.length > 0) {
      const relations = newGroupIds.map(groupId => ({
        user_id: userId,
        group_id: groupId
      }));
      
      await UserGroup.bulkCreate(relations);
    }
  }
};

export const getUserGroupsSer = async (userId: number) => {
  const res = await UserGroup.findAll({
    where: { user_id: userId, deleted_at: null },
    attributes: ['group_id']
  }) as any;

  if (!res) return [];
  
  return res.map(relation => `group-${relation.dataValues.group_id}`);
};
