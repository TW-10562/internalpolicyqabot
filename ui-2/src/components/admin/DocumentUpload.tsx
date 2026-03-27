import { useState, useRef, useEffect, useMemo } from 'react';
import {
  X,
  FileText,
  CheckCircle,
  Clock,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { getToken } from '../../api/auth';
import { User as UserType } from '../../types';

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

interface DocumentUploadProps {
  onUploadComplete?: (files: DocumentHistory[]) => void;
  documentHistory: DocumentHistory[];
  triggerFileInput?: boolean;
  onTriggerReset?: () => void;
  currentUser?: Pick<UserType, 'roleCode' | 'departmentCode'>;
}

type FileStatus = 'pending' | 'uploading' | 'indexing' | 'success' | 'error';
type PipelineStatus = 'pending' | 'in-progress' | 'completed' | 'failed';

export default function DocumentUpload({
  onUploadComplete,
  documentHistory,
  triggerFileInput = false,
  onTriggerReset,
  currentUser,
}: DocumentUploadProps) {
  const { t } = useLang();
  const toast = useToast();
  const resolveDefaultDepartment = (): 'HR' | 'GA' | 'ACC' | 'OTHER' => {
    const dep = String(currentUser?.departmentCode || 'HR').toUpperCase();
    if (dep === 'GA' || dep === 'ACC' || dep === 'OTHER') return dep;
    return 'HR';
  };
  const isSuperAdmin = currentUser?.roleCode === 'SUPER_ADMIN';
  const defaultDepartment = resolveDefaultDepartment();
  const departmentOptions: Array<{ value: 'HR' | 'GA' | 'ACC' | 'OTHER'; label: string }> = [
    { value: 'HR', label: 'HR' },
    { value: 'GA', label: 'GA' },
    { value: 'ACC', label: 'ACC' },
    { value: 'OTHER', label: 'OTHER' },
  ];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const [uploadingFiles, setUploadingFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<string, FileStatus>>({});
  const [uploadCategory, setUploadCategory] = useState<'HR' | 'GA' | 'ACC' | 'OTHER'>(defaultDepartment);
  const [reviewMode, setReviewMode] = useState<boolean>(false);
  const [fileCategories, setFileCategories] = useState<Record<string, string>>({});
  const [selectedToRemove, setSelectedToRemove] = useState<Set<string>>(new Set());
  const [isUploading, setIsUploading] = useState<boolean>(false);

  // Derive pipeline status from actual file states
  const fileCounts = useMemo(() => {
    const statuses = Object.values(uploadProgress);
    const total = uploadingFiles.length;
    const uploading = statuses.filter(s => s === 'uploading').length;
    const indexing = statuses.filter(s => s === 'indexing').length;
    const success = statuses.filter(s => s === 'success').length;
    const error = statuses.filter(s => s === 'error').length;
    const done = success + error;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return { total, uploading, indexing, success, error, done, percent };
  }, [uploadProgress, uploadingFiles.length]);

  const pipelineSteps = useMemo((): { labelKey: string; status: PipelineStatus }[] => {
    const { total, uploading, indexing, success, error, done } = fileCounts;
    if (total === 0 || !isUploading && done === 0) {
      return [
        { labelKey: 'documentTable.pipeline.upload', status: 'pending' },
        { labelKey: 'documentTable.pipeline.processing', status: 'pending' },
        { labelKey: 'documentTable.pipeline.ready', status: 'pending' },
      ];
    }

    const allDone = done === total;
    const anyUploading = uploading > 0;
    const anyIndexing = indexing > 0;
    const allFailed = error === total;

    // Step 1: Upload — in-progress if any file is uploading, completed when all past upload stage
    let uploadStatus: PipelineStatus = 'pending';
    if (anyUploading) {
      uploadStatus = 'in-progress';
    } else if (done > 0 || anyIndexing) {
      uploadStatus = allFailed ? 'failed' : 'completed';
    }

    // Step 2: Processing — in-progress if any file indexing or some done but not all
    let processingStatus: PipelineStatus = 'pending';
    if (anyIndexing || (done > 0 && !allDone)) {
      processingStatus = 'in-progress';
    } else if (allDone) {
      processingStatus = allFailed ? 'failed' : 'completed';
    }

    // Step 3: Ready — only completed when ALL files are done
    let readyStatus: PipelineStatus = 'pending';
    if (allDone) {
      readyStatus = allFailed ? 'failed' : (error > 0 ? 'completed' : 'completed');
    }

    return [
      { labelKey: 'documentTable.pipeline.upload', status: uploadStatus },
      { labelKey: 'documentTable.pipeline.processing', status: processingStatus },
      { labelKey: 'documentTable.pipeline.ready', status: readyStatus },
    ];
  }, [fileCounts, isUploading]);

  // Handle external trigger to open file input
  useEffect(() => {
    if (triggerFileInput && fileInputRef.current) {
      fileInputRef.current.click();
      onTriggerReset?.();
    }
  }, [triggerFileInput, onTriggerReset]);

  useEffect(() => {
    if (!isSuperAdmin) {
      setUploadCategory(defaultDepartment);
      setFileCategories((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k) => {
          next[k] = defaultDepartment;
        });
        return next;
      });
    }
  }, [defaultDepartment, isSuperAdmin]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files);

      const duplicates: string[] = [];
      const validFiles: File[] = [];

      newFiles.forEach(file => {
        const existingFile = documentHistory.find(doc => doc.filename === file.name);
        if (existingFile) {
          duplicates.push(file.name);
        } else {
          validFiles.push(file);
        }
      });

      if (duplicates.length > 0) {
        toast.info(t('documentTable.skippedExisting', { files: duplicates.join(', ') }));
      }

      if (validFiles.length > 0) {
        setUploadingFiles(prev => [...prev, ...validFiles]);
        const newProgress: Record<string, 'pending'> = {};
        validFiles.forEach(f => { newProgress[f.name] = 'pending'; });
        setUploadProgress(prev => ({ ...prev, ...newProgress }));

        setFileCategories(prev => {
          const updated = { ...prev };
          validFiles.forEach(f => {
            if (!updated[f.name]) updated[f.name] = uploadCategory || defaultDepartment;
          });
          return updated;
        });
        setReviewMode(true);
        setSelectedToRemove(new Set());
      }

      e.target.value = '';
    }
  };

  const handleStartUpload = async () => {
    if (uploadingFiles.length === 0) return;
    setReviewMode(false);
    setIsUploading(true);

    const controller = new AbortController();
    uploadControllerRef.current = controller;
    const token = getToken();
    let completed = 0;
    let failed = 0;

    try {
      for (const file of uploadingFiles) {
        if (controller.signal.aborted) break;

        setUploadProgress((prev) => ({ ...prev, [file.name]: 'uploading' }));

        try {
          const formData = new FormData();
          formData.append('files', file);
          const fileDept = fileCategories[file.name] || uploadCategory || defaultDepartment;
          formData.append('category', fileDept);
          formData.append('departmentCode', fileDept);
          formData.append('fileCategories', JSON.stringify({ [file.name]: fileDept }));

          const uploadResponse = await fetch('/dev-api/api/files/upload', {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
            signal: controller.signal,
          });

          if (!uploadResponse.ok) {
            throw new Error(`HTTP ${uploadResponse.status}`);
          }

          const result = await uploadResponse.json();
          const hasErrors = result?.result?.errors?.length > 0 || result?.errors?.length > 0;

          if (hasErrors) {
            throw new Error('Server reported error');
          }

          // Backend processes extraction + indexing during upload call
          setUploadProgress((prev) => ({ ...prev, [file.name]: 'indexing' }));

          // Brief pause so the user can see the processing state
          await new Promise<void>((resolve, reject) => {
            if (controller.signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
            const t = setTimeout(resolve, 300);
            controller.signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
          });

          setUploadProgress((prev) => ({ ...prev, [file.name]: 'success' }));
          completed++;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          console.error(`[DocumentUpload] Failed to upload ${file.name}:`, err);
          setUploadProgress((prev) => ({ ...prev, [file.name]: 'error' }));
          failed++;
        }
      }

      // Refresh the file list
      const refreshResponse = await fetch('/dev-api/api/files?pageNum=1&pageSize=100', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      const refreshData = await refreshResponse.json();
      const files = refreshData.result?.rows || refreshData.data || refreshData.rows || [];
      if (Array.isArray(files)) {
        onUploadComplete?.(files);
      }

      if (failed === 0) {
        toast.success(t('documentTable.uploadSuccess', { count: completed, category: uploadCategory }));
      } else if (completed > 0) {
        toast.info(t('documentTable.uploadPartial', { success: completed, failed }, `${completed} uploaded, ${failed} failed`));
      } else {
        toast.error(t('documentTable.uploadFailed', { error: `All ${failed} files failed` }));
      }

      // Auto-reset after a short delay so user can see final status
      setTimeout(() => resetUpload(), failed > 0 ? 3000 : 1500);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const uploadedFileNames = Object.entries(uploadProgress)
          .filter(([, status]) => status === 'success')
          .map(([name]) => name);
        const pendingFileNames = uploadingFiles
          .map((f) => f.name)
          .filter((name) => !uploadedFileNames.includes(name) && uploadProgress[name] === 'uploading');
        void cleanupCancelledUploads(pendingFileNames);
        setReviewMode(true);
        setUploadProgress((prev) => {
          const next = { ...prev };
          Object.keys(next).forEach((key) => {
            if (next[key] === 'uploading' || next[key] === 'indexing') next[key] = 'pending';
          });
          return next;
        });
        toast.info(t('documentTable.uploadCanceled'));
        return;
      }
      console.error('[DocumentUpload] Upload failed:', error);
      toast.error(t('documentTable.uploadFailed', { error: error instanceof Error ? error.message : t('common.error') }));
    } finally {
      setIsUploading(false);
      uploadControllerRef.current = null;
    }
  };

  const handleCancelUpload = () => {
    if (!isUploading || !uploadControllerRef.current) return;
    uploadControllerRef.current.abort();
  };

  const handleDefaultCategoryChange = (nextCategory: 'HR' | 'GA' | 'ACC' | 'OTHER') => {
    if (!isSuperAdmin) return;
    const previousCategory = uploadCategory;
    setUploadCategory(nextCategory);
    setFileCategories((prev) => {
      const next = { ...prev };
      uploadingFiles.forEach((file) => {
        const current = next[file.name] ?? previousCategory;
        if (current === previousCategory) next[file.name] = nextCategory;
      });
      return next;
    });
  };

  const cleanupCancelledUploads = async (fileNames: string[]) => {
    if (fileNames.length === 0) return;
    try {
      const token = getToken();
      const listResponse = await fetch('/dev-api/api/files?pageNum=1&pageSize=200', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      const listData = await listResponse.json();
      const files = listData.result?.rows || listData.data || listData.rows || [];
      if (!Array.isArray(files)) return;
      const toDelete = files.filter((file) => fileNames.includes(file.filename));
      await Promise.allSettled(
        toDelete.map((file) =>
          fetch(`/dev-api/api/files/${file.id}`, {
            method: 'DELETE',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          })
        )
      );
    } catch (err) {
      console.warn('[DocumentUpload] Cleanup after cancel failed:', err);
    }
  };

  const removeFile = (fileName: string) => {
    setUploadingFiles(prev => prev.filter(f => f.name !== fileName));
    setUploadProgress(prev => {
      const newProgress = { ...prev };
      delete newProgress[fileName];
      return newProgress;
    });
  };

  const resetUpload = () => {
    if (isUploading) {
      uploadControllerRef.current?.abort();
    }
    setUploadingFiles([]);
    setUploadProgress({});
    setUploadCategory(defaultDepartment);
    setFileCategories({});
    setSelectedToRemove(new Set());
    setReviewMode(false);
  };

  const removeSelectedFiles = () => {
    if (selectedToRemove.size === 0) return;
    const names = new Set(selectedToRemove);
    setUploadingFiles(prev => prev.filter(f => !names.has(f.name)));
    setUploadProgress(prev => {
      const next = { ...prev } as Record<string, FileStatus>;
      names.forEach(n => { delete next[n]; });
      return next;
    });
    setFileCategories(prev => {
      const next = { ...prev };
      names.forEach(n => { delete next[n]; });
      return next;
    });
    setSelectedToRemove(new Set());
  };

  const getPipelineStatusBadge = (status: PipelineStatus) => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-2 py-0.5 rounded-full">
            <CheckCircle className="w-3 h-3" />
            {t('documentTable.pipelineStatusDone')}
          </span>
        );
      case 'in-progress':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full animate-pulse">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('documentTable.pipelineStatusProcessing')}
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-full">
            <AlertCircle className="w-3 h-3" />
            {t('documentTable.pipelineStatusFailed')}
          </span>
        );
      default:
        return (
          <span className="text-xs font-medium text-muted dark:text-dark-text-muted px-2 py-0.5">
            {t('documentTable.pipelineStatusPending')}
          </span>
        );
    }
  };

  const getProgressBarWidth = (status: PipelineStatus) => {
    switch (status) {
      case 'completed': return 'w-full';
      case 'in-progress': return 'w-2/3';
      case 'failed': return 'w-full';
      default: return 'w-0';
    }
  };

  const getProgressBarColor = (status: PipelineStatus) => {
    switch (status) {
      case 'completed': return 'bg-green-500';
      case 'in-progress': return 'bg-blue-500';
      case 'failed': return 'bg-red-400';
      default: return 'bg-surface-alt';
    }
  };

  return (
    <>
      {uploadingFiles.length > 0 && (
        <div className="bg-surface-alt dark:bg-dark-surface-alt border border-default rounded-2xl p-4 space-y-4 transition-colors">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h4 className="text-lg font-semibold text-foreground dark:text-white transition-colors mb-1">{t('documentTable.filesSelected', { count: uploadingFiles.length })}</h4>
              <p className="text-sm text-muted dark:text-dark-text-muted transition-colors">{t('documentTable.totalSize', { size: (uploadingFiles.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2) })}</p>
            </div>
            <button
              onClick={resetUpload}
              className="p-2 hover:bg-surface dark:hover:bg-white/10 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-icon-muted dark:text-dark-text-muted icon-current" />
            </button>
          </div>

          <div className="space-y-2 max-h-60 overflow-y-auto">
            {uploadingFiles.map((file, index) => (
              <div key={index} className="flex items-center justify-between bg-surface dark:bg-dark-surface rounded-xl px-3 py-2 gap-3 border border-default transition-colors">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-accent dark:accent-accent"
                    checked={selectedToRemove.has(file.name)}
                    onChange={(e) => {
                      setSelectedToRemove(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(file.name); else next.delete(file.name);
                        return next;
                      });
                    }}
                    disabled={uploadProgress[file.name] !== 'pending'}
                  />
                  <FileText className="w-4 h-4 text-icon-muted flex-shrink-0 icon-current" />
                  <span className="text-sm text-foreground dark:text-dark-text truncate transition-colors" title={file.name}>{file.name}</span>
                  <span className="text-xs text-muted dark:text-dark-text-muted transition-colors">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                  {uploadProgress[file.name] === 'success' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full flex-shrink-0">
                      <CheckCircle className="w-3.5 h-3.5" />
                      {t('documentTable.fileStatus.done')}
                    </span>
                  )}
                  {uploadProgress[file.name] === 'uploading' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full animate-pulse flex-shrink-0">
                      <Clock className="w-3.5 h-3.5" />
                      {t('documentTable.fileStatus.uploading')}
                    </span>
                  )}
                  {uploadProgress[file.name] === 'indexing' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full animate-pulse flex-shrink-0">
                      <Clock className="w-3.5 h-3.5" />
                      {t('documentTable.fileStatus.processing')}
                    </span>
                  )}
                  {uploadProgress[file.name] === 'error' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full flex-shrink-0">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {t('documentTable.fileStatus.failed')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400 dark:text-dark-text-muted transition-colors">
                    {t('documentTable.categoryLabel')}
                  </label>
                  <select
                    value={fileCategories[file.name] || defaultDepartment}
                    onChange={(e) => setFileCategories(prev => ({ ...prev, [file.name]: e.target.value }))}
                    disabled={uploadProgress[file.name] !== 'pending' || !isSuperAdmin}
                    className="bg-surface dark:bg-dark-surface-alt border border-default text-foreground dark:text-dark-text text-xs rounded-lg px-2 py-1 focus:outline-none focus-ring-accent transition-colors"
                  >
                    {departmentOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {uploadProgress[file.name] === 'pending' && (
                    <button
                      onClick={() => removeFile(file.name)}
                      className="p-1 hover:bg-white/10 rounded text-muted hover:text-error transition-colors"
                    >
                      <X className="w-4 h-4 icon-current" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {reviewMode && (
            <div className="flex items-center justify-between">
              <button
                onClick={removeSelectedFiles}
                disabled={selectedToRemove.size === 0}
                className="px-3 py-2 rounded-xl bg-surface dark:bg-dark-surface-alt hover:bg-surface-alt dark:hover:bg-dark-surface text-foreground dark:text-dark-text disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors"
              >
                {t('documentTable.removeSelected')}
              </button>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[#232333] dark:text-dark-text mb-3 transition-colors">
              {t('documentTable.defaultCategory')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {departmentOptions.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => handleDefaultCategoryChange(cat.value)}
                  disabled={isUploading || !isSuperAdmin}
                  className={`px-4 py-2 rounded-xl font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                    uploadCategory === cat.value
                      ? 'btn-primary text-white shadow-lg ring-2 ring-accent ring-offset-1'
                      : 'bg-surface dark:bg-dark-surface text-muted dark:text-dark-text-muted hover:bg-surface-alt dark:hover:bg-dark-border border border-default'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Pipeline Progress */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h5 className="text-sm font-semibold text-[#232333] dark:text-white transition-colors">
                {t('documentTable.pipelineTitle')}
              </h5>
            </div>

            {/* Global progress bar */}
            {isUploading || fileCounts.done > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground dark:text-dark-text">
                    {fileCounts.done === fileCounts.total
                      ? (fileCounts.error > 0
                        ? t('documentTable.progressWithErrors', { done: fileCounts.done, total: fileCounts.total, failed: fileCounts.error })
                        : t('documentTable.progressComplete', { done: fileCounts.done, total: fileCounts.total }))
                      : t('documentTable.progress', { done: fileCounts.done, total: fileCounts.total, percent: fileCounts.percent })}
                  </span>
                  <span className="text-lg font-bold text-foreground dark:text-dark-text tabular-nums">
                    {fileCounts.percent}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-white/10 rounded-full h-3 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ease-out ${
                      fileCounts.done === fileCounts.total
                        ? (fileCounts.error > 0 ? 'bg-amber-500' : 'bg-green-500')
                        : 'bg-blue-500'
                    }`}
                    style={{ width: `${fileCounts.percent}%` }}
                  />
                </div>
              </div>
            ) : null}

            {/* Pipeline steps */}
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2">
              {pipelineSteps.map((step, idx) => (
                <>
                  <span key={`num-${idx}`} className="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold bg-surface dark:bg-dark-surface text-muted dark:text-dark-text-muted border border-default">
                    {idx + 1}
                  </span>
                  <span key={`label-${idx}`} className="text-sm font-medium text-foreground dark:text-dark-text transition-colors">
                    {t(step.labelKey)}
                  </span>
                  <span key={`badge-${idx}`}>
                    {getPipelineStatusBadge(step.status)}
                  </span>
                </>
              ))}
            </div>
          </div>

          {reviewMode ? (
            <div className="flex justify-end">
              <button
                onClick={handleStartUpload}
                className="px-6 py-3 btn-primary text-white font-semibold rounded-xl transition-all"
              >
                {t('documentTable.nextContinue')}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={handleCancelUpload}
                disabled={!isUploading}
                className="px-5 py-3 rounded-xl btn-danger text-on-accent text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <span className="inline-flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  {t('documentTable.cancelUpload')}
                </span>
              </button>
              <button
                onClick={handleStartUpload}
                disabled={isUploading}
                className="px-6 py-3 btn-primary text-white disabled:opacity-50 disabled:cursor-not-allowed font-semibold rounded-xl transition-all"
              >
                {isUploading ? t('documentTable.pipeline.inProgress') : t('documentTable.pipeline.start')}
              </button>
            </div>
          )}
        </div>
      )}

      {uploadingFiles.length === 0 && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          accept=".pdf,.doc,.docx,.txt,.xlsx,.csv"
        />
      )}
    </>
  );
}
