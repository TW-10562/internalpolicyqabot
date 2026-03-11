/**
 * Prisma Seed Configuration - Aviary Platform
 * Converted from: 02_init_data.sql
 * Purpose: Initialize seed data for development and testing environments
 * 
 * USAGE:
 * 1. Copy this file to: prisma/seed.ts
 * 2. Update package.json prisma.seed:
 *    "prisma": {
 *      "seed": "ts-node prisma/seed.ts"
 *    }
 * 3. Run: npx prisma db seed
 * 
 * @generated January 2026
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * ============================================================================
 * SEED EXECUTION ORCHESTRATION
 * ============================================================================
 */
async function main() {
  console.log("🌱 Starting Aviary Platform database seeding...\n");

  try {
    // Phase 1: System Foundation Data
    await seedRoles();
    console.log("✓ Roles seeded successfully\n");

    await seedDepartments();
    console.log("✓ Departments seeded successfully\n");

    // Phase 2: User Management
    await seedUsers();
    console.log("✓ Users seeded successfully\n");

    await seedUserRoles();
    console.log("✓ User-role mappings seeded successfully\n");

    // Phase 3: UI & Navigation
    await seedMenus();
    console.log("✓ Menus seeded successfully\n");

    await seedDictTypes();
    console.log("✓ Dictionary types seeded successfully\n");

    await seedDictData();
    console.log("✓ Dictionary data seeded successfully\n");

    // Phase 4: Configuration
    await seedConfig();
    console.log("✓ System configuration seeded successfully\n");

    console.log("✅ Database seeding completed successfully!\n");
  } catch (error) {
    console.error("❌ Error during seeding:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// ============================================================================
// SEED PHASE 1: SYSTEM FOUNDATION
// ============================================================================

/**
 * Seed sys_role table
 * 
 * Roles define access levels and permissions:
 * - admin (id=1): Administrative access
 * - super (id=2): Superuser with all permissions
 * - aviary (id=5): Aviary-specific role
 * - common (id=6): Common user role
 * - unlimited (id=7): Unlimited usage tier role
 */
async function seedRoles() {
  const roles = [
    {
      roleId: 1n,
      roleName: "admin",
      roleKey: "admin",
      roleSort: 0n,
      dataScope: "1", // ALL_DATA
      status: "0", // ACTIVE
      delFlag: "0", // NOT DELETED
      createdBy: "admin",
      updatedBy: null,
      remark: null,
      createdAt: new Date("2024-10-02 15:59:38"),
      updatedAt: new Date("2024-10-02 15:59:38"),
    },
    {
      roleId: 2n,
      roleName: "super",
      roleKey: "super",
      roleSort: 1n,
      dataScope: "1", // ALL_DATA
      status: "0", // ACTIVE
      delFlag: "0", // NOT DELETED
      createdBy: "admin",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2024-10-02 15:59:38"),
      updatedAt: new Date("2026-01-19 06:13:56"),
    },
    {
      roleId: 5n,
      roleName: "aviary",
      roleKey: "aviary",
      roleSort: 3n,
      dataScope: "1", // ALL_DATA
      status: "0", // ACTIVE
      delFlag: "0", // NOT DELETED
      createdBy: "super",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2024-12-24 19:03:40"),
      updatedAt: new Date("2026-01-19 06:11:55"),
    },
    {
      roleId: 6n,
      roleName: "common",
      roleKey: "common",
      roleSort: 0n,
      dataScope: "1", // ALL_DATA
      status: "0", // ACTIVE
      delFlag: "0", // NOT DELETED
      createdBy: "admin",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2025-03-04 17:43:02"),
      updatedAt: new Date("2026-01-19 06:14:23"),
    },
    {
      roleId: 7n,
      roleName: "Unlimited usage",
      roleKey: "unlimited",
      roleSort: 0n,
      dataScope: "1", // ALL_DATA
      status: "0", // ACTIVE
      delFlag: "0", // NOT DELETED
      createdBy: "super",
      updatedBy: "super",
      remark: "",
      createdAt: new Date("2025-07-02 11:17:33"),
      updatedAt: new Date("2025-07-02 11:18:23"),
    },
  ];

  for (const role of roles) {
    await prisma.sysRole.upsert({
      where: { roleId: role.roleId },
      update: role,
      create: role,
    });
  }
}

/**
 * Seed sys_dept table
 * 
 * Departments represent organizational units.
 * Root department "aviary" is the main organization.
 */
async function seedDepartments() {
  const dept = {
    deptId: 1n,
    parentId: 0n,
    ancestors: "",
    deptName: "aviary",
    orderNum: 1n,
    leader: "aviary",
    phone: null,
    email: null,
    status: "0", // ACTIVE
    delFlag: "0", // NOT DELETED
    createdBy: "admin",
    updatedBy: null,
    createdAt: new Date("2024-10-02 15:59:38"),
    updatedAt: new Date("2025-01-08 15:55:50"),
    schoolId: null,
    schoolCode: null,
    prefecture: "その他",
    address: "-",
  };

  await prisma.sysDept.upsert({
    where: { deptId: dept.deptId },
    update: dept,
    create: dept,
  });
}

// ============================================================================
// SEED PHASE 2: USER MANAGEMENT
// ============================================================================

/**
 * Seed sys_user table
 * 
 * Default users for system initialization:
 * - admin (id=1): Administrator account
 * - super (id=3): Superuser account
 * 
 * Password: $2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6
 * (bcrypt hash of "123456")
 */
async function seedUsers() {
  const users = [
    {
      userId: 1n,
      deptId: 1n,
      userName: "admin",
      nickName: "admin",
      userType: "0", // ADMIN
      email: null,
      phonenumber: null,
      sex: "0", // MALE
      avatar: null,
      password: "$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6",
      status: "0", // ACTIVE
      delFlag: 0n,
      loginIp: "::1",
      loginDate: new Date("1970-01-01 02:52:36"),
      createdBy: "admin",
      updatedBy: "admin",
      remark: null,
      firstLoginDate: null,
      expirationDate: null,
      createdAt: new Date("2026-01-19 01:45:02"),
      updatedAt: new Date("2026-01-20 02:52:35"),
    },
    {
      userId: 3n,
      deptId: 1n,
      userName: "super",
      nickName: "super",
      userType: "0", // ADMIN
      email: "",
      phonenumber: "",
      sex: "0", // MALE
      avatar: "84bb0860890d40572678e9e00.png",
      password: "$2a$10$7j7.uRiNoqQ9sNHllpnrLOnfwdo1W.XQo0h7GX/Fk1RcqL7Lt30j6",
      status: "0", // ACTIVE
      delFlag: 0n,
      loginIp: "::1",
      loginDate: new Date("1970-01-01 02:51:39"),
      createdBy: "admin",
      updatedBy: "admin",
      remark: null,
      firstLoginDate: null,
      expirationDate: null,
      createdAt: new Date("2026-01-19 01:45:02"),
      updatedAt: new Date("2026-01-20 02:51:39"),
    },
  ];

  for (const user of users) {
    await prisma.sysUser.upsert({
      where: { userId: user.userId },
      update: user,
      create: user,
    });
  }
}

/**
 * Seed sys_user_role table
 * 
 * Maps users to their assigned roles:
 * - admin → admin role
 * - super → super role, aviary role
 */
async function seedUserRoles() {
  const mappings = [
    {
      id: 1,
      userId: 1n,
      roleId: 1n,
      createdAt: new Date("2024-10-02 15:59:38"),
      updatedAt: new Date("2024-10-02 15:59:38"),
    },
    {
      id: 93,
      userId: 3n,
      roleId: 2n,
      createdAt: new Date("2024-10-02 15:59:38"),
      updatedAt: new Date("2024-10-02 15:59:38"),
    },
    {
      id: 94,
      userId: 3n,
      roleId: 5n,
      createdAt: new Date("2024-10-02 15:59:38"),
      updatedAt: new Date("2024-10-02 15:59:38"),
    },
  ];

  for (const mapping of mappings) {
    await prisma.sysUserRole.upsert({
      where: { id: mapping.id },
      update: mapping,
      create: mapping,
    });
  }
}

// ============================================================================
// SEED PHASE 3: UI & NAVIGATION
// ============================================================================

/**
 * Seed sys_menu table
 * 
 * Defines the hierarchical menu structure for the UI.
 * Menus are categorized as:
 * - M (DIRECTORY): Menu folders/categories
 * - C (MENU): Clickable menu items
 * - F (ACTION): Buttons/actions within menus
 */
async function seedMenus() {
  const menus = [
    {
      menuId: 2n,
      menuName: "システム管理",
      parentId: 0n,
      orderNum: 2n,
      path: "system",
      component: "",
      query: "",
      isFrame: 1n, // INTERNAL
      isCache: 0n,
      menuType: "M", // DIRECTORY
      visible: "0", // VISIBLE
      status: "0", // ACTIVE
      perms: "",
      icon: "settings",
      createdBy: "admin",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2022-12-16 13:56:36"),
      updatedAt: new Date("2026-01-19 06:33:30"),
    },
    {
      menuId: 3n,
      menuName: "ユーザー管理",
      parentId: 2n,
      orderNum: 1n,
      path: "user",
      component: "system/user/index",
      query: "",
      isFrame: 1n,
      isCache: 0n,
      menuType: "C", // MENU
      visible: "0",
      status: "0",
      perms: "R|user",
      icon: "user",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "",
      createdAt: new Date("2022-12-16 13:56:36"),
      updatedAt: new Date("2025-08-18 13:35:17"),
    },
    {
      menuId: 4n,
      menuName: "メニュー管理",
      parentId: 2n,
      orderNum: 3n,
      path: "menu",
      component: "system/menu/index",
      query: "",
      isFrame: 1n,
      isCache: 0n,
      menuType: "C",
      visible: "0",
      status: "0",
      perms: "R|menu",
      icon: "category",
      createdBy: "admin",
      updatedBy: "super",
      remark: "",
      createdAt: new Date("2022-12-16 13:56:36"),
      updatedAt: new Date("2025-08-18 16:02:37"),
    },
    {
      menuId: 6n,
      menuName: "ロール管理",
      parentId: 2n,
      orderNum: 2n,
      path: "role",
      component: "system/role/index",
      query: "",
      isFrame: 1n,
      isCache: 0n,
      menuType: "C",
      visible: "0",
      status: "0",
      perms: "R|role",
      icon: "users",
      createdBy: "admin",
      updatedBy: "super",
      remark: "",
      createdAt: new Date("2022-12-16 13:56:36"),
      updatedAt: new Date("2025-08-18 16:00:56"),
    },
    {
      menuId: 9n,
      menuName: "新規追加",
      parentId: 3n,
      orderNum: 1n,
      path: "",
      component: "",
      query: "",
      isFrame: 1n,
      isCache: 0n,
      menuType: "F", // ACTION
      visible: "0",
      status: "0",
      perms: "C|user",
      icon: "#",
      createdBy: "admin",
      updatedBy: "super",
      remark: "",
      createdAt: new Date("2022-12-16 14:01:27"),
      updatedAt: new Date("2025-08-18 16:04:04"),
    },
    {
      menuId: 1018n,
      menuName: "学校管理",
      parentId: 2n,
      orderNum: 4n,
      path: "dept",
      component: "system/dept/index",
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "C",
      visible: "0",
      status: "0",
      perms: "R|dept",
      icon: "sitemap",
      createdBy: "",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2023-05-29 16:04:26"),
      updatedAt: new Date("2025-08-18 13:43:20"),
    },
    {
      menuId: 1020n,
      menuName: "職位管理",
      parentId: 2n,
      orderNum: 5n,
      path: "post",
      component: "system/post/index",
      query: null,
      isFrame: 1n,
      isCache: 1n,
      menuType: "C",
      visible: "0",
      status: "0",
      perms: "R|post",
      icon: "user-square",
      createdBy: "",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2023-05-30 10:28:29"),
      updatedAt: new Date("2025-08-18 13:45:27"),
    },
    {
      menuId: 1031n,
      menuName: "編集",
      parentId: 3n,
      orderNum: 2n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "U|user",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 09:37:36"),
      updatedAt: new Date("2025-08-18 16:05:39"),
    },
    {
      menuId: 1034n,
      menuName: "削除",
      parentId: 3n,
      orderNum: 3n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "D|user",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 09:41:27"),
      updatedAt: new Date("2025-08-18 16:06:13"),
    },
    {
      menuId: 1035n,
      menuName: "导出",
      parentId: 3n,
      orderNum: 4n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "system:user:export",
      icon: "",
      createdBy: "",
      updatedBy: "",
      remark: null,
      createdAt: new Date("2023-06-07 09:41:46"),
      updatedAt: new Date("2023-06-07 09:41:46"),
    },
    {
      menuId: 1036n,
      menuName: "导入",
      parentId: 3n,
      orderNum: 5n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "system:user:import",
      icon: "",
      createdBy: "",
      updatedBy: "",
      remark: null,
      createdAt: new Date("2023-06-07 09:41:57"),
      updatedAt: new Date("2023-06-07 09:41:57"),
    },
    {
      menuId: 1037n,
      menuName: "パスワードリセット",
      parentId: 3n,
      orderNum: 6n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "U:user",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 09:42:14"),
      updatedAt: new Date("2025-08-18 16:07:17"),
    },
    {
      menuId: 1038n,
      menuName: "照会",
      parentId: 3n,
      orderNum: 0n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "R|user",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 10:57:46"),
      updatedAt: new Date("2025-08-18 16:03:48"),
    },
    {
      menuId: 1039n,
      menuName: "照会",
      parentId: 6n,
      orderNum: 1n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "R|role",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 10:58:15"),
      updatedAt: new Date("2025-08-18 16:05:01"),
    },
    {
      menuId: 1040n,
      menuName: "新規追加",
      parentId: 6n,
      orderNum: 2n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "C|role",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 10:58:30"),
      updatedAt: new Date("2025-08-18 16:04:09"),
    },
    {
      menuId: 1041n,
      menuName: "編集",
      parentId: 6n,
      orderNum: 3n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "U|role",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 10:58:46"),
      updatedAt: new Date("2025-08-18 16:05:45"),
    },
    {
      menuId: 1042n,
      menuName: "削除",
      parentId: 6n,
      orderNum: 4n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "D|role",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 10:59:03"),
      updatedAt: new Date("2025-08-18 16:06:21"),
    },
    {
      menuId: 1044n,
      menuName: "メニュー照会",
      parentId: 4n,
      orderNum: 1n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "R|menu",
      icon: "",
      createdBy: "",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2023-06-07 11:01:13"),
      updatedAt: new Date("2025-08-20 17:33:08"),
    },
    {
      menuId: 1045n,
      menuName: "新規追加",
      parentId: 4n,
      orderNum: 2n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "C|menu",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:01:33"),
      updatedAt: new Date("2025-08-18 16:04:14"),
    },
    {
      menuId: 1046n,
      menuName: "編集",
      parentId: 4n,
      orderNum: 3n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "U|menu",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:01:46"),
      updatedAt: new Date("2025-08-18 16:05:50"),
    },
    {
      menuId: 1047n,
      menuName: "削除",
      parentId: 4n,
      orderNum: 4n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "D|menu",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:01:59"),
      updatedAt: new Date("2025-08-18 16:06:26"),
    },
    {
      menuId: 1048n,
      menuName: "照会",
      parentId: 1018n,
      orderNum: 1n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "C|dept",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:03:01"),
      updatedAt: new Date("2025-08-18 16:05:11"),
    },
    {
      menuId: 1049n,
      menuName: "新規追加",
      parentId: 1018n,
      orderNum: 2n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "C|dept",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:03:12"),
      updatedAt: new Date("2025-08-18 16:04:18"),
    },
    {
      menuId: 1050n,
      menuName: "編集",
      parentId: 1018n,
      orderNum: 3n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "U|dept",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:03:24"),
      updatedAt: new Date("2025-08-18 16:05:55"),
    },
    {
      menuId: 1051n,
      menuName: "削除",
      parentId: 1018n,
      orderNum: 4n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "D|dept",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:03:34"),
      updatedAt: new Date("2025-08-18 16:06:31"),
    },
    {
      menuId: 1052n,
      menuName: "照会",
      parentId: 1020n,
      orderNum: 1n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "R|post",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:03:54"),
      updatedAt: new Date("2025-08-18 16:05:16"),
    },
    {
      menuId: 1053n,
      menuName: "新規追加",
      parentId: 1020n,
      orderNum: 2n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "C|post",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:04:07"),
      updatedAt: new Date("2025-08-18 16:04:31"),
    },
    {
      menuId: 1054n,
      menuName: "編集",
      parentId: 1020n,
      orderNum: 3n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "U|post",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:04:17"),
      updatedAt: new Date("2025-08-18 16:06:00"),
    },
    {
      menuId: 1055n,
      menuName: "削除",
      parentId: 1020n,
      orderNum: 4n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "D|post",
      icon: "",
      createdBy: "",
      updatedBy: "super",
      remark: null,
      createdAt: new Date("2023-06-07 11:04:29"),
      updatedAt: new Date("2025-08-18 16:06:36"),
    },
    {
      menuId: 1225n,
      menuName: "チャット",
      parentId: 0n,
      orderNum: 1n,
      path: "/chat",
      component: "index",
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "C",
      visible: "0",
      status: "0",
      perms: "R|CHAT_GEN",
      icon: "message",
      createdBy: "",
      updatedBy: "admin",
      remark: null,
      createdAt: new Date("2025-08-18 18:01:09"),
      updatedAt: new Date("2026-01-19 06:33:04"),
    },
    {
      menuId: 1231n,
      menuName: "チャット",
      parentId: 1225n,
      orderNum: 1n,
      path: "",
      component: null,
      query: null,
      isFrame: 1n,
      isCache: 0n,
      menuType: "F",
      visible: "0",
      status: "0",
      perms: "C|QUESTION_GEN",
      icon: "",
      createdBy: "",
      updatedBy: "",
      remark: null,
      createdAt: new Date("2025-08-19 11:31:13"),
      updatedAt: new Date("2025-08-19 11:31:13"),
    },
  ];

  for (const menu of menus) {
    await prisma.sysMenu.upsert({
      where: { menuId: menu.menuId },
      update: menu,
      create: menu,
    });
  }
}

/**
 * Seed sys_dict_type table
 * 
 * Dictionary types define categories for sys_dict_data entries.
 * Examples: sys_user_sex, sys_show_hide, sys_normal_disable, etc.
 */
async function seedDictTypes() {
  const dictTypes = [
    {
      dictId: 10n,
      dictName: "メニュー状態",
      dictType: "sys_show_hide",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "メニュー状態リスト",
      createdAt: new Date("2023-04-03 13:44:50"),
      updatedAt: new Date("2023-06-14 14:36:47"),
    },
    {
      dictId: 11n,
      dictName: "システムスイッチ",
      dictType: "sys_normal_disable",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "システムスイッチリスト",
      createdAt: new Date("2023-04-03 15:53:07"),
      updatedAt: new Date("2023-05-26 14:16:27"),
    },
    {
      dictId: 23n,
      dictName: "パラメータ設定の有無",
      dictType: "sys_yes_no",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "パラメータ設定の有無",
      createdAt: new Date("2023-05-30 14:57:36"),
      updatedAt: new Date("2023-05-30 14:57:36"),
    },
    {
      dictId: 24n,
      dictName: "通知タイプ",
      dictType: "sys_notice_type",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "通知タイプリスト",
      createdAt: new Date("2023-05-30 15:26:45"),
      updatedAt: new Date("2023-05-30 15:26:45"),
    },
    {
      dictId: 25n,
      dictName: "通知状態",
      dictType: "sys_notice_status",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "通知状態リスト",
      createdAt: new Date("2023-05-30 15:28:54"),
      updatedAt: new Date("2023-05-30 15:28:54"),
    },
    {
      dictId: 26n,
      dictName: "システム状態",
      dictType: "sys_common_status",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "ログイン状態リスト",
      createdAt: new Date("2023-05-30 16:52:47"),
      updatedAt: new Date("2023-05-30 16:52:47"),
    },
    {
      dictId: 27n,
      dictName: "操作タイプ",
      dictType: "sys_oper_type",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "操作タイプリスト",
      createdAt: new Date("2023-05-30 16:53:44"),
      updatedAt: new Date("2023-05-30 16:53:44"),
    },
    {
      dictId: 29n,
      dictName: "タスク状態",
      dictType: "sys_job_status",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "タスク状態リスト",
      createdAt: new Date("2023-06-19 09:19:31"),
      updatedAt: new Date("2023-06-19 09:19:31"),
    },
    {
      dictId: 30n,
      dictName: "タスクグループ",
      dictType: "sys_job_group",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "タスクグループリスト",
      createdAt: new Date("2023-06-19 09:19:46"),
      updatedAt: new Date("2023-06-19 09:19:46"),
    },
  ];

  for (const dictType of dictTypes) {
    await prisma.sysDictType.upsert({
      where: { dictId: dictType.dictId },
      update: dictType,
      create: dictType,
    });
  }
}

/**
 * Seed sys_dict_data table
 * 
 * Dictionary data entries provide enumeration values for dropdowns and selects.
 * Examples: Male/Female, Active/Inactive, Create/Update/Delete operations, etc.
 */
async function seedDictData() {
  const dictData = [
    // Gender options
    {
      dictCode: 1n,
      dictSort: 1n,
      dictLabel: "男",
      dictValue: "0",
      dictType: "sys_user_sex",
      cssClass: null,
      listClass: "empty",
      isDefault: "1", // YES
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "男性",
      createdAt: new Date("2023-04-03 15:55:59"),
      updatedAt: new Date("2023-04-21 09:10:23"),
    },
    {
      dictCode: 2n,
      dictSort: 2n,
      dictLabel: "女",
      dictValue: "1",
      dictType: "sys_user_sex",
      cssClass: null,
      listClass: "empty",
      isDefault: "1",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "女性",
      createdAt: new Date("2023-04-03 15:55:59"),
      updatedAt: new Date("2023-04-21 09:10:27"),
    },
    {
      dictCode: 3n,
      dictSort: 3n,
      dictLabel: "不明",
      dictValue: "2",
      dictType: "sys_user_sex",
      cssClass: null,
      listClass: "empty",
      isDefault: "1",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "不明",
      createdAt: new Date("2023-04-03 15:55:59"),
      updatedAt: new Date("2023-04-24 09:14:14"),
    },
    // Menu visibility
    {
      dictCode: 6n,
      dictSort: 1n,
      dictLabel: "表示",
      dictValue: "0",
      dictType: "sys_show_hide",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "メニュー表示",
      createdAt: new Date("2023-04-04 14:18:22"),
      updatedAt: new Date("2023-07-08 09:05:43"),
    },
    {
      dictCode: 7n,
      dictSort: 2n,
      dictLabel: "非表示",
      dictValue: "1",
      dictType: "sys_show_hide",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "メニュー非表示",
      createdAt: new Date("2023-04-04 14:22:39"),
      updatedAt: new Date("2023-07-08 09:05:16"),
    },
    // Normal/Disable status
    {
      dictCode: 8n,
      dictSort: 1n,
      dictLabel: "正常",
      dictValue: "0",
      dictType: "sys_normal_disable",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "正常状態",
      createdAt: new Date("2023-04-04 14:24:22"),
      updatedAt: new Date("2023-04-10 17:08:21"),
    },
    {
      dictCode: 9n,
      dictSort: 2n,
      dictLabel: "停止",
      dictValue: "1",
      dictType: "sys_normal_disable",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "停止状態",
      createdAt: new Date("2023-04-04 14:25:27"),
      updatedAt: new Date("2023-04-10 17:23:27"),
    },
    // Yes/No options
    {
      dictCode: 41n,
      dictSort: 1n,
      dictLabel: "はい",
      dictValue: "Y",
      dictType: "sys_yes_no",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "パラメータ設定のデフォルトは「はい」",
      createdAt: new Date("2023-05-30 14:58:20"),
      updatedAt: new Date("2023-05-30 14:58:20"),
    },
    {
      dictCode: 42n,
      dictSort: 2n,
      dictLabel: "いいえ",
      dictValue: "N",
      dictType: "sys_yes_no",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "パラメータ設定のデフォルトは「いいえ」",
      createdAt: new Date("2023-05-30 14:58:46"),
      updatedAt: new Date("2023-05-30 14:58:46"),
    },
    // Notice types
    {
      dictCode: 43n,
      dictSort: 1n,
      dictLabel: "通知",
      dictValue: "1",
      dictType: "sys_notice_type",
      cssClass: null,
      listClass: "warning",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "通知",
      createdAt: new Date("2023-05-30 15:27:14"),
      updatedAt: new Date("2023-05-30 15:27:14"),
    },
    {
      dictCode: 44n,
      dictSort: 2n,
      dictLabel: "公告",
      dictValue: "2",
      dictType: "sys_notice_type",
      cssClass: null,
      listClass: "success",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "公告",
      createdAt: new Date("2023-05-30 15:27:31"),
      updatedAt: new Date("2023-05-30 15:27:31"),
    },
    // Notice status
    {
      dictCode: 45n,
      dictSort: 1n,
      dictLabel: "正常",
      dictValue: "0",
      dictType: "sys_notice_status",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "正常状態",
      createdAt: new Date("2023-05-30 15:29:12"),
      updatedAt: new Date("2023-05-30 15:29:12"),
    },
    {
      dictCode: 46n,
      dictSort: 2n,
      dictLabel: "停止",
      dictValue: "1",
      dictType: "sys_notice_status",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "停止状態",
      createdAt: new Date("2023-05-30 15:29:29"),
      updatedAt: new Date("2023-05-30 15:29:29"),
    },
    // Common status
    {
      dictCode: 47n,
      dictSort: 1n,
      dictLabel: "成功",
      dictValue: "0",
      dictType: "sys_common_status",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "成功状態",
      createdAt: new Date("2023-05-30 16:53:09"),
      updatedAt: new Date("2023-05-30 16:53:09"),
    },
    {
      dictCode: 48n,
      dictSort: 2n,
      dictLabel: "失敗",
      dictValue: "1",
      dictType: "sys_common_status",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "失敗状態",
      createdAt: new Date("2023-05-30 16:53:24"),
      updatedAt: new Date("2023-06-12 14:57:40"),
    },
    // Operation types
    {
      dictCode: 49n,
      dictSort: 1n,
      dictLabel: "新規追加",
      dictValue: "1",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "default",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "新規追加操作",
      createdAt: new Date("2023-05-30 16:54:41"),
      updatedAt: new Date("2023-05-30 16:54:41"),
    },
    {
      dictCode: 50n,
      dictSort: 2n,
      dictLabel: "更新",
      dictValue: "2",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "default",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "更新操作",
      createdAt: new Date("2023-05-30 16:55:01"),
      updatedAt: new Date("2023-05-30 16:55:01"),
    },
    {
      dictCode: 51n,
      dictSort: 3n,
      dictLabel: "削除",
      dictValue: "3",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "削除操作",
      createdAt: new Date("2023-05-30 16:55:17"),
      updatedAt: new Date("2023-05-30 16:55:17"),
    },
    {
      dictCode: 52n,
      dictSort: 4n,
      dictLabel: "権限付与",
      dictValue: "4",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "権限付与操作",
      createdAt: new Date("2023-05-30 16:55:33"),
      updatedAt: new Date("2023-05-30 16:55:33"),
    },
    {
      dictCode: 53n,
      dictSort: 5n,
      dictLabel: "エクスポート",
      dictValue: "5",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "warning",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "エクスポート操作",
      createdAt: new Date("2023-05-30 16:55:47"),
      updatedAt: new Date("2023-05-30 16:55:53"),
    },
    {
      dictCode: 54n,
      dictSort: 6n,
      dictLabel: "インポート",
      dictValue: "6",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "warning",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "インポート操作",
      createdAt: new Date("2023-05-30 16:56:09"),
      updatedAt: new Date("2023-05-30 16:56:09"),
    },
    {
      dictCode: 55n,
      dictSort: 7n,
      dictLabel: "強制ログアウト",
      dictValue: "7",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "強制ログアウト操作",
      createdAt: new Date("2023-05-30 16:56:30"),
      updatedAt: new Date("2023-05-30 16:56:30"),
    },
    {
      dictCode: 56n,
      dictSort: 8n,
      dictLabel: "コード生成",
      dictValue: "8",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "warning",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "生成操作",
      createdAt: new Date("2023-05-30 16:56:49"),
      updatedAt: new Date("2023-05-30 16:56:49"),
    },
    {
      dictCode: 58n,
      dictSort: 99n,
      dictLabel: "その他",
      dictValue: "0",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "default",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "その他の操作",
      createdAt: new Date("2023-05-30 16:57:33"),
      updatedAt: new Date("2023-06-14 14:39:36"),
    },
    {
      dictCode: 59n,
      dictSort: 9n,
      dictLabel: "データクリア",
      dictValue: "9",
      dictType: "sys_oper_type",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: "admin",
      remark: "データクリア操作",
      createdAt: new Date("2023-06-14 11:39:42"),
      updatedAt: new Date("2023-06-14 11:39:49"),
    },
    // Job status
    {
      dictCode: 60n,
      dictSort: 1n,
      dictLabel: "正常",
      dictValue: "0",
      dictType: "sys_job_status",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "正常状態",
      createdAt: new Date("2023-06-19 09:20:13"),
      updatedAt: new Date("2023-06-19 09:20:13"),
    },
    {
      dictCode: 61n,
      dictSort: 2n,
      dictLabel: "停止",
      dictValue: "1",
      dictType: "sys_job_status",
      cssClass: null,
      listClass: "error",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "停止状態",
      createdAt: new Date("2023-06-19 09:20:34"),
      updatedAt: new Date("2023-06-19 09:20:34"),
    },
    // Job groups
    {
      dictCode: 62n,
      dictSort: 1n,
      dictLabel: "デフォルト",
      dictValue: "DEFAULT",
      dictType: "sys_job_group",
      cssClass: null,
      listClass: "processing",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "デフォルトグループ",
      createdAt: new Date("2023-06-19 09:21:38"),
      updatedAt: new Date("2023-06-19 09:21:38"),
    },
    {
      dictCode: 63n,
      dictSort: 2n,
      dictLabel: "システム",
      dictValue: "SYSTEM",
      dictType: "sys_job_group",
      cssClass: null,
      listClass: "success",
      isDefault: "0",
      status: "0",
      createdBy: "admin",
      updatedBy: null,
      remark: "システムグループ",
      createdAt: new Date("2023-06-19 09:21:58"),
      updatedAt: new Date("2023-06-19 09:21:58"),
    },
  ];

  for (const data of dictData) {
    await prisma.sysDictData.upsert({
      where: { dictCode: data.dictCode },
      update: data,
      create: data,
    });
  }
}

// ============================================================================
// SEED PHASE 4: CONFIGURATION
// ============================================================================

/**
 * Seed sys_config table
 * 
 * System-wide configuration parameters:
 * - Initial password for new users
 * - UI theme colors and styles
 * - Feature flags (user registration, etc.)
 */
async function seedConfig() {
  const configs = [
    {
      configId: 1,
      configName: "-",
      configKey: "sys.user.initPassword",
      configValue: "123456",
      configType: "Y", // BUILT_IN
      createdBy: "admin",
      createdAt: new Date("2023-05-30 15:08:37"),
      updatedBy: "admin",
      updatedAt: new Date("2023-08-17 15:13:45"),
      remark: "初期パスワード 123456",
    },
    {
      configId: 2,
      configName: "-",
      configKey: "sys.index.skinName",
      configValue: "#1890ff",
      configType: "Y",
      createdBy: "admin",
      createdAt: new Date("2023-05-30 15:14:16"),
      updatedBy: "admin",
      updatedAt: new Date("2023-08-17 16:01:20"),
      remark: "16進カラーコード対応",
    },
    {
      configId: 3,
      configName: "-",
      configKey: "sys.index.headerTheme",
      configValue: "darkBlue",
      configType: "Y",
      createdBy: "admin",
      createdAt: new Date("2023-05-30 15:19:10"),
      updatedBy: "admin",
      updatedAt: new Date("2023-08-17 16:01:08"),
      remark: "pink、darkGreen、cornflowerBlue、goldenrod、darkBlue",
    },
    {
      configId: 4,
      configName: "-",
      configKey: "sys.account.registerUser",
      configValue: "false",
      configType: "Y",
      createdBy: "admin",
      createdAt: new Date("2023-05-30 15:19:39"),
      updatedBy: "admin",
      updatedAt: new Date("2023-08-17 14:28:09"),
      remark: "ユーザー登録機能を有効にするか（true: 有効、false: 無効）",
    },
  ];

  for (const config of configs) {
    await prisma.sysConfig.upsert({
      where: { configId: config.configId },
      update: config,
      create: config,
    });
  }
}

// ============================================================================
// EXECUTION
// ============================================================================

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
