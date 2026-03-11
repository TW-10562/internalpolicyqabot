import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const ChatHistoryMessage = seq.define(
  'chat_history_message',
  {
    id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    conversation_id: {
      type: DataTypes.CHAR(21),
      allowNull: false,
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    user_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    department_code: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'HR',
    },
    message_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    role: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    original_text: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    detected_language: {
      type: DataTypes.STRING(8),
      allowNull: false,
    },
    translated_text: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    model_answer_text: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    rag_used: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    source_ids: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    token_input: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    token_output: {
      type: DataTypes.INTEGER,
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
    tableName: 'chat_history_messages',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

export default ChatHistoryMessage;
