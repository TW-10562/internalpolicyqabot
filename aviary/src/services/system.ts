import { ConfigService } from "@aviary-ai/governance-config";
import { MySQLConfigRepository } from "@aviary-ai/governance-config-mysql";
import {
    DictTypeService,
    DictDataService,
    DeptService,
    PostService,
} from "@aviary-ai/domain-meta";
import {
    MySQLDictTypeRepository,
    MySQLDictDataRepository,
    MySQLDeptRepository,
    MySQLPostRepository,
} from "@aviary-ai/domain-meta-mysql";
import { RoleService, MenuService, SystemUserService } from "@aviary-ai/identity-management";
import {
    MySQLRoleRepository,
    MySQLMenuRepository,
    MySQLSystemUserRepository,
} from "@aviary-ai/identity-management-mysql";
import { sequelize } from "../database";

const configRepo = new MySQLConfigRepository(sequelize);
export const configService = new ConfigService(configRepo);

const dictTypeRepo = new MySQLDictTypeRepository(sequelize);
const dictDataRepo = new MySQLDictDataRepository(sequelize);
const deptRepo = new MySQLDeptRepository(sequelize);
const postRepo = new MySQLPostRepository(sequelize);

export const dictTypeService = new DictTypeService(dictTypeRepo);
export const dictDataService = new DictDataService(dictDataRepo);
export const deptService = new DeptService(deptRepo);
export const postService = new PostService(postRepo);

const queryInterface = sequelize.getQueryInterface();
const roleRepo = new MySQLRoleRepository({ queryInterface });
const menuRepo = new MySQLMenuRepository({ queryInterface });
const systemUserRepo = new MySQLSystemUserRepository({ queryInterface });

export const roleService = new RoleService(roleRepo);
export const menuService = new MenuService(menuRepo);
export const systemUserService = new SystemUserService(systemUserRepo, postRepo, roleRepo);
