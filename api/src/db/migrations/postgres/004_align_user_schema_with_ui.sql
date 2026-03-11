-- Align legacy-compatible "user" table with UI user-management fields.
-- This is idempotent and safe for existing databases.

ALTER TABLE IF EXISTS "user"
  ADD COLUMN IF NOT EXISTS emp_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(100) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(100) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS job_role_key VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS area_of_work_key VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status CHAR(1) NOT NULL DEFAULT '1',
  ADD COLUMN IF NOT EXISTS sso_bound SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS department VARCHAR(100) NOT NULL DEFAULT 'Unknown',
  ADD COLUMN IF NOT EXISTS create_by BIGINT,
  ADD COLUMN IF NOT EXISTS deleted_by BIGINT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_user_emp_id ON "user"(emp_id);
CREATE INDEX IF NOT EXISTS idx_user_deleted_at ON "user"(deleted_at);
CREATE INDEX IF NOT EXISTS idx_user_job_role_key ON "user"(job_role_key);
CREATE INDEX IF NOT EXISTS idx_user_area_of_work_key ON "user"(area_of_work_key);

