CREATE TABLE IF NOT EXISTS aviary_gen_task (
  id VARCHAR(21) PRIMARY KEY,
  type VARCHAR(32) NOT NULL DEFAULT 'WAIT',
  form_data TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'WAIT',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aviary_gen_task_output (
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

CREATE TABLE IF NOT EXISTS sys_config (
  config_id BIGSERIAL PRIMARY KEY,
  config_name VARCHAR(255),
  config_key VARCHAR(255),
  config_value VARCHAR(255),
  config_type VARCHAR(255) NOT NULL DEFAULT 'N',
  create_by VARCHAR(255),
  created_at TIMESTAMPTZ,
  update_by VARCHAR(255),
  updated_at TIMESTAMPTZ,
  remark VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS sys_dept (
  dept_id BIGSERIAL PRIMARY KEY,
  parent_id BIGINT NOT NULL DEFAULT 0,
  ancestors VARCHAR(50) DEFAULT '',
  dept_name VARCHAR(255),
  order_num BIGINT NOT NULL DEFAULT 0,
  leader VARCHAR(255),
  phone VARCHAR(255),
  email VARCHAR(255),
  status CHAR(1) DEFAULT '0',
  del_flag CHAR(1) DEFAULT '0',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  school_id BIGINT,
  school_code VARCHAR(64),
  prefecture VARCHAR(64),
  address TEXT
);

CREATE TABLE IF NOT EXISTS sys_post (
  post_id BIGSERIAL PRIMARY KEY,
  post_code VARCHAR(255),
  post_name VARCHAR(255),
  post_sort BIGINT,
  status CHAR(1) DEFAULT '0',
  del_flag CHAR(1) DEFAULT '0',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  remark VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sys_role (
  role_id BIGSERIAL PRIMARY KEY,
  role_name VARCHAR(255),
  role_key VARCHAR(255) UNIQUE,
  role_sort BIGINT,
  data_scope CHAR(1) DEFAULT '1',
  menu_check_strictly BOOLEAN NOT NULL DEFAULT TRUE,
  dept_check_strictly BOOLEAN NOT NULL DEFAULT TRUE,
  status CHAR(1) DEFAULT '0',
  del_flag CHAR(1) DEFAULT '0',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  remark VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sys_menu (
  menu_id BIGSERIAL PRIMARY KEY,
  menu_name VARCHAR(255) NOT NULL,
  parent_id BIGINT DEFAULT 0,
  order_num BIGINT DEFAULT 0,
  path VARCHAR(255) DEFAULT '',
  component VARCHAR(255),
  query VARCHAR(255),
  is_frame BIGINT DEFAULT 1,
  is_cache BIGINT DEFAULT 0,
  menu_type CHAR(1) DEFAULT 'C',
  visible CHAR(1) DEFAULT '0',
  status CHAR(1) DEFAULT '0',
  perms VARCHAR(100),
  icon VARCHAR(100) DEFAULT '',
  create_by VARCHAR(64) DEFAULT '',
  update_by VARCHAR(64) DEFAULT '',
  remark VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sys_user (
  user_id BIGSERIAL PRIMARY KEY,
  user_name VARCHAR(255) NOT NULL UNIQUE,
  nick_name VARCHAR(255),
  user_type CHAR(1) DEFAULT '0',
  email VARCHAR(255),
  phonenumber VARCHAR(20),
  sex CHAR(1) DEFAULT '0',
  avatar TEXT,
  password VARCHAR(255) NOT NULL,
  status CHAR(1) DEFAULT '0',
  del_flag BIGINT DEFAULT 0,
  login_ip VARCHAR(128),
  login_date TIMESTAMPTZ,
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  remark VARCHAR(255),
  first_login_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dept_id BIGINT
);

CREATE TABLE IF NOT EXISTS sys_role_menu (
  id BIGSERIAL PRIMARY KEY,
  role_id BIGINT,
  menu_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (role_id, menu_id)
);

CREATE TABLE IF NOT EXISTS sys_user_role (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  role_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sys_oper_log (
  oper_id BIGSERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  business_type VARCHAR(1) NOT NULL DEFAULT '0',
  method VARCHAR(255),
  request_method VARCHAR(255),
  operator_type VARCHAR(1) DEFAULT '0',
  oper_name VARCHAR(255),
  dept_name VARCHAR(255),
  oper_url VARCHAR(255),
  oper_ip VARCHAR(255),
  oper_location VARCHAR(255),
  oper_param VARCHAR(2000),
  json_result VARCHAR(2000),
  status VARCHAR(1) DEFAULT '0',
  error_msg VARCHAR(2000),
  oper_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sys_logininfor (
  info_id BIGSERIAL PRIMARY KEY,
  user_name VARCHAR(255),
  ipaddr VARCHAR(255),
  login_location VARCHAR(255),
  browser VARCHAR(255),
  os VARCHAR(255),
  status VARCHAR(1),
  msg VARCHAR(255),
  login_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

INSERT INTO sys_role (role_id, role_name, role_key, role_sort, status, del_flag, create_by)
VALUES
  (1, 'admin', 'admin', 0, '0', '0', 'system'),
  (2, 'user', 'user', 1, '0', '0', 'system')
ON CONFLICT (role_id) DO NOTHING;

INSERT INTO sys_user (user_id, user_name, password, status)
VALUES
  (1, 'admin', '$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6', '0')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO sys_user_role (user_id, role_id)
VALUES (1, 1)
ON CONFLICT (user_id, role_id) DO NOTHING;
