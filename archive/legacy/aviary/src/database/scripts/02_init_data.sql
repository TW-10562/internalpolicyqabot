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

INSERT INTO `sys_role` VALUES
(1,'admin','admin',0,'1','0','0','admin',NULL,NULL,'2024-10-02 15:59:38','2024-10-02 15:59:38'),
(2,'super','super',1,'1','0','0','admin','admin',NULL,'2024-10-02 15:59:38','2026-01-19 06:13:56'),
(5,'aviary','aviary',3,'1','0','0','super','admin',NULL,'2024-12-24 19:03:40','2026-01-19 06:11:55'),
(6,'common','common',0,'1','0','0','admin','admin',NULL,'2025-03-04 17:43:02','2026-01-19 06:14:23'),
(7,'Unlimited usage','unlimited',0,'1','0','0','super','super','','2025-07-02 11:17:33','2025-07-02 11:18:23');

INSERT INTO `sys_user` VALUES
(1,1,'admin','admin','0',NULL,NULL,'0',NULL,'$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6','0',0,'::1','02:52:36','admin','admin',NULL,NULL,NULL,'2026-01-19 01:45:02','2026-01-20 02:52:35'),
(3,1,'super','super','0','','','0','84bb0860890d40572678e9e00.png','$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6','0',0,'::1','02:51:39','admin','admin',NULL,NULL,NULL,'2026-01-19 01:45:02','2026-01-20 02:51:39');

INSERT INTO `sys_user_role` VALUES
(1,1,1,'2024-10-02 15:59:38','2024-10-02 15:59:38'),
(93,3,2,'2024-10-02 15:59:38','2024-10-02 15:59:38'),
(94,3,4,'2024-10-02 15:59:38','2024-10-02 15:59:38');

INSERT INTO `sys_menu` VALUES
(2,'システム管理',0,2,'system','','',1,0,'M','0','0','','settings','admin','admin',NULL,'2022-12-16 13:56:36','2026-01-19 06:33:30'),
(3,'ユーザー管理',2,1,'user','system/user/index','',1,0,'C','0','0','R|user','user','admin','admin','','2022-12-16 13:56:36','2025-08-18 13:35:17'),
(4,'メニュー管理',2,3,'menu','system/menu/index','',1,0,'C','0','0','R|menu','category','admin','super','','2022-12-16 13:56:36','2025-08-18 16:02:37'),
(6,'ロール管理',2,2,'role','system/role/index','',1,0,'C','0','0','R|role','users','admin','super','','2022-12-16 13:56:36','2025-08-18 16:00:56'),
(9,'新規追加',3,1,'','','',1,0,'F','0','0','C|user','#','admin','super','','2022-12-16 14:01:27','2025-08-18 16:04:04'),
(1018,'学校管理',2,4,'dept','system/dept/index',NULL,1,0,'C','0','0','R|dept','sitemap','','admin',NULL,'2023-05-29 16:04:26','2025-08-18 13:43:20'),
(1020,'職位管理',2,5,'post','system/post/index',NULL,1,1,'C','0','0','R|post','user-square','','admin',NULL,'2023-05-30 10:28:29','2025-08-18 13:45:27'),
(1031,'編集',3,2,'',NULL,NULL,1,0,'F','0','0','U|user','','','super',NULL,'2023-06-07 09:37:36','2025-08-18 16:05:39'),
(1034,'削除',3,3,'',NULL,NULL,1,0,'F','0','0','D|user','','','super',NULL,'2023-06-07 09:41:27','2025-08-18 16:06:13'),
(1035,'导出',3,4,'',NULL,NULL,1,0,'F','0','0','system:user:export','','','',NULL,'2023-06-07 09:41:46','2023-06-07 09:41:46'),
(1036,'导入',3,5,'',NULL,NULL,1,0,'F','0','0','system:user:import','','','',NULL,'2023-06-07 09:41:57','2023-06-07 09:41:57'),
(1037,'パスワードリセット',3,6,'',NULL,NULL,1,0,'F','0','0','U:user','','','super',NULL,'2023-06-07 09:42:14','2025-08-18 16:07:17'),
(1038,'照会',3,0,'',NULL,NULL,1,0,'F','0','0','R|user','','','super',NULL,'2023-06-07 10:57:46','2025-08-18 16:03:48'),
(1039,'照会',6,1,'',NULL,NULL,1,0,'F','0','0','R|role','','','super',NULL,'2023-06-07 10:58:15','2025-08-18 16:05:01'),
(1040,'新規追加',6,2,'',NULL,NULL,1,0,'F','0','0','C|role','','','super',NULL,'2023-06-07 10:58:30','2025-08-18 16:04:09'),
(1041,'編集',6,3,'',NULL,NULL,1,0,'F','0','0','U|role','','','super',NULL,'2023-06-07 10:58:46','2025-08-18 16:05:45'),
(1042,'削除',6,4,'',NULL,NULL,1,0,'F','0','0','D|role','','','super',NULL,'2023-06-07 10:59:03','2025-08-18 16:06:21'),
(1044,'メニュー照会',4,1,'',NULL,NULL,1,0,'F','0','0','R|menu','','','admin',NULL,'2023-06-07 11:01:13','2025-08-20 17:33:08'),
(1045,'新規追加',4,2,'',NULL,NULL,1,0,'F','0','0','C|menu','','','super',NULL,'2023-06-07 11:01:33','2025-08-18 16:04:14'),
(1046,'編集',4,3,'',NULL,NULL,1,0,'F','0','0','U|menu','','','super',NULL,'2023-06-07 11:01:46','2025-08-18 16:05:50'),
(1047,'削除',4,4,'',NULL,NULL,1,0,'F','0','0','D|menu','','','super',NULL,'2023-06-07 11:01:59','2025-08-18 16:06:26'),
(1048,'照会',1018,1,'',NULL,NULL,1,0,'F','0','0','C|dept','','','super',NULL,'2023-06-07 11:03:01','2025-08-18 16:05:11'),
(1049,'新規追加',1018,2,'',NULL,NULL,1,0,'F','0','0','C|dept','','','super',NULL,'2023-06-07 11:03:12','2025-08-18 16:04:18'),
(1050,'編集',1018,3,'',NULL,NULL,1,0,'F','0','0','U|dept','','','super',NULL,'2023-06-07 11:03:24','2025-08-18 16:05:55'),
(1051,'削除',1018,4,'',NULL,NULL,1,0,'F','0','0','D|dept','','','super',NULL,'2023-06-07 11:03:34','2025-08-18 16:06:31'),
(1052,'照会',1020,1,'',NULL,NULL,1,0,'F','0','0','R|post','','','super',NULL,'2023-06-07 11:03:54','2025-08-18 16:05:16'),
(1053,'新規追加',1020,2,'',NULL,NULL,1,0,'F','0','0','C|post','','','super',NULL,'2023-06-07 11:04:07','2025-08-18 16:04:31'),
(1054,'編集',1020,3,'',NULL,NULL,1,0,'F','0','0','U|post','','','super',NULL,'2023-06-07 11:04:17','2025-08-18 16:06:00'),
(1055,'削除',1020,4,'',NULL,NULL,1,0,'F','0','0','D|post','','','super',NULL,'2023-06-07 11:04:29','2025-08-18 16:06:36'),
(1225,'チャット',0,1,'/chat','index',NULL,1,0,'C','0','0','R|CHAT_GEN','message','','admin',NULL,'2025-08-18 18:01:09','2026-01-19 06:33:04'),
(1231,'チャット',1225,1,'',NULL,NULL,1,0,'F','0','0','C|CHAT_GEN','','','',NULL,'2025-08-19 11:31:13','2025-08-19 11:31:13');

INSERT INTO `sys_dict_type` VALUES
(10,'メニュー状態','sys_show_hide','0','admin','admin','メニュー状態リスト','2023-04-03 13:44:50','2023-06-14 14:36:47'),
(11,'システムスイッチ','sys_normal_disable','0','admin','admin','システムスイッチリスト','2023-04-03 15:53:07','2023-05-26 14:16:27'),
(23,'パラメータ設定の有無','sys_yes_no','0','admin',NULL,'パラメータ設定の有無','2023-05-30 14:57:36','2023-05-30 14:57:36'),
(24,'通知タイプ','sys_notice_type','0','admin',NULL,'通知タイプリスト','2023-05-30 15:26:45','2023-05-30 15:26:45'),
(25,'通知状態','sys_notice_status','0','admin',NULL,'通知状態リスト','2023-05-30 15:28:54','2023-05-30 15:28:54'),
(26,'システム状態','sys_common_status','0','admin',NULL,'ログイン状態リスト','2023-05-30 16:52:47','2023-05-30 16:52:47'),
(27,'操作タイプ','sys_oper_type','0','admin',NULL,'操作タイプリスト','2023-05-30 16:53:44','2023-05-30 16:53:44'),
(29,'タスク状態','sys_job_status','0','admin',NULL,'タスク状態リスト','2023-06-19 09:19:31','2023-06-19 09:19:31'),
(30,'タスクグループ','sys_job_group','0','admin',NULL,'タスクグループリスト','2023-06-19 09:19:46','2023-06-19 09:19:46');

INSERT INTO `sys_dict_data` VALUES
(1,1,'男','0','sys_user_sex',NULL,'empty','Y','0','admin','男性',NULL,'2023-04-03 15:55:59','2023-04-21 09:10:23'),
(2,2,'女','1','sys_user_sex',NULL,'empty','Y','0','admin','女性',NULL,'2023-04-03 15:55:59','2023-04-21 09:10:27'),
(3,3,'不明','2','sys_user_sex',NULL,'empty','Y','0','admin','不明',NULL,'2023-04-03 15:55:59','2023-04-24 09:14:14'),
(6,1,'表示','0','sys_show_hide',NULL,'processing','N','0','admin','admin','メニュー表示','2023-04-04 14:18:22','2023-07-08 09:05:43'),
(7,2,'非表示','1','sys_show_hide',NULL,'error','N','0','admin','admin','メニュー非表示','2023-04-04 14:22:39','2023-07-08 09:05:16'),
(8,1,'正常','0','sys_normal_disable',NULL,'processing','N','0','admin',NULL,'正常状態','2023-04-04 14:24:22','2023-04-10 17:08:21'),
(9,2,'停止','1','sys_normal_disable',NULL,'error','N','0','admin',NULL,'停止状態','2023-04-04 14:25:27','2023-04-10 17:23:27'),
(41,1,'はい','Y','sys_yes_no',NULL,'processing','N','0','admin',NULL,'パラメータ設定のデフォルトは「はい」','2023-05-30 14:58:20','2023-05-30 14:58:20'),
(42,2,'いいえ','N','sys_yes_no',NULL,'error','N','0','admin',NULL,'パラメータ設定のデフォルトは「いいえ」','2023-05-30 14:58:46','2023-05-30 14:58:46'),
(43,1,'通知','1','sys_notice_type',NULL,'warning','N','0','admin',NULL,'通知','2023-05-30 15:27:14','2023-05-30 15:27:14'),
(44,2,'公告','2','sys_notice_type',NULL,'success','N','0','admin',NULL,'公告','2023-05-30 15:27:31','2023-05-30 15:27:31'),
(45,1,'正常','0','sys_notice_status',NULL,'processing','N','0','admin',NULL,'正常状態','2023-05-30 15:29:12','2023-05-30 15:29:12'),
(46,2,'停止','1','sys_notice_status',NULL,'error','N','0','admin',NULL,'停止状態','2023-05-30 15:29:29','2023-05-30 15:29:29'),
(47,1,'成功','0','sys_common_status',NULL,'processing','N','0','admin',NULL,'成功状態','2023-05-30 16:53:09','2023-05-30 16:53:09'),
(48,2,'失敗','1','sys_common_status',NULL,'error','N','0','admin','admin','失敗状態','2023-05-30 16:53:24','2023-06-12 14:57:40'),
(49,1,'新規追加','1','sys_oper_type',NULL,'default','N','0','admin',NULL,'新規追加操作','2023-05-30 16:54:41','2023-05-30 16:54:41'),
(50,2,'更新','2','sys_oper_type',NULL,'default','N','0','admin',NULL,'更新操作','2023-05-30 16:55:01','2023-05-30 16:55:01'),
(51,3,'削除','3','sys_oper_type',NULL,'error','N','0','admin',NULL,'削除操作','2023-05-30 16:55:17','2023-05-30 16:55:17'),
(52,4,'権限付与','4','sys_oper_type',NULL,'processing','N','0','admin',NULL,'権限付与操作','2023-05-30 16:55:33','2023-05-30 16:55:33'),
(53,5,'エクスポート','5','sys_oper_type',NULL,'warning','N','0','admin','admin','エクスポート操作','2023-05-30 16:55:47','2023-05-30 16:55:53'),
(54,6,'インポート','6','sys_oper_type',NULL,'warning','N','0','admin',NULL,'インポート操作','2023-05-30 16:56:09','2023-05-30 16:56:09'),
(55,7,'強制ログアウト','7','sys_oper_type',NULL,'error','N','0','admin',NULL,'強制ログアウト操作','2023-05-30 16:56:30','2023-05-30 16:56:30'),
(56,8,'コード生成','8','sys_oper_type',NULL,'warning','N','0','admin',NULL,'生成操作','2023-05-30 16:56:49','2023-05-30 16:56:49'),
(58,99,'その他','0','sys_oper_type',NULL,'default','N','0','admin','admin','その他の操作','2023-05-30 16:57:33','2023-06-14 14:39:36'),
(59,9,'データクリア','9','sys_oper_type',NULL,'error','N','0','admin','admin','データクリア操作','2023-06-14 11:39:42','2023-06-14 11:39:49'),
(60,1,'正常','0','sys_job_status',NULL,'processing','N','0','admin',NULL,'正常状態','2023-06-19 09:20:13','2023-06-19 09:20:13'),
(61,2,'停止','1','sys_job_status',NULL,'error','N','0','admin',NULL,'停止状態','2023-06-19 09:20:34','2023-06-19 09:20:34'),
(62,1,'デフォルト','DEFAULT','sys_job_group',NULL,'processing','N','0','admin',NULL,'デフォルトグループ','2023-06-19 09:21:38','2023-06-19 09:21:38'),
(63,2,'システム','SYSTEM','sys_job_group',NULL,'success','N','0','admin',NULL,'システムグループ','2023-06-19 09:21:58','2023-06-19 09:21:58');

INSERT INTO `sys_dept` VALUES
(1,0,'','aviary',1,'aviary',NULL,'','0','0','admin',NULL,'2024-10-02 15:59:38','2025-01-08 15:55:50',NULL,NULL,'その他','-');

INSERT INTO `sys_config` VALUES
(1,'-','sys.user.initPassword','123456','Y','admin','2023-05-30 15:08:37','admin','2023-08-17 15:13:45','初期パスワード 123456'),
(2,'-','sys.index.skinName','#1890ff','Y','admin','2023-05-30 15:14:16','admin','2023-08-17 16:01:20','16進カラーコード対応'),
(3,'-','sys.index.headerTheme','darkBlue','Y','admin','2023-05-30 15:19:10','admin','2023-08-17 16:01:08','pink、darkGreen、cornflowerBlue、goldenrod、darkBlue'),
(4,'-','sys.account.registerUser','false','Y','admin','2023-05-30 15:19:39','admin','2023-08-17 14:28:09','ユーザー登録機能を有効にするか（true: 有効、false: 無効）');


/*!40000 ALTER TABLE `sys_config` ENABLE KEYS */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-01-20 11:11:45
