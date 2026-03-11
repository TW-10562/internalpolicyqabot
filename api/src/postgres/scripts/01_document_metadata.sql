-- Document metadata table for source/citation features

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
);

ALTER TABLE document_metadata ADD COLUMN IF NOT EXISTS department_code TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_document_metadata_uploaded_by ON document_metadata(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_document_metadata_updated_at ON document_metadata(updated_at);
CREATE INDEX IF NOT EXISTS idx_document_metadata_department_code ON document_metadata(department_code);
