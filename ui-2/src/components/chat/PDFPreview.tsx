/**
 * Document Preview - Inline preview for PDF, images, text, Excel, and Word files
 */
import { useState, useEffect } from 'react';
import {
  FileText, X, ExternalLink, ChevronLeft, ChevronRight,
  ZoomIn, ZoomOut, Download, Maximize2, Minimize2, Loader2
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';
import { getToken } from '../../api/auth';

// ── file-type helpers ──────────────────────────────────────────
const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase();

const detectType = (filename: string, mime: string | null) => {
  const ext = extOf(filename);
  const mt = (mime || '').toLowerCase();
  if (mt.includes('pdf') || ext === 'pdf') return 'pdf' as const;
  if (mt.startsWith('image/') || /^(png|jpe?g|webp|gif|svg)$/.test(ext)) return 'image' as const;
  if (
    mt.includes('spreadsheetml') || mt.includes('ms-excel') ||
    /^(xlsx|xls|csv)$/.test(ext)
  ) return 'excel' as const;
  if (
    mt.includes('wordprocessingml') || mt.includes('msword') ||
    /^(docx|doc)$/.test(ext)
  ) return 'word' as const;
  if (mt.startsWith('text/') || /^(txt|log|md|csv)$/.test(ext)) return 'text' as const;
  return 'other' as const;
};

// ── Excel sheet-selector state ────────────────────────────────
interface SheetData {
  name: string;
  html: string;
}

// ── component ─────────────────────────────────────────────────
interface PDFPreviewProps {
  filename: string;
  fileUrl?: string;
  fileId?: number;
  pageNumber?: number;
  highlightText?: string;
  onClose: () => void;
}

export default function PDFPreview({
  filename,
  fileUrl: initialFileUrl,
  fileId,
  pageNumber = 1,
  highlightText,
  onClose,
}: PDFPreviewProps) {
  const { t } = useLang();
  const [currentPage, setCurrentPage] = useState(pageNumber);
  const [zoom, setZoom] = useState(100);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(initialFileUrl || null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Content states for different renderers
  const [textContent, setTextContent] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [excelSheets, setExcelSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  const fileType = detectType(filename, mimeType);

  // ── fetch & parse file ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const fetchAndParse = async () => {
      setLoading(true);
      setError(null);

      // 1. Get the blob
      let blob: Blob | null = null;
      let contentType = '';

      if (initialFileUrl) {
        try {
          const res = await fetch(initialFileUrl);
          if (res.ok) {
            blob = await res.blob();
            contentType = res.headers.get('Content-Type') || blob.type || '';
          }
        } catch { /* fall through */ }
      }

      if (!blob) {
        const token = getToken();
        const endpoints = [
          ...(fileId ? [`/dev-api/api/files/${fileId}/view`] : []),
          `/dev-api/api/files/preview/${encodeURIComponent(filename)}`,
        ];
        for (const ep of endpoints) {
          try {
            const res = await fetch(ep, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (res.ok) {
              blob = await res.blob();
              contentType = res.headers.get('Content-Type') || blob.type || '';
              break;
            }
          } catch { /* try next */ }
        }
      }

      if (!blob || cancelled) {
        if (!cancelled) { setError('Could not load document'); setLoading(false); }
        return;
      }

      const url = URL.createObjectURL(blob);
      if (cancelled) { URL.revokeObjectURL(url); return; }

      setMimeType(contentType);
      setBlobUrl(url);

      // 2. Parse office formats client-side
      const type = detectType(filename, contentType);

      if (type === 'excel') {
        try {
          const XLSX = await import('xlsx');
          const buffer = await blob.arrayBuffer();
          const wb = XLSX.read(buffer, { type: 'array' });
          const sheets: SheetData[] = wb.SheetNames.map((name) => {
            const ws = wb.Sheets[name];
            const html = XLSX.utils.sheet_to_html(ws, { id: 'excel-table', editable: false });
            return { name, html };
          });
          if (!cancelled) {
            setExcelSheets(sheets);
            setActiveSheet(0);
          }
        } catch (e) {
          console.warn('[PDFPreview] Excel parse error:', e);
          if (!cancelled) setError('Failed to parse Excel file');
        }
      } else if (type === 'word') {
        try {
          const mammoth = await import('mammoth');
          const buffer = await blob.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
          if (!cancelled) setHtmlContent(result.value);
        } catch (e) {
          console.warn('[PDFPreview] Word parse error:', e);
          if (!cancelled) setError('Failed to parse Word document');
        }
      } else if (type === 'text') {
        try {
          const text = await blob.text();
          if (!cancelled) setTextContent(text);
        } catch { /* ignore */ }
      }

      if (!cancelled) setLoading(false);
    };

    fetchAndParse();
    return () => {
      cancelled = true;
    };
  }, [initialFileUrl, fileId, filename]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => { if (blobUrl && !initialFileUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl, initialFileUrl]);

  // ── controls ──────────────────────────────────────────────
  const handleZoomIn = () => setZoom((p) => Math.min(p + 25, 200));
  const handleZoomOut = () => setZoom((p) => Math.max(p - 25, 50));
  const handlePrevPage = () => setCurrentPage((p) => Math.max(p - 1, 1));
  const handleNextPage = () => setCurrentPage((p) => p + 1);
  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.click();
  };

  // ── render ────────────────────────────────────────────────
  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
          <span className="ml-3 text-sm text-slate-400">Loading document...</span>
        </div>
      );
    }

    if (error || !blobUrl) {
      return (
        <div className="p-8 text-center">
          <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
          <h4 className="text-lg font-medium text-slate-700 dark:text-dark-text mb-2">{filename}</h4>
          <p className="text-sm text-slate-500">{error || 'Preview not available'}</p>
        </div>
      );
    }

    switch (fileType) {
      case 'pdf':
        return (
          <iframe
            src={`${blobUrl}#page=${currentPage}`}
            className="w-full h-full min-h-[600px] rounded-lg"
            title={filename}
          />
        );

      case 'image':
        return (
          <div className="flex items-center justify-center p-4">
            <img src={blobUrl} alt={filename} className="max-w-full max-h-[500px] object-contain rounded" />
          </div>
        );

      case 'excel':
        if (!excelSheets.length) {
          return <div className="p-8 text-center text-slate-500">No sheets found in workbook</div>;
        }
        return (
          <div className="flex flex-col h-full">
            {/* Sheet tabs */}
            {excelSheets.length > 1 && (
              <div className="flex gap-1 px-4 pt-3 pb-1 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
                {excelSheets.map((sheet, idx) => (
                  <button
                    key={sheet.name}
                    onClick={() => setActiveSheet(idx)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-t whitespace-nowrap transition-colors ${
                      idx === activeSheet
                        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 border border-b-0 border-slate-200 dark:border-slate-700'
                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            )}
            {/* Sheet content */}
            <div
              className="p-4 overflow-auto flex-1 excel-preview"
              dangerouslySetInnerHTML={{ __html: excelSheets[activeSheet]?.html || '' }}
            />
          </div>
        );

      case 'word':
        if (!htmlContent) {
          return <div className="p-8 text-center text-slate-500">Could not render document</div>;
        }
        return (
          <div
            className="p-6 prose prose-sm dark:prose-invert max-w-none overflow-auto word-preview"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        );

      case 'text':
        return (
          <pre className="p-6 text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap font-mono overflow-auto max-h-[600px]">
            {textContent}
          </pre>
        );

      default:
        return (
          <iframe src={blobUrl} className="w-full h-full min-h-[600px] rounded-lg" title={filename} />
        );
    }
  };

  return (
    <div className={`${isFullscreen ? 'fixed inset-0 z-50' : 'relative'} bg-slate-900 rounded-xl border border-white/10 overflow-hidden`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-slate-800/50">
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-blue-400" />
          <div>
            <h3 className="text-sm font-medium text-white truncate max-w-[300px]">{filename}</h3>
            {highlightText && (
              <p className="text-xs text-slate-400 truncate max-w-[200px]">
                {t('pdfPreview.showing')}: &quot;{highlightText}&quot;
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Zoom */}
          <div className="flex items-center gap-1 px-2 py-1 bg-white/5 rounded-lg">
            <button onClick={handleZoomOut} className="p-1 text-slate-400 hover:text-white transition-colors" title={t('pdfPreview.zoomOut')}>
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-400 w-12 text-center">{zoom}%</span>
            <button onClick={handleZoomIn} className="p-1 text-slate-400 hover:text-white transition-colors" title={t('pdfPreview.zoomIn')}>
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>

          {/* Page nav (PDF only) */}
          {fileType === 'pdf' && (
            <div className="flex items-center gap-1 px-2 py-1 bg-white/5 rounded-lg">
              <button onClick={handlePrevPage} disabled={currentPage <= 1} className="p-1 text-slate-400 hover:text-white disabled:opacity-50 transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-400 w-16 text-center">{t('pdfPreview.page')} {currentPage}</span>
              <button onClick={handleNextPage} className="p-1 text-slate-400 hover:text-white transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Fullscreen / open / download / close */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title={isFullscreen ? t('pdfPreview.exitFullscreen') : t('pdfPreview.fullscreen')}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          {blobUrl && (
            <a href={blobUrl} target="_blank" rel="noopener noreferrer" className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors" title={t('pdfPreview.openNewTab')}>
              <ExternalLink className="w-4 h-4" />
            </a>
          )}

          {blobUrl && (
            <button onClick={handleDownload} className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors" title={t('pdfPreview.download')}>
              <Download className="w-4 h-4" />
            </button>
          )}

          <button onClick={onClose} className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors" title={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div
        className={`${isFullscreen ? 'h-[calc(100vh-60px)]' : 'h-[500px]'} overflow-auto bg-slate-950 p-4`}
        style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left' }}
      >
        <div className="bg-white dark:bg-dark-surface rounded-lg shadow-lg min-h-full transition-colors">
          {renderContent()}
        </div>
      </div>

      {/* Highlight indicator */}
      {highlightText && (
        <div className="absolute bottom-4 left-4 right-4 flex items-center gap-2 px-3 py-2 bg-yellow-500/20 border border-yellow-500/30 rounded-lg">
          <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
          <span className="text-xs text-yellow-300">
            {t('pdfPreview.highlighted')}: &quot;{highlightText.slice(0, 50)}{highlightText.length > 50 ? '...' : ''}&quot;
          </span>
        </div>
      )}

      {/* Inline styles for excel/word tables */}
      <style>{`
        .excel-preview table {
          border-collapse: collapse;
          width: 100%;
          font-size: 0.8125rem;
        }
        .excel-preview th,
        .excel-preview td {
          border: 1px solid #e2e8f0;
          padding: 4px 8px;
          text-align: left;
          white-space: nowrap;
        }
        .excel-preview th {
          background: #f1f5f9;
          font-weight: 600;
        }
        .excel-preview tr:nth-child(even) {
          background: #f8fafc;
        }
        .word-preview img {
          max-width: 100%;
          height: auto;
        }
      `}</style>
    </div>
  );
}

// ── SourceCitation (unchanged) ──────────────────────────────
interface SourceCitationProps {
  document: string;
  page: number;
  excerpt?: string;
  onClick: () => void;
}

export function SourceCitation({ document, page, excerpt, onClick }: SourceCitationProps) {
  const { t } = useLang();
  return (
    <button
      onClick={onClick}
      className="group flex items-start gap-2 p-2 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg text-left transition-colors w-full"
    >
      <FileText className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-blue-300 truncate">{document}</span>
          <span className="text-xs text-blue-400/70 flex-shrink-0">{t('pdfPreview.page')} {page}</span>
        </div>
        {excerpt && (
          <p className="text-xs text-slate-400 mt-1 line-clamp-2">&quot;{excerpt}&quot;</p>
        )}
      </div>
      <ExternalLink className="w-3.5 h-3.5 text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  );
}
