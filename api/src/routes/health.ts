import Router from 'koa-router';
import { getDbStatus } from '@/db/adapter';

const router = new Router();

const healthHandler = async (ctx: any) => {
  const db = await getDbStatus();
  ctx.body = {
    status: 'ok',
    db,
    timestamp: new Date().toISOString(),
  };
};

router.get('/health', healthHandler);
router.get('/healthz', healthHandler);
router.get('/readyz', healthHandler);

export default router;
