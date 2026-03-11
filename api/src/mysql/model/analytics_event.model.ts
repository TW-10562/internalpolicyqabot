import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const AnalyticsEvent = seq.define(
  'analytics_event',
  {
    id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    event_type: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    task_id: {
      type: DataTypes.CHAR(21),
      allowNull: true,
      defaultValue: null,
    },
    task_output_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },
    user_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    department_code: {
      type: DataTypes.STRING(16),
      allowNull: true,
      defaultValue: null,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: true,
      defaultValue: null,
    },
    response_ms: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    rag_used: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    feedback_signal: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      defaultValue: null,
    },
    query_text: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    answer_text: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    metadata_json: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'analytics_event',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

export default AnalyticsEvent;
