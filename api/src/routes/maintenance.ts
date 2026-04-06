import Router from 'koa-router';
import fs from 'fs';
import path from 'path';

const router = new Router();

const MAINTENANCE_FILE = path.resolve(__dirname, '../../data/maintenance.json');

router.get('/api/maintenance', async (ctx) => {
  try {
    const raw = fs.readFileSync(MAINTENANCE_FILE, 'utf-8');
    ctx.body = JSON.parse(raw);
  } catch {
    ctx.body = { active: false };
  }
});

export default router;
