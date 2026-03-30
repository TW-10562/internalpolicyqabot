-- Backfill messages for conversations that have 0 messages
-- These are orphaned conversation records where persistChatTurn failed silently

BEGIN;

-- Step 1: Identify empty conversations
CREATE TEMP TABLE empty_convos AS
SELECT c.conversation_id, c.user_id, c.user_name, c.department_code
FROM chat_history_conversations c
LEFT JOIN chat_history_messages m ON m.conversation_id = c.conversation_id
GROUP BY c.conversation_id, c.user_id, c.user_name, c.department_code
HAVING count(m.id) = 0;

-- Step 2: Insert user messages from gen_task_output metadata
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
  CAST(o.id AS TEXT) || ':user',
  'user',
  COALESCE(
    (o.metadata::jsonb)->>'originalQuery',
    (o.metadata::jsonb)->>'prompt',
    '(question not recorded)'
  ),
  COALESCE((o.metadata::jsonb)->>'detectedLanguage', 'en'),
  NULL,
  NULL,
  COALESCE(((o.metadata::jsonb)->>'ragTriggered')::boolean, false),
  NULL, NULL, NULL, NULL,
  o.created_at, o.created_at
FROM empty_convos ec
JOIN krd_gen_task_output o ON o.task_id = ec.conversation_id
WHERE o.status = 'FINISHED'
ON CONFLICT (message_id) DO NOTHING;

-- Step 3: Insert assistant messages from gen_task_output content
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
  CAST(o.id AS TEXT) || ':assistant',
  'assistant',
  COALESCE(
    (o.metadata::jsonb)->>'finalAnswer',
    SUBSTRING(o.content FROM '"content"\s*:\s*"([^"]+)"'),
    LEFT(o.content, 500)
  ),
  COALESCE((o.metadata::jsonb)->>'detectedLanguage', 'en'),
  NULL,
  COALESCE(
    (o.metadata::jsonb)->>'finalAnswer',
    SUBSTRING(o.content FROM '"content"\s*:\s*"([^"]+)"'),
    LEFT(o.content, 500)
  ),
  COALESCE(((o.metadata::jsonb)->>'ragTriggered')::boolean, false),
  NULL, NULL, NULL, NULL,
  o.created_at, o.created_at
FROM empty_convos ec
JOIN krd_gen_task_output o ON o.task_id = ec.conversation_id
WHERE o.status = 'FINISHED'
ON CONFLICT (message_id) DO NOTHING;

-- Step 4: Report
SELECT 'Backfilled' as status, count(*) as messages_created
FROM chat_history_messages m
JOIN empty_convos ec ON ec.conversation_id = m.conversation_id;

DROP TABLE empty_convos;

COMMIT;
