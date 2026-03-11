import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const UserRole = seq.define(
  'user_role',
  {
    user_id: {
      type: DataTypes.BIGINT,
      comment: '',
    },
    role_id: {
      type: DataTypes.BIGINT,
      comment: '',
    },
  },
  {
    tableName: 'user_role',
    freezeTableName: true,
    comment: '',
  },
);

export default UserRole;
