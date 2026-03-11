import { DataTypes } from 'sequelize';
import seq from '@/mysql/db/seq.db';

// models/user.js
const User = seq.define(
  'user',
  {
    user_id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
      comment: 'ユーザid',
    },
    user_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'ユーザ名',
    },
    emp_id: {
      type: DataTypes.STRING(64),
      allowNull: true,
      comment: '社員ID',
    },
    first_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: '',
      comment: '名',
    },
    last_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: '',
      comment: '姓',
    },
    job_role_key: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: '',
      comment: '職種キー',
    },
    area_of_work_key: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: '',
      comment: '業務エリアキー',
    },
    password: {
      type: DataTypes.CHAR(60),
      allowNull: false,
      comment: 'パスワード',
    },
    email: {
      type: DataTypes.CHAR(255),
      allowNull: true,
      comment: 'ユーザのメールアドレス',
    },
    phonenumber: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: 'ユーザの電話番号',
    },
    status: {
      type: DataTypes.CHAR(1),
      allowNull: false,
      defaultValue: '0',
      comment: 'アカウント有効化フラグ(0=無効, 1=有効。アカウント作成時の承認前の状態に使用)',
    },
    sso_bound: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
      comment: 'SSO連携済みフラグ',
    },
    last_login_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: '最終ログイン日時',
    },
    department: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: 'Unknown',
      comment: '部署',
    },
    department_code: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'HR',
      comment: '部署コード',
    },
    role_code: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'USER',
      comment: 'ロールコード',
    },
    create_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: '当ユーザの作成者の id',
    },
    deleted_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: '当ユーザの削除者の id',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'ユーザ追加日時',
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'ユーザ削除日時',
    },
  },
  {
    tableName: 'user',
    timestamps: true,
    comment: '',
  }
);

export default User;
