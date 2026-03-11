import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const File = seq.define(
  'file',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tag: {
      type: DataTypes.INTEGER,
      defaultValue: null,
    },
    filename: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    storage_key: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    mime_type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    create_by: {
      type: DataTypes.CHAR(64),
      defaultValue: null,
      comment: '',
    },
    department_code: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'HR',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: null,
      comment: '',
    },
    update_by: {
      type: DataTypes.CHAR(64),
      defaultValue: null,
      comment: '',
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: null,
      comment: '',
    },
  },
  {
    tableName: 'file',
    freezeTableName: true,
  },
);

export default File;
