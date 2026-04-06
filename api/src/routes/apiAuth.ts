import IndexCon from '@/controller';
import Router from 'koa-router';
import { loginByEmployeeId, logoutByToken, getCurrentUser } from '@/controller/apiAuth';
import { loginWithMicrosoft, loginWithMicrosoftMock } from '@/controller/ssoAuth';

const router = new Router({ prefix: '/api/auth' });

router.get('/me', getCurrentUser, IndexCon('ユーザー情報取得成功'));
router.post('/login', loginByEmployeeId, IndexCon('ログイン成功しました'));
router.post('/sso/microsoft', loginWithMicrosoft, IndexCon('SSO ログイン成功しました'));
router.post('/sso/microsoft/mock', loginWithMicrosoftMock, IndexCon('SSO ログイン成功しました'));
router.post('/logout', logoutByToken, IndexCon('ログアウトしました'));

export default router;
