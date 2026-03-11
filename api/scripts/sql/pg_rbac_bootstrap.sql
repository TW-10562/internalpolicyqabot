-- Non-destructive RBAC bootstrap for PostgreSQL (DGX)
-- Creates tables only if they do not exist.

CREATE TABLE IF NOT EXISTS sys_user (
  user_id BIGINT PRIMARY KEY,
  user_name VARCHAR(100) NOT NULL,
  password VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phonenumber VARCHAR(20),
  status CHAR(1) DEFAULT '0',
  sso_bound SMALLINT DEFAULT 0,
  last_login_at TIMESTAMP,
  create_by BIGINT,
  deleted_by BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  department VARCHAR(100) DEFAULT 'Unknown'
);

CREATE UNIQUE INDEX IF NOT EXISTS sys_user_user_name_uniq ON sys_user(user_name);

CREATE TABLE IF NOT EXISTS sys_role (
  role_id BIGSERIAL PRIMARY KEY,
  role_name VARCHAR(255),
  role_key VARCHAR(255) UNIQUE,
  role_sort BIGINT,
  status CHAR(1) DEFAULT '0',
  del_flag CHAR(1) DEFAULT '0',
  create_by VARCHAR(64),
  update_by VARCHAR(64),
  remark VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sys_menu (
  menu_id BIGSERIAL PRIMARY KEY,
  menu_name VARCHAR(255) NOT NULL,
  parent_id BIGINT DEFAULT 0,
  order_num INT DEFAULT 0,
  path VARCHAR(255) DEFAULT '',
  component VARCHAR(255),
  query VARCHAR(255),
  is_frame CHAR(1) DEFAULT '1',
  is_cache CHAR(1) DEFAULT '0',
  menu_type CHAR(1) DEFAULT '',
  visible CHAR(1) DEFAULT '0',
  status CHAR(1) DEFAULT '0',
  perms VARCHAR(100),
  icon VARCHAR(100) DEFAULT '',
  create_by VARCHAR(64) DEFAULT '',
  update_by VARCHAR(64) DEFAULT '',
  remark VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS sys_menu_perms_uniq ON sys_menu(perms);

CREATE TABLE IF NOT EXISTS sys_user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT sys_user_role_user_fk FOREIGN KEY (user_id) REFERENCES sys_user(user_id) ON DELETE CASCADE,
  CONSTRAINT sys_user_role_role_fk FOREIGN KEY (role_id) REFERENCES sys_role(role_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sys_role_menu (
  role_id BIGINT NOT NULL,
  menu_id BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, menu_id),
  CONSTRAINT sys_role_menu_role_fk FOREIGN KEY (role_id) REFERENCES sys_role(role_id) ON DELETE CASCADE,
  CONSTRAINT sys_role_menu_menu_fk FOREIGN KEY (menu_id) REFERENCES sys_menu(menu_id) ON DELETE CASCADE
);
