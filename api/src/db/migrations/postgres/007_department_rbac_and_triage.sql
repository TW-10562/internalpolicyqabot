CREATE TABLE IF NOT EXISTS departments (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(16) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL
);

INSERT INTO departments (code, name)
VALUES
  ('HR', 'Human Resources'),
  ('GA', 'General Affairs'),
  ('ACC', 'Accounting')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE IF EXISTS sys_user
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16),
  ADD COLUMN IF NOT EXISTS role_code VARCHAR(16);

ALTER TABLE IF EXISTS "user"
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16),
  ADD COLUMN IF NOT EXISTS role_code VARCHAR(16);

UPDATE sys_user
SET department_code = COALESCE(NULLIF(department_code, ''), 'HR')
WHERE department_code IS NULL OR department_code = '';

UPDATE "user"
SET department_code = COALESCE(NULLIF(department_code, ''), 'HR')
WHERE department_code IS NULL OR department_code = '';

UPDATE sys_user
SET role_code = CASE
  WHEN LOWER(COALESCE(user_name, '')) = 'admin' THEN 'SUPER_ADMIN'
  ELSE COALESCE(NULLIF(role_code, ''), 'USER')
END
WHERE role_code IS NULL OR role_code = '';

UPDATE "user"
SET role_code = COALESCE(NULLIF(role_code, ''), 'USER')
WHERE role_code IS NULL OR role_code = '';

ALTER TABLE IF EXISTS sys_user
  ALTER COLUMN department_code SET DEFAULT 'HR',
  ALTER COLUMN role_code SET DEFAULT 'USER';

ALTER TABLE IF EXISTS "user"
  ALTER COLUMN department_code SET DEFAULT 'HR',
  ALTER COLUMN role_code SET DEFAULT 'USER';

ALTER TABLE IF EXISTS sys_user
  ADD CONSTRAINT fk_sys_user_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);

ALTER TABLE IF EXISTS "user"
  ADD CONSTRAINT fk_user_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);

CREATE INDEX IF NOT EXISTS idx_sys_user_department_role
  ON sys_user(department_code, role_code);
CREATE INDEX IF NOT EXISTS idx_user_department_role
  ON "user"(department_code, role_code);

ALTER TABLE IF EXISTS file
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS file
  ADD CONSTRAINT fk_file_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_file_department_code ON file(department_code);

ALTER TABLE IF EXISTS krd_gen_task
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS krd_gen_task
  ADD CONSTRAINT fk_krd_gen_task_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_krd_gen_task_department_code ON krd_gen_task(department_code);

ALTER TABLE IF EXISTS krd_gen_task_output
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS krd_gen_task_output
  ADD CONSTRAINT fk_krd_gen_task_output_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_krd_gen_task_output_department_code ON krd_gen_task_output(department_code);

ALTER TABLE IF EXISTS messages
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR',
  ADD COLUMN IF NOT EXISTS sender_user_id BIGINT;
ALTER TABLE IF EXISTS messages
  ADD CONSTRAINT fk_messages_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_messages_department_code_created
  ON messages(department_code, created_at DESC);

ALTER TABLE IF EXISTS support_tickets
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS support_tickets
  ADD CONSTRAINT fk_support_tickets_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_support_tickets_department_code_created
  ON support_tickets(department_code, created_at DESC);

ALTER TABLE IF EXISTS notifications
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS notifications
  ADD CONSTRAINT fk_notifications_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_notifications_department_user_created
  ON notifications(department_code, user_id, created_at DESC);

ALTER TABLE IF EXISTS app_notifications
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS app_notifications
  ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE IF EXISTS app_notifications
  ADD CONSTRAINT fk_app_notifications_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_app_notifications_department_user_created
  ON app_notifications(department_code, user_id, created_at DESC);

ALTER TABLE IF EXISTS chat_history_conversations
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS chat_history_conversations
  ADD CONSTRAINT fk_chat_history_conversations_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_chat_history_conversations_department_user_updated
  ON chat_history_conversations(department_code, user_id, updated_at DESC);

ALTER TABLE IF EXISTS chat_history_messages
  ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
ALTER TABLE IF EXISTS chat_history_messages
  ADD CONSTRAINT fk_chat_history_messages_department_code
  FOREIGN KEY (department_code) REFERENCES departments(code);
CREATE INDEX IF NOT EXISTS idx_chat_history_messages_department_conversation_created
  ON chat_history_messages(department_code, conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS triage_tickets (
  id BIGSERIAL PRIMARY KEY,
  department_code VARCHAR(16) NOT NULL REFERENCES departments(code),
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  created_by BIGINT NOT NULL,
  assigned_to BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS triage_payload (
  ticket_id BIGINT PRIMARY KEY REFERENCES triage_tickets(id) ON DELETE CASCADE,
  conversation_id VARCHAR(64),
  message_id VARCHAR(64),
  user_query_original TEXT NOT NULL,
  assistant_answer TEXT NOT NULL,
  issue_type VARCHAR(64) NOT NULL,
  user_comment TEXT NOT NULL,
  expected_answer TEXT,
  retrieved_source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieval_query_used TEXT,
  model_name VARCHAR(128),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triage_tickets_department_status
  ON triage_tickets(department_code, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT NOT NULL,
  actor_role_code VARCHAR(16),
  actor_department_code VARCHAR(16),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(64),
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
  ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs(action, created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'document_metadata'
  ) THEN
    ALTER TABLE document_metadata
      ADD COLUMN IF NOT EXISTS department_code VARCHAR(16) NOT NULL DEFAULT 'HR';
    CREATE INDEX IF NOT EXISTS idx_document_metadata_department_code
      ON document_metadata(department_code);
  END IF;
END$$;
