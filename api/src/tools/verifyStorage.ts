import '@/config/env';
import fs from 'node:fs/promises';
import path from 'node:path';
import Redis from 'ioredis';
import { pgPool } from '@/clients/postgres';
import { config } from '@/config/index';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

const results: CheckResult[] = [];

const push = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  const tag = ok ? 'OK  ' : 'FAIL';
  console.log(`[${tag}] ${name}: ${detail}`);
};

const safeCountDir = async (dirPath: string) => {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.length;
  } catch {
    return -1;
  }
};

const walkFiles = async (rootDir: string): Promise<string[]> => {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true }) as any;
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(path.relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  }
  return out;
};

const checkDocsRoot = async () => {
  const root = FILE_UPLOAD_DIR;
  const departments = ['HR', 'GA', 'ACC', 'OTHER'];
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      push('docs_root', false, `${root} is not a directory`);
      return;
    }
    const counts: string[] = [];
    for (const dept of departments) {
      const deptDir = path.join(root, dept);
      const count = await safeCountDir(deptDir);
      counts.push(`${dept}=${count >= 0 ? count : 'missing'}`);
    }
    push('docs_root', true, `${root} (${counts.join(', ')})`);
  } catch (e: any) {
    push('docs_root', false, `${root} (${e?.message || e})`);
  }
};

const checkPostgres = async () => {
  try {
    const ping = await pgPool.query('SELECT 1 AS ok');
    const ok = ping.rows?.[0]?.ok === 1;
    push('postgres_connect', ok, ok ? 'connected' : 'unexpected ping result');
    if (!ok) return;

    const fileCount = await pgPool.query(`SELECT COUNT(*)::int AS c FROM file`);
    const docMetaTable = await pgPool.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name='document_metadata'`,
    );
    const docMetaTableExists = Number(docMetaTable.rows?.[0]?.c || 0) > 0;
    let docMetaRows = 0;
    if (docMetaTableExists) {
      const q = await pgPool.query(`SELECT COUNT(*)::int AS c FROM document_metadata`);
      docMetaRows = q.rows?.[0]?.c || 0;
    }
    const byDept = await pgPool.query(
      `SELECT COALESCE(department_code,'NULL') AS d, COUNT(*)::int AS c FROM file GROUP BY 1 ORDER BY 2 DESC`,
    );
    const deptStr = byDept.rows.map((r: any) => `${r.d}:${r.c}`).join(', ');
    push(
      'postgres_data',
      true,
      `file=${fileCount.rows?.[0]?.c || 0}, document_metadata_table=${docMetaTableExists ? 'yes' : 'no'}, document_metadata_rows=${docMetaRows}, by_dept=[${deptStr}]`,
    );

    const latest = await pgPool.query(
      `SELECT storage_key, filename FROM file ORDER BY created_at DESC LIMIT 5`,
    );
    let diskHit = 0;
    for (const row of latest.rows as Array<{ storage_key: string }>) {
      try {
        await fs.stat(path.join(FILE_UPLOAD_DIR, row.storage_key));
        diskHit += 1;
      } catch {
        // ignore
      }
    }
    if (latest.rows.length === 0) {
      push('file_disk_link', true, 'latest_on_disk=0/0 (no file rows in DB)');
    } else {
      push('file_disk_link', diskHit > 0, `latest_on_disk=${diskHit}/${latest.rows.length}`);
    }

    const keysQuery = await pgPool.query(`SELECT storage_key FROM file`);
    const dbKeys = new Set((keysQuery.rows as Array<{ storage_key: string }>).map((r) => String(r.storage_key)));
    const diskFiles = await walkFiles(FILE_UPLOAD_DIR);
    const orphanCount = diskFiles.filter((p) => !dbKeys.has(p)).length;
    const missingCount = Array.from(dbKeys).filter((k) => !diskFiles.includes(k)).length;
    push(
      'file_consistency',
      orphanCount === 0 && missingCount === 0,
      `db_keys=${dbKeys.size}, disk_files=${diskFiles.length}, orphan_disk=${orphanCount}, missing_on_disk=${missingCount}`,
    );
  } catch (e: any) {
    push('postgres_connect', false, e?.message || String(e));
  }
};

const checkRedis = async () => {
  const host = process.env.REDIS_HOST || config.Redis.host || '127.0.0.1';
  const port = Number(process.env.REDIS_PORT || config.Redis.port || 6379);
  const password = process.env.REDIS_PASSWORD || config.Redis.password || undefined;
  const db = Number(process.env.REDIS_DB || config.Redis.database || 0);

  const client = new Redis({
    host,
    port,
    password,
    db,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    lazyConnect: true,
  });
  client.on('error', () => {
    // keep output concise; detailed failure is reported by the check result
  });
  try {
    await client.connect();
    const pong = await client.ping();
    push('redis_connect', pong === 'PONG', `host=${host}, port=${port}, db=${db}`);
    const info = await client.info('keyspace');
    push('redis_keyspace', true, info.replace(/\s+/g, ' ').trim());
  } catch (e: any) {
    push('redis_connect', false, `${host}:${port} (${e?.message || e})`);
  } finally {
    client.disconnect();
  }
};

const fetchJson = async (url: string, timeoutMs = 3000) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(t);
  }
};

const checkSolr = async () => {
  const base = (process.env.SOLR_URL || config.ApacheSolr.url || '').replace(/\/+$/, '');
  const core = process.env.SOLR_CORE_NAME || config.ApacheSolr.coreName || 'mycore';
  if (!base) {
    push('solr_connect', false, 'SOLR_URL not configured');
    return;
  }
  try {
    const status = await fetchJson(`${base}/solr/admin/cores?action=STATUS&wt=json`);
    if (!status.ok) {
      push('solr_connect', false, `${base} HTTP ${status.status}`);
      return;
    }
    push('solr_connect', true, `${base}, core=${core}`);

    const q = await fetchJson(`${base}/solr/${encodeURIComponent(core)}/select?q=*:*&rows=0&wt=json`);
    if (!q.ok) {
      push('solr_core', false, `core=${core}, HTTP ${q.status}`);
      return;
    }
    const parsed = JSON.parse(q.text);
    const numFound = Number(parsed?.response?.numFound || 0);
    push('solr_core', true, `core=${core}, numFound=${numFound}`);
  } catch (e: any) {
    push('solr_connect', false, `${base} (${e?.message || e})`);
  }
};

const checkDbVsSolr = async () => {
  const base = (process.env.SOLR_URL || config.ApacheSolr.url || '').replace(/\/+$/, '');
  const core = process.env.SOLR_CORE_NAME || config.ApacheSolr.coreName || 'mycore';
  if (!base) {
    push('db_vs_solr', false, 'SOLR_URL not configured');
    return;
  }
  try {
    const fileCountRes = await pgPool.query(`SELECT COUNT(*)::int AS c FROM file`);
    const dbCount = Number(fileCountRes.rows?.[0]?.c || 0);
    const q = await fetchJson(
      `${base}/solr/${encodeURIComponent(core)}/select?q=*:*&rows=0&wt=json&json.facet=${encodeURIComponent(
        JSON.stringify({ unique_files: 'unique(file_name_s)' }),
      )}`,
    );
    if (!q.ok) {
      push('db_vs_solr', false, `solr HTTP ${q.status}`);
      return;
    }
    const parsed = JSON.parse(q.text);
    const solrCount = Number(parsed?.response?.numFound || 0);
    const solrUniqueFileCount = Number(parsed?.facets?.unique_files);
    if (Number.isFinite(solrUniqueFileCount) && solrUniqueFileCount >= 0) {
      push(
        'db_vs_solr',
        dbCount === solrUniqueFileCount,
        `db_files=${dbCount}, solr_unique_file_name_s=${solrUniqueFileCount}, solr_docs=${solrCount}`,
      );
      return;
    }
    push('db_vs_solr', dbCount === solrCount, `db=${dbCount}, solr=${solrCount}`);
  } catch (e: any) {
    push('db_vs_solr', false, e?.message || String(e));
  }
};

const checkRagAndFaq = async () => {
  const rag = (process.env.RAG_BACKEND_URL || config.RAG.Backend.url || '').replace(/\/+$/, '');
  const faq = (process.env.FAQ_CACHE_API_URL || config.RAG.FaqCacheSettings.cacheApiUrl || '').replace(/\/+$/, '');
  if (rag) {
    try {
      const probes = ['/health', '/healthz', '/docs'];
      let ok = false;
      let detail = '';
      for (const p of probes) {
        try {
          const res = await fetchJson(`${rag}${p}`);
          if (res.ok) {
            ok = true;
            detail = `${rag}${p} HTTP ${res.status}`;
            break;
          }
          if (!detail) detail = `${rag}${p} HTTP ${res.status}`;
        } catch (e: any) {
          if (!detail) detail = `${rag}${p} (${e?.message || e})`;
        }
      }
      if (!ok) {
        push('rag_backend', false, detail || `${rag} probe failed`);
      } else {
        let capabilityOk = false;
        let capabilityDetail = '';
        try {
          const openapi = await fetchJson(`${rag}/openapi.json`, 5000);
          if (openapi.ok) {
            const parsed = JSON.parse(openapi.text || '{}');
            const title = String(parsed?.info?.title || 'unknown');
            const paths = Object.keys(parsed?.paths || {});
            const hasSearch = paths.includes('/search') || paths.includes('/search/hybrid');
            capabilityOk = hasSearch;
            capabilityDetail = `title=${title}, has_/search=${hasSearch ? 'yes' : 'no'}`;
          } else {
            capabilityDetail = `${rag}/openapi.json HTTP ${openapi.status}`;
          }
        } catch (e: any) {
          capabilityDetail = `${rag}/openapi.json (${e?.message || e})`;
        }

        if (!capabilityOk) {
          push(
            'rag_backend',
            false,
            `${detail || `${rag} reachable`} but RAG endpoints missing (${capabilityDetail})`,
          );
        } else {
          push('rag_backend', true, `${detail}; ${capabilityDetail}`);
        }
      }
    } catch (e: any) {
      push('rag_backend', false, `${rag} (${e?.message || e})`);
    }
  } else {
    push('rag_backend', false, 'RAG_BACKEND_URL not configured');
  }

  const useFaqCache = process.env.USE_FAQ_CACHE === 'true' || config.RAG.useFaqCache === true;
  if (!useFaqCache) {
    push('faq_cache', true, 'skipped (FAQ cache disabled)');
    return;
  }

  if (faq) {
    try {
      const probes = ['/health', '/healthz', '/'];
      let ok = false;
      let detail = '';
      for (const p of probes) {
        try {
          const res = await fetchJson(`${faq}${p}`);
          if (res.ok) {
            ok = true;
            detail = `${faq}${p} HTTP ${res.status}`;
            break;
          }
          if (!detail) detail = `${faq}${p} HTTP ${res.status}`;
        } catch (e: any) {
          if (!detail) detail = `${faq}${p} (${e?.message || e})`;
        }
      }
      push('faq_cache', ok, detail || `${faq} probe failed`);
    } catch (e: any) {
      push('faq_cache', false, `${faq} (${e?.message || e})`);
    }
  } else {
    push('faq_cache', false, 'FAQ_CACHE_API_URL not configured');
  }
};

const printEnvSummary = () => {
  const show = (k: string) => `${k}=${process.env[k] || ''}`;
  console.log('=== Storage Verify: Environment Summary ===');
  console.log(show('DB_MODE'));
  console.log(show('DATABASE_URL'));
  console.log(show('PG_HOST'));
  console.log(show('PG_PORT'));
  console.log(show('REDIS_HOST'));
  console.log(show('REDIS_PORT'));
  console.log(show('SOLR_URL'));
  console.log(show('SOLR_CORE_NAME'));
  console.log(show('DOCS_ROOT'));
  console.log(show('RAG_BACKEND_URL'));
  console.log(show('FAQ_CACHE_API_URL'));
  console.log(`FILE_UPLOAD_DIR=${FILE_UPLOAD_DIR}`);
  console.log('===========================================');
};

async function main() {
  printEnvSummary();
  await checkDocsRoot();
  await checkPostgres();
  await checkRedis();
  await checkSolr();
  await checkDbVsSolr();
  await checkRagAndFaq();

  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;
  console.log('===========================================');
  console.log(`Summary: ${total - failed}/${total} checks passed`);
  if (failed > 0) {
    console.log('Failed checks:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`- ${r.name}: ${r.detail}`);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('[verifyStorage] Fatal:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end().catch(() => undefined);
  });
