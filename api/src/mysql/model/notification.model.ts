import { DataTypes, Model, Optional, Sequelize } from 'sequelize';

interface NotificationAttributes {
  id: number;
  user_id: number;
  department_code: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'admin_reply';
  is_read: boolean;
  link?: string;
  related_id?: number;
  created_at?: Date;
  updated_at?: Date;
}

interface NotificationCreationAttributes extends Optional<NotificationAttributes, 'id' | 'is_read' | 'link' | 'related_id' | 'created_at' | 'updated_at'> {}

class Notification extends Model<NotificationAttributes, NotificationCreationAttributes> implements NotificationAttributes {
  public id!: number;
  public user_id!: number;
  public department_code!: string;
  public title!: string;
  public message!: string;
  public type!: 'info' | 'success' | 'warning' | 'error' | 'admin_reply';
  public is_read!: boolean;
  public link?: string;
  public related_id?: number;
  public created_at?: Date;
  public updated_at?: Date;
}

export const initNotification = (sequelize: Sequelize) => {
  Notification.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      user_id: {
        type: DataTypes.INTEGER,
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
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      type: {
        type: DataTypes.ENUM('info', 'success', 'warning', 'error', 'admin_reply'),
        defaultValue: 'info',
        allowNull: false,
      },
      is_read: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      link: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      related_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
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
      sequelize,
      tableName: 'notifications',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return Notification;
};

export default Notification;
