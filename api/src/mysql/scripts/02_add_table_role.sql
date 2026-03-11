DROP TABLE IF EXISTS `role`;

CREATE TABLE
    `role` (
        `role_id` bigint NOT NULL AUTO_INCREMENT COMMENT '役割ID',
        `role_name` char(255) CHARACTER
        SET
            utf8 COLLATE utf8_general_ci DEFAULT NULL COMMENT '役割名称',
            `role_key` char(255) CHARACTER
        SET
            utf8 COLLATE utf8_general_ci DEFAULT NULL COMMENT '役割権限文字列',
            `role_sort` bigint DEFAULT NULL COMMENT '表示順序',
            `status` char(1) CHARACTER
        SET
            utf8 COLLATE utf8_general_ci DEFAULT '0' COMMENT '役割の状態（0正常 1停用）',
            `del_flag` char(1) CHARACTER
        SET
            utf8 COLLATE utf8_general_ci DEFAULT '0' COMMENT '削除フラグ（0は存在することを示し 1は削除されたことを示す）',
            `create_by` char(64) CHARACTER
        SET
            utf8 COLLATE utf8_general_ci DEFAULT NULL COMMENT '作成者',
            `update_by` char(64) CHARACTER
        SET
            utf8 COLLATE utf8_general_ci DEFAULT NULL COMMENT '更新者',
            `remark` char(255) CHARACTER
        SET
            utf8 COLLATE utf8_general_ci DEFAULT NULL COMMENT '備考',
            `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
            `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`role_id`) USING BTREE,
            UNIQUE KEY `role_id` (`role_id`) USING BTREE
    ) ENGINE = InnoDB AUTO_INCREMENT = 3 DEFAULT CHARSET = utf8 ROW_FORMAT = DYNAMIC COMMENT = '役割情報テーブル';

DROP TABLE IF EXISTS `user_role`;

CREATE TABLE
    `user_role` (
        `id` int NOT NULL AUTO_INCREMENT,
        `user_id` bigint DEFAULT NULL,
        `role_id` bigint DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (`id`) USING BTREE
    ) ENGINE = InnoDB AUTO_INCREMENT = 1 DEFAULT CHARSET = utf8 ROW_FORMAT = DYNAMIC;

DROP TABLE IF EXISTS `file_role`;

CREATE TABLE
    `file_role` (
        `id` int NOT NULL AUTO_INCREMENT,
        `file_id` bigint DEFAULT NULL,
        `role_id` bigint DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (`id`) USING BTREE
    ) ENGINE = InnoDB AUTO_INCREMENT = 1 DEFAULT CHARSET = utf8 ROW_FORMAT = DYNAMIC;

-- 初期データ挿入
INSERT INTO
    `role` (
        `role_id`,
        `role_name`,
        `role_key`,
        `role_sort`,
        `status`,
        `del_flag`,
        `create_by`,
        `created_at`,
        `updated_at`
    )
VALUES
    (
        1,
        'admin',
        'admin',
        0,
        '0',
        '0',
        'admin',
        NOW(),
        NOW()
    );

INSERT INTO
    `role` (
        `role_id`,
        `role_name`,
        `role_key`,
        `role_sort`,
        `status`,
        `del_flag`,
        `create_by`,
        `created_at`,
        `updated_at`
    )
VALUES
    (
        2,
        'sso',
        'sso',
        1,
        '0',
        '0',
        'admin',
        NOW(),
        NOW()
    );

INSERT INTO
    `user_role` (`user_id`, `role_id`, `created_at`, `updated_at`)
VALUES
    (1, 1, NOW(), NOW()),
    (2, 2, NOW(), NOW());
