/**
 * Builds the Excel and PDF files for the history export. Both libraries are loaded only when an export is
 * actually made, so they don't add to the page's normal download size.
 */
import { AuditEvent, SampledActivity } from '../../core/models';

export interface ExportColumn<T> {
  header: string;
  /** Excel column width, in characters. */
  width: number;
  value: (r: T) => string | number | null;
  /** Right-align (numbers). */
  numeric?: boolean;
}

/** What the export covers, printed on the PDF and on the Excel "About" sheet. */
export interface ExportInfo {
  title: string;
  /** Label + value pairs: server, database, period, filters… */
  details: [string, string][];
  note?: string;
  /** File name without extension. */
  fileBase: string;
}

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const who = (login: string | null, host: string | null) => [login, host].filter(Boolean).join(' @ ');

/* ---------------- Columns ---------------- */

export const SAMPLED_EXCEL: ExportColumn<SampledActivity>[] = [
  { header: 'First seen', width: 23, value: (r) => r.firstSeen },
  { header: 'Last seen', width: 23, value: (r) => r.lastSeen },
  { header: 'Times seen', width: 11, value: (r) => r.samples, numeric: true },
  { header: 'Action', width: 10, value: (r) => r.action },
  { header: 'Login', width: 28, value: (r) => r.loginName },
  { header: 'Host', width: 22, value: (r) => r.hostName },
  { header: 'Client address', width: 16, value: (r) => r.clientAddress },
  { header: 'Application', width: 36, value: (r) => r.programName },
  { header: 'Agent job', width: 40, value: (r) => r.jobName },
  { header: 'Database', width: 20, value: (r) => r.db },
  { header: 'Procedure', width: 36, value: (r) => r.procName ?? 'Direct SQL (no procedure)' },
  { header: 'Statement', width: 90, value: (r) => r.statement },
  { header: 'Tables (best effort)', width: 50, value: (r) => r.tables },
  { header: 'Ran for (ms)', width: 13, value: (r) => r.elapsedMs, numeric: true },
  { header: 'CPU (ms)', width: 11, value: (r) => r.cpuMs, numeric: true },
  { header: 'Logical reads', width: 14, value: (r) => r.logicalReads, numeric: true },
  { header: 'Writes', width: 10, value: (r) => r.writes, numeric: true },
  { header: 'Rows', width: 10, value: (r) => r.rowsAffected, numeric: true },
  { header: 'Session', width: 9, value: (r) => r.sessionId, numeric: true },
  { header: 'Captured', width: 16, value: (r) => (r.capture === 'last' ? 'After it finished' : 'While running') },
];

export const AUDIT_EXCEL: ExportColumn<AuditEvent>[] = [
  { header: 'When', width: 23, value: (r) => r.eventTime },
  { header: 'Action', width: 10, value: (r) => r.action },
  { header: 'Result', width: 10, value: (r) => (r.succeeded ? 'Allowed' : 'Denied') },
  { header: 'Login', width: 28, value: (r) => r.loginName },
  { header: 'Session login', width: 28, value: (r) => r.sessionLogin },
  { header: 'Database user', width: 20, value: (r) => r.dbUser },
  { header: 'Host', width: 22, value: (r) => r.hostName },
  { header: 'Client IP', width: 16, value: (r) => r.clientIp },
  { header: 'Application', width: 36, value: (r) => r.programName },
  { header: 'Database', width: 20, value: (r) => r.db },
  { header: 'Schema', width: 10, value: (r) => r.schemaName },
  { header: 'Table / procedure', width: 36, value: (r) => r.objectName },
  { header: 'Statement', width: 90, value: (r) => r.statement },
  { header: 'Session', width: 9, value: (r) => r.sessionId, numeric: true },
];

/** The PDF is a page-width summary: fewer, combined columns, and long SQL is cut. `width` here is a share of the page. */
export const SAMPLED_PDF: ExportColumn<SampledActivity>[] = [
  { header: 'When', width: 9, value: (r) => r.firstSeen.slice(0, 19) },
  { header: 'Action', width: 6, value: (r) => r.action },
  { header: 'Who', width: 18, value: (r) => [who(r.loginName, r.hostName), r.jobName ? `Agent job: ${r.jobName}` : r.programName].filter(Boolean).join('\n') },
  { header: 'Procedure / statement', width: 37, value: (r) => `${r.procName ?? 'Direct SQL (no procedure)'}\n${clip(oneLine(r.statement), 260)}` },
  { header: 'Tables (best effort)', width: 15, value: (r) => clip(r.tables ?? '', 160) },
  { header: 'Database', width: 9, value: (r) => r.db },
  { header: 'Ran for', width: 6, value: (r) => durationText(r.elapsedMs), numeric: true },
];

export const AUDIT_PDF: ExportColumn<AuditEvent>[] = [
  { header: 'When', width: 9, value: (r) => r.eventTime.slice(0, 19) },
  { header: 'Action', width: 7, value: (r) => (r.succeeded ? r.action : `${r.action}\n(denied)`) },
  { header: 'Who', width: 20, value: (r) => [r.loginName ?? r.sessionLogin, [r.hostName, r.programName].filter(Boolean).join(' · ')].filter(Boolean).join('\n') },
  { header: 'Table / procedure', width: 16, value: (r) => [r.schemaName, r.objectName].filter(Boolean).join('.') },
  { header: 'Statement', width: 39, value: (r) => clip(oneLine(r.statement), 300) },
  { header: 'Database', width: 9, value: (r) => r.db },
];

function durationText(ms: number | null): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ---------------- Excel ---------------- */

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Excel refuses cells longer than this. */
const MAX_CELL = 32_767;

export async function buildExcel<T>(rows: T[], columns: ExportColumn<T>[], info: ExportInfo): Promise<Blob> {
  // ExcelJS is a CommonJS package: depending on the bundler its API is on the module or on its default export.
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') } & typeof import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SQL Monitor';
  wb.created = new Date();

  const ws = wb.addWorksheet('Activity', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  for (const r of rows) {
    ws.addRow(
      columns.map((c) => {
        const v = c.value(r);
        return typeof v === 'string' && v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v;
      }),
    );
  }
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F6FDE' } };
  head.alignment = { vertical: 'middle' };
  columns.forEach((c, i) => {
    ws.getColumn(i + 1).alignment = { vertical: 'top', horizontal: c.numeric ? 'right' : 'left' };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const about = wb.addWorksheet('About');
  about.columns = [{ width: 22 }, { width: 90 }];
  about.addRow([info.title]).font = { bold: true, size: 14 };
  about.addRow([]);
  for (const [label, value] of info.details) about.addRow([label, value]).getCell(1).font = { bold: true };
  if (info.note) {
    about.addRow([]);
    about.addRow(['Note', info.note]).getCell(1).font = { bold: true };
    about.getCell(`B${about.rowCount}`).alignment = { wrapText: true, vertical: 'top' };
  }

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_TYPE });
}

/* ---------------- PDF ---------------- */

/** The built-in PDF fonts only cover Western European characters; anything else is replaced so it doesn't print as garbage. */
function pdfSafe(v: string): string {
  return v.replace(/→/g, '->').replace(/[^\n\x20-\x7E -ÿ…–—‘’“”•]/g, '?');
}

export async function buildPdf<T>(rows: T[], columns: ExportColumn<T>[], info: ExportInfo): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 28;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(pdfSafe(info.title), margin, 34);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(90);
  let y = 50;
  const detailLines = doc.splitTextToSize(pdfSafe(info.details.map(([l, v]) => `${l}: ${v}`).join('   |   ')), pageW - margin * 2) as string[];
  doc.text(detailLines, margin, y);
  y += detailLines.length * 11;
  if (info.note) {
    const noteLines = doc.splitTextToSize(pdfSafe(info.note), pageW - margin * 2) as string[];
    doc.text(noteLines, margin, y);
    y += noteLines.length * 11;
  }
  doc.setTextColor(0);

  const usable = pageW - margin * 2;
  const totalShare = columns.reduce((s, c) => s + c.width, 0);
  autoTable(doc, {
    startY: y + 4,
    margin: { left: margin, right: margin, top: 28, bottom: 30 },
    head: [columns.map((c) => c.header)],
    body: rows.map((r) => columns.map((c) => pdfSafe(String(c.value(r) ?? '')))),
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 3, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [47, 111, 222], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [246, 248, 251] },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, { cellWidth: (usable * c.width) / totalShare, halign: c.numeric ? 'right' : 'left' }])),
    rowPageBreak: 'avoid',
  });

  // Footer on every page, once the page count is known.
  const pages = doc.getNumberOfPages();
  doc.setFontSize(8);
  doc.setTextColor(120);
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.text(pdfSafe(info.title), margin, pageH - 14);
    doc.text(`Page ${p} of ${pages}`, pageW - margin, pageH - 14, { align: 'right' });
  }
  return doc.output('blob');
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
