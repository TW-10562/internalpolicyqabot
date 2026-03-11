import '@/polyfills';
import '@/config/env';
import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { pgPool } from '@/clients/postgres';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';
import { solrService } from '@/service/solrService';

type FileRow = {
  storage_key: string;
  filename: string;
  mime_type: string;
  size: number;
  department_code?: string;
  create_by?: string;
  update_by?: string;
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

const getFileColumns = async (): Promise<Set<string>> => {
  const res = await pgPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='file'`,
  );
  return new Set(res.rows.map((r: { column_name: string }) => r.column_name));
};

const toRow = async (storageKey: string, columns: Set<string>): Promise<FileRow> => {
  const absPath = path.join(FILE_UPLOAD_DIR, storageKey);
  const stat = await fs.stat(absPath);
  const filename = path.basename(storageKey);
  const mimeType = String(mime.lookup(filename) || 'application/octet-stream');
  const parts = storageKey.split('/');
  const department = parts[0] || 'HR';
  const row: FileRow = {
    storage_key: storageKey,
    filename,
    mime_type: mimeType,
    size: Number(stat.size || 0),
  };
  if (columns.has('department_code')) {
    row.department_code = department;
  }
  if (columns.has('create_by')) {
    row.create_by = 'system';
  }
  if (columns.has('update_by')) {
    row.update_by = 'system';
  }
  return row;
};

const insertFile = async (row: FileRow, columns: Set<string>) => {
  const cols = ['filename', 'storage_key', 'mime_type', 'size'];
  if (columns.has('department_code')) cols.push('department_code');
  if (columns.has('create_by')) cols.push('create_by');
  if (columns.has('update_by')) cols.push('update_by');

  const values = cols.map((c) => (row as any)[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  await pgPool.query(
    `INSERT INTO file (${cols.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (storage_key) DO NOTHING`,
    values,
  );
};

const main = async () => {
  console.log(`[Backfill] FILE_UPLOAD_DIR=${FILE_UPLOAD_DIR}`);
  const columns = await getFileColumns();
  if (!columns.has('storage_key')) {
    throw new Error('file table missing storage_key column');
  }

  const diskFiles = await walkFiles(FILE_UPLOAD_DIR);
  console.log(`[Backfill] Disk files: ${diskFiles.length}`);

  let inserted = 0;
  let indexed = 0;
  let failed = 0;

  for (const storageKey of diskFiles) {
    try {
      const row = await toRow(storageKey, columns);
      await insertFile(row, columns);
      inserted += 1;

      const absPath = path.join(FILE_UPLOAD_DIR, storageKey);
      const title = row.filename || storageKey;
      const meta: Record<string, string> = {};
      if (row.department_code) meta.department_code = row.department_code;
      const ok = await solrService.indexDocument(absPath, storageKey, title, meta);
      if (ok) indexed += 1;
    } catch (e: any) {
      failed += 1;
      console.warn(`[Backfill] Failed ${storageKey}: ${e?.message || e}`);
    }
  }

  console.log(`[Backfill] Done. inserted=${inserted}, indexed=${indexed}, failed=${failed}`);
};

main().catch((e) => {
  console.error('[Backfill] Fatal:', e?.message || e);
  process.exit(1);
});
