import Router from 'koa-router';
import { getDbStatus } from '@/db/adapter';
import { openaiClient } from '@/service/openai_client';

const router = new Router();

// Cache LLM status to avoid hammering the model on every health poll
let llmStatusCache: { healthy: boolean; checkedAt: number } | null = null;
const LLM_CACHE_TTL_MS = 30_000; // re-check every 30s

const getLlmStatus = async (): Promise<boolean> => {
  if (llmStatusCache && Date.now() - llmStatusCache.checkedAt < LLM_CACHE_TTL_MS) {
    return llmStatusCache.healthy;
  }
  try {
    const healthy = await openaiClient.ping();
    llmStatusCache = { healthy, checkedAt: Date.now() };
    return healthy;
  } catch {
    llmStatusCache = { healthy: false, checkedAt: Date.now() };
    return false;
  }
};

const healthHandler = async (ctx: any) => {
  const db = await getDbStatus();
  const llm = await getLlmStatus();
  ctx.body = {
    status: db && llm ? 'ok' : 'degraded',
    db,
    llm,
    timestamp: new Date().toISOString(),
  };
};

router.get('/health', healthHandler);
router.get('/healthz', healthHandler);
router.get('/readyz', healthHandler);

export default router;
