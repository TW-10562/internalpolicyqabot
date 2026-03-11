import { pgPool } from '@/clients/postgres';

export type DocumentMetaUpsert = {
  storageKey: string;
  filename: string;
  filePath?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedBy?: string;
  departmentCode?: string;
};

let ensureSchemaPromise: Promise<void> | null = null;

async function ensureDocumentMetaSchema(): Promise<void> {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      const client = await pgPool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS document_metadata (
            storage_key TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            file_path TEXT NULL,
            mime_type TEXT NULL,
            size_bytes BIGINT NULL,
            uploaded_by TEXT NULL,
            department_code TEXT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS department_code TEXT NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_document_metadata_uploaded_by ON document_metadata(uploaded_by)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_document_metadata_updated_at ON document_metadata(updated_at)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_document_metadata_department_code ON document_metadata(department_code)`);
      } finally {
        client.release();
      }
    })();
  }
  return ensureSchemaPromise;
}

/**
 * Store document metadata in Postgres.
 *
 * This is used for future features like returning source documents/pages
 * in chat responses.
 */
export async function upsertDocumentMeta(meta: DocumentMetaUpsert): Promise<void> {
  await ensureDocumentMetaSchema();
  const client = await pgPool.connect();
  try {
    await client.query(
      `
      INSERT INTO document_metadata (
        storage_key,
        filename,
        file_path,
        mime_type,
        size_bytes,
        uploaded_by,
        department_code,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
      ON CONFLICT (storage_key)
      DO UPDATE SET
        filename = EXCLUDED.filename,
        file_path = EXCLUDED.file_path,
        mime_type = EXCLUDED.mime_type,
        size_bytes = EXCLUDED.size_bytes,
        uploaded_by = EXCLUDED.uploaded_by,
        department_code = EXCLUDED.department_code,
        updated_at = NOW()
      `,
      [
        meta.storageKey,
        meta.filename,
        meta.filePath || null,
        meta.mimeType || null,
        meta.sizeBytes ?? null,
        meta.uploadedBy || null,
        meta.departmentCode || 'HR',
      ],
    );
  } finally {
    client.release();
  }
}

export async function getDocumentMetaByStorageKey(storageKey: string) {
  const client = await pgPool.connect();
  try {
    const res = await client.query(
      `SELECT storage_key, filename, file_path, mime_type, size_bytes, uploaded_by, updated_at
       FROM document_metadata
       WHERE storage_key = $1
       LIMIT 1`,
      [storageKey],
    );
    return res.rows?.[0] || null;
  } finally {
    client.release();
  }
}
