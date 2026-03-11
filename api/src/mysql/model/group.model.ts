import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const Group = seq.define(
  'group',
  {
    group_id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
      comment: 'グループid',
    },
    group_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: 'グループ名',
    },
    parent_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: '親グループid',
    },
    color_code: {
      type: DataTypes.CHAR(7),
      allowNull: true,
      comment: 'GUIでのグループ表示時の色コード',
    },
    attributes: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'グループの属性情報',
    },
    use_group_color: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
      comment: 'グループカラーを使用するか（0:無効, 1:有効)',
    },
    create_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: '当グループの作成者の id',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'グループ追加日時',
    },
    deleted_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: '当グループの削除者の id',
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'グループ削除日時',
    },
    updated_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'グループ更新者の id',
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'グループ更新日時',
    },
  },
  {
    tableName: 'group',
    timestamps: false, // created_at, updated_at を手動管理するので false
    comment: 'グループ管理テーブル',
  }
);


import User from './user.model';

Group.belongsTo(User, {
  foreignKey: 'create_by',
  as: 'creator'
});

Group.belongsTo(User, {
  foreignKey: 'updated_by', 
  as: 'updater'
});

export default Group;
