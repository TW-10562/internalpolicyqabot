import IndexCon from '@/controller';
import { usePermission } from '@/controller/auth';
import { formatHandle } from '@/controller/common';
import { add, addFileRole, addUserRole, del, getDetail, getList, put, updateRoleStatus } from '@/controller/role';
import { addEditSchema, judgeIdSchema } from '@/schemas';
import PERMISSIONS from '@/utils/permissions';
import Joi from 'joi';
import Router from 'koa-router';

export const addJudg = Joi.object({
    roleName: Joi.string().required(),
    roleKey: Joi.string().required(),
    status: Joi.string().required(),
    roleSort: Joi.number().required(),
    menuIds: Joi.array(),
    remark: Joi.any(),
});

export const putJudg = Joi.object({
    roleId: Joi.number().required(),
    roleName: Joi.string().required(),
    roleKey: Joi.string().required(),
    roleSort: Joi.number().required(),
    status: Joi.string().required(),
    menuIds: Joi.array(),
    remark: Joi.any(),
});

const router = new Router({ prefix: '/roles' });

router.get('/', usePermission(PERMISSIONS.READ_ROLE), getList, formatHandle, IndexCon());

router.post('/', usePermission(PERMISSIONS.CREATE_ROLE), addEditSchema(addJudg), add, IndexCon());

router.put('/', usePermission(PERMISSIONS.UPDATE_ROLE), addEditSchema(putJudg), put, IndexCon());

router.delete('/role/:id', usePermission(PERMISSIONS.DELETE_ROLE), judgeIdSchema(), del, IndexCon());

router.get('/role/:id', usePermission(PERMISSIONS.READ_ROLE), judgeIdSchema(), getDetail, formatHandle, IndexCon());

router.put('/role/status', usePermission(PERMISSIONS.UPDATE_ROLE), updateRoleStatus, IndexCon());

router.post('/user/bind', usePermission(PERMISSIONS.UPDATE_ROLE), addUserRole, IndexCon());

router.post('/file/bind', usePermission(PERMISSIONS.UPDATE_ROLE), addFileRole, IndexCon());

export default router;
