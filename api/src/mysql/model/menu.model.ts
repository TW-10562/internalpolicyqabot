import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const Menu = seq.define(
  'menu',
  {
    menu_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,
      autoIncrement: true,
      primaryKey: true,
      comment: '',
    },
    menu_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: '',
    },
    parent_id: {
      type: DataTypes.BIGINT,
      defaultValue: 0,
      comment: '',
    },
    order_num: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: '',
    },
    path: {
      type: DataTypes.CHAR(255),
      defaultValue: '',
      comment: '',
    },
    component: {
      type: DataTypes.CHAR(255),
      comment: '',
    },
    query: {
      type: DataTypes.CHAR(255),
      comment: '',
    },
    is_frame: {
      type: DataTypes.CHAR(1),
      defaultValue: '1',
      comment: '',
    },
    is_cache: {
      type: DataTypes.CHAR(1),
      defaultValue: '0',
      comment: '',
    },
    menu_type: {
      type: DataTypes.CHAR(1),
      defaultValue: '',
      comment: '',
    },
    visible: {
      type: DataTypes.CHAR(1),
      defaultValue: '0',
      comment: '',
    },
    status: {
      type: DataTypes.CHAR(1),
      defaultValue: '0',
      comment: '',
    },
    perms: {
      type: DataTypes.CHAR(100),
      defaultValue: null,
      comment: '',
    },
    icon: {
      type: DataTypes.CHAR(100),
      defaultValue: '',
      comment: '',
    },
    create_by: {
      type: DataTypes.CHAR(64),
      defaultValue: '',
      comment: '',
    },
    update_by: {
      type: DataTypes.CHAR(64),
      defaultValue: '',
      comment: '',
    },
    remark: {
      type: DataTypes.CHAR(255),
      comment: '',
    },
  },
  {
    tableName: 'sys_menu',
    freezeTableName: true,
    comment: '',
  },
);

export default Menu;
