import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const RoleMenu = seq.define(
  'role_menu',
  {
    role_id: {
      type: DataTypes.BIGINT,
      comment: '',
    },
    menu_id: {
      type: DataTypes.BIGINT,
      comment: '',
    },
  },
  {
    tableName: 'role_menu',
    freezeTableName: true,
    comment: '',
  },
);

export default RoleMenu;
