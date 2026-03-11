import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const UserGroup = seq.define(
  'user_group',
  {
    user_id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      allowNull: false,
      comment: 'ユーザid',
    },
    group_id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      allowNull: false,
      comment: 'グループid',
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: '削除日時',
    },
  },
  {
    tableName: 'user_group',
    timestamps: false,
    comment: '',
  }
);

export default UserGroup;
