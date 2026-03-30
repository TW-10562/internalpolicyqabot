-- Per-user read tracking for broadcast messages.
-- Mirrors the notification_reads pattern used by app_notifications.
-- Direct (single-recipient) messages continue to use the shared is_read flag on the messages row.
-- Broadcast messages (is_broadcast=true) use this table so each user has independent read state.

CREATE TABLE IF NOT EXISTS message_reads (
  user_id   BIGINT  NOT NULL,
  message_id INTEGER NOT NULL,
  read_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads (message_id);
