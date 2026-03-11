import fs from 'fs';
import Router from 'koa-router';

const router = new Router();

async function registerRouter(basePath: string) {
  const files = (await fs.promises.readdir(basePath)).sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const filePath = `${basePath}/${file}`;
    // eslint-disable-next-line no-await-in-loop
    const stats = await fs.promises.stat(filePath);

    if (stats.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      await registerRouter(filePath);
    } else if (stats.isFile() && !file.includes('index') && /\.(ts|js)$/.test(file)) {
      // eslint-disable-next-line no-await-in-loop
      const { default: r } = await import(filePath);
      router.use(r.routes());
      // allowedMethods is optional on some routers; safe guard:
      if (typeof r.allowedMethods === 'function') router.use(r.allowedMethods());
    }
  }
}

/** Call this once in main.ts BEFORE app.listen */
export async function initRoutes() {
  await registerRouter(__dirname);
  return router;
}

export default router;
