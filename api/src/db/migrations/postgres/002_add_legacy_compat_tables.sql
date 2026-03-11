CREATE TABLE IF NOT EXISTS "user" (
  user_id BIGINT PRIMARY KEY,
  user_name VARCHAR(100) NOT NULL UNIQUE,
  emp_id VARCHAR(64),
  first_name VARCHAR(100) NOT NULL DEFAULT '',
  last_name VARCHAR(100) NOT NULL DEFAULT '',
  job_role_key VARCHAR(64) NOT NULL DEFAULT '',
  area_of_work_key VARCHAR(64) NOT NULL DEFAULT '',
  password VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phonenumber VARCHAR(20),
  status CHAR(1) NOT NULL DEFAULT '1',
  sso_bound SMALLINT NOT NULL DEFAULT 0,
  department VARCHAR(100) NOT NULL DEFAULT 'Unknown',
  last_login_at TIMESTAMPTZ,
  create_by BIGINT,
  deleted_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "group" (
  group_id BIGSERIAL PRIMARY KEY,
  group_name VARCHAR(255) NOT NULL,
  parent_id BIGINT,
  color_code CHAR(7),
  attributes VARCHAR(255),
  use_group_color SMALLINT NOT NULL DEFAULT 0,
  create_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by BIGINT,
  deleted_at TIMESTAMPTZ,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_group (
  user_id BIGINT NOT NULL,
  group_id BIGINT NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS flow_definitions (
  id VARCHAR(21) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  json_schema TEXT,
  create_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  update_by VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_emp_id ON "user"(emp_id);
CREATE INDEX IF NOT EXISTS idx_group_parent_id ON "group"(parent_id);

INSERT INTO "user" (
  user_id,
  user_name,
  emp_id,
  first_name,
  last_name,
  password,
  email,
  phonenumber,
  status,
  sso_bound,
  department,
  create_by,
  created_at,
  updated_at
)
SELECT
  su.user_id,
  su.user_name,
  COALESCE(su.user_name, su.user_id::text),
  su.user_name,
  '',
  su.password,
  su.email,
  su.phonenumber,
  CASE WHEN COALESCE(su.status, '1') = '0' THEN '1' ELSE COALESCE(su.status, '1') END,
  COALESCE(su.sso_bound, 0),
  COALESCE(su.department, 'Unknown'),
  su.create_by,
  COALESCE(su.created_at, NOW()),
  COALESCE(su.updated_at, NOW())
FROM sys_user su
ON CONFLICT (user_id) DO NOTHING;

