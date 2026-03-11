import IndexCon from '@/controller';
import Router from 'koa-router';
import { loginByEmployeeId, logoutByToken } from '@/controller/apiAuth';

const router = new Router({ prefix: '/api/auth' });

router.post('/login', loginByEmployeeId, IndexCon('ログイン成功しました'));
router.post('/logout', logoutByToken, IndexCon('ログアウトしました'));

export default router;
