import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const Tag = seq.define(
  'file_tag',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
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
    tableName: 'file_tag',
    freezeTableName: true,
  },
);

export default Tag;
