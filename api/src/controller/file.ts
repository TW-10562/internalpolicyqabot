import File from '@/mysql/model/file.model';
import Tag from '@/mysql/model/file_tag.model';
import { userType } from '@/types';
import { IFileQuerySerType, IFileQueryType } from '@/types/file';
import { queryPage } from '@/utils/mapper';
import axios from 'axios';
import { Context } from 'koa';
import path from 'path';
import fs from 'fs';
import mime from 'mime-types';
import { putFileInfo, postNewTag, putTag, delTag } from '@/service/file';
import { parseOfficeAsync } from 'officeparser';
import { FILE_UPLOAD_DIR } from '@/config/uploadPath';
import { config } from '@/config/index';
import UserRole from '@/mysql/model/user_role.model';
import { Op } from 'sequelize';
import FileRole from '@/mysql/model/file_role.model';
import { getAddMid } from '@/controller/genTask';
import { AccessScope, isDepartmentAdminRole, isSuperAdminRole, normalizeDepartmentCode } from '@/service/rbac';
import { detectDbMode } from '@/db/adapter';
import { pgPool } from '@/clients/postgres';

type UploadedFile = {
  newFilename: string;
  originalFilename: string;
  mimetype: string;
  size: number;
  filepath: string;
};

export type UploadResult = {
  id: number;
  filename: string;
  storage_key: string;
  mime_type: string;
  size: number;
  created_at: Date;
};

const normalizeUploadDepartmentCode = (value: unknown): 'HR' | 'GA' | 'ACC' | 'OTHER' => {
  const normalized = normalizeDepartmentCode(value);
  if (normalized === 'HR' || normalized === 'GA' || normalized === 'ACC' || normalized === 'OTHER') {
    return normalized;
  }
  return 'OTHER';
};

const removePhysicalArtifacts = async (storageKey: string, opts?: { strict?: boolean }) => {
  const baseName = path.basename(storageKey, path.extname(storageKey));
  const filePath = path.join(FILE_UPLOAD_DIR, storageKey);
  const perFileDir = path.dirname(filePath);
  const folderCandidates = Array.from(
    new Set([
      path.join(FILE_UPLOAD_DIR, baseName), // legacy layout: <root>/<baseName>
      path.join(perFileDir, baseName), // department-aware layout: <root>/<dept>/<baseName>
    ]),
  );
  const strict = opts?.strict === true;

  await fs.promises.unlink(filePath).catch((err: any) => {
    // Missing physical files should not block metadata cleanup.
    // We only fail hard for real IO/permission errors in strict mode.
    if (err?.code !== 'ENOENT' && strict) {
      console.error(`Failed to delete file ${filePath}:`, err?.name, err?.message || err);
      throw err;
    }
  });

  for (const folderPath of folderCandidates) {
    // eslint-disable-next-line no-await-in-loop
    await fs.promises.rm(folderPath, { recursive: true, force: true }).catch((err: any) => {
      if (err?.code !== 'ENOENT' && strict) {
        console.error(`Failed to delete folder ${folderPath}:`, err?.name, err?.message || err);
        throw err;
      }
    });
  }
};

const deleteFileRowsFromDb = async (fileIds: number[]): Promise<number> => {
  const ids = fileIds.filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return 0;

  const mode = await detectDbMode();
  if (mode === 'postgres') {
    const res = await pgPool.query(
      `
      DELETE FROM "file"
      WHERE id = ANY($1::int[])
      `,
      [ids],
    );
    return Number(res.rowCount || 0);
  }

  const count = await File.destroy({ where: { id: ids } });
  return Number(count || 0);
};

// ルートハンドラ - Clean upload using FileUploadService
export const uploadFile = async (ctx: Context, next: () => Promise<void>) => {
  const { fileUploadService } = await import('@/service/fileUploadService');
  const reqAny = ctx.request as any;
  const raw = reqAny.files?.files;
  if (!raw) ctx.throw(400, 'ファイルが見つかりません');
  const files: UploadedFile[] = Array.isArray(raw) ? raw : [raw];

  // Parse tags
  const { tags } = reqAny.body || {};
  let tagId: number | undefined;
  if (tags != null && String(tags).trim() !== '') {
    try {
      const parsedTags = typeof tags === 'string' ? JSON.parse(tags) : tags;
      if (Array.isArray(parsedTags) && parsedTags.length > 0) {
        const candidate = Number(parsedTags[0]);
        if (Number.isFinite(candidate) && candidate > 0) {
          tagId = candidate;
        }
      } else {
        const candidate = Number(parsedTags);
        if (Number.isFinite(candidate) && candidate > 0) {
          tagId = candidate;
        }
      }
    } catch {
      console.warn('[uploadFile] invalid tags payload, ignored');
    }
  }
  let fileCategories: Record<string, string> = {};
  if (reqAny.body?.fileCategories) {
    try {
      const parsed = JSON.parse(String(reqAny.body.fileCategories));
      if (parsed && typeof parsed === 'object') {
        fileCategories = parsed as Record<string, string>;
      }
    } catch (e) {
      console.warn('[uploadFile] invalid fileCategories payload, ignored');
    }
  }
  const { userName } = ctx.state.user as userType;
  const scope = (ctx.state as any).accessScope as AccessScope;
  const requestedDepartmentCode = String(
    (reqAny.body?.departmentCode || reqAny.body?.category || '') as string,
  ).trim();
  const uploadDepartmentCode = isSuperAdminRole(scope.roleCode)
    ? normalizeUploadDepartmentCode(requestedDepartmentCode || scope.departmentCode)
    : scope.departmentCode;

  const success: Awaited<ReturnType<typeof fileUploadService.uploadFile>>[] = [];
  const failed: string[] = [];
  const failedDetails: Array<{ filename: string; reason: string }> = [];
  for (const f of files) {
    try {
      const perFileRequestedDepartment = String(fileCategories[f.originalFilename] || '').trim();
      const perFileDepartmentCode = isSuperAdminRole(scope.roleCode)
        ? normalizeUploadDepartmentCode(perFileRequestedDepartment || uploadDepartmentCode)
        : scope.departmentCode;
      const result = await fileUploadService.uploadFile(
        {
          originalFilename: f.originalFilename,
          filepath: f.filepath,
          mimetype: f.mimetype,
          size: f.size,
        },
        userName,
        perFileDepartmentCode,
        tagId,
        perFileRequestedDepartment || uploadDepartmentCode,
      );
      success.push(result);
    } catch (e: any) {
      const reason = String(e?.message || 'upload_failed');
      console.error('[uploadFile] failed:', {
        filename: f.originalFilename,
        reason,
      });
      failed.push(f.originalFilename);
      failedDetails.push({
        filename: f.originalFilename,
        reason,
      });
    }
  }

  ctx.state.formatData = {
    message: failed.length === 0 
      ? 'ファイルのアップロードに成功しました' 
      : `${success.length}件成功、${failed.length}件失敗`,
    data: success.map(r => ({
      id: r.id,
      filename: r.filename,
      storage_key: r.storageKey,
      mime_type: r.mimeType,
      size: r.size,
      indexed: r.indexed,
    })),
    errors: failed.length > 0 ? failed : undefined,
    errorDetails: failedDetails.length > 0 ? failedDetails : undefined,
  };

  await next();
};

export const listFiles = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const { userId } = ctx.state.user as userType;
    const scope = (ctx.state as any).accessScope as AccessScope;
    const applyRoleFilter = !isSuperAdminRole(scope.roleCode) && !isDepartmentAdminRole(scope.roleCode);

    let filteredFileIds: number[] = [];
    if (applyRoleFilter) {
      const roleRows = (await UserRole.findAll({
        raw: true,
        attributes: ['role_id'],
        where: { user_id: userId },
      })) as any[];
      const roleIds = roleRows.map((r) => Number(r.role_id)).filter((id) => Number.isFinite(id));

      if (roleIds.length > 0) {
        const fileRoleRows = (await FileRole.findAll({
          raw: true,
          attributes: ['file_id'],
          where: { role_id: { [Op.in]: roleIds } },
        })) as any[];
        filteredFileIds = fileRoleRows.map((r) => Number(r.file_id)).filter((id) => Number.isFinite(id));
      }
    }

    const { pageNum, pageSize, fileContent, ...rawParams } = ctx.query as unknown as IFileQueryType;
    const params: any = { ...rawParams };
    const tags: number[] = [];

    for (const key of Object.keys(params)) {
      const match = key.match(/^tags\[(\d+)\]$/);
      if (match) {
        const index = parseInt(match[1], 10);
        tags[index] = Number(params[key]);
        delete params[key];
      }
    }

    if (tags.length > 0) {
      params.tags = tags.filter((v) => v !== undefined);
    }
    if (!isSuperAdminRole(scope.roleCode)) {
      // Department admins can view all documents in their own department.
      // Regular users remain constrained by explicit file-role mapping.
      if (applyRoleFilter) {
        params.id = filteredFileIds.length > 0 ? { [Op.in]: filteredFileIds } : { [Op.in]: [-1] };
      }
      params.department_code = scope.departmentCode;
    }
    let response;
    response = await queryPage<IFileQuerySerType>(File, { pageNum, pageSize, params });

    if (fileContent) {
      const count = response.count;
      let fileList;
      fileList = await queryPage<IFileQuerySerType>(File, { pageNum: 1, pageSize: count, params });

      const fileIds = fileList.rows.map((file) => file.getDataValue('storage_key'));
      const q = "(" + fileIds.map(id => `id:"${id}"`).join(' OR ') + ") AND " + '"' + fileContent + '"';

      await axios.get(
        `${config.ApacheSolr.url}/solr/${config.ApacheSolr.coreName || 'mycore'}/select`,
        {
          params: {
            q: q,
            indent: 'true',
          },
        })
        .then((res) => {
          const ids = res.data.response.docs.map((doc: any) => doc.id);

          fileList = fileList.rows.filter(
            (file) =>
              ids.includes(file.getDataValue('storage_key')) &&
              (
                isSuperAdminRole(scope.roleCode) ||
                !applyRoleFilter ||
                filteredFileIds.includes(Number(file.getDataValue('id')))
              ),
          );

          response.rows = fileList.slice((pageNum - 1) * pageSize, pageNum * pageSize);
          response.count = fileList.length;
        });
    }

    ctx.state.formatData = response;
    ctx.set('Cache-Control', 'no-store');
    await next();
  } catch (error: any) {
    console.error('[listFiles] failed:', error?.message || error, error?.stack || '');
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'リストの取得に失敗しました',
      },
      ctx,
    );
  }
};

// Delete single file by ID parameter (for UI delete button)
export const deleteFileById = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const scope = (ctx.state as any).accessScope as AccessScope;
    const { id } = ctx.params;
    const fileId = parseInt(id, 10);

    if (!fileId || isNaN(fileId)) {
      ctx.throw(400, 'Invalid file ID');
    }

    console.log('🗑️  [FileController] Deleting file by ID:', {
      fileId,
      timestamp: new Date().toISOString(),
    });

    // Find the file first
    const file = await File.findByPk(fileId, {
      attributes: ['id', 'storage_key', 'filename', 'department_code'],
    });

    if (!file) {
      ctx.throw(404, 'ファイルが見つかりません');
    }
    if (!isSuperAdminRole(scope.roleCode) && file.getDataValue('department_code') !== scope.departmentCode) {
      ctx.throw(403, 'アクセス権限がありません');
    }

    console.log('📄 [FileController] File found:', {
      id: file.getDataValue('id'),
      filename: file.getDataValue('filename'),
      storage_key: file.getDataValue('storage_key'),
    });

    // Delete from RAG system
    try {
      if (config.RAG.mode[0] === "splitByArticleWithHybridSearch") {
        await axios.delete(`${config.RAG.Backend.url}/collection`, {
          data: {
            collection_name: config.RAG.PreProcess.PDF.splitByArticle.collectionName,
            ids: [fileId.toString()],
          },
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        await axios.delete(`${config.RAG.Backend.url}/collection`, {
          data: {
            collection_name: file.getDataValue('storage_key'),
            ids: [fileId.toString()],
          },
          headers: { 'Content-Type': 'application/json' },
        });
      }
      console.log('✅ [FileController] File deleted from RAG:', { fileId });
    } catch (e) {
      console.warn('⚠️  [FileController] RAG deletion warning:', e.message);
      // Don't throw - continue even if RAG deletion fails
    }

    // Delete from Solr
    try {
      const url = `${config.ApacheSolr.url}/solr/${config.ApacheSolr.coreName}/update?commit=true`;
      const body = { delete: { query: `file_name_s:"${file.getDataValue('storage_key')}"` } };
      await axios.post(url, body, { headers: { 'Content-Type': 'application/json' } });
      console.log('✅ [FileController] File deleted from Solr:', { fileId });
    } catch (e) {
      console.warn('⚠️  [FileController] Solr deletion warning:', e.message);
      // Don't throw - continue even if Solr deletion fails
    }

    // Delete physical artifacts from disk first.
    // If this fails, we must not delete DB metadata to avoid "UI-only deletion".
    await removePhysicalArtifacts(String(file.getDataValue('storage_key')), { strict: true });
    console.log('✅ [FileController] File deleted from disk:', { fileId });

    // Delete file metadata from DB (must succeed)
    try {
      const deletedCount = await deleteFileRowsFromDb([fileId]);
      if (deletedCount <= 0) {
        throw new Error('file_metadata_not_deleted');
      }
      console.log('✅ [FileController] File metadata deleted from DB:', { fileId, deletedCount });
    } catch (e) {
      console.error('❌ [FileController] DB metadata deletion failed:', e);
      throw e;
    }

    console.log('🎉 [FileController] File deleted successfully:', {
      fileId,
      filename: file.getDataValue('filename'),
      deletedAt: new Date().toISOString(),
    });

    ctx.state.formatData = {
      message: 'ファイルが正常に削除されました',
      id: fileId,
    };

    await next();
  } catch (error) {
    console.error('❌ [FileController] Delete error:', error);
    ctx.status = error.status || 500;
    ctx.body = {
      code: error.status || 500,
      message: error.message || 'ファイルの削除に失敗しました',
    };
  }
};

export const deleteFile = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const scope = (ctx.state as any).accessScope as AccessScope;
    const reqAny = ctx.request as any;
    const { ids } = reqAny.body as { ids: Array<string | number> };
    const filteredIds = (Array.isArray(ids) ? ids : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (!Array.isArray(filteredIds) || filteredIds.length === 0) {
      ctx.throw(404, 'ファイルが見つかりません');
    }

    const files = await File.findAll({
      where: {
        id: filteredIds,
        ...(isSuperAdminRole(scope.roleCode) ? {} : { department_code: scope.departmentCode }),
      },
      attributes: ['id', 'storage_key', 'department_code'], // name カラムが collection_name に相当
    });

    const authorizedIds = files
      .map((file) => Number(file.getDataValue('id')))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (authorizedIds.length === 0) {
      ctx.throw(404, 'ファイルが見つかりません');
    }

    // RAG 削除
    if (config.RAG.mode[0] === "splitByArticleWithHybridSearch") {
      try {
          await axios.delete(`${config.RAG.Backend.url}/collection`, {
            data: {
            collection_name: config.RAG.PreProcess.PDF.splitByArticle.collectionName,
            ids: authorizedIds.map((id) => id.toString()),
          },
          headers: { 'Content-Type': 'application/json' },
        });
        } catch (e) {
          console.error('RAG削除失敗:', e.name, e.message);
        }
    } else {
      for (const file of files) {
        try {
          await axios.delete(`${config.RAG.Backend.url}/collection`, {
            data: {
              collection_name: file.getDataValue('storage_key'),
              ids: [file.getDataValue('id').toString()],
            },
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          console.error('RAG削除失敗:', e.name, e.message);
        }
      }
    }

    // Solr 削除（allSettledで継続）
    await Promise.allSettled(
      files.map((file) => {
        // let a
        // a = axios.post(`${config.ApacheSolr.url}/solr/mycore/update?commit=true`, {
        //   delete: { id: "6Lnh9UjKCSPuchJzMlX_g.png" }
        // })
        const url = `${config.ApacheSolr.url}/solr/${config.ApacheSolr.coreName}/update?commit=true`
        const body = { delete: { query: `file_name_s:"${file.getDataValue('storage_key')}"` } }
        return axios.post(
          url,
          body,
          { headers: { 'Content-Type': 'application/json' } }
        ).catch(e => {
          console.error('Solr削除失敗:', e.name, e.message);
        })
      })
    );
    // await Promise.allSettled(
    //   files.map((file) =>
    //     axios.post(`${config.ApacheSolr.url}/solr/mycore/update?commit=true`, {
    //       delete: { id: "gQ0jgf9mVQI3hf9rANctw.pdf" }
    //     }).catch(e => {
    //       console.error('Solr削除失敗:', e.name, e.message);
    //     })
    //   )
    // );

    // File artifacts deletion (best-effort for bulk flow)
    await Promise.all(
      files.map(async (file) =>
        removePhysicalArtifacts(String(file.getDataValue('storage_key')), { strict: true }),
      ),
    );

    // Delete file metadata from DB (must succeed)
    const deletedCount = await deleteFileRowsFromDb(authorizedIds);
    if (deletedCount <= 0) {
      throw new Error('file_metadata_not_deleted');
    }

    ctx.state.formatData = {
      message: 'ファイルが削除されました',
      deletedCount,
      requestedCount: filteredIds.length,
      authorizedCount: authorizedIds.length,
    };
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: '削除に失敗しました',
      },
      ctx,
    );
  }
};

export const updateFileInfo = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const reqAny = ctx.request as any;
    if (reqAny.body?.tag == undefined) {
      reqAny.body.tag = null;
      await putFileInfo(reqAny.body);
    } else {
      await putFileInfo(reqAny.body);
    }
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit('error');
  }
};

export const addNewTag = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const reqAny = ctx.request as any;
    const newTag = reqAny.body;
    await postNewTag(newTag);
    ctx.state.formatData = { message: 'タグが追加されました' };
    await next();
  } catch (error) {
    console.error(error);
    if (error.name === 'SequelizeUniqueConstraintError' || error?.message === 'このタグ名はすでに存在しています') {
      return ctx.app.emit(
        'error',
        {
          code: '500',
          message: '同じタグ名がすでに存在します',
        },
        ctx,
      );
    } else {
      return ctx.app.emit(
        'error',
        {
          code: '500',
          message: 'タグの追加に失敗しました',
        },
        ctx,
      );
    }
  }
};

export const editTag = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const reqAny = ctx.request as any;
    reqAny.body.tag = null;
    await putTag(reqAny.body);
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit('error');
  }
};

export const deleteTag = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const res = await delTag(ctx.params.id);
    ctx.state.formatData = res;
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: '削除に失敗しました',
      },
      ctx,
    );
  }
};

export const listTags = async (ctx: Context, next: () => Promise<void>) => {
  try {
    type QueryWithOrder = IFileQuerySerType & {
      order?: [string, 'ASC' | 'DESC'][];
    };
    const res = await queryPage<QueryWithOrder>(Tag, {
      pageNum: 1,
      pageSize: Number.MAX_SAFE_INTEGER,
      order: [['created_at', 'ASC']],
    });
    ctx.state.formatData = res;
    await next();
  } catch (error) {
    console.error(error);
    return ctx.app.emit(
      'error',
      {
        code: '500',
        message: 'リストの取得に失敗しました',
      },
      ctx,
    );
  }
};

const canAccessStorageKey = async (scope: AccessScope, storageKey: string): Promise<boolean> => {
  const file = await File.findOne({
    where: { storage_key: storageKey },
    attributes: ['department_code'],
    raw: true,
  }) as any;
  if (!file) return false;
  if (isSuperAdminRole(scope.roleCode)) return true;
  return String(file.department_code || '') === String(scope.departmentCode || '');
};

export const previewFile = async (ctx) => {
  const scope = (ctx.state as any).accessScope as AccessScope;
  const storage_key = ctx.params.storage_key;
  if (!storage_key) {
    ctx.status = 400;
    ctx.body = '不正な入力です';
    return;
  }
  const allowed = await canAccessStorageKey(scope, storage_key);
  if (!allowed) {
    ctx.status = 403;
    ctx.body = 'アクセス権限がありません';
    return;
  }
  const filePath = path.join(FILE_UPLOAD_DIR, storage_key);
  if (!fs.existsSync(filePath)) {
    ctx.set('Content-Type', 'application/json');
    ctx.body = {
      code: 404,
      message: 'ファイルが見つかりません',
    };
    return;
  }
  const mimeType = mime.lookup(storage_key) || 'application/octet-stream';
  ctx.set('Content-Type', mimeType);
  ctx.set('Content-Disposition', `inline; filename="${encodeURIComponent(storage_key)}"`);
  ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  ctx.body = fs.createReadStream(filePath);
};

export const downloadFile = async (ctx) => {
  const scope = (ctx.state as any).accessScope as AccessScope;
  const storage_key = ctx.params.storage_key;
  if (!storage_key) {
    ctx.status = 400;
    ctx.body = '不正な入力です';
    return;
  }
  const allowed = await canAccessStorageKey(scope, storage_key);
  if (!allowed) {
    ctx.status = 403;
    ctx.body = 'アクセス権限がありません';
    return;
  }
  const filePath = path.join(FILE_UPLOAD_DIR, storage_key);
  if (!fs.existsSync(filePath)) {
    ctx.set('Content-Type', 'application/json');
    ctx.body = {
      code: 404,
      message: 'ファイルが見つかりません',
    };
    return;
  }
  const mimeType = mime.lookup(storage_key) || 'application/octet-stream';
  ctx.set('Content-Type', mimeType);
  ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(storage_key)}"`);
  ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  ctx.body = fs.createReadStream(filePath);
};

export const extractTextFromFile = async (ctx: Context, next: () => Promise<void>) => {
  try {
    const reqAny = ctx.request as any;
    const raw = reqAny.files?.file;
    if (!raw) {
      ctx.throw(400, 'ファイルが見つかりません / File not found');
    }

    const file: UploadedFile = Array.isArray(raw) ? raw[0] : raw;

    const ext = path.extname(file.originalFilename).toLowerCase();
    const supportedFormats = ['.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.odp', '.ods', '.txt'];

    if (!supportedFormats.includes(ext)) {
      ctx.throw(
        400,
        `対応していないファイル形式です。対応形式: ${supportedFormats.join(', ')} / Unsupported file format. Supported formats: ${supportedFormats.join(', ')}`,
      );
    }

    let extractedText: string;

    if (ext === '.txt') {
      extractedText = fs.readFileSync(file.filepath, 'utf-8');
    } else {
      try {
        extractedText = await parseOfficeAsync(file.filepath);
      } catch (error) {
        ctx.throw(400, 'ファイルの解析に失敗しました / Failed to parse file');
      }
    }

    if (!extractedText || extractedText.trim().length === 0) {
      ctx.throw(400, 'テキストが抽出できませんでした / Could not extract text from file');
    }

    ctx.state.formatData = {
      filename: file.originalFilename,
      text: extractedText.trim(),
      size: file.size,
      mimeType: file.mimetype,
      message: 'テキスト抽出に成功しました / Text extraction successful',
    };

    await next();
  } catch (error) {
    console.error('Text Extraction Error:', error);

    let errorMessage = 'テキスト抽出に失敗しました / Text extraction failed';
    if (error.message) {
      errorMessage += `: ${error.message}`;
    }

    ctx.status = error.status || 500;
    ctx.app.emit(
      'error',
      {
        code: (error.status || 500).toString(),
        message: errorMessage,
      },
      ctx,
    );
  }
};
