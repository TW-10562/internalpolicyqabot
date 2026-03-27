/*M!999999\- enable the sandbox mode */
-- MariaDB dump 10.19  Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: 127.0.0.1    Database: aviary
-- ------------------------------------------------------
-- Server version	8.0.44

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `aviary_gen_task`
--

DROP TABLE IF EXISTS `aviary_gen_task`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `aviary_gen_task` (
  `id` varchar(21) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Task unique identifier',
  `type` varchar(32) NOT NULL DEFAULT 'WAIT' COMMENT 'Task type: CHAT_GEN',
  `form_data` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Form payload in JSON format',
  `status` varchar(32) NOT NULL DEFAULT 'WAIT' COMMENT 'Task status: WAIT, IN_PROCESS, FINISHED, FAILED',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator user identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater user identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Task table for AI content generation';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `aviary_gen_task_output`
--

DROP TABLE IF EXISTS `aviary_gen_task_output`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `aviary_gen_task_output` (
  `id` int NOT NULL AUTO_INCREMENT,
  `task_id` varchar(21) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Associated task identifier',
  `metadata` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Template metadata used during generation',
  `sort` bigint DEFAULT NULL COMMENT 'Output ordering index (reserved for multi-output sequencing)',
  `content` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'Generated result: markdown for text/search, file path for voice/image',
  `status` varchar(32) NOT NULL DEFAULT 'WAIT' COMMENT 'Output status: WAIT, IN_PROCESS, FINISHED, FAILED',
  `feedback` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci COMMENT 'User feedback: GOOD, AVERAGE, NOT_GOOD',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator user identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater user identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=491 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Generated outputs of AI generation tasks';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `aviary_import_snapshot`
--

DROP TABLE IF EXISTS `aviary_import_snapshot`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `aviary_import_snapshot` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `task_id` bigint NOT NULL COMMENT 'Associated import task identifier',
  `type` varchar(32) NOT NULL DEFAULT 'SCHOOL' COMMENT 'Snapshot type: SCHOOL, USER',
  `kv` varchar(255) NOT NULL COMMENT 'Business key: school_code or user_id',
  `action` varchar(32) NOT NULL DEFAULT 'INSERT' COMMENT 'Data action: INSERT, UPDATE, DELETE, UNCHANGED',
  `old_data` json DEFAULT NULL COMMENT 'Original data before change',
  `new_data` json DEFAULT NULL COMMENT 'New data after change',
  `diff` json DEFAULT NULL COMMENT 'Difference between old and new data',
  `create_by` char(64) DEFAULT NULL COMMENT 'Creator user identifier',
  `update_by` char(64) DEFAULT NULL COMMENT 'Last updater user identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC COMMENT='Import data snapshot table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `aviary_import_task`
--

DROP TABLE IF EXISTS `aviary_import_task`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `aviary_import_task` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `type` varchar(32) NOT NULL DEFAULT 'SCHOOL' COMMENT 'Import type: SCHOOL, USER',
  `file_path` varchar(255) NOT NULL COMMENT 'Uploaded CSV file path',
  `status` varchar(32) NOT NULL DEFAULT 'UPLOADED' COMMENT 'Task status: UPLOADED, PARSING, PARSED, COMPLETED, FAILED',
  `total_count` int DEFAULT '0' COMMENT 'Total parsed records',
  `insert_count` int DEFAULT '0' COMMENT 'Inserted record count',
  `update_count` int DEFAULT '0' COMMENT 'Updated record count',
  `delete_count` int DEFAULT '0' COMMENT 'Deleted record count',
  `create_by` char(64) DEFAULT NULL COMMENT 'Creator user identifier',
  `update_by` char(64) DEFAULT NULL COMMENT 'Last updater user identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC COMMENT='CSV import task table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_config`
--

DROP TABLE IF EXISTS `sys_config`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_config` (
  `config_id` int NOT NULL AUTO_INCREMENT COMMENT 'Configuration primary key',
  `config_name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Configuration display name',
  `config_key` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Configuration key',
  `config_value` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Configuration value',
  `config_type` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL DEFAULT 'N' COMMENT 'System built-in flag (Y = built-in, N = custom)',
  `create_by` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator identifier',
  `created_at` datetime DEFAULT NULL COMMENT 'Creation timestamp',
  `update_by` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater identifier',
  `updated_at` datetime DEFAULT NULL COMMENT 'Last update timestamp',
  `remark` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Remarks',
  PRIMARY KEY (`config_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='System configuration table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_dept`
--

DROP TABLE IF EXISTS `sys_dept`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_dept` (
  `dept_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'Department identifier',
  `parent_id` bigint DEFAULT '0' COMMENT 'Parent department identifier',
  `ancestors` char(50) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Ancestor hierarchy path',
  `dept_name` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Department name',
  `order_num` bigint DEFAULT '0' COMMENT 'Display order',
  `leader` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Department leader',
  `phone` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Contact phone number',
  `email` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Contact email address',
  `status` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Department status (0 = active, 1 = disabled)',
  `del_flag` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Deletion flag (0 = existing, 1 = deleted)',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  `school_id` bigint DEFAULT NULL COMMENT 'Associated school identifier',
  `school_code` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'School code',
  `prefecture` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Prefecture',
  `address` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'Address',
  PRIMARY KEY (`dept_id`) USING BTREE,
  UNIQUE KEY `dept_id` (`dept_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=45561 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Department master table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_dict_data`
--

DROP TABLE IF EXISTS `sys_dict_data`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_dict_data` (
  `dict_code` bigint NOT NULL AUTO_INCREMENT COMMENT 'Dictionary entry identifier',
  `dict_sort` bigint DEFAULT '0' COMMENT 'Sort order',
  `dict_label` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Display label',
  `dict_value` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Stored value',
  `dict_type` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Dictionary category type',
  `css_class` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'CSS style class',
  `list_class` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Table display style class',
  `is_default` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT 'N' COMMENT 'Default flag (Y = default, N = non-default)',
  `status` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Status (0 = active, 1 = disabled)',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater identifier',
  `remark` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Remarks',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`dict_code`) USING BTREE,
  UNIQUE KEY `dict_code` (`dict_code`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=69 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Dictionary data entries';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_dict_type`
--

DROP TABLE IF EXISTS `sys_dict_type`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_dict_type` (
  `dict_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'Dictionary type identifier',
  `dict_name` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Dictionary name',
  `dict_type` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Dictionary type code',
  `status` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Status (0 = active, 1 = disabled)',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater identifier',
  `remark` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Remarks',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`dict_id`) USING BTREE,
  UNIQUE KEY `dict_id` (`dict_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=33 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Dictionary type definitions';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_logininfor`
--

DROP TABLE IF EXISTS `sys_logininfor`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_logininfor` (
  `info_id` int NOT NULL AUTO_INCREMENT COMMENT 'Login record identifier',
  `user_name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Login username',
  `ipaddr` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Client IP address',
  `login_location` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Login geo location',
  `browser` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Browser name',
  `os` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Operating system',
  `status` varchar(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Login result (0 = success, 1 = failure)',
  `msg` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Result message',
  `login_time` datetime DEFAULT NULL COMMENT 'Login timestamp',
  `created_at` datetime DEFAULT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime DEFAULT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`info_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='User login audit log';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_menu`
--

DROP TABLE IF EXISTS `sys_menu`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_menu` (
  `menu_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'Menu identifier',
  `menu_name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Menu display name',
  `parent_id` bigint DEFAULT '0' COMMENT 'Parent menu identifier',
  `order_num` bigint DEFAULT '0' COMMENT 'Display order',
  `path` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Routing path',
  `component` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Frontend component path',
  `query` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Routing query parameters',
  `is_frame` bigint DEFAULT '1' COMMENT 'External link flag (0 = external, 1 = internal)',
  `is_cache` bigint DEFAULT '0' COMMENT 'Cache enabled flag (0 = cached, 1 = not cached)',
  `menu_type` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Menu type (M = directory, C = menu, F = action/button)',
  `visible` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Visibility (0 = visible, 1 = hidden)',
  `status` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Status (0 = active, 1 = disabled)',
  `perms` char(100) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Permission identifier',
  `icon` char(100) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Icon name',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Creator identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '' COMMENT 'Last updater identifier',
  `remark` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Remarks',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`menu_id`) USING BTREE,
  UNIQUE KEY `menu_id` (`menu_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1237 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='System menu definitions';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_oper_log`
--

DROP TABLE IF EXISTS `sys_oper_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_oper_log` (
  `oper_id` int NOT NULL AUTO_INCREMENT COMMENT 'Operation log identifier',
  `title` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Module title',
  `business_type` varchar(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL DEFAULT '0' COMMENT 'Business type (0 = other, 1 = create, 2 = update, 3 = delete)',
  `method` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Method name',
  `request_method` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'HTTP request method',
  `operator_type` varchar(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Operator category (0 = other, 1 = admin user, 2 = mobile user)',
  `oper_name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Operator name',
  `dept_name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Department name',
  `oper_url` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Request URL',
  `oper_ip` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Client IP address',
  `oper_location` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Operation location',
  `oper_param` varchar(2000) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Request parameters',
  `json_result` varchar(2000) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Response payload',
  `status` varchar(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Operation status (0 = success, 1 = error)',
  `error_msg` varchar(2000) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Error message',
  `oper_time` datetime DEFAULT NULL COMMENT 'Operation timestamp',
  `created_at` datetime DEFAULT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime DEFAULT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`oper_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=63 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='System operation audit log';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_post`
--

DROP TABLE IF EXISTS `sys_post`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_post` (
  `post_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'Position identifier',
  `post_code` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Position code',
  `post_name` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Position name',
  `post_sort` bigint DEFAULT NULL COMMENT 'Display order',
  `status` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Status (0 = active, 1 = disabled)',
  `del_flag` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Deletion flag (0 = existing, 2 = deleted)',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater identifier',
  `remark` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Remarks',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`post_id`) USING BTREE,
  UNIQUE KEY `post_id` (`post_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Position master table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_role`
--

DROP TABLE IF EXISTS `sys_role`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_role` (
  `role_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'Role identifier',
  `role_name` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Role display name',
  `role_key` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Role permission key',
  `role_sort` bigint DEFAULT NULL COMMENT 'Display order',
  `data_scope` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '1' COMMENT 'Data scope (1 = all data, 2 = custom, 3 = department only, 4 = department and sub-departments)',
  `status` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Status (0 = active, 1 = disabled)',
  `del_flag` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Deletion flag (0 = existing, 1 = deleted)',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater identifier',
  `remark` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Remarks',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`role_id`) USING BTREE,
  UNIQUE KEY `role_id` (`role_id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Role master table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_role_menu`
--

DROP TABLE IF EXISTS `sys_role_menu`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_role_menu` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Relation identifier',
  `role_id` bigint DEFAULT NULL COMMENT 'Role identifier',
  `menu_id` bigint DEFAULT NULL COMMENT 'Menu identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=1536 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='Role-menu mapping table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_user`
--

DROP TABLE IF EXISTS `sys_user`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_user` (
  `user_id` bigint NOT NULL AUTO_INCREMENT COMMENT 'User identifier',
  `dept_id` bigint DEFAULT NULL COMMENT 'Department identifier',
  `user_name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Login username',
  `nick_name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Display nickname',
  `user_type` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'User type (0 = admin, 1 = normal user)',
  `email` char(50) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Email address',
  `phonenumber` char(11) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Mobile phone number',
  `sex` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Gender (0 = male, 1 = female)',
  `avatar` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Avatar image URL',
  `password` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL COMMENT 'Encrypted password',
  `status` char(1) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT '0' COMMENT 'Account status (0 = active, 1 = disabled)',
  `del_flag` bigint DEFAULT '0' COMMENT 'Deletion flag (0 = existing, 1 = deleted)',
  `login_ip` char(128) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last login IP address',
  `login_date` time DEFAULT NULL COMMENT 'Last login time',
  `create_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Creator identifier',
  `update_by` char(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Last updater identifier',
  `remark` char(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL COMMENT 'Remarks',
  `first_login_date` date DEFAULT NULL COMMENT 'First login date',
  `expiration_date` date DEFAULT NULL COMMENT 'Account expiration date',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`user_id`) USING BTREE,
  KEY `dept_id` (`dept_id`) USING BTREE,
  CONSTRAINT `sys_user_ibfk_1`
    FOREIGN KEY (`dept_id`) REFERENCES `sys_dept` (`dept_id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=30029 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='System user table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_user_opinion`
--

DROP TABLE IF EXISTS `sys_user_opinion`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_user_opinion` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Opinion identifier',
  `user_id` int NOT NULL COMMENT 'User identifier',
  `dept_id` int DEFAULT NULL COMMENT 'Department (school) identifier',
  `school_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'School name',
  `opinion` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Opinion content',
  `functions` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci COMMENT 'Function tags in JSON format',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC COMMENT='User feedback and opinions';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_user_post`
--

DROP TABLE IF EXISTS `sys_user_post`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_user_post` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Relation identifier',
  `user_id` bigint DEFAULT NULL COMMENT 'User identifier',
  `post_id` bigint DEFAULT NULL COMMENT 'Position identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='User-position mapping table';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sys_user_role`
--

DROP TABLE IF EXISTS `sys_user_role`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_user_role` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT 'Relation identifier',
  `user_id` bigint DEFAULT NULL COMMENT 'User identifier',
  `role_id` bigint DEFAULT NULL COMMENT 'Role identifier',
  `created_at` datetime NOT NULL COMMENT 'Creation timestamp',
  `updated_at` datetime NOT NULL COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB AUTO_INCREMENT=97 DEFAULT CHARSET=utf8mb3 ROW_FORMAT=DYNAMIC COMMENT='User-role mapping table';
/*!40101 SET character_set_client = @saved_cs_client */;

-- ------------------------
-- Dump footer
-- ------------------------

/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
