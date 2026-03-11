import IndexCon from '@/controller';
import { formatHandle } from '@/controller/common';
import { deleteMid, executeMid, getListMid, getMid, upsertMid } from '@/controller/flow';
import Router from 'koa-router';

const router = new Router({ prefix: '/api/flows' });

router.get('/', getListMid, formatHandle, IndexCon());

router.get('/:id', getMid, formatHandle, IndexCon());

router.post('/', upsertMid, formatHandle, IndexCon());

router.delete('/:id', deleteMid, IndexCon());

router.post('/execute', executeMid, IndexCon());

export default router;
