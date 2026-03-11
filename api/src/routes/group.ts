import IndexCon from '@/controller';
import { getAllGroups, populateTestData, createGroup, updateGroup, deleteGroup } from '@/controller/group';
import Router from 'koa-router';

const router = new Router({ prefix: '/group' });

router.get('/list', getAllGroups, IndexCon('グループ一覧を取得成功しました'));
router.post('/create', createGroup, IndexCon('グループを作成成功しました'));
router.put('/:id', updateGroup, IndexCon('グループを更新成功しました'));
router.delete('/:id', deleteGroup, IndexCon('グループを削除成功しました'));
router.post('/populate-test-data', populateTestData, IndexCon('テストデータを作成しました'));

export default router;
