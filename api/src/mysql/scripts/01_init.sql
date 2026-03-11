DROP TABLE IF EXISTS user;

DROP TABLE IF EXISTS `group`;

DROP TABLE IF EXISTS user_group;

DROP TABLE IF EXISTS krd_gen_task;

DROP TABLE IF EXISTS krd_gen_task_output;

DROP TABLE IF EXISTS `file`;

DROP TABLE IF EXISTS `file_tag`;

CREATE TABLE `user` (
    `user_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'ユーザid',
    `user_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'ユーザ名',
    `password` CHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'パスワード',
    `email` char(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ユーザのメールアドレス',
    `phonenumber` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ユーザの電話番号',
    `status` char(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '0' COMMENT 'アカウント有効化フラグ(0=無効, 1=有効。アカウント作成時の承認前の状態に使用)',
    `last_login_at` datetime DEFAULT NULL COMMENT '最終ログイン日時',
    `create_by` bigint DEFAULT NULL COMMENT '当ユーザの作成者の id',
    `deleted_by` bigint DEFAULT NULL COMMENT '当ユーザの削除者の id',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'ユーザ追加日時',
    `deleted_at` datetime DEFAULT NULL COMMENT 'ユーザ削除日時',
    `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'ユーザ更新日時',
    PRIMARY KEY (`user_id`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 ROW_FORMAT = DYNAMIC;

CREATE TABLE `group` (
    `group_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'グループid',
    `group_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'グループ名',
    `parent_id` bigint DEFAULT NULL COMMENT '親グループid',
    `color_code` CHAR(7) DEFAULT NULL COMMENT 'GUIでのグループ表示時の色コード',
    `attributes` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'グループの属性情報',
    `use_group_color` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'グループカラーを使用するか（0:無効, 1:有効)',
    `create_by` bigint DEFAULT NULL COMMENT '当グループの作成者の id',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'グループ追加日時',
    `deleted_by` bigint DEFAULT NULL COMMENT '当グループの削除者の id',
    `deleted_at` datetime DEFAULT NULL COMMENT 'グループ削除日時',
    `updated_by` bigint DEFAULT NULL COMMENT 'グループ更新者の id',
    `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'グループ更新日時',
    PRIMARY KEY (`group_id`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;

CREATE TABLE `user_group` (
    `user_id` bigint NOT NULL COMMENT 'ユーザid',
    `group_id` bigint NOT NULL COMMENT 'グループid',
    `deleted_at` datetime DEFAULT NULL COMMENT '削除日時',
    PRIMARY KEY (`user_id`, `group_id`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 ROW_FORMAT = DYNAMIC;

CREATE TABLE `krd_gen_task` (
    `id` varchar(21) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'タスクの id',
    `type` varchar(32) NOT NULL DEFAULT 'WAIT' COMMENT 'タスクの種類',
    `form_data` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'フォーム情報 json',
    `status` varchar(32) NOT NULL DEFAULT 'WAIT' COMMENT '状態',
    `create_by` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `update_by` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `created_at` datetime NOT NULL,
    `updated_at` datetime NOT NULL,
    PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;

CREATE TABLE `krd_gen_task_output` (
    `id` int NOT NULL AUTO_INCREMENT,
    `task_id` varchar(21) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    `metadata` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    `sort` bigint DEFAULT NULL,
    `content` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '結果を生成します',
    `status` varchar(32) NOT NULL DEFAULT 'WAIT',
    `feedback` varchar(32) DEFAULT NULL,
    `create_by` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `update_by` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `created_at` datetime NOT NULL,
    `updated_at` datetime NOT NULL,
    PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci ROW_FORMAT = DYNAMIC;

CREATE TABLE `file_tag` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL UNIQUE COMMENT 'タグ',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `file` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `tag` INT NULL COMMENT 'タグ',
    `filename` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    `storage_key` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    `mime_type` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    `size` INT NOT NULL,
    `create_by` CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `update_by` CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT `fk_file_tag` FOREIGN KEY (`tag`) REFERENCES `file_tag` (`id`) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Messages table for user-admin communication
CREATE TABLE IF NOT EXISTS `messages` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `sender_id` VARCHAR(64) NOT NULL,
    `sender_type` ENUM('user', 'admin') NOT NULL,
    `recipient_id` VARCHAR(64) NOT NULL,
    `recipient_type` ENUM('user', 'admin', 'all') NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `content` TEXT NOT NULL,
    `parent_id` INT DEFAULT NULL,
    `is_read` BOOLEAN DEFAULT FALSE,
    `is_broadcast` BOOLEAN DEFAULT FALSE,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_sender_id (sender_id),
    INDEX idx_recipient_id (recipient_id),
    INDEX idx_parent_id (parent_id),
    INDEX idx_is_read (is_read),
    INDEX idx_is_broadcast (is_broadcast)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Support tickets table
CREATE TABLE IF NOT EXISTS `support_tickets` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `user_name` VARCHAR(100) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `status` ENUM('open', 'in_progress', 'resolved', 'closed') DEFAULT 'open',
    `admin_reply` TEXT,
    `admin_id` INT,
    `admin_name` VARCHAR(100),
    `replied_at` DATETIME,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Notifications table
CREATE TABLE IF NOT EXISTS `notifications` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `type` VARCHAR(50) DEFAULT 'general',
    `is_read` BOOLEAN DEFAULT FALSE,
    `link` VARCHAR(500) DEFAULT NULL,
    `related_id` INT,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_is_read (is_read)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

INSERT INTO
    `user`
VALUES (
        1,
        'admin',
        '$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6',
        'admin@admin.co.jp',
        '117',
        '1',
        NULL,
        '1',
        NULL,
        NOW(),
        NULL,
        NOW()
    ),
    (
        2,
        'test_user_1',
        '$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6',
        'test_user_1@test.co.jp',
        '117',
        '1',
        NULL,
        '1',
        NULL,
        NOW(),
        NULL,
        NOW()
    ),
    (
        3,
        'test_user_2',
        '$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6',
        'test_user_2@test.co.jp',
        '117',
        '1',
        NULL,
        '1',
        NULL,
        NOW(),
        NULL,
        NOW()
    );