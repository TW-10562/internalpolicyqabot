import '@/polyfills';
import path from 'path';
import fs from 'fs';

import { FILE_UPLOAD_DIR } from '@/config/uploadPath';
import { solrService } from '@/service/solrService';
import { pgPool } from '@/clients/postgres';

type FileRow = {
  id: number;
  filename: string;
  storage_key: string;
  department_code?: string | null;
};

async function main() {
  const client = await pgPool.connect();
  let rows: FileRow[] = [];
  try {
    const cols = await client.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'file'
      `,
    );
    const colSet = new Set((cols.rows || []).map((r: any) => String(r.column_name)));
    const hasDeletedAt = colSet.has('deleted_at');

    const sql = hasDeletedAt
      ? `
        SELECT id, filename, storage_key, department_code
        FROM file
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
      `
      : `
        SELECT id, filename, storage_key, department_code
        FROM file
        ORDER BY created_at DESC
      `;

    const res = await client.query(sql);
    rows = (res.rows || []) as FileRow[];
  } finally {
    client.release();
  }

  console.log(`[Reindex] Found ${rows.length} file record(s)`);

  let ok = 0;
  let fail = 0;
  let missing = 0;

  for (const row of rows) {
    const storageKey = String(row.storage_key || '').trim();
    const title = String(row.filename || storageKey || 'document');
    if (!storageKey) {
      fail += 1;
      console.warn('[Reindex] Skip row with empty storage_key:', row.id);
      continue;
    }

    const filePath = path.join(FILE_UPLOAD_DIR, storageKey);
    if (!fs.existsSync(filePath)) {
      missing += 1;
      console.warn('[Reindex] Missing file on disk:', filePath);
      continue;
    }

    const indexed = await solrService.indexDocument(filePath, storageKey, title, {
      department_code_s: String(row.department_code || 'HR'),
    });

    if (indexed) ok += 1;
    else fail += 1;
  }

  console.log(`[Reindex] Done. ok=${ok}, fail=${fail}, missing=${missing}`);
  process.exit(fail > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error('[Reindex] Fatal:', e);
  process.exit(1);
});
