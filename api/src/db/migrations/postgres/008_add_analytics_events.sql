CREATE TABLE IF NOT EXISTS analytics_event (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL,
  task_id CHAR(21),
  task_output_id BIGINT,
  user_id BIGINT,
  user_name VARCHAR(100),
  department_code VARCHAR(16),
  status VARCHAR(32),
  response_ms INTEGER,
  rag_used BOOLEAN NOT NULL DEFAULT FALSE,
  feedback_signal SMALLINT,
  query_text TEXT,
  answer_text TEXT,
  metadata_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_event_type_time
  ON analytics_event (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_event_department_time
  ON analytics_event (department_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_event_user_time
  ON analytics_event (user_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_event_task_output
  ON analytics_event (task_output_id);
