import { useState, useRef, useEffect } from 'react';
import {
  X,
  FileText,
  CheckCircle,
  Clock,
  AlertCircle,
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
  const [uploadProgress, setUploadProgress] = useState<Record<string, 'pending' | 'uploading' | 'success' | 'error'>>({});
  const [uploadCategory, setUploadCategory] = useState<'HR' | 'GA' | 'ACC' | 'OTHER'>(defaultDepartment);
  const [reviewMode, setReviewMode] = useState<boolean>(false);
  const [fileCategories, setFileCategories] = useState<Record<string, string>>({});
  const [selectedToRemove, setSelectedToRemove] = useState<Set<string>>(new Set());
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [pipelineSteps, setPipelineSteps] = useState<{
    step: number;
    status: 'pending' | 'in-progress' | 'completed' | 'error';
    labelKey: string;
  }[]>([
    { step: 1, status: 'pending', labelKey: 'documentTable.pipeline.fileUpload' },
    { step: 2, status: 'pending', labelKey: 'documentTable.pipeline.contentExtraction' },
    { step: 3, status: 'pending', labelKey: 'documentTable.pipeline.embeddingIndexing' },
    { step: 4, status: 'pending', labelKey: 'documentTable.pipeline.ragIntegration' },
  ]);

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
      console.log('📎 [DocumentUpload] Files selected:', newFiles.length);

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

    console.log('🚀 [DocumentUpload] Starting upload pipeline...');

    try {
      const controller = new AbortController();
      uploadControllerRef.current = controller;

      const abortableDelay = (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          const timer = window.setTimeout(resolve, ms);
          const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });

      console.log('🔄 [DocumentUpload] STEP 1: File Upload - IN PROGRESS');
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 1 ? { ...s, status: 'in-progress' } : s))
      );

      const formData = new FormData();
      uploadingFiles.forEach(file => {
        formData.append('files', file);
        setUploadProgress(prev => ({ ...prev, [file.name]: 'uploading' }));
      });
      formData.append('category', uploadCategory);
      formData.append('departmentCode', uploadCategory);

      try {
        const mapping: Record<string, string> = {};
        uploadingFiles.forEach(f => {
          mapping[f.name] = fileCategories[f.name] || uploadCategory || defaultDepartment;
        });
        formData.append('fileCategories', JSON.stringify(mapping));
      } catch (err) {
        console.warn('Could not append fileCategories mapping');
      }

      const token = getToken();
      const uploadResponse = await fetch('/dev-api/api/files/upload', {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData,
        signal: controller.signal,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed with status ${uploadResponse.status}`);
      }

      const uploadResult = await uploadResponse.json();
      console.log('✅ [DocumentUpload] STEP 1: File Upload - COMPLETED', uploadResult);
      const successProgress: Record<string, 'success'> = {};
      uploadingFiles.forEach(f => { successProgress[f.name] = 'success'; });
      setUploadProgress(prev => ({ ...prev, ...successProgress }));
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 1 ? { ...s, status: 'completed' } : s))
      );

      console.log('🔄 [DocumentUpload] STEP 2: Content Extraction - IN PROGRESS');
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 2 ? { ...s, status: 'in-progress' } : s))
      );
      await abortableDelay(1500, controller.signal);
      console.log('✅ [DocumentUpload] STEP 2: Content Extraction - COMPLETED');
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 2 ? { ...s, status: 'completed' } : s))
      );

      console.log('🔄 [DocumentUpload] STEP 3: Embedding & Indexing - IN PROGRESS');
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 3 ? { ...s, status: 'in-progress' } : s))
      );
      await abortableDelay(2000, controller.signal);
      console.log('✅ [DocumentUpload] STEP 3: Embedding & Indexing - COMPLETED');
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 3 ? { ...s, status: 'completed' } : s))
      );

      console.log('🔄 [DocumentUpload] STEP 4: RAG Integration - IN PROGRESS');
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 4 ? { ...s, status: 'in-progress' } : s))
      );
      await abortableDelay(1000, controller.signal);
      console.log('✅ [DocumentUpload] STEP 4: RAG Integration - COMPLETED');
      setPipelineSteps((prev) =>
        prev.map((s) => (s.step === 4 ? { ...s, status: 'completed' } : s))
      );

      console.log('🎉 [DocumentUpload] Upload pipeline completed successfully!');

      const refreshResponse = await fetch('/dev-api/api/files?pageNum=1&pageSize=100', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      const refreshData = await refreshResponse.json();
      const files = refreshData.result?.rows || refreshData.data || refreshData.rows || [];
      if (Array.isArray(files)) {
        onUploadComplete?.(files);
      }

      toast.success(t('documentTable.uploadSuccess', { count: uploadingFiles.length, category: uploadCategory }));
      resetUpload();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.warn('⏹️ [DocumentUpload] Upload cancelled by user.');
        const cancelledFileNames = uploadingFiles.map((file) => file.name);
        void cleanupCancelledUploads(cancelledFileNames);
        setPipelineSteps([
          { step: 1, status: 'pending', labelKey: 'documentTable.pipeline.fileUpload' },
          { step: 2, status: 'pending', labelKey: 'documentTable.pipeline.contentExtraction' },
          { step: 3, status: 'pending', labelKey: 'documentTable.pipeline.embeddingIndexing' },
          { step: 4, status: 'pending', labelKey: 'documentTable.pipeline.ragIntegration' },
        ]);
        setReviewMode(true);
        setUploadProgress((prev) => {
          const next = { ...prev };
          Object.keys(next).forEach((key) => {
            if (next[key] === 'uploading') next[key] = 'pending';
          });
          return next;
        });
        toast.info(t('documentTable.uploadCanceled'));
        return;
      }
      console.error('❌ [DocumentUpload] Upload failed:', error);
      setPipelineSteps((prev) =>
        prev.map((s) =>
          s.status === 'in-progress' ? { ...s, status: 'error' } : s
        )
      );
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
      console.warn('⚠️ [DocumentUpload] Cleanup after cancel failed:', err);
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
    console.log('🔄 [DocumentUpload] Resetting upload form...');
    if (pipelineSteps.some((step) => step.status === 'in-progress')) {
      uploadControllerRef.current?.abort();
    }
    setUploadingFiles([]);
    setUploadProgress({});
    setUploadCategory(defaultDepartment);
    setFileCategories({});
    setSelectedToRemove(new Set());
    setReviewMode(false);
    setPipelineSteps([
      { step: 1, status: 'pending', labelKey: 'documentTable.pipeline.fileUpload' },
      { step: 2, status: 'pending', labelKey: 'documentTable.pipeline.contentExtraction' },
      { step: 3, status: 'pending', labelKey: 'documentTable.pipeline.embeddingIndexing' },
      { step: 4, status: 'pending', labelKey: 'documentTable.pipeline.ragIntegration' },
    ]);
  };

  const removeSelectedFiles = () => {
    if (selectedToRemove.size === 0) return;
    const names = new Set(selectedToRemove);
    setUploadingFiles(prev => prev.filter(f => !names.has(f.name)));
    setUploadProgress(prev => {
      const next = { ...prev } as Record<string, 'pending' | 'uploading' | 'success' | 'error'>;
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

  /* pipeline icons intentionally removed — UI shows label + progress bar only */
  /* step icons were removed to declutter the pipeline; status is still communicated via
     badge + progress bar (accessible and theme-aware) */

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
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                  )}
                  {uploadProgress[file.name] === 'uploading' && (
                    <Clock className="w-4 h-4 text-yellow-400 animate-pulse flex-shrink-0" />
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
              {[
                ...departmentOptions,
              ].map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => handleDefaultCategoryChange(cat.value)}
                  disabled={isUploading || !isSuperAdmin}
                  className={`px-4 py-2 rounded-xl font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                    uploadCategory === cat.value
                      ? 'btn-primary text-white shadow-lg'
                      : 'bg-surface dark:bg-dark-surface text-muted dark:text-dark-text-muted hover:bg-surface-alt dark:hover:bg-dark-border border border-default'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <h5 className="text-sm font-semibold text-[#232333] dark:text-white transition-colors">
              {t('documentTable.pipelineTitle')}
            </h5>
            <div className="space-y-3">
              {pipelineSteps.map((step) => (
                <div key={step.step}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-foreground dark:text-dark-text transition-colors">
                      {t(step.labelKey)}
                    </span>

                    {step.status === 'completed' && (
                      <span className="text-xs bg-surface-alt text-success px-2 py-1 rounded">
                        {t('documentTable.pipelineStatusDone')}
                      </span>
                    )}
                    {step.status === 'in-progress' && (
                      <span className="text-xs bg-surface-alt text-warning px-2 py-1 rounded">
                        {t('documentTable.pipelineStatusProcessing')}
                      </span>
                    )}
                  </div>

                  <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        step.status === 'completed'
                          ? 'w-full btn-success'
                          : step.status === 'in-progress'
                          ? 'w-2/3 bg-accent'
                          : 'w-0 bg-surface-alt'
                      }`}
                    />
                  </div>
                </div>
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
                disabled={pipelineSteps[0].status !== 'pending' || isUploading}
                className="px-6 py-3 btn-primary text-white disabled:opacity-50 disabled:cursor-not-allowed font-semibold rounded-xl transition-all"
              >
                {pipelineSteps[0].status === 'pending' ? t('documentTable.pipeline.start') : t('documentTable.pipeline.processing')}
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
