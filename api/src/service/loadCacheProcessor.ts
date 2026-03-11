import type { CacheProcessor } from '@/types/cacheProcessor';

export async function loadCacheProcessor(useFaqCache: boolean): Promise<CacheProcessor> {
  try {
    // If useFaqCache is true, load useFaqCache module; otherwise, use default splitByPage
    const moduleName = useFaqCache ? 'useFaqCache' : 'splitByPage';
    const mod = await import(`@/ragclass/${moduleName}.ts`);
    const Cls = mod.default;

    if (typeof Cls !== "function") {
      throw new Error(`${moduleName} の default export がクラスではありません`);
    }
    const instance: unknown = new Cls();

    if (typeof (instance as any).search !== "function") {
      throw new Error(`${moduleName} は search() メソッドを実装してください`);
    }
    
    if (!useFaqCache && typeof (instance as any).upload !== "function") {
      throw new Error(`${moduleName} は upload() と search() の両方を実装してください`);
    }
    return instance as CacheProcessor;
  } catch (e: any) {
    throw new Error(`Cache 実装を読み込めません: ${e.message}`);
  }
}