import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const Role = seq.define(
  'role',
  {
    role_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,
      autoIncrement: true,
      primaryKey: true,
      comment: '',
    },
    role_name: {
      type: DataTypes.CHAR(255),
      defaultValue: null,
      comment: '',
    },
    role_key: {
      type: DataTypes.CHAR(255),
      defaultValue: null,
      comment: '',
    },
    role_sort: {
      type: DataTypes.BIGINT,
      defaultValue: null,
      comment: '',
    },
    status: {
      type: DataTypes.CHAR(1),
      defaultValue: '0',
      comment: '',
    },
    del_flag: {
      type: DataTypes.CHAR(1),
      defaultValue: '0',
      comment: '',
    },
    create_by: {
      type: DataTypes.CHAR(64),
      defaultValue: null,
      comment: '',
    },
    update_by: {
      type: DataTypes.CHAR(64),
      defaultValue: null,
      comment: '',
    },
    remark: {
      type: DataTypes.CHAR(255),
      defaultValue: '',
      comment: '',
    },
  },
  {
    tableName: 'role',
    freezeTableName: true,
    comment: '',
  },
);

export default Role;
