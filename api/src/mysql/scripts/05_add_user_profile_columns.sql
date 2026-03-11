-- Safe extension for user profile/login columns used by admin user management
ALTER TABLE `user` ADD COLUMN IF NOT EXISTS `emp_id` VARCHAR(64) NULL COMMENT '社員ID' AFTER `user_name`;
ALTER TABLE `user` ADD COLUMN IF NOT EXISTS `first_name` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '名' AFTER `emp_id`;
ALTER TABLE `user` ADD COLUMN IF NOT EXISTS `last_name` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '姓' AFTER `first_name`;
ALTER TABLE `user` ADD COLUMN IF NOT EXISTS `job_role_key` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '職種キー' AFTER `last_name`;
ALTER TABLE `user` ADD COLUMN IF NOT EXISTS `area_of_work_key` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '業務エリアキー' AFTER `job_role_key`;

UPDATE `user`
SET `emp_id` = CONCAT('EMP', LPAD(`user_id`, 6, '0'))
WHERE `emp_id` IS NULL OR `emp_id` = '';

ALTER TABLE `user` MODIFY COLUMN `emp_id` VARCHAR(64) NOT NULL COMMENT '社員ID';

-- Add unique index if it does not exist
SET @idx_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'user'
    AND index_name = 'uk_user_emp_id'
);
SET @sql := IF(@idx_exists = 0, 'ALTER TABLE `user` ADD UNIQUE INDEX `uk_user_emp_id` (`emp_id`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
