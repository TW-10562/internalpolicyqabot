CREATE TABLE IF NOT EXISTS chat_history_conversations (
  id BIGSERIAL PRIMARY KEY,
  conversation_id VARCHAR(21) NOT NULL UNIQUE,
  user_id BIGINT NOT NULL,
  user_name VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT 'New Chat',
  last_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_history_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id VARCHAR(21) NOT NULL,
  user_id BIGINT NOT NULL,
  user_name VARCHAR(100) NOT NULL,
  message_id VARCHAR(64) NOT NULL UNIQUE,
  role VARCHAR(16) NOT NULL,
  original_text TEXT NOT NULL,
  detected_language VARCHAR(8) NOT NULL,
  translated_text TEXT,
  model_answer_text TEXT,
  rag_used BOOLEAN NOT NULL DEFAULT FALSE,
  source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_input INT,
  token_output INT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_history_conv_user_updated
  ON chat_history_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_history_msg_conv_created
  ON chat_history_messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_history_msg_user_created
  ON chat_history_messages(user_id, created_at DESC);

