-- Add restored_at and restored_by columns to track user restoration from deleted state
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS restored_by BIGINT DEFAULT NULL;
