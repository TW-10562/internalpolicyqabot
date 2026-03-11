/**
 * File Upload Service - Clean file upload and indexing
 */
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import axios from 'axios';
import FormData from 'form-data';
import File from '@/mysql/model/file.model';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';
import { config } from '@/config/index';
import { solrService } from '@/service/solrService';
import { upsertDocumentMeta } from '@/db/postgresDocumentMeta';
import { normalizeDepartmentCode } from '@/service/rbac';

export interface UploadedFile {
  originalFilename: string;
  filepath: string;
  mimetype: string;
  size: number;
}

export interface UploadResult {
  id: number;
  filename: string;
  storageKey: string;
  mimeType: string;
  size: number;
  indexed: boolean;
}

class FileUploadService {
  private uploadDir: string;

  constructor() {
    this.uploadDir = FILE_UPLOAD_DIR;
  }

  private normalizeStorageFolder(categoryOrTag?: string): 'HR' | 'GA' | 'ACC' | 'OTHER' {
    const normalized = normalizeDepartmentCode(categoryOrTag);
    if (normalized === 'HR' || normalized === 'GA' || normalized === 'ACC' || normalized === 'OTHER') {
      return normalized;
    }
    return 'OTHER';
  }

  private async retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastErr;
  }

  private isHybridUploadModeEnabled(): boolean {
    const modes = Array.isArray(config?.RAG?.mode) ? config.RAG.mode : [];
    return modes.includes('splitByArticleWithHybridSearch');
  }

  private isPdfFile(file: UploadedFile): boolean {
    const ext = path.extname(String(file?.originalFilename || '')).toLowerCase();
    const mime = String(file?.mimetype || '').toLowerCase();
    return ext === '.pdf' || mime.includes('pdf');
  }

  private async uploadPdfToHybridBackend(input: {
    permanentPath: string;
    storageKey: string;
    originalFilename: string;
    fileId: number;
    userName: string;
    departmentCode: string;
  }): Promise<void> {
    const backendUrl = String(config?.RAG?.Backend?.url || '').trim().replace(/\/+$/, '');
    if (!backendUrl) {
      throw new Error('rag_backend_url_missing');
    }

    const collectionName = String(
      config?.RAG?.PreProcess?.PDF?.splitByArticle?.collectionName || 'splitByArticleWithHybridSearch',
    ).trim();
    const normalizedDept = this.normalizeStorageFolder(input.departmentCode);
    const timeoutMs = Math.max(2000, Number(process.env.RAG_BACKEND_UPLOAD_TIMEOUT_MS || 120000));

    const form = new FormData();
    form.append('collection_name', collectionName);
    form.append('file', fs.createReadStream(input.permanentPath));
    form.append('file_original_name', input.originalFilename);
    form.append(
      'extra_metadata',
      JSON.stringify({
        file_id: String(input.fileId),
        file_path_s: input.storageKey,
        file_name_s: input.storageKey,
        file_abs_path_s: input.permanentPath,
        uploaded_by_s: input.userName,
        rag_tag_s: 'splitByArticleWithHybridSearch',
        department_code_s: normalizedDept,
        system_s: normalizedDept.toLowerCase(),
      }),
    );

    const res = await axios.post(`${backendUrl}/upload/split-by-article`, form, {
      headers: form.getHeaders(),
      timeout: timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    if (Number(res.status) !== 200) {
      const detail = typeof res.data?.detail === 'string'
        ? res.data.detail
        : res.data?.detail
          ? JSON.stringify(res.data.detail).slice(0, 220)
          : '';
      throw new Error(detail ? `hybrid_http_${res.status}:${detail}` : `hybrid_http_${res.status}`);
    }
  }

  /**
   * Process and upload a single file
   */
  async uploadFile(
    file: UploadedFile,
    userName: string,
    departmentCode: string,
    tagId?: number,
    categoryOrTag?: string,
  ): Promise<UploadResult> {
    console.log(`[FileUpload] Processing: ${file.originalFilename}`);

    // 1. Generate unique filename
    const ext = path.extname(file.originalFilename || '.pdf');
    const storageFileName = nanoid() + ext;
    const storageFolder = this.normalizeStorageFolder(categoryOrTag || departmentCode);
    const storageKey = `${storageFolder}/${storageFileName}`;
    const departmentDir = path.join(this.uploadDir, storageFolder);
    const permanentPath = path.join(departmentDir, storageFileName);
    await fs.promises.mkdir(departmentDir, { recursive: true });

    // 2. Copy file to permanent location
    await fs.promises.copyFile(file.filepath, permanentPath);
    console.log(`[FileUpload] Saved: ${permanentPath}`);

    // 3. Save to database
    let fileId: number;
    try {
      const record = await File.create({
        filename: file.originalFilename,
        tag: tagId || null,
        storage_key: storageKey,
        mime_type: file.mimetype,
        size: file.size,
        create_by: userName,
        department_code: departmentCode,
      });
      fileId = Number(record.getDataValue('id'));
      console.log(`[FileUpload] DB record: ${fileId}`);
    } catch (dbErr) {
      // Keep storage and DB consistent when DB insert fails.
      await fs.promises.unlink(permanentPath).catch(() => {});
      throw dbErr;
    }

    // 3.1 Save metadata in Postgres (for future source/citation features)
    // If Postgres isn't configured (or migration not applied), do not fail the upload.
    upsertDocumentMeta({
      storageKey,
      filename: file.originalFilename,
      filePath: permanentPath,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      uploadedBy: userName,
      departmentCode,
    }).catch((e: any) => {
      console.warn('[FileUpload] Postgres metadata upsert skipped:', e?.message || e);
    });

    // 4. Index to Solr with retries.
    // If indexing still fails, keep file + DB metadata persisted and mark indexed=false.
    // This avoids losing uploads when Solr is temporarily unavailable.
    let indexed = false;
    try {
      const normalizedDept = this.normalizeStorageFolder(departmentCode);
      indexed = await this.retry(
        () => solrService.indexDocument(
          permanentPath,
          storageKey,
          file.originalFilename,
          {
            department_code_s: normalizedDept,
            system_s: normalizedDept.toLowerCase(),
          },
        ),
        3,
        1200,
      );
    } catch (error: any) {
      console.error(`[FileUpload] Solr indexing failed after retries: ${error?.message || error}`);
      indexed = false;
    }

    if (indexed) {
      console.log(`[FileUpload] SUCCESS: ${file.originalFilename}`);
    } else {
      console.warn(
        `[FileUpload] Stored without Solr index (indexed=false): ${file.originalFilename}`,
      );
    }

    // Keep hybrid/vector collection in sync for PDF uploads in hybrid mode.
    // Failure here should not roll back DB/Solr persistence.
    if (this.isHybridUploadModeEnabled() && this.isPdfFile(file)) {
      try {
        await this.uploadPdfToHybridBackend({
          permanentPath,
          storageKey,
          originalFilename: file.originalFilename,
          fileId: Number(fileId),
          userName,
          departmentCode,
        });
        console.log(`[FileUpload] Hybrid indexed: ${file.originalFilename}`);
      } catch (error: any) {
        console.warn(
          `[FileUpload] Hybrid indexing failed (stored in DB/Solr only): ${file.originalFilename} :: ${error?.message || error}`,
        );
      }
    }

    return {
      id: Number(fileId),
      filename: file.originalFilename,
      storageKey,
      mimeType: file.mimetype,
      size: file.size,
      indexed,
    };
  }

  /**
   * Upload multiple files
   */
  async uploadFiles(
    files: UploadedFile[],
    userName: string,
    departmentCode: string,
    tagId?: number,
    categoryOrTag?: string,
  ): Promise<{ success: UploadResult[]; failed: string[] }> {
    const success: UploadResult[] = [];
    const failed: string[] = [];

    for (const file of files) {
      try {
        const result = await this.uploadFile(file, userName, departmentCode, tagId, categoryOrTag);
        success.push(result);
      } catch (error: any) {
        console.error(`[FileUpload] FAILED: ${file.originalFilename}`, error.message);
        failed.push(file.originalFilename);
      }
    }

    return { success, failed };
  }

  /**
   * Delete a file by storage key
   */
  async deleteFile(storageKey: string): Promise<boolean> {
    try {
      // Delete from Solr
      await solrService.deleteDocument(storageKey);

      // Delete physical file
      const filePath = path.join(this.uploadDir, storageKey);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }

      // Delete from database
      await File.destroy({ where: { storage_key: storageKey } });

      console.log(`[FileUpload] Deleted: ${storageKey}`);
      return true;
    } catch (error: any) {
      console.error(`[FileUpload] Delete failed: ${storageKey}`, error.message);
      return false;
    }
  }
}

// Export singleton instance
export const fileUploadService = new FileUploadService();
export default FileUploadService;
