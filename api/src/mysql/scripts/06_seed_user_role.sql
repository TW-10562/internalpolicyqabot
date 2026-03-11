-- Ensure required role keys exist for RBAC mapping
INSERT INTO `role` (`role_name`, `role_key`, `role_sort`, `status`, `del_flag`, `create_by`, `created_at`, `updated_at`)
SELECT 'admin', 'admin', 0, '0', '0', 'system', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM `role` WHERE `role_key` = 'admin' AND `del_flag` = '0'
);

INSERT INTO `role` (`role_name`, `role_key`, `role_sort`, `status`, `del_flag`, `create_by`, `created_at`, `updated_at`)
SELECT 'user', 'user', 1, '0', '0', 'system', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM `role` WHERE `role_key` = 'user' AND `del_flag` = '0'
);
