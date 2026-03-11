import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const SsoUserBind = seq.define(
  'sso_user_bind',
  {
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: '',
    },
    sso_provider: {
      type: DataTypes.CHAR(255),
      allowNull: false,
      comment: '',
    },
    sso_oid: {
      type: DataTypes.CHAR(255),
      allowNull: false,
      comment: '',
    },
  },
  {
    tableName: 'sso_user_bind',
    freezeTableName: true,
    comment: '',
  },
);

export default SsoUserBind;
