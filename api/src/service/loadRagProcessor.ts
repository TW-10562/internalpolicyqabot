import type { RAGProcessor } from '@/types/ragProcessor.ts';

export async function loadRagProcessor(mode: string): Promise<RAGProcessor> {
  const candidates = [
    `@/ragclass/${mode}.ts`,
    `@/ragclass/${mode}`,
    `../ragclass/${mode}.js`,
    `../ragclass/${mode}`,
  ];
  const errors: string[] = [];

  try {
    for (const spec of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const mod = await import(spec);
        const Cls = mod.default;

        if (typeof Cls !== 'function') {
          errors.push(`${spec}: default export is not a class`);
          continue;
        }

        const instance: unknown = new Cls();
        if (typeof (instance as any).upload !== 'function' || typeof (instance as any).search !== 'function') {
          errors.push(`${spec}: missing upload()/search()`);
          continue;
        }

        return instance as RAGProcessor;
      } catch (e: any) {
        errors.push(`${spec}: ${e?.message || String(e)}`);
      }
    }
    throw new Error(errors.join(' | '));
  } catch (e: any) {
    throw new Error(`RAG 実装 "${mode}" を読み込めません: ${e?.message || String(e)}`);
  }
}
