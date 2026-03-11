DROP TABLE IF EXISTS `sso_user_bind`;

CREATE TABLE
  IF NOT EXISTS `sso_user_bind` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` BIGINT NOT NULL COMMENT 'ユーザーID',
    `sso_provider` VARCHAR(255) NOT NULL COMMENT 'SSOプロバイダー',
    `sso_oid` VARCHAR(255) NOT NULL COMMENT 'SSOユーザーID',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `unique_sso_user` (`sso_provider`, `sso_oid`)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8 COMMENT = 'SSOユーザーバインド情報テーブル';

ALTER TABLE `user` ADD COLUMN `sso_bound` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'SSO連携済みフラグ' AFTER `status`;
