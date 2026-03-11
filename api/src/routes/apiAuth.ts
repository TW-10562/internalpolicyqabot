import IndexCon from '@/controller';
import Router from 'koa-router';
import { loginByEmployeeId, logoutByToken } from '@/controller/apiAuth';
import { loginWithMicrosoftMock } from '@/controller/ssoAuth';

const router = new Router({ prefix: '/api/auth' });

router.post('/login', loginByEmployeeId, IndexCon('ログイン成功しました'));
router.post('/sso/microsoft/mock', loginWithMicrosoftMock, IndexCon('SSO ログイン成功しました'));
router.post('/logout', logoutByToken, IndexCon('ログアウトしました'));

export default router;
