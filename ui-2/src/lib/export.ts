/**
 * Export utilities for CSV and PDF generation.
 * Used across Activity, Users, Escalations, Documents, and Conversation History pages.
 */
import type { ColumnInput } from 'jspdf-autotable';

/* ------------------------------------------------------------------ */
/*  CJK Font Loader (Noto Sans JP for Japanese support)                */
/* ------------------------------------------------------------------ */

const NOTO_SANS_JP_URL =
  'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-jp@latest/japanese-400-normal.ttf';

let fontLoadPromise: Promise<ArrayBuffer> | null = null;

function loadCjkFont(): Promise<ArrayBuffer> {
  if (!fontLoadPromise) {
    fontLoadPromise = fetch(NOTO_SANS_JP_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Font fetch failed: ${res.status}`);
        return res.arrayBuffer();
      })
      .catch((err) => {
        fontLoadPromise = null; // allow retry on failure
        throw err;
      });
  }
  return fontLoadPromise;
}

function registerCjkFont(doc: any, fontData: ArrayBuffer) {
  const fontName = 'NotoSansJP';
  const binaryStr = Array.from(new Uint8Array(fontData))
    .map((b) => String.fromCharCode(b))
    .join('');
  const base64 = btoa(binaryStr);
  doc.addFileToVFS('NotoSansJP-Regular.ttf', base64);
  doc.addFont('NotoSansJP-Regular.ttf', fontName, 'normal');
  doc.setFont(fontName);
}

/* ------------------------------------------------------------------ */
/*  CSV Export                                                         */
/* ------------------------------------------------------------------ */

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
) {
  const headerLine = headers.map(escapeCsvCell).join(',');
  const bodyLines = rows.map((row) => row.map(escapeCsvCell).join(','));
  const csv = [headerLine, ...bodyLines].join('\n');

  // BOM for Excel UTF-8 compatibility
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

/* ------------------------------------------------------------------ */
/*  PDF Export                                                         */
/* ------------------------------------------------------------------ */

export interface PdfColumnDef {
  /** Header label */
  header: string;
  /** Relative width weight — columns are sized proportionally.
   *  e.g. [1, 3, 1] means the middle column is 3x wider than the others. */
  width?: number;
  /** Horizontal alignment for body cells. Default: 'left' */
  align?: 'left' | 'center' | 'right';
}

export interface PdfExportOptions {
  title: string;
  subtitle?: string;
  /** Simple string array (equal widths) OR PdfColumnDef[] for fine control */
  headers: string[] | PdfColumnDef[];
  rows: (string | number | null | undefined)[][];
  filename: string;
  orientation?: 'portrait' | 'landscape';
}

export async function exportPdf(options: PdfExportOptions) {
  const {
    title,
    subtitle,
    rows,
    filename,
    orientation = 'landscape',
  } = options;

  const { default: jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });

  // Load and register CJK font for Japanese text support
  try {
    const fontData = await loadCjkFont();
    registerCjkFont(doc, fontData);
  } catch {
    console.warn('CJK font load failed — falling back to default font');
  }

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginLeft = 10;
  const marginRight = 10;
  const usableWidth = pageWidth - marginLeft - marginRight;

  // Parse headers — support both string[] and PdfColumnDef[]
  const columns: PdfColumnDef[] = options.headers.map((h) =>
    typeof h === 'string' ? { header: h } : h,
  );
  const headerLabels = columns.map((c) => c.header);

  // Calculate column widths proportionally
  const totalWeight = columns.reduce((sum, c) => sum + (c.width ?? 1), 0);
  const columnStyles: Record<number, Partial<{ cellWidth: number; halign: 'left' | 'center' | 'right' }>> = {};
  columns.forEach((col, i) => {
    const weight = col.width ?? 1;
    columnStyles[i] = {
      cellWidth: (weight / totalWeight) * usableWidth,
      halign: col.align ?? 'left',
    };
  });

  // Title
  doc.setFontSize(14);
  doc.setTextColor(35, 35, 51);
  doc.text(title, marginLeft, 14);

  // Subtitle / date
  doc.setFontSize(8);
  doc.setTextColor(110, 118, 128);
  const exportDate = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  doc.text(subtitle ? `${subtitle}  |  Exported: ${exportDate}` : `Exported: ${exportDate}`, marginLeft, 20);

  // Separator line
  doc.setDrawColor(232, 232, 232);
  doc.setLineWidth(0.3);
  doc.line(marginLeft, 22, pageWidth - marginRight, 22);

  // Table
  const { default: autoTable } = await import('jspdf-autotable');
  autoTable(doc, {
    startY: 25,
    head: [headerLabels],
    body: rows.map((row) => row.map((cell) => String(cell ?? ''))),
    columns: columns.map((col) => ({ header: col.header, dataKey: col.header })) as ColumnInput[],
    columnStyles,
    styles: {
      fontSize: 7,
      cellPadding: { top: 2.5, right: 2, bottom: 2.5, left: 2 },
      overflow: 'linebreak',
      lineColor: [220, 220, 220],
      lineWidth: 0.15,
      valign: 'top',
      textColor: [50, 50, 50],
      font: doc.getFont().fontName,
    },
    headStyles: {
      fillColor: [29, 32, 137],
      textColor: 255,
      fontStyle: 'bold',
      fontSize: 7,
      cellPadding: { top: 3, right: 2, bottom: 3, left: 2 },
      halign: 'left',
      valign: 'middle',
    },
    alternateRowStyles: {
      fillColor: [248, 248, 250],
    },
    margin: { left: marginLeft, right: marginRight, top: 25 },
    tableWidth: usableWidth,
    showHead: 'everyPage',
    didParseCell: (data) => {
      // Apply per-column alignment to header row too
      if (data.section === 'head' && columns[data.column.index]?.align) {
        data.cell.styles.halign = columns[data.column.index].align!;
      }
    },
    // Page footer with page numbers
    didDrawPage: (data) => {
      const pageCount = doc.getNumberOfPages();
      const currentPage = data.pageNumber;
      doc.setFontSize(7);
      doc.setTextColor(160, 160, 160);
      doc.text(
        `Page ${currentPage} of ${pageCount}`,
        pageWidth - marginRight,
        doc.internal.pageSize.getHeight() - 6,
        { align: 'right' },
      );
      doc.text(title, marginLeft, doc.internal.pageSize.getHeight() - 6);
    },
  });

  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Generate a timestamped filename like "activity-logs_2026-04-02" */
export function stampedFilename(base: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${base}_${stamp}`;
}
