import '@/config/env';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import FormData from 'form-data';

import { config } from '@/config/index';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';

type SolrDoc = {
  id?: string;
  file_path_s?: string;
  file_name_s?: string;
  title?: string[] | string;
  department_code_s?: string;
};

type SolrSelectResponse = {
  response?: {
    numFound?: number;
    docs?: SolrDoc[];
  };
};

const SOLR_URL = String(process.env.SOLR_URL || config.ApacheSolr.url || '').replace(/\/+$/, '');
const SOLR_CORE = String(process.env.SOLR_CORE_NAME || config.ApacheSolr.coreName || '').trim();
const RAG_BACKEND_URL = String(process.env.RAG_BACKEND_URL || config.RAG.Backend.url || '').replace(/\/+$/, '');
const COLLECTION_NAME = String(
  process.env.RAG_COLLECTION_NAME ||
    config.RAG.PreProcess.PDF.splitByArticle.collectionName ||
    'splitByArticleWithHybridSearch',
).trim();

const SOLR_PAGE_SIZE = Math.max(1, Math.min(200, Number(process.env.BACKFILL_SOLR_ROWS || 50)));
const REQUEST_TIMEOUT_MS = Math.max(2000, Number(process.env.BACKFILL_REQUEST_TIMEOUT_MS || 120000));
const MAX_FILES = Math.max(0, Number(process.env.BACKFILL_MAX_FILES || 0));
const START_OFFSET = Math.max(0, Number(process.env.BACKFILL_START || 0));
const SLEEP_MS = Math.max(0, Number(process.env.BACKFILL_SLEEP_MS || 0));
const STRICT_EXIT = String(process.env.BACKFILL_STRICT_EXIT || '0') === '1';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseTitle = (doc: SolrDoc): string => {
  const rawTitle = Array.isArray(doc?.title) ? String(doc.title[0] || '').trim() : String(doc?.title || '').trim();
  if (rawTitle) return rawTitle;
  const fileName = String(doc?.file_name_s || '').trim();
  if (fileName) return path.basename(fileName);
  const id = String(doc?.id || '').trim();
  return id ? path.basename(id) : 'document.pdf';
};

const uniqueCandidates = (values: string[]): string[] =>
  Array.from(
    new Set(
      values
        .map((v) => String(v || '').trim())
        .filter(Boolean),
    ),
  );

const isPdfPath = (value: string): boolean => /\.pdf$/i.test(String(value || '').trim());

const isPdfDoc = (doc: SolrDoc): boolean => {
  const candidates = [
    String(doc?.id || '').trim(),
    String(doc?.file_name_s || '').trim(),
    String(doc?.file_path_s || '').trim(),
  ].filter(Boolean);
  return candidates.some((v) => isPdfPath(v));
};

const resolvePathFromDoc = (doc: SolrDoc): string => {
  const direct = String(doc?.file_path_s || '').trim();
  if (direct && fs.existsSync(direct)) return direct;

  const candidates = uniqueCandidates([
    String(doc?.id || ''),
    String(doc?.file_name_s || ''),
    path.basename(String(doc?.id || '')),
    path.basename(String(doc?.file_name_s || '')),
  ]);

  for (const key of candidates) {
    const candidatePath = path.join(FILE_UPLOAD_DIR, key);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  return '';
};

const inferDepartmentCode = (storageKey: string, explicit?: string): string => {
  const e = String(explicit || '').trim().toUpperCase();
  if (e) return e;
  const first = String(storageKey || '').split('/')[0]?.trim().toUpperCase();
  return first || 'HR';
};

const getSolrPage = async (start: number, rows: number): Promise<{ docs: SolrDoc[]; numFound: number }> => {
  const endpoint = `${SOLR_URL}/solr/${SOLR_CORE}/select`;
  const response = await axios.get<SolrSelectResponse>(endpoint, {
    params: {
      q: '*:*',
      rows,
      start,
      sort: 'id asc',
      fl: 'id,file_path_s,file_name_s,title,department_code_s',
      wt: 'json',
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const docs = Array.isArray(response.data?.response?.docs) ? response.data.response!.docs! : [];
  const numFound = Number(response.data?.response?.numFound || 0);
  return { docs, numFound };
};

const uploadOne = async (doc: SolrDoc): Promise<{ ok: boolean; count: number; reason?: string }> => {
  const storageKey = String(doc?.id || doc?.file_name_s || '').trim();
  if (!storageKey) return { ok: false, count: 0, reason: 'missing_storage_key' };
  if (!isPdfDoc(doc)) return { ok: false, count: 0, reason: 'skip_non_pdf' };

  const filePath = resolvePathFromDoc(doc);
  if (!filePath) return { ok: false, count: 0, reason: 'file_not_found' };
  if (!isPdfPath(filePath)) return { ok: false, count: 0, reason: 'skip_non_pdf' };

  const fileOriginalName = parseTitle(doc);
  const departmentCode = inferDepartmentCode(storageKey, doc?.department_code_s);
  const payload = {
    file_path_s: storageKey,
    file_abs_path_s: filePath,
    file_name_s: storageKey,
    rag_tag_s: 'splitByArticleWithHybridSearch',
    department_code_s: departmentCode,
    system_s: departmentCode.toLowerCase(),
  };

  const form = new FormData();
  form.append('collection_name', COLLECTION_NAME);
  form.append('file', fs.createReadStream(filePath));
  form.append('file_original_name', fileOriginalName);
  form.append('extra_metadata', JSON.stringify(payload));

  try {
    const res = await axios.post(`${RAG_BACKEND_URL}/upload/split-by-article`, form, {
      headers: form.getHeaders(),
      timeout: REQUEST_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      const detail = typeof res.data?.detail === 'string'
        ? res.data.detail
        : res.data?.detail
          ? JSON.stringify(res.data.detail).slice(0, 220)
          : '';
      return {
        ok: false,
        count: 0,
        reason: detail ? `http_${res.status}:${detail}` : `http_${res.status}`,
      };
    }
    const count = Number(res.data?.count || 0);
    if (count <= 0) {
      return { ok: false, count, reason: 'zero_chunks' };
    }
    return { ok: true, count };
  } catch (error: any) {
    return {
      ok: false,
      count: 0,
      reason: String(error?.message || error),
    };
  }
};

const ensureRequiredConfig = () => {
  if (!SOLR_URL || !SOLR_CORE) {
    throw new Error(`Missing Solr config. SOLR_URL="${SOLR_URL}", SOLR_CORE_NAME="${SOLR_CORE}"`);
  }
  if (!RAG_BACKEND_URL) {
    throw new Error('Missing RAG backend URL. Set RAG_BACKEND_URL.');
  }
  if (!COLLECTION_NAME) {
    throw new Error('Missing target collection name.');
  }
};

const main = async () => {
  ensureRequiredConfig();
  console.log('[BackfillHybrid] Starting');
  console.log(`[BackfillHybrid] Solr: ${SOLR_URL}/solr/${SOLR_CORE}`);
  console.log(`[BackfillHybrid] RAG backend: ${RAG_BACKEND_URL}`);
  console.log(`[BackfillHybrid] Collection: ${COLLECTION_NAME}`);
  console.log(`[BackfillHybrid] FILE_UPLOAD_DIR: ${FILE_UPLOAD_DIR}`);

  let start = START_OFFSET;
  let total = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let missing = 0;
  let chunkCount = 0;
  let numFound = Number.POSITIVE_INFINITY;

  while (start < numFound) {
    if (MAX_FILES > 0 && total >= MAX_FILES) break;

    const { docs, numFound: totalFound } = await getSolrPage(start, SOLR_PAGE_SIZE);
    numFound = totalFound;
    if (!docs.length) break;

    for (const doc of docs) {
      if (MAX_FILES > 0 && total >= MAX_FILES) break;
      total += 1;
      const id = String(doc?.id || `doc_${total}`);
      const result = await uploadOne(doc);
      if (result.ok) {
        ok += 1;
        chunkCount += Number(result.count || 0);
        console.log(`[BackfillHybrid] OK   ${id} chunks=${result.count}`);
      } else {
        if (result.reason === 'skip_non_pdf') {
          skipped += 1;
          console.log(`[BackfillHybrid] SKIP ${id} reason=non_pdf`);
        } else {
          failed += 1;
          if (result.reason === 'file_not_found') missing += 1;
          console.warn(`[BackfillHybrid] FAIL ${id} reason=${result.reason}`);
        }
      }
      if (SLEEP_MS > 0) await sleep(SLEEP_MS);
    }

    start += docs.length;
    console.log(`[BackfillHybrid] Progress ${Math.min(start, numFound)}/${numFound} processed.`);
  }

  console.log(
    `[BackfillHybrid] Done. processed=${total}, success=${ok}, failed=${failed}, skipped=${skipped}, missing_files=${missing}, inserted_chunks=${chunkCount}`,
  );
  if (STRICT_EXIT) {
    process.exit(failed > 0 ? 2 : 0);
  }
  process.exit(ok > 0 ? 0 : 2);
};

main().catch((error) => {
  console.error('[BackfillHybrid] Fatal:', error?.message || error);
  process.exit(1);
});
