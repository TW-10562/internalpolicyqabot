import Router from 'koa-router';
import IndexCon from '@/controller';
import {
  createAdminUserController,
  importAdminUsersCsvController,
  bulkDeleteAdminUsersController,
  deleteAdminUserController,
  getAdminUsers,
  updateAdminUserController,
} from '@/controller/adminUser';
import { requireRole, requireScopedAccess, requireUserManager } from '@/controller/auth';

const router = new Router({ prefix: '/api/users' });

router.get('/', requireScopedAccess, requireUserManager, getAdminUsers, IndexCon());
router.post('/', requireScopedAccess, requireUserManager, createAdminUserController, IndexCon('ユーザーを作成しました'));
router.post('/upload-csv', requireScopedAccess, requireUserManager, importAdminUsersCsvController, IndexCon('CSV 取込完了'));
router.delete('/bulk-delete', requireScopedAccess, requireRole('SUPER_ADMIN'), bulkDeleteAdminUsersController, IndexCon());
router.patch('/:userId', requireScopedAccess, requireUserManager, updateAdminUserController, IndexCon('ユーザーを更新しました'));
router.delete('/:userId', requireScopedAccess, requireUserManager, deleteAdminUserController, IndexCon('ユーザーを削除しました'));

export default router;
