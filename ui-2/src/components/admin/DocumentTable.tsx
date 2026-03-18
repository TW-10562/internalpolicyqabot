import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  Eye,
  Download,
  X,
  FileText,
  Search,
  Upload,
  CheckCircle,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { getToken } from '../../api/auth';
import { formatDateJP } from '../../lib/dateTime';

interface DocumentHistory {
  id: number;
  filename: string;
  size: number;
  mime_type: string;
  created_at: string;
  create_by: string;
  storage_key: string;
  department_code?: 'HR' | 'GA' | 'ACC' | 'OTHER';
}

interface DocumentTableProps {
  documentHistory: DocumentHistory[];
  onDocumentDeleted?: () => void;
  onUploadClick?: () => void;
  showTitle?: boolean;
  showControls?: boolean;
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
}

export default function DocumentTable({
  documentHistory,
  onDocumentDeleted,
  onUploadClick,
  showTitle = true,
  showControls = true,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
}: DocumentTableProps) {
  const { t } = useLang();
  const toast = useToast();
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [selectedDocIds, setSelectedDocIds] = useState<Set<number>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<{ id: number; filename: string } | null>(null);
  const [deletingFileIds, setDeletingFileIds] = useState<Set<number>>(new Set());
  const [viewingFileIds, setViewingFileIds] = useState<Set<number>>(new Set());
  const [previewDoc, setPreviewDoc] = useState<DocumentHistory | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewMimeType, setPreviewMimeType] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState<DocumentHistory[] | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const searchQuery = controlledSearchQuery ?? localSearchQuery;
  const getDepartmentLabel = (departmentCode?: string) => {
    const normalized = String(departmentCode || '').toUpperCase();
    if (normalized === 'HR') return t('common.departments.hr');
    if (normalized === 'GA') return t('common.departments.ga');
    if (normalized === 'ACC') return t('common.departments.acc');
    if (normalized === 'OTHER') return t('common.departments.other');
    return t('common.departments.unknown');
  };

  const filteredDocs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return documentHistory;
    return documentHistory.filter(doc => doc.filename.toLowerCase().includes(q));
  }, [documentHistory, searchQuery]);

  const allFilteredSelected = filteredDocs.length > 0 && filteredDocs.every(doc => selectedDocIds.has(doc.id));
  const someFilteredSelected = filteredDocs.some(doc => selectedDocIds.has(doc.id));

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = !allFilteredSelected && someFilteredSelected;
  }, [allFilteredSelected, someFilteredSelected]);

  const getDeleteErrorMessage = async (response: Response): Promise<string> => {
    try {
      const data = await response.json();
      return data?.message || `Delete failed with status ${response.status}`;
    } catch {
      return `Delete failed with status ${response.status}`;
    }
  };

  const isDeleting = (fileId: number) => deletingFileIds.has(fileId);
  const isViewing = (fileId: number) => viewingFileIds.has(fileId);

  const getViewErrorMessage = async (response: Response): Promise<string> => {
    try {
      const data = await response.json();
      return data?.message || `View failed with status ${response.status}`;
    } catch {
      return `View failed with status ${response.status}`;
    }
  };

  const isInlineViewable = (filename: string, mimeType?: string): boolean => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const normalizedMime = String(mimeType || '').toLowerCase();
    if (normalizedMime === 'application/pdf') return true;
    if (normalizedMime.startsWith('text/plain')) return true;
    if (normalizedMime === 'image/png' || normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg' || normalizedMime === 'image/webp') return true;
    return ext === 'pdf' || ext === 'txt' || ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp';
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewDoc(null);
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewMimeType(null);
    setPreviewError(null);
    setIsPreviewLoading(false);
  };

  const handlePreviewDownload = () => {
    if (!previewDoc || !previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = previewDoc.filename || 'document';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleViewFile = async (doc: DocumentHistory): Promise<void> => {
    setOperationError(null);
    setPreviewError(null);
    setPreviewText(null);
    setPreviewMimeType(null);
    setIsPreviewLoading(true);
    setPreviewDoc(doc);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setViewingFileIds(prev => {
      const next = new Set(prev);
      next.add(doc.id);
      return next;
    });

    const token = getToken();
    const viewUrl = `/dev-api/api/files/${doc.id}/view`;

    try {
      const response = await fetch(viewUrl, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        throw new Error(await getViewErrorMessage(response));
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
      const contentType = response.headers.get('Content-Type') || blob.type || doc.mime_type;
      setPreviewMimeType(contentType || null);

      const inline = isInlineViewable(doc.filename, contentType || doc.mime_type);
      if (inline && String(contentType || '').toLowerCase().startsWith('text/plain')) {
        const text = await blob.text();
        setPreviewText(text);
      }
    } catch (error) {
      console.error('❌ [DocumentTable] Error viewing file:', error);
      const message = error instanceof Error ? error.message : t('documentTable.viewError');
      setOperationError(message);
      setPreviewError(message);
      toast.error(t('documentTable.viewError'), message);
    } finally {
      setIsPreviewLoading(false);
      setViewingFileIds(prev => {
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
    }
  };

  const handleDeleteFile = async (
    fileId: number,
    filename: string,
    options?: { suppressToast?: boolean },
  ): Promise<boolean> => {
    console.log('🗑️  [DocumentTable] Deleting file:', {
      fileId,
      filename,
      timestamp: new Date().toISOString(),
    });

    setOperationError(null);
    setDeletingFileIds(prev => {
      const next = new Set(prev);
      next.add(fileId);
      return next;
    });
    try {
      const token = getToken();
      const response = await fetch(`/dev-api/api/files/${fileId}`, {
        method: 'DELETE',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        throw new Error(await getDeleteErrorMessage(response));
      }

      console.log('✅ [DocumentTable] File deleted successfully:', {
        fileId,
        filename,
      });

      if (!options?.suppressToast) {
        toast.success(t('documentTable.deleteSuccess', { filename }));
      }
      setSelectedDocIds(prev => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
      onDocumentDeleted?.();
      return true;
    } catch (error) {
      console.error('❌ [DocumentTable] Error deleting file:', error);
      const message = error instanceof Error ? error.message : t('documentTable.deleteError');
      setOperationError(message);
      if (!options?.suppressToast) {
        toast.error(t('documentTable.deleteError'), message);
      }
      return false;
    } finally {
      setDeletingFileIds(prev => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-4">
      <div
        className={`flex flex-col gap-3 lg:flex-row lg:items-center ${
          showTitle ? 'lg:justify-between' : 'lg:justify-end'
        }`}
      >
        {showTitle ? (
          <h3 className="app-page-title transition-colors">{t('documentTable.title')}</h3>
        ) : null}
        {showControls ? (
        <div className={`flex items-center gap-3 w-full ${showTitle ? 'lg:max-w-2xl' : 'lg:max-w-3xl'}`}>
          <div className="relative flex-1 min-w-0">
            <div className="input-icon-absolute pointer-events-none"><Search className="w-4 h-4 text-icon-muted dark:text-dark-text-muted icon-current" /></div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                onSearchQueryChange?.(e.target.value);
                if (controlledSearchQuery == null) setLocalSearchQuery(e.target.value);
              }}
              placeholder={t('documentTable.searchPlaceholder')}
              className="w-full input-with-icon pr-4 py-2 bg-surface dark:bg-dark-surface border border-default dark:border-default rounded-xl text-foreground dark:text-dark-text placeholder-muted dark:placeholder-dark-text-muted focus:outline-none focus-ring-accent transition-colors"
            />
          </div>
          <button
            onClick={onUploadClick}
            className="flex items-center justify-center gap-2 h-10 px-4 btn-primary dark:bg-accent-strong text-on-accent rounded-xl transition-colors cursor-pointer whitespace-nowrap font-medium shadow-sm"
            title={t('documentTable.upload')}
          >
            <Upload className="w-4 h-4 icon-current" />
            <span className="hidden sm:inline">{t('documentTable.upload')}</span>
          </button>
        </div>
        ) : null}
      </div>
      {operationError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {operationError}
        </div>
      )}

      {/* Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface dark:bg-dark-surface rounded-2xl border border-default shadow-xl w-full max-w-5xl h-[85vh] overflow-hidden transition-colors">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#E8E8E8] dark:border-dark-border bg-[#F6F6F6] dark:bg-dark-bg-primary transition-colors">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground dark:text-dark-text truncate" title={previewDoc.filename}>
                  {previewDoc.filename}
                </div>
                {previewMimeType ? (
                  <div className="text-xs text-muted dark:text-dark-text-muted truncate" title={previewMimeType}>
                    {previewMimeType}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handlePreviewDownload}
                  disabled={!previewUrl || isPreviewLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-surface dark:bg-dark-surface hover:bg-surface-alt dark:hover:bg-dark-border border border-default text-foreground dark:text-dark-text text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t('pdfPreview.download')}
                >
                  <Download className="w-4 h-4 icon-current" />
                  <span className="hidden sm:inline">{t('pdfPreview.download')}</span>
                </button>
                <button
                  onClick={closePreview}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-surface dark:bg-dark-surface hover:bg-surface-alt dark:hover:bg-dark-border border border-default text-foreground dark:text-dark-text text-sm font-medium transition-colors"
                  title={t('common.close')}
                >
                  <X className="w-4 h-4 icon-current" />
                  <span className="hidden sm:inline">{t('common.close')}</span>
                </button>
              </div>
            </div>

            <div className="h-[calc(85vh-60px)] bg-surface dark:bg-dark-surface transition-colors">
              {isPreviewLoading ? (
                <div className="h-full flex items-center justify-center gap-3 text-muted dark:text-dark-text-muted">
                  <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                  <span className="text-sm">{t('common.loading')}</span>
                </div>
              ) : previewError ? (
                <div className="h-full flex items-center justify-center p-6">
                  <div className="max-w-xl w-full rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {previewError}
                  </div>
                </div>
              ) : (
                (() => {
                  const mime = String(previewMimeType || previewDoc.mime_type || '').toLowerCase();
                  const ext = previewDoc.filename.split('.').pop()?.toLowerCase();
                  const isPdf = mime.includes('application/pdf') || ext === 'pdf';
                  const isImage = mime.startsWith('image/');
                  const isText = mime.startsWith('text/plain') || ext === 'txt';

                  if (!previewUrl) {
                    return (
                      <div className="h-full flex items-center justify-center p-6 text-muted dark:text-dark-text-muted">
                        {t('documentTable.previewUnavailable')}
                      </div>
                    );
                  }

                  if (isPdf) {
                    return (
                      <iframe
                        src={previewUrl}
                        className="w-full h-full bg-white"
                        title={previewDoc.filename}
                      />
                    );
                  }

                  if (isImage) {
                    return (
                      <div className="h-full overflow-auto p-6 flex items-center justify-center bg-white/50 dark:bg-dark-bg-primary/40">
                        <img
                          src={previewUrl}
                          alt={previewDoc.filename}
                          className="max-w-full max-h-full rounded-xl shadow"
                        />
                      </div>
                    );
                  }

                  if (isText) {
                    return (
                      <pre className="h-full overflow-auto p-6 text-sm font-mono whitespace-pre-wrap text-foreground dark:text-dark-text">
                        {previewText || ''}
                      </pre>
                    );
                  }

                  return (
                    <div className="h-full flex items-center justify-center p-6">
                      <div className="max-w-xl w-full rounded-2xl border border-default bg-surface dark:bg-dark-surface p-6 text-center transition-colors">
                        <div className="mx-auto mb-3 w-12 h-12 rounded-2xl bg-surface-alt dark:bg-dark-border flex items-center justify-center">
                          <FileText className="w-6 h-6 text-muted dark:text-dark-text-muted" />
                        </div>
                        <div className="text-sm text-muted dark:text-dark-text-muted">
                          {t('documentTable.previewUnavailable')}
                        </div>
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {pendingDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface dark:bg-dark-surface rounded-2xl border border-default shadow-xl max-w-md w-full p-6 space-y-4 transition-colors">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-500/15">
                <Trash2 className="w-6 h-6 text-error dark:text-error" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground dark:text-[#f1f5f9] transition-colors">
                  {t('documentTable.deleteTitle')}
                </h3>
                <p className="text-sm text-muted dark:text-dark-text-muted transition-colors">
                  {t('documentTable.deleteWarning')}
                </p>
              </div>
            </div> 
            <div className="bg-[#F6F6F6] dark:bg-[#252538] rounded-xl p-4 transition-colors border border-[#E8E8E8] dark:border-[#3d3d4d]">
              <p className="text-xs text-[#6E7680] dark:text-[#9ca3af] mb-1 transition-colors">{t('documentTable.fileName')}</p>
              <p className="text-sm font-medium text-[#232333] dark:text-[#e5e7eb] break-all transition-colors">{pendingDelete.filename}</p>
            </div>
            <div className="flex gap-3 pt-2 border-t border-[#E8E8E8] dark:border-[#3d3d4d]">
              <button
                onClick={() => setPendingDelete(null)}
                className="flex-1 px-4 py-3 rounded-xl bg-surface dark:bg-dark-surface hover:bg-surface-alt dark:hover:bg-dark-border text-foreground dark:text-dark-text font-medium transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  handleDeleteFile(pendingDelete.id, pendingDelete.filename);
                  setPendingDelete(null);
                }}
                disabled={isDeleting(pendingDelete.id)}
                className="flex-1 px-4 py-3 rounded-xl bg-red-500 hover:bg-red-600 text-on-accent font-semibold transition-colors flex items-center justify-center gap-2"
              >
                <Trash2 className="w-4 h-4 icon-current" />
                {isDeleting(pendingDelete.id) ? t('common.loading') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Modal */}
      {pendingBulkDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-[#1a1a2e] border border-[#E8E8E8] dark:border-[#2d2d3d] rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-xl transition-colors">
            <div className="flex items-center gap-3 mb-1">
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-500/15">
                <Trash2 className="w-6 h-6 text-red-500 dark:text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-[#232333] dark:text-[#f1f5f9] transition-colors">
                  {t('documentTable.deleteSelectedTitle')}
                </h3>
                <p className="text-sm text-[#6E7680] dark:text-[#cbd5e1] transition-colors">
                  {t('documentTable.deleteWarning')}
                </p>
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto bg-[#F6F6F6] dark:bg-[#252538] rounded-xl p-3 space-y-1 border border-[#E8E8E8] dark:border-[#3d3d4d] transition-colors">
              {pendingBulkDelete.map((d) => (
                <div key={d.id} className="text-sm text-[#232333] dark:text-[#e5e7eb] truncate transition-colors" title={d.filename}>• {d.filename}</div>
              ))}
            </div>
            <div className="flex gap-3 pt-2 border-t border-[#E8E8E8] dark:border-[#3d3d4d]">
              <button
                onClick={() => setPendingBulkDelete(null)}
                className="flex-1 px-4 py-3 rounded-xl bg-[#F6F6F6] dark:bg-[#252538] hover:bg-[#E8E8E8] dark:hover:bg-[#3d3d4d] text-[#232333] dark:text-[#e5e7eb] font-medium transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={async () => {
                  const docs = pendingBulkDelete || [];
                  setPendingBulkDelete(null);
                  setIsBulkDeleting(true);
                  let successCount = 0;
                  let failedCount = 0;
                  for (const d of docs) {
                    // eslint-disable-next-line no-await-in-loop
                    const ok = await handleDeleteFile(d.id, d.filename, { suppressToast: true });
                    if (ok) successCount += 1;
                    else failedCount += 1;
                  }
                  setIsBulkDeleting(false);
                  if (failedCount === 0) {
                    toast.success(t('documentTable.bulkDeleteSuccess', { count: successCount }));
                  } else {
                    toast.warning(
                      t('documentTable.bulkDeletePartial', { success: successCount, failed: failedCount }),
                      t('documentTable.deleteError'),
                    );
                  }
                }}
                disabled={isBulkDeleting}
                className="flex-1 px-4 py-3 rounded-xl bg-red-500 hover:bg-red-600 text-white font-semibold transition-colors flex items-center justify-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                {isBulkDeleting ? t('common.loading') : t('common.deleteAll')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-dark-surface border border-[#E8E8E8] dark:border-dark-border rounded-2xl overflow-hidden shadow-sm transition-colors">
        <div className="flex items-center justify-between p-3 border-b border-[#E8E8E8] dark:border-dark-border bg-[#F6F6F6] dark:bg-dark-bg-primary transition-colors">
          <div className="text-sm text-[#6E7680] dark:text-dark-text-muted transition-colors">
            {selectedDocIds.size > 0 ? t('documentTable.selectedCount', { count: selectedDocIds.size }) : t('documentTable.manage')}
          </div>
          <button
            onClick={() => {
              const selected = Array.from(selectedDocIds);
              if (selected.length === 0) return;
              const docs = documentHistory.filter(d => selected.includes(d.id));
              setPendingBulkDelete(docs);
            }}
            disabled={selectedDocIds.size === 0 || isBulkDeleting}
            className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium"
          >
            {t('documentTable.deleteSelected')} ({selectedDocIds.size})
          </button>
        </div>

        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-12" />
            <col />
            <col className="w-12" />
            <col className="w-28" />
            <col className="w-32" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-28" />
            <col className="w-24" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[#F6F6F6] dark:bg-dark-bg-primary border-b border-[#E8E8E8] dark:border-dark-border transition-colors">
            <tr>
              <th className="px-4 py-3 text-left">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="w-4 h-4 accent-[#1d2089]"
                  checked={allFilteredSelected}
                  onChange={(e) => {
                    const next = new Set(selectedDocIds);
                    if (e.target.checked) {
                      filteredDocs.forEach(d => next.add(d.id));
                    } else {
                      filteredDocs.forEach(d => next.delete(d.id));
                    }
                    setSelectedDocIds(next);
                  }}
                />
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.documentName')}
              </th>
              <th className="px-2 py-3 text-center text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.view')}
              </th>
              <th className="px-3 py-3 text-right text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.size')}
              </th>
              <th className="px-3 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.uploadedBy')}
              </th>
              <th className="px-3 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.uploadDate')}
              </th>
              <th className="px-3 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.department')}
              </th>
              <th className="px-3 py-3 text-left text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.status')}
              </th>
              <th className="px-3 py-3 text-right text-sm font-medium text-[#6E7680] dark:text-dark-text-muted transition-colors">
                {t('documentTable.delete')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredDocs.length > 0 ? (
              filteredDocs.map((doc) => (
                <tr key={doc.id} className="border-b border-[#E8E8E8] dark:border-dark-border hover:bg-[#F6F6F6] dark:hover:bg-dark-border transition-colors">
                  <td className="px-3 py-3 align-middle">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-[#1d2089]"
                      checked={selectedDocIds.has(doc.id)}
                      onChange={(e) => {
                        setSelectedDocIds(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(doc.id); else next.delete(doc.id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td className="px-4 py-3 align-middle text-[#232333] dark:text-dark-text font-medium transition-colors truncate" title={doc.filename}>
                  {doc.filename}
                  </td>
                  <td className="px-2 py-3 align-middle">
                    <div className="flex items-center justify-center">
                      <button
                        onClick={() => handleViewFile(doc)}
                        disabled={isViewing(doc.id) || isDeleting(doc.id)}
                        className="p-1 text-blue-600 dark:text-dark-accent-blue hover:bg-blue-50 dark:hover:bg-blue-500/20 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={t('documentTable.view')}
                        aria-label={t('documentTable.view')}
                      >
                        <Eye className={`w-4 h-4 ${isViewing(doc.id) ? 'animate-pulse' : ''}`} />
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-3 align-middle text-right text-[#6E7680] dark:text-dark-text-muted transition-colors tabular-nums">
                    {(doc.size / 1024 / 1024).toFixed(2)} MB
                  </td>
                  <td className="px-3 py-3 align-middle text-[#6E7680] dark:text-dark-text-muted transition-colors truncate" title={doc.create_by || t('documentTable.system')}>
                    {doc.create_by || t('documentTable.system')}
                  </td>
                  <td className="px-3 py-3 align-middle text-[#6E7680] dark:text-dark-text-muted transition-colors tabular-nums">
                    {formatDateJP(doc.created_at)}
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <span
                      title={getDepartmentLabel(doc.department_code)}
                      className={`inline-block max-w-[7rem] truncate px-2 py-1 rounded-full text-xs font-medium ${
                        doc.department_code === 'HR'
                          ? 'bg-blue-50 text-blue-700'
                          : doc.department_code === 'GA'
                            ? 'bg-emerald-50 text-emerald-700'
                            : doc.department_code === 'ACC'
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {getDepartmentLabel(doc.department_code)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-50 text-green-600">
                      <CheckCircle className="w-3 h-3" />
                      {t('documentTable.active')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setPendingDelete({ id: doc.id, filename: doc.filename })}
                        disabled={isDeleting(doc.id) || isViewing(doc.id)}
                        className="p-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/20 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={t('documentTable.delete')}
                        aria-label={t('documentTable.delete')}
                      >
                        <Trash2 className={`w-4 h-4 ${isDeleting(doc.id) ? 'animate-pulse' : ''}`} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-[#6E7680] dark:text-dark-text-muted transition-colors">
                  {searchQuery.trim() ? t('documentTable.noMatchingDocuments') : t('documentTable.noDocuments')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
