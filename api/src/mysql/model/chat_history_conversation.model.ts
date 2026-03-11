import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

const ChatHistoryConversation = seq.define(
  'chat_history_conversation',
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
      unique: true,
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
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: 'New Chat',
    },
    last_message: {
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
    tableName: 'chat_history_conversations',
    freezeTableName: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

export default ChatHistoryConversation;
