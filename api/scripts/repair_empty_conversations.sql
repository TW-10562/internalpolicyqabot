-- Repair empty conversations by creating missing messages from krd_gen_task_output data.
--
-- Root cause: output IDs were reused after a DB reset, causing message_id collisions
-- in chat_history_messages (e.g., "49:user" already existed for a different conversation).
-- findOrCreate silently returned the old row, so no new messages were created.
--
-- This script creates new messages using conversation-scoped message_ids
-- (format: "${conversationId}:${outputId}:user") to avoid the collision.

BEGIN;

-- Step 1: Identify empty conversations
CREATE TEMP TABLE _empty_convos AS
SELECT c.conversation_id, c.user_id, c.user_name, c.department_code
FROM chat_history_conversations c
WHERE NOT EXISTS (
  SELECT 1 FROM chat_history_messages m WHERE m.conversation_id = c.conversation_id
);

-- Step 2: Insert user messages (question)
INSERT INTO chat_history_messages (
  conversation_id, user_id, user_name, department_code,
  message_id, role, original_text, detected_language,
  translated_text, model_answer_text, rag_used, source_ids,
  token_input, token_output, metadata_json, created_at, updated_at
)
SELECT
  ec.conversation_id,
  ec.user_id,
  ec.user_name,
  ec.department_code,
  -- Use conversation-scoped message_id to avoid collision with old data
  ec.conversation_id || ':' || CAST(o.id AS TEXT) || ':user',
  'user',
  COALESCE(
    (o.metadata::jsonb)->>'originalQuery',
    (o.metadata::jsonb)->>'prompt',
    '(question not recorded)'
  ),
  COALESCE((o.metadata::jsonb)->>'detectedLanguage', 'ja'),
  NULL,
  NULL,
  COALESCE(((o.metadata::jsonb)->>'ragTriggered')::boolean, false),
  NULL, NULL, NULL, NULL,
  o.created_at, o.created_at
FROM _empty_convos ec
JOIN krd_gen_task_output o ON o.task_id = ec.conversation_id
WHERE o.status = 'FINISHED'
ON CONFLICT (message_id) DO NOTHING;

-- Step 3: Insert assistant messages (answer)
-- Extract the answer content from the JSON-wrapped output
INSERT INTO chat_history_messages (
  conversation_id, user_id, user_name, department_code,
  message_id, role, original_text, detected_language,
  translated_text, model_answer_text, rag_used, source_ids,
  token_input, token_output, metadata_json, created_at, updated_at
)
SELECT
  ec.conversation_id,
  ec.user_id,
  ec.user_name,
  ec.department_code,
  ec.conversation_id || ':' || CAST(o.id AS TEXT) || ':assistant',
  'assistant',
  -- Extract "content" field from the JSON output, falling back to raw content
  COALESCE(
    SUBSTRING(o.content FROM '"content"\s*:\s*"((?:[^"\\]|\\.)*)\"'),
    LEFT(o.content, 1000)
  ),
  COALESCE((o.metadata::jsonb)->>'detectedLanguage', 'ja'),
  NULL,
  COALESCE(
    SUBSTRING(o.content FROM '"content"\s*:\s*"((?:[^"\\]|\\.)*)\"'),
    LEFT(o.content, 1000)
  ),
  COALESCE(((o.metadata::jsonb)->>'ragTriggered')::boolean, false),
  NULL, NULL, NULL, NULL,
  o.created_at, o.created_at
FROM _empty_convos ec
JOIN krd_gen_task_output o ON o.task_id = ec.conversation_id
WHERE o.status = 'FINISHED'
ON CONFLICT (message_id) DO NOTHING;

-- Step 4: Report results
SELECT
  (SELECT count(*) FROM _empty_convos) as empty_conversations_found,
  (SELECT count(*)
   FROM chat_history_messages m
   JOIN _empty_convos ec ON ec.conversation_id = m.conversation_id
  ) as messages_created;

DROP TABLE _empty_convos;

COMMIT;
