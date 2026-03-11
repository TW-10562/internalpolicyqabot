CREATE TABLE IF NOT EXISTS sys_user (
  user_id BIGINT PRIMARY KEY,
  user_name VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phonenumber VARCHAR(20),
  status CHAR(1) NOT NULL DEFAULT '0',
  del_flag CHAR(1) NOT NULL DEFAULT '0',
  sso_bound SMALLINT NOT NULL DEFAULT 0,
  department VARCHAR(100) NOT NULL DEFAULT 'Unknown',
  create_by BIGINT,
  deleted_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  create_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  update_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sys_role (
  role_id BIGSERIAL PRIMARY KEY,
  role_name VARCHAR(255),
  role_key VARCHAR(255) UNIQUE,
  role_sort BIGINT,
  status CHAR(1) NOT NULL DEFAULT '0',
  del_flag CHAR(1) NOT NULL DEFAULT '0',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  remark VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sys_menu (
  menu_id BIGSERIAL PRIMARY KEY,
  menu_name VARCHAR(255) NOT NULL,
  parent_id BIGINT NOT NULL DEFAULT 0,
  order_num BIGINT NOT NULL DEFAULT 0,
  path VARCHAR(255) NOT NULL DEFAULT '',
  component VARCHAR(255),
  query VARCHAR(255),
  is_frame CHAR(1) NOT NULL DEFAULT '1',
  is_cache CHAR(1) NOT NULL DEFAULT '0',
  menu_type CHAR(1) NOT NULL DEFAULT 'C',
  visible CHAR(1) NOT NULL DEFAULT '0',
  status CHAR(1) NOT NULL DEFAULT '0',
  perms VARCHAR(100),
  icon VARCHAR(100) NOT NULL DEFAULT '',
  create_by VARCHAR(64) NOT NULL DEFAULT '',
  update_by VARCHAR(64) NOT NULL DEFAULT '',
  remark VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sys_user_role (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  role_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sys_role_menu (
  id BIGSERIAL PRIMARY KEY,
  role_id BIGINT,
  menu_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS role (
  role_id BIGSERIAL PRIMARY KEY,
  role_name VARCHAR(255),
  role_key VARCHAR(255),
  role_sort BIGINT,
  status CHAR(1) NOT NULL DEFAULT '0',
  del_flag CHAR(1) NOT NULL DEFAULT '0',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  remark VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_role (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  role_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_menu (
  id BIGSERIAL PRIMARY KEY,
  role_id BIGINT,
  menu_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS file_tag (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS file (
  id BIGSERIAL PRIMARY KEY,
  tag BIGINT REFERENCES file_tag(id) ON DELETE SET NULL,
  filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(255) NOT NULL UNIQUE,
  mime_type VARCHAR(255) NOT NULL,
  size BIGINT NOT NULL,
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS file_role (
  id BIGSERIAL PRIMARY KEY,
  file_id BIGINT,
  role_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (file_id, role_id)
);

CREATE TABLE IF NOT EXISTS krd_gen_task (
  id VARCHAR(21) PRIMARY KEY,
  type VARCHAR(32) NOT NULL DEFAULT 'WAIT',
  form_data TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'WAIT',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS krd_gen_task_output (
  id BIGSERIAL PRIMARY KEY,
  task_id VARCHAR(21) NOT NULL,
  metadata TEXT NOT NULL,
  sort BIGINT,
  content TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'WAIT',
  feedback VARCHAR(32),
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  sender_id VARCHAR(64) NOT NULL,
  sender_type VARCHAR(16) NOT NULL,
  recipient_id VARCHAR(64) NOT NULL,
  recipient_type VARCHAR(16) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  parent_id BIGINT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  is_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  user_name VARCHAR(100) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  admin_reply TEXT,
  admin_id BIGINT,
  admin_name VARCHAR(100),
  replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'general',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  link VARCHAR(500),
  related_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sso_user_bind (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  sso_provider VARCHAR(255) NOT NULL,
  sso_oid VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sso_provider, sso_oid)
);

INSERT INTO sys_role (role_id, role_name, role_key, role_sort, status, del_flag, create_by)
VALUES
  (1, 'admin', 'admin', 0, '0', '0', 'system'),
  (2, 'user', 'user', 1, '0', '0', 'system')
ON CONFLICT (role_id) DO NOTHING;

INSERT INTO role (role_id, role_name, role_key, role_sort, status, del_flag, create_by)
VALUES
  (1, 'admin', 'admin', 0, '0', '0', 'system'),
  (2, 'user', 'user', 1, '0', '0', 'system')
ON CONFLICT (role_id) DO NOTHING;

INSERT INTO sys_user (user_id, user_name, password, email, phonenumber, status)
VALUES
  (1, 'admin', '$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6', 'admin@admin.co.jp', '117', '1')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO sys_user_role (user_id, role_id)
VALUES (1, 1)
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO user_role (user_id, role_id)
VALUES (1, 1)
ON CONFLICT (user_id, role_id) DO NOTHING;
