import Router from 'koa-router';
import { requireScopedAccess } from '@/controller/auth';
import { findRagTraceByTaskOutput, getRagPerfSummary } from '@/service/ragPerf';
import { getQueryEventMetricsByTaskOutput } from '@/service/analyticsService';

const router = new Router({ prefix: '/api/rag' });

router.get('/metrics', requireScopedAccess, async (ctx: any) => {
  ctx.body = {
    ok: true,
    data: getRagPerfSummary(),
    error: null,
  };
});

router.get('/trace', requireScopedAccess, async (ctx: any) => {
  const taskId = String(ctx.query?.taskId || '').trim();
  const outputIdRaw = Number(ctx.query?.outputId);
  if (!taskId || !Number.isFinite(outputIdRaw) || outputIdRaw <= 0) {
    ctx.status = 400;
    ctx.body = { ok: false, data: null, error: 'taskId and outputId are required' };
    return;
  }

  const trace = findRagTraceByTaskOutput(taskId, outputIdRaw);
  ctx.body = {
    ok: true,
    data: trace,
    error: null,
  };
});

router.get('/kpi', requireScopedAccess, async (ctx: any) => {
  const outputIdRaw = Number(ctx.query?.outputId);
  if (!Number.isFinite(outputIdRaw) || outputIdRaw <= 0) {
    ctx.status = 400;
    ctx.body = { ok: false, data: null, error: 'outputId is required' };
    return;
  }

  const metrics = await getQueryEventMetricsByTaskOutput(outputIdRaw);
  ctx.body = {
    ok: true,
    data: metrics,
    error: null,
  };
});

export default router;
