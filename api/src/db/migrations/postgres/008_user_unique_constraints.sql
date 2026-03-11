CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emp_id_unique
  ON "user"(emp_id)
  WHERE emp_id IS NOT NULL AND emp_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_user_name_unique
  ON "user"(LOWER(user_name))
  WHERE user_name IS NOT NULL AND user_name <> '';
