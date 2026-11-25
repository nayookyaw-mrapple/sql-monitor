import { DecimalPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiService, errorMessage } from '../../core/api.service';
import { AuditEvent, HistoryQuery, SampledActivity } from '../../core/models';
import { AUDIT_EXCEL, AUDIT_PDF, ExportColumn, ExportInfo, SAMPLED_EXCEL, SAMPLED_PDF, buildExcel, buildPdf, downloadBlob } from './history-export-files';

type Format = 'excel' | 'pdf';
type AnyRow = SampledActivity | AuditEvent;

/** Rows shown in the Excel preview (the file itself holds all of them). */
const PREVIEW_ROWS = 100;
/** A PDF much longer than this is slow to build and nobody reads it; Excel takes everything. */
const PDF_MAX_ROWS = 5000;

/**
 * Export dialog for the history tabs: loads every row matching the current filters, shows a preview
 * (the sheet as a table for Excel, the real document for PDF), then downloads the chosen file.
 */
@Component({
  selector: 'app-history-export',
  imports: [DecimalPipe],
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="modal-backdrop" (click)="closed.emit()"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Export history">
      <div class="modal-head">
        <h2>Export · {{ info().title }}</h2>
        <button type="button" class="btn" (click)="closed.emit()">✕</button>
      </div>

      <div class="modal-body">
        <div class="export-info">
          @for (d of info().details; track d[0]) {
            <span><span class="muted">{{ d[0] }}:</span> {{ d[1] }}</span>
          }
        </div>

        <div class="tabs export-tabs">
          <button type="button" [class.active]="format() === 'excel'" (click)="setFormat('excel')">Excel (.xlsx)</button>
          <button type="button" [class.active]="format() === 'pdf'" (click)="setFormat('pdf')">PDF</button>
        </div>

        @if (error(); as e) {
          <div class="banner error">{{ e }}</div>
        }

        @if (loading()) {
          <div class="export-preview export-empty">Loading the rows to export…</div>
        } @else if (rows().length === 0) {
          <div class="export-preview export-empty">Nothing matches the current filters, so there is nothing to export.</div>
        } @else if (format() === 'excel') {
          <p class="muted small export-note">
            The Excel file will hold <strong>{{ rows().length | number }}</strong> row(s) and {{ excelColumns().length }} columns, with a second
            sheet describing the filters.
            @if (truncated()) {
              <strong>{{ total() | number }} rows match, but one export holds at most {{ limit() | number }} (the newest). Narrow the date range or filters to get the rest.</strong>
            }
            @if (rows().length > previewRows().length) {
              Preview shows the first {{ previewRows().length }}.
            }
          </p>
          <div class="export-preview">
            <table class="grid">
              <thead>
                <tr>
                  @for (c of excelColumns(); track c.header) {
                    <th [class.num]="c.numeric">{{ c.header }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (r of previewRows(); track r.id) {
                  <tr>
                    @for (c of excelColumns(); track c.header) {
                      <td [class.num]="c.numeric" [title]="'' + (c.value(r) ?? '')">{{ c.value(r) }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="muted small export-note">
            The PDF is a landscape A4 summary: fewer columns, and long SQL is shortened. Use Excel for the full statements.
            @if (rows().length > pdfRowCount()) {
              <strong>PDF is limited to the newest {{ pdfRowCount() | number }} of {{ rows().length | number }} rows.</strong>
            } @else if (truncated()) {
              <strong>{{ total() | number }} rows match; only the newest {{ rows().length | number }} are included.</strong>
            }
          </p>
          <div class="export-preview">
            @if (pdfUrl(); as url) {
              <iframe [src]="url" title="PDF preview"></iframe>
            } @else {
              <div class="export-empty">{{ pdfBuilding() ? 'Building the PDF preview (' + (pdfRowCount() | number) + ' rows)…' : '' }}</div>
            }
          </div>
        }
      </div>

      <div class="modal-foot">
        <span class="muted small">{{ fileName() }}</span>
        <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
        <button type="button" class="btn primary" (click)="download()" [disabled]="!canDownload()">
          {{ busy() ? 'Preparing…' : format() === 'excel' ? 'Download Excel' : 'Download PDF' }}
        </button>
      </div>
    </div>
  `,
})
export class HistoryExport implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly kind = input.required<'sampled' | 'audit'>();
  readonly query = input.required<Omit<HistoryQuery, 'page' | 'pageSize'>>();
  /** Title, filters and file name. Row count and export time are added here. */
  readonly info = input.required<ExportInfo>();
  readonly closed = output<void>();

  protected readonly rows = signal<AnyRow[]>([]);
  protected readonly total = signal(0);
  protected readonly limit = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly format = signal<Format>('excel');
  protected readonly busy = signal(false);
  protected readonly pdfBuilding = signal(false);
  protected readonly pdfUrl = signal<SafeResourceUrl | null>(null);

  private pdfBlob: Blob | null = null;
  private pdfObjectUrl: string | null = null;

  protected readonly truncated = computed(() => this.total() > this.rows().length);
  protected readonly previewRows = computed(() => this.rows().slice(0, PREVIEW_ROWS));
  protected readonly pdfRowCount = computed(() => Math.min(this.rows().length, PDF_MAX_ROWS));
  protected readonly excelColumns = computed(() => (this.kind() === 'sampled' ? SAMPLED_EXCEL : AUDIT_EXCEL) as unknown as ExportColumn<AnyRow>[]);
  private readonly pdfColumns = computed(() => (this.kind() === 'sampled' ? SAMPLED_PDF : AUDIT_PDF) as unknown as ExportColumn<AnyRow>[]);
  protected readonly fileName = computed(() => `${this.info().fileBase}.${this.format() === 'excel' ? 'xlsx' : 'pdf'}`);
  protected readonly canDownload = computed(
    () => !this.loading() && !this.busy() && this.rows().length > 0 && (this.format() === 'excel' || !this.pdfBuilding()),
  );

  ngOnInit(): void {
    this.api.historyExport<AnyRow>(this.kind(), this.query()).subscribe({
      next: (r) => {
        this.rows.set(r.rows);
        this.total.set(r.total);
        this.limit.set(r.limit);
        this.loading.set(false);
        if (this.format() === 'pdf') void this.preparePdf();
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy(): void {
    if (this.pdfObjectUrl) URL.revokeObjectURL(this.pdfObjectUrl);
  }

  setFormat(f: Format): void {
    this.format.set(f);
    if (f === 'pdf' && !this.loading()) void this.preparePdf();
  }

  /** The details printed in the file: the filters, plus how many rows and when. */
  private fileInfo(rowCount: number): ExportInfo {
    const info = this.info();
    const rows = rowCount < this.total() ? `${rowCount.toLocaleString()} (newest) of ${this.total().toLocaleString()} matching` : rowCount.toLocaleString();
    return { ...info, details: [...info.details, ['Rows', rows], ['Exported', new Date().toLocaleString()]] };
  }

  /** Build the PDF once; the preview and the download use the same file. */
  private async preparePdf(): Promise<void> {
    if (this.pdfBlob || this.pdfBuilding() || this.rows().length === 0) return;
    this.pdfBuilding.set(true);
    this.error.set(null);
    try {
      // Let the "Building…" message paint before the (synchronous) layout work starts.
      await new Promise((r) => setTimeout(r, 30));
      const rows = this.rows().slice(0, PDF_MAX_ROWS);
      this.pdfBlob = await buildPdf(rows, this.pdfColumns(), this.fileInfo(rows.length));
      this.pdfObjectUrl = URL.createObjectURL(this.pdfBlob);
      this.pdfUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.pdfObjectUrl));
    } catch (err) {
      this.error.set(`Could not build the PDF: ${errorMessage(err)}`);
    } finally {
      this.pdfBuilding.set(false);
    }
  }

  async download(): Promise<void> {
    if (!this.canDownload()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.format() === 'excel') {
        const blob = await buildExcel(this.rows(), this.excelColumns(), this.fileInfo(this.rows().length));
        downloadBlob(blob, this.fileName());
      } else {
        await this.preparePdf();
        if (this.pdfBlob) downloadBlob(this.pdfBlob, this.fileName());
      }
    } catch (err) {
      this.error.set(`Could not build the file: ${errorMessage(err)}`);
    } finally {
      this.busy.set(false);
    }
  }
}
