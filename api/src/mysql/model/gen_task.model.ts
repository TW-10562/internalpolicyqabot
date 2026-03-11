import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const KrdGenTask = seq.define(
  'krd_gen_task',
  {
    id: {
      type: DataTypes.CHAR(21),
      allowNull: false,
      unique: true,
      primaryKey: true,
      comment: '',
    },
    type: {
      type: DataTypes.CHAR(32),
      allowNull: false,
      comment: '',
    },
    form_data: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '',
    },
    status: {
      type: DataTypes.CHAR(1),
      defaultValue: '0',
      comment: '',
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
    tableName: 'krd_gen_task',
    freezeTableName: true,
    comment: '',
  },
);

export default KrdGenTask;
