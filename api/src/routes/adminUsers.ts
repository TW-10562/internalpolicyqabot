import IndexCon from '@/controller';
import Router from 'koa-router';
import {
  createAdminUserController,
  deleteAdminUserController,
  getAdminUsers,
  importAdminUsersCsvController,
  permanentlyDeleteAdminUserController,
  restoreAdminUserController,
  updateAdminUserController,
} from '@/controller/adminUser';
import { requireScopedAccess, requireUserManager } from '@/controller/auth';

const router = new Router({ prefix: '/api/admin/users' });

router.get('/', requireScopedAccess, requireUserManager, getAdminUsers, IndexCon());
router.post('/', requireScopedAccess, requireUserManager, createAdminUserController, IndexCon('ユーザーを作成しました'));
router.put('/:userId', requireScopedAccess, requireUserManager, updateAdminUserController, IndexCon('ユーザーを更新しました'));
router.post('/:userId/restore', requireScopedAccess, requireUserManager, restoreAdminUserController, IndexCon('ユーザーを復元しました'));
router.delete('/:userId', requireScopedAccess, requireUserManager, deleteAdminUserController, IndexCon('ユーザーを削除しました'));
router.delete('/:userId/permanent-delete', requireScopedAccess, requireUserManager, permanentlyDeleteAdminUserController, IndexCon('ユーザーを完全削除しました'));
router.post('/import-csv', requireScopedAccess, requireUserManager, importAdminUsersCsvController, IndexCon('CSV 取込完了'));

export default router;
