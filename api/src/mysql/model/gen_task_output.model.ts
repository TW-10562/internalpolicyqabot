import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const KrdGenTaskOutput = seq.define(
  'krd_gen_task_output',
  {
    id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,
      autoIncrement: true,
      primaryKey: true,
      comment: '',
    },
    task_id: {
      type: DataTypes.CHAR(21),
      allowNull: false,
      comment: '',
    },
    metadata: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '',
    },
    sort: {
      type: DataTypes.INTEGER,
      comment: '',
    },
    content: {
      type: DataTypes.TEXT,
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
    feedback: {
      type: DataTypes.TEXT,
      defaultValue: null,
      comment: '',
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
    tableName: 'krd_gen_task_output',
    freezeTableName: true,
    comment: '',
  },
);

export default KrdGenTaskOutput;
