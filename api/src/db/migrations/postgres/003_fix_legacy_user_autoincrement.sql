-- Ensure legacy compatibility table "user" has auto-increment behavior on user_id.
-- 002_add_legacy_compat_tables created user_id as BIGINT without default, which breaks inserts.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'user'
  ) THEN
    CREATE SEQUENCE IF NOT EXISTS user_user_id_seq;

    ALTER SEQUENCE user_user_id_seq
      OWNED BY "user".user_id;

    ALTER TABLE "user"
      ALTER COLUMN user_id SET DEFAULT nextval('user_user_id_seq');

    PERFORM setval(
      'user_user_id_seq',
      COALESCE((SELECT MAX(user_id) FROM "user"), 0) + 1,
      false
    );
  END IF;
END $$;

