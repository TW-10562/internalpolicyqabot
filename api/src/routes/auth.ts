import IndexCon from '@/controller';
import {
  authCallback,
  authExchange,
  createUser,
  delUser,
  getAllUsers,
  getUserBase,
  getUserGroups,
  login,
  loginVal,
  logout,
  putUserStatus,
  putUserPassword,
  registerUser,
  queryUserInfo,
  updateUser,
} from '@/controller/user';
import { judgeIdSchema, userSchema } from '@/schemas/user';
import Router from 'koa-router';

const router = new Router({ prefix: '/user' });

router.post('/login', userSchema, loginVal, getUserBase, login, IndexCon('ログイン成功しました'));
router.post('/register', userSchema, registerUser, IndexCon('ユーザー登録成功しました'));

router.delete('/logout', logout, IndexCon('アカウントを退出しました'));

router.get('/getInfo', queryUserInfo, IndexCon('ユーザーの個人情報を取得成功しました'));

router.get('/list', getAllUsers, IndexCon('ユーザー一覧を取得成功しました'));

router.post('/create', createUser, IndexCon('ユーザーを作成成功しました'));

router.put('/update', updateUser, IndexCon('ユーザーを更新成功しました'));

router.delete('/:id', judgeIdSchema(), delUser, IndexCon('ユーザーを削除成功しました'));

router.put('/profile', putUserStatus, IndexCon('ユーザーのステータスを更新成功しました'));

router.put('/password', putUserPassword, IndexCon('ユーザーのパスワードを更新成功しました'));

router.get('/:userId/groups', getUserGroups, IndexCon('ユーザーグループを取得成功しました'));

router.get('/auth/callback', authCallback, IndexCon('認証コールバック成功しました'));

router.get('/auth/exchange', authExchange, IndexCon('認証エクスチェンジ成功しました'));

export default router;
