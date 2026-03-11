INSERT INTO departments (code, name)
VALUES ('SYSTEMS', 'Systems')
ON CONFLICT (code) DO NOTHING;
