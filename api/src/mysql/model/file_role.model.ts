import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const FileRole = seq.define(
  'file_role',
  {
    file_id: {
      type: DataTypes.BIGINT,
      comment: '',
    },
    role_id: {
      type: DataTypes.BIGINT,
      comment: '',
    },
  },
  {
    tableName: 'file_role',
    freezeTableName: true,
    comment: '',
  },
);

export default FileRole;
