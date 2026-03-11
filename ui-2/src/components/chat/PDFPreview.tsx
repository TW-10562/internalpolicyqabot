/**
 * PDF Preview - Inline document preview with highlighting
 */
import { useState } from 'react';
import { 
  FileText, X, ExternalLink, ChevronLeft, ChevronRight, 
  ZoomIn, ZoomOut, Download, Maximize2, Minimize2 
} from 'lucide-react';
import { useLang } from '../../context/LanguageContext';

interface PDFPreviewProps {
  filename: string;
  fileUrl?: string;
  pageNumber?: number;
  highlightText?: string;
  onClose: () => void;
}

export default function PDFPreview({ 
  filename, 
  fileUrl, 
  pageNumber = 1, 
  highlightText,
  onClose 
}: PDFPreviewProps) {
  const { t } = useLang();
  const [currentPage, setCurrentPage] = useState(pageNumber);
  const [zoom, setZoom] = useState(100);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Generate preview URL (in production, this would be a real file URL)
  const previewUrl = fileUrl || `/dev-api/api/files/preview/${encodeURIComponent(filename)}`;

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 25, 200));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 25, 50));
  const handlePrevPage = () => setCurrentPage(prev => Math.max(prev - 1, 1));
  const handleNextPage = () => setCurrentPage(prev => prev + 1);

  return (
    <div className={`${isFullscreen ? 'fixed inset-0 z-50' : 'relative'} bg-slate-900 rounded-xl border border-white/10 overflow-hidden`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-slate-800/50">
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-blue-400" />
          <div>
            <h3 className="text-sm font-medium text-white truncate max-w-[200px]">
              {filename}
            </h3>
            {highlightText && (
              <p className="text-xs text-slate-400 truncate max-w-[200px]">
                {t('pdfPreview.showing')}: "{highlightText}"
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <div className="flex items-center gap-1 px-2 py-1 bg-white/5 rounded-lg">
            <button
              onClick={handleZoomOut}
              className="p-1 text-slate-400 hover:text-white transition-colors"
              title={t('pdfPreview.zoomOut')}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-400 w-12 text-center">{zoom}%</span>
            <button
              onClick={handleZoomIn}
              className="p-1 text-slate-400 hover:text-white transition-colors"
              title={t('pdfPreview.zoomIn')}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>

          {/* Page navigation */}
          <div className="flex items-center gap-1 px-2 py-1 bg-white/5 rounded-lg">
            <button
              onClick={handlePrevPage}
              disabled={currentPage <= 1}
              className="p-1 text-slate-400 hover:text-white disabled:opacity-50 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-400 w-16 text-center">
              {t('pdfPreview.page')} {currentPage}
            </span>
            <button
              onClick={handleNextPage}
              className="p-1 text-slate-400 hover:text-white transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Actions */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title={isFullscreen ? t('pdfPreview.exitFullscreen') : t('pdfPreview.fullscreen')}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title={t('pdfPreview.openNewTab')}
          >
            <ExternalLink className="w-4 h-4" />
          </a>

          <a
            href={previewUrl}
            download={filename}
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title={t('pdfPreview.download')}
          >
            <Download className="w-4 h-4" />
          </a>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Preview Content */}
      <div 
        className={`${isFullscreen ? 'h-[calc(100vh-60px)]' : 'h-[400px]'} overflow-auto bg-slate-950 p-4`}
        style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top left' }}
      >
        {/* PDF Preview - using iframe or object for actual PDF */}
        <div className="bg-white dark:bg-dark-surface rounded-lg shadow-lg min-h-full transition-colors">
          {fileUrl ? (
            <iframe
              src={`${previewUrl}#page=${currentPage}`}
              className="w-full h-full min-h-[600px] rounded-lg"
              title={filename}
            />
          ) : (
            /* Fallback preview for when URL is not available */
            <div className="p-8 text-center dark:bg-dark-surface transition-colors">
              <FileText className="w-16 h-16 text-slate-300 dark:text-dark-text-muted mx-auto mb-4 transition-colors" />
              <h4 className="text-lg font-medium text-slate-700 dark:text-dark-text mb-2 transition-colors">{filename}</h4>
              <p className="text-sm text-slate-500 mb-4">
                {t('pdfPreview.page')} {currentPage}
              </p>
              
              {highlightText && (
                <div className="max-w-md mx-auto p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-sm text-slate-600">
                    <span className="font-medium">{t('pdfPreview.relevantSection')}:</span>
                  </p>
                  <p className="mt-2 text-sm text-slate-800 bg-yellow-200/50 px-1 rounded">
                    "...{highlightText}..."
                  </p>
                </div>
              )}

              <p className="text-xs text-slate-400 mt-6">
                {t('pdfPreview.previewIntegrationRequired')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Highlight indicator */}
      {highlightText && (
        <div className="absolute bottom-4 left-4 right-4 flex items-center gap-2 px-3 py-2 bg-yellow-500/20 border border-yellow-500/30 rounded-lg">
          <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
          <span className="text-xs text-yellow-300">
            {t('pdfPreview.highlighted')}: "{highlightText.slice(0, 50)}{highlightText.length > 50 ? '...' : ''}"
          </span>
        </div>
      )}
    </div>
  );
}

// Compact source citation component for chat messages
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
          <span className="text-sm font-medium text-blue-300 truncate">
            {document}
          </span>
          <span className="text-xs text-blue-400/70 flex-shrink-0">
            {t('pdfPreview.page')} {page}
          </span>
        </div>
        {excerpt && (
          <p className="text-xs text-slate-400 mt-1 line-clamp-2">
            "{excerpt}"
          </p>
        )}
      </div>
      <ExternalLink className="w-3.5 h-3.5 text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
    </button>
  );
}
