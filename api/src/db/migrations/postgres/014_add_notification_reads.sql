-- Per-user read tracking for app_notifications.
-- Direct (single-recipient) notifications also update the shared is_read flag on the app_notifications row.
-- Broadcast notifications (user_id=null) use this table so each user has independent read state.

CREATE TABLE IF NOT EXISTS notification_reads (
  user_id         BIGINT       NOT NULL,
  notification_id BIGINT       NOT NULL,
  read_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_notification_id
  ON notification_reads (notification_id);
