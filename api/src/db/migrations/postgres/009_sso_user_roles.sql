CREATE TABLE IF NOT EXISTS sso_user_roles (
  email TEXT PRIMARY KEY,
  role_code VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sso_user_roles_role_code ON sso_user_roles(role_code);

INSERT INTO sso_user_roles (email, role_code)
VALUES
  (LOWER('m_priyankashri@twave.co.jp'), 'SUPER_ADMIN'),
  (LOWER('p_harikrishnan@twave.co.jp'), 'SUPER_ADMIN'),
  (LOWER('k_toda@twave.co.jp'), 'HR_ADMIN'),
  (LOWER('te_sasaki@twave.co.jp'), 'GA_ADMIN'),
  (LOWER('y_osaka@twave.co.jp'), 'SUPER_ADMIN')
ON CONFLICT(email) DO NOTHING;

