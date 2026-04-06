import { useEffect, useRef, useState } from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';

interface ExportDropdownProps {
  onExportCsv: () => void;
  onExportPdf: () => void;
  disabled?: boolean;
  label?: string;
}

export default function ExportDropdown({
  onExportCsv,
  onExportPdf,
  disabled = false,
  label = 'Export',
}: ExportDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-default text-sm font-medium text-foreground dark:text-dark-text hover:bg-surface-alt dark:hover:bg-dark-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Download className="w-4 h-4" />
        {label}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 min-w-[180px] bg-surface dark:bg-dark-surface border border-default rounded-xl shadow-lg overflow-hidden">
          <button
            type="button"
            onClick={() => { onExportCsv(); setOpen(false); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-foreground dark:text-dark-text hover:bg-surface-alt dark:hover:bg-dark-border transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4 text-green-600 dark:text-green-400" />
            Export as CSV
          </button>
          <div className="border-t border-default" />
          <button
            type="button"
            onClick={() => { onExportPdf(); setOpen(false); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-foreground dark:text-dark-text hover:bg-surface-alt dark:hover:bg-dark-border transition-colors"
          >
            <FileText className="w-4 h-4 text-red-600 dark:text-red-400" />
            Export as PDF
          </button>
        </div>
      )}
    </div>
  );
}
