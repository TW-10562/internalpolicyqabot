import { config } from '@config/index';

let ensurePromise: Promise<void> | null = null;

const postSchemaUpdate = async (
  baseUrl: string,
  core: string,
  payload: Record<string, any>,
): Promise<{ ok: boolean; message: string }> => {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/solr/${encodeURIComponent(core)}/schema`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const bodyText = await response.text();
    if (response.ok) {
      return { ok: true, message: 'ok' };
    }

    const lower = String(bodyText || '').toLowerCase();
    const alreadyExists =
      lower.includes('already exists') ||
      lower.includes('duplicate') ||
      lower.includes('copy field') ||
      lower.includes('cannot add') ||
      lower.includes('exists');

    if (alreadyExists) {
      return { ok: true, message: 'already_exists' };
    }
    return { ok: false, message: `http_${response.status}: ${bodyText}` };
  } catch (error: any) {
    return { ok: false, message: String(error?.message || error) };
  }
};

export const ensureSolrJapaneseAnalyzer = async (
  onLog?: (event: string, payload?: Record<string, any>) => void,
): Promise<void> => {
  const enabled = String(process.env.RAG_SOLR_ENSURE_JA_ANALYZER ?? '1') !== '0';
  if (!enabled) return;

  if (!ensurePromise) {
    ensurePromise = (async () => {
      const baseUrl = String(config?.ApacheSolr?.url || process.env.SOLR_URL || '').trim();
      const core = String(config?.ApacheSolr?.coreName || process.env.SOLR_CORE_NAME || 'mycore').trim();
      if (!baseUrl || !core) return;

      const dynamicFieldRes = await postSchemaUpdate(baseUrl, core, {
        'add-dynamic-field': {
          name: '*_txt_ja',
          type: 'text_ja',
          stored: false,
          indexed: true,
          multiValued: true,
        },
      });

      const copyFieldRes = await postSchemaUpdate(baseUrl, core, {
        'add-copy-field': {
          source: '*_txt',
          dest: '*_txt_ja',
          maxChars: 100000,
        },
      });

      const log = onLog || (() => undefined);
      log('solr_japanese_analyzer_ensure', {
        dynamic_field: dynamicFieldRes.message,
        copy_field: copyFieldRes.message,
      });
    })();
  }

  await ensurePromise;
};
