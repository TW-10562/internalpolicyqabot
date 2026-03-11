import { DataTypes, Model, Optional, Sequelize } from 'sequelize';

interface SupportTicketAttributes {
  id: number;
  user_id: number;
  user_name: string;
  department_code: string;
  subject: string;
  message: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  admin_reply?: string;
  admin_id?: number;
  admin_name?: string;
  replied_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

interface SupportTicketCreationAttributes extends Optional<SupportTicketAttributes, 'id' | 'admin_reply' | 'admin_id' | 'admin_name' | 'replied_at' | 'created_at' | 'updated_at'> {}

class SupportTicket extends Model<SupportTicketAttributes, SupportTicketCreationAttributes> implements SupportTicketAttributes {
  public id!: number;
  public user_id!: number;
  public user_name!: string;
  public department_code!: string;
  public subject!: string;
  public message!: string;
  public status!: 'open' | 'in_progress' | 'resolved' | 'closed';
  public admin_reply?: string;
  public admin_id?: number;
  public admin_name?: string;
  public replied_at?: Date;
  public created_at?: Date;
  public updated_at?: Date;
}

export const initSupportTicket = (sequelize: Sequelize) => {
  SupportTicket.init(
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
      user_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      department_code: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'HR',
      },
      subject: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('open', 'in_progress', 'resolved', 'closed'),
        defaultValue: 'open',
        allowNull: false,
      },
      admin_reply: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      admin_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      admin_name: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      replied_at: {
        type: DataTypes.DATE,
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
      tableName: 'support_tickets',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return SupportTicket;
};

export default SupportTicket;
