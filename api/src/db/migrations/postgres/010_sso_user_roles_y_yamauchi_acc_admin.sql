INSERT INTO sso_user_roles (email, role_code)
VALUES
  (LOWER('y_yamauchi@twave.co.jp'), 'ACC_ADMIN')
ON CONFLICT(email) DO NOTHING;
