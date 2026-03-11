import IndexCon from '@/controller';
import { usePermission } from '@/controller/auth';
import { formatHandle } from '@/controller/common';
import { addMenuCtl, delMenuCtl, getDetailCtl, getMenusCtl, putCtl } from '@/controller/menu';
import { addJudg, putJudg } from '@/routes/role';
import { addEditSchema, judgeIdSchema } from '@/schemas';
import PERMISSIONS from '@/utils/permissions';
import Router from 'koa-router';

const router = new Router({ prefix: '/menus' });

router.get('/list', usePermission(PERMISSIONS.READ_MENU), getMenusCtl, formatHandle, IndexCon());
router.post('/', usePermission(PERMISSIONS.CREATE_MENU), addEditSchema(addJudg), addMenuCtl, IndexCon());
router.delete('/:id', usePermission(PERMISSIONS.DELETE_MENU), judgeIdSchema(), delMenuCtl, IndexCon());
router.get('/:id', usePermission(PERMISSIONS.READ_MENU), judgeIdSchema(), getDetailCtl, formatHandle, IndexCon());
router.put('/', usePermission(PERMISSIONS.UPDATE_MENU), addEditSchema(putJudg), putCtl, IndexCon());

export default router;
