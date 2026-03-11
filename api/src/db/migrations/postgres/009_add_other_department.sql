INSERT INTO departments (code, name)
VALUES ('OTHER', 'Other')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name;
