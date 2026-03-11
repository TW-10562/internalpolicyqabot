import IndexCon from '@/controller';
import { deleteFile, deleteFileById, listFiles, uploadFile, updateFileInfo, addNewTag, editTag, deleteTag, listTags, previewFile, downloadFile, extractTextFromFile} from '@/controller/file';
import { requireScopedAccess } from '@/controller/auth';
import Router from 'koa-router';

const router = new Router({ prefix: '/api/files' });

// Specific routes first
router.post('/upload', requireScopedAccess, uploadFile, IndexCon());
router.post('/addNewTag', requireScopedAccess, addNewTag, IndexCon());
router.post('/extract-text', requireScopedAccess, extractTextFromFile, IndexCon());

// GET routes
router.get('/', requireScopedAccess, listFiles, IndexCon());
router.get('/tags', requireScopedAccess, listTags, IndexCon());
router.get('/preview/:storage_key', requireScopedAccess, previewFile);
router.get('/download/:storage_key', requireScopedAccess, downloadFile);

// DELETE routes - specific first, then general param
router.delete('/delete', requireScopedAccess, deleteFile, IndexCon()); // DELETE /api/files/delete with body
router.delete('/:id', requireScopedAccess, deleteFileById, IndexCon()); // DELETE /api/files/:id (file deletion)

// PUT routes
router.put('/', requireScopedAccess, updateFileInfo, IndexCon());
router.put('/editTag', requireScopedAccess, editTag, IndexCon());

export default router;
