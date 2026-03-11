/**
 * Message Model - For user-admin communication
 */
import { DataTypes, Model, Optional } from 'sequelize';
import seq from '@/mysql/db/seq.db';

interface MessageAttributes {
  id: number;
  sender_id: string;        // Username of sender
  sender_user_id: number | null;
  department_code: string;
  sender_type: 'user' | 'admin';
  recipient_id: string;     // Username of recipient (or 'all' for broadcast)
  recipient_type: 'user' | 'admin' | 'all';
  subject: string;
  content: string;
  parent_id: number | null; // For replies - links to original message
  is_read: boolean;
  is_broadcast: boolean;    // True if sent to all users
  created_at?: Date;
  updated_at?: Date;
}

interface MessageCreationAttributes extends Optional<MessageAttributes, 'id' | 'parent_id' | 'is_read' | 'is_broadcast' | 'created_at' | 'updated_at'> {}

class Message extends Model<MessageAttributes, MessageCreationAttributes> implements MessageAttributes {
  declare id: number;
  declare sender_id: string;
  declare sender_user_id: number | null;
  declare department_code: string;
  declare sender_type: 'user' | 'admin';
  declare recipient_id: string;
  declare recipient_type: 'user' | 'admin' | 'all';
  declare subject: string;
  declare content: string;
  declare parent_id: number | null;
  declare is_read: boolean;
  declare is_broadcast: boolean;
  declare created_at: Date;
  declare updated_at: Date;
}

Message.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    sender_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    sender_user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },
    department_code: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'HR',
    },
    sender_type: {
      type: DataTypes.ENUM('user', 'admin'),
      allowNull: false,
    },
    recipient_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    recipient_type: {
      type: DataTypes.ENUM('user', 'admin', 'all'),
      allowNull: false,
    },
    subject: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    parent_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    is_read: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    is_broadcast: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize: seq,
    tableName: 'messages',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['sender_id'] },
      { fields: ['recipient_id'] },
      { fields: ['parent_id'] },
      { fields: ['is_read'] },
      { fields: ['is_broadcast'] },
    ],
  }
);

export default Message;
