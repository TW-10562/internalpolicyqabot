import { QueryInterface, Sequelize } from 'sequelize';

async function ensureUserColumns(queryInterface: QueryInterface) {
  const table = await queryInterface.describeTable('user');

  if (!table.emp_id) {
    await queryInterface.addColumn('user', 'emp_id', {
      type: 'VARCHAR(64)',
      allowNull: true,
      comment: '社員ID',
    } as any);
  }
  if (!table.first_name) {
    await queryInterface.addColumn('user', 'first_name', {
      type: 'VARCHAR(100)',
      allowNull: false,
      defaultValue: '',
      comment: '名',
    } as any);
  }
  if (!table.last_name) {
    await queryInterface.addColumn('user', 'last_name', {
      type: 'VARCHAR(100)',
      allowNull: false,
      defaultValue: '',
      comment: '姓',
    } as any);
  }
  if (!table.job_role_key) {
    await queryInterface.addColumn('user', 'job_role_key', {
      type: 'VARCHAR(64)',
      allowNull: false,
      defaultValue: '',
      comment: '職種キー',
    } as any);
  }
  if (!table.area_of_work_key) {
    await queryInterface.addColumn('user', 'area_of_work_key', {
      type: 'VARCHAR(64)',
      allowNull: false,
      defaultValue: '',
      comment: '業務エリアキー',
    } as any);
  }

  await queryInterface.sequelize.query(
    `UPDATE user SET emp_id = CONCAT('EMP', LPAD(user_id, 6, '0')) WHERE emp_id IS NULL OR emp_id = ''`,
  );

  const indexes = (await queryInterface.showIndex('user')) as any[];
  const hasEmpIdUnique = indexes.some((idx: any) => {
    const fields = Array.isArray(idx.fields) ? idx.fields.map((f: any) => f.attribute) : [];
    return idx.unique && fields.length === 1 && fields[0] === 'emp_id';
  });

  if (!hasEmpIdUnique) {
    await queryInterface.addIndex('user', ['emp_id'], {
      unique: true,
      name: 'uk_user_emp_id',
    });
  }

  await queryInterface.changeColumn('user', 'emp_id', {
    type: 'VARCHAR(64)',
    allowNull: false,
    comment: '社員ID',
  } as any);
}

async function ensureRoles(sequelize: Sequelize) {
  await sequelize.query(
    `
    INSERT INTO role (role_name, role_key, role_sort, status, del_flag, create_by, created_at, updated_at)
    SELECT 'admin', 'admin', 0, '0', '0', 'system', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM role WHERE role_key = 'admin' AND del_flag = '0'
    )
    `,
  );

  await sequelize.query(
    `
    INSERT INTO role (role_name, role_key, role_sort, status, del_flag, create_by, created_at, updated_at)
    SELECT 'user', 'user', 1, '0', '0', 'system', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM role WHERE role_key = 'user' AND del_flag = '0'
    )
    `,
  );
}

export async function runMysqlMigrations(sequelize: Sequelize) {
  const queryInterface = sequelize.getQueryInterface();
  await ensureUserColumns(queryInterface);
  await ensureRoles(sequelize);
}
