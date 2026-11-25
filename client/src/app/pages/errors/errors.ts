import { DecimalPipe, KeyValuePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { catchError, filter, map, of, switchMap, tap } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { ErrorRow, ErrorSourceStatus, ErrorsPage, ErrorsQuery, RecurringError, Severity } from '../../core/models';
import { AgoPipe, CellPipe, CompactPipe } from '../../shared/format';
import { AutoRefresh } from '../../shared/auto-refresh';
import { DateRange, RangeChange, normalizeRange, resolveRange } from '../../shared/date-range';
import { Pager } from '../../shared/pager';

const LAST_SEEN_KEY = 'nay-monitor.errors.lastSeen';

@Component({
  selector: 'app-errors',
  imports: [RouterLink, DecimalPipe, KeyValuePipe, AgoPipe, CellPipe, CompactPipe, Pager, AutoRefresh, DateRange],
  template: `
    <div class="page-head">
      <div>
        <h1>Errors &amp; failures</h1>
        <p class="muted">
          SQL Agent jobs, application logs, integrations and business exceptions in one feed ·
          <strong>{{ ctx.scopeLabel() }}</strong>
        </p>
      </div>
      <div class="toolbar">
        <app-auto-refresh
          storageKey="errors"
          [defaultMs]="30000"
          [lastUpdated]="updatedAt()"
          [loading]="loading() || recurringLoading()"
          [paused]="!!selected()"
          (refresh)="refreshAll()"
        />
      </div>
    </div>

    <!-- Source cards -->
    <section class="sources">
      <button type="button" class="source-card" [class.active]="!source()" (click)="setSource(null)">
        <div class="sc-label">All sources</div>
        <div class="sc-count" [class.hot]="totals().h24 > 0">{{ totals().h24 | number }}</div>
        <div class="sc-foot">last 24 h · {{ totals().d7 | number }} in 7 days</div>
      </button>
      @for (s of sources(); track s.id) {
        <button
          type="button"
          class="source-card"
          [class.active]="source() === s.id"
          [class.disabled]="!s.available"
          (click)="setSource(s.id)"
          [title]="s.description"
        >
          <div class="sc-label">
            {{ s.label }}
            <span class="sc-cat">{{ s.category }}</span>
          </div>
          <div class="sc-table" [title]="s.tableName">{{ shortTable(s.tableName) }}</div>
          @if (s.available) {
            <div class="sc-count" [class.hot]="s.last24h > 0">{{ s.last24h | number }}</div>
            <div class="sc-foot">
              {{ s.last7d | number }} in 7 d · {{ s.total | compact }} total
              <br />
              last {{ s.lastAt ? (s.lastAt | ago) : 'never' }}
            </div>
          } @else {
            <div class="sc-count muted">—</div>
            <div class="sc-foot">No access · click for setup</div>
          }
        </button>
      }
    </section>

    @if (selectedSource(); as s) {
      @if (!s.available) {
        <section class="card setup">
          <h2>{{ s.label }} needs read access</h2>
          <p>
            The database login used by SQL Monitor can't read this source:
            <span class="mono small">{{ s.unavailableReason }}</span>
          </p>
          @if (s.id === 'agent') {
            <p>
              Ask a DBA to run this on <strong>the SQL Server that runs the Agent jobs</strong>. It gives read-only access to job history
              and nothing else. Alternatively, set <span class="mono">MSDB_USER</span> / <span class="mono">MSDB_PASSWORD</span> in
              <span class="mono">server/.env</span> to a login that already has it. The source rechecks access every 5 minutes.
            </p>
            <pre class="script">{{ grantScript() }}</pre>
            <button type="button" class="btn" (click)="copy(grantScript())">{{ copied() ? '✓ Copied' : 'Copy script' }}</button>
          }
        </section>
      } @else {
        <p class="muted small source-desc">
          {{ s.description }}
          @if (s.rls === 'server') {
            · server-wide (not filtered by site/season)
          } @else if (s.rls !== 'none') {
            · filtered by {{ s.rls === 'season' ? 'season' : 'site and season' }}
          }
          · table <span class="mono">{{ s.tableName }}</span>
          @if (s.historyTable) {
            · <a [routerLink]="['/tables', s.historyTable]">change history ({{ shortTable(s.historyTable) }})</a>
          }
        </p>
      }
    }

    <section class="card range-bar">
      <app-date-range [range]="rangeKey()" [from]="from()" [to]="to()" (rangeChange)="setRange($event)" />
    </section>

    <!-- Tabs -->
    <div class="tabs">
      <button type="button" [class.active]="tab() === 'recent'" (click)="setTab('recent')">Recent errors</button>
      <button type="button" [class.active]="tab() === 'recurring'" (click)="setTab('recurring')">Recurring errors</button>
    </div>

    @if (tab() === 'recent') {
      <section class="card filters">
        <label class="grow">
          Search message / origin / code
          <input type="search" placeholder="e.g. invalid character" [value]="fSearch()" (input)="fSearch.set($any($event.target).value)" (keydown.enter)="apply()" />
        </label>
        <label>
          Severity
          <select [value]="fSeverity()" (change)="fSeverity.set($any($event.target).value)">
            <option value="">All</option>
            <option value="error" [selected]="fSeverity() === 'error'">Errors</option>
            <option value="warning" [selected]="fSeverity() === 'warning'">Warnings</option>
            <option value="info" [selected]="fSeverity() === 'info'">Info</option>
          </select>
        </label>
        <div class="filter-actions">
          <button type="button" class="btn primary" (click)="apply()">Apply</button>
          <button type="button" class="btn" (click)="clear()" [disabled]="!hasFilters()">Clear</button>
        </div>
      </section>

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @for (s of skippedOther(); track s.source) {
        <div class="banner warn small">{{ sourceLabel(s.source) }} skipped: {{ s.reason }}</div>
      }

      <section class="card flush">
        <div class="table-wrap tall" [class.dim]="loading()">
          <table class="grid errors-grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Severity</th>
                <th>Source / table</th>
                <th>Origin</th>
                <th>Code</th>
                <th>Message</th>
                <th>User</th>
              </tr>
            </thead>
            <tbody>
              @for (r of result()?.rows ?? []; track r.source + ':' + r.id + ':' + $index) {
                <tr (click)="selected.set(r)" [class.selected]="selected() === r">
                  <td class="nowrap" [title]="r.at ?? ''">
                    @if (isNew(r)) {
                      <span class="new-badge">NEW</span>
                    }
                    {{ r.at | cell }}
                    <div class="muted small">{{ r.at | ago }}</div>
                  </td>
                  <td><span class="sev" [class]="'sev-' + r.severity">{{ r.severity }}</span></td>
                  <td class="nowrap">
                    {{ r.sourceLabel }}
                    <div class="table-name" [title]="(r.table) + (r.key ? ' WHERE ' + r.key : '')">
                      {{ shortTable(r.table) }}@if (r.key) {<span class="muted"> · {{ r.key }}</span>}
                    </div>
                  </td>
                  <td class="origin" [title]="r.origin ?? ''">{{ r.origin }}</td>
                  <td class="nowrap">{{ r.code }}</td>
                  <td class="msg"><div class="clamp">{{ r.message }}</div></td>
                  <td class="nowrap">{{ r.user }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="7" class="empty">
                    @if (loading()) {
                      Loading…
                    } @else {
                      No errors in this period. 🎉
                      @if (rangeKey() !== 'all') {
                        <button type="button" class="btn" (click)="setRange({ range: 'all', from: null, to: null })">Show all time</button>
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (result(); as res) {
          <app-pager
            [page]="res.page"
            [pageSize]="res.pageSize"
            [total]="res.total"
            [sizes]="[25, 50, 100, 200]"
            (pageChange)="navigate({ page: $event })"
            (pageSizeChange)="navigate({ size: $event, page: 1 })"
          />
        }
      </section>
      @if (result(); as res) {
        <p class="muted small">Query took {{ (res.elapsedMs / 1000).toFixed(1) }}s · click a row for full details.</p>
      }
    } @else {
      <section class="card filters">
        <p class="muted small grow">Identical messages grouped together (first 300 characters), most frequent first. Click one to see every occurrence.</p>
      </section>
      <section class="card flush">
        <div class="table-wrap tall" [class.dim]="recurringLoading()">
          <table class="grid errors-grid">
            <thead>
              <tr>
                <th class="num">Count</th>
                <th>Source / table</th>
                <th>Origin</th>
                <th>Message</th>
                <th>First seen</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              @for (r of recurring(); track $index) {
                <tr (click)="drill(r)">
                  <td class="num"><strong>{{ r.count | number }}</strong></td>
                  <td class="nowrap">
                    {{ r.sourceLabel }}
                    <div class="table-name">{{ shortTable(r.table) }}</div>
                  </td>
                  <td class="origin">{{ r.origin }}</td>
                  <td class="msg"><div class="clamp">{{ r.message }}</div></td>
                  <td class="nowrap">{{ r.firstAt | cell }}</td>
                  <td class="nowrap">{{ r.lastAt | ago }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="6" class="empty">{{ recurringLoading() ? 'Loading…' : 'No errors in this period.' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }

    @if (selected(); as row) {
      <div class="drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <h2>{{ row.sourceLabel }}</h2>
          <button type="button" class="btn" (click)="selected.set(null)">✕</button>
        </div>
        <dl>
          <dt>Table</dt>
          <dd>{{ row.table }}</dd>
          @if (row.key) {
            <dt>Row</dt>
            <dd>{{ row.key }}</dd>
          }
          <dt>When</dt>
          <dd>{{ row.at }} ({{ row.at | ago }})</dd>
          <dt>Severity</dt>
          <dd><span class="sev" [class]="'sev-' + row.severity">{{ row.severity }}</span></dd>
          <dt>Origin</dt>
          <dd>{{ row.origin ?? '—' }}</dd>
          @if (row.code) {
            <dt>Code / status</dt>
            <dd>{{ row.code }}</dd>
          }
          @if (row.user) {
            <dt>User</dt>
            <dd>{{ row.user }}</dd>
          }
          <dt>Message</dt>
          <dd class="message">{{ row.message }}</dd>
          @for (kv of row.extra | keyvalue: keep; track kv.key) {
            <dt>{{ kv.key }}</dt>
            <dd>{{ kv.value | cell }}</dd>
          }
          @if (row.traceSql) {
            <dt>Find this row in SSMS</dt>
            <dd class="sql">{{ row.traceSql }}</dd>
          }
        </dl>
        <div class="drawer-actions">
          @if (row.traceSql) {
            <button type="button" class="btn primary" (click)="copy(row.traceSql)">{{ copied() ? '✓ Copied' : 'Copy SQL' }}</button>
          }
          <button type="button" class="btn" (click)="copy(row.message ?? '')">Copy message</button>
          <button type="button" class="btn" (click)="similar(row)">Show similar</button>
          @if (historyFor(row.source); as h) {
            <a class="btn" [routerLink]="['/tables', h]" (click)="selected.set(null)">Change history</a>
          }
        </div>
      </aside>
    }
  `,
})
export class Errors {
  // Query params, bound by withComponentInputBinding.
  readonly source = input<string>();
  readonly tab = input<'recent' | 'recurring', string | undefined>('recent', { transform: (v) => (v === 'recurring' ? 'recurring' : 'recent') });
  readonly page = input<string>();
  readonly size = input<string>();
  readonly range = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly q = input<string>();
  readonly sev = input<string>();

  protected readonly ctx = inject(ContextService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly keep = () => 0;
  protected readonly rangeKey = computed(() => normalizeRange(this.range()));

  protected readonly sources = signal<ErrorSourceStatus[]>([]);
  protected readonly grantScript = signal('');
  protected readonly result = signal<ErrorsPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly selected = signal<ErrorRow | null>(null);
  protected readonly recurring = signal<RecurringError[]>([]);
  protected readonly recurringLoading = signal(false);
    protected readonly updatedAt = signal<Date | null>(null);
  protected readonly copied = signal(false);
  private readonly reload = signal(0);
  /** Rows newer than this were not on screen the last time the page was opened. */
  private readonly lastSeen = signal<string>(this.readLastSeen());

  protected readonly fSearch = signal('');
  protected readonly fSeverity = signal('');

  protected readonly selectedSource = computed(() => this.sources().find((s) => s.id === this.source()) ?? null);
  protected readonly totals = computed(() =>
    this.sources().reduce((t, s) => ({ h24: t.h24 + s.last24h, d7: t.d7 + s.last7d }), { h24: 0, d7: 0 }),
  );
  protected readonly hasFilters = computed(() => !!(this.q() || this.sev()));
  /** Skipped-source warnings, except a known no-access source (shown on its card instead). */
  protected readonly skippedOther = computed(() =>
    (this.result()?.skipped ?? []).filter((s) => !this.sources().some((x) => x.id === s.source && !x.available)),
  );

  private readonly query = computed<{ q: ErrorsQuery; ctx: string; n: number } | null>(() => {
    if (this.tab() !== 'recent') return null;
    const sev = this.sev();
    // Presets are rolling windows: recomputed on every refresh (reload) so "last 7 days" stays current.
    const range = resolveRange(this.rangeKey(), this.from(), this.to());
    return {
      ctx: this.ctx.key(),
      n: this.reload(),
      q: {
        source: this.source() || undefined,
        page: Math.max(1, Number(this.page()) || 1),
        pageSize: Number(this.size()) || 50,
        from: range.from,
        to: range.to,
        search: this.q() || undefined,
        severity: sev === 'error' || sev === 'warning' || sev === 'info' ? (sev as Severity) : undefined,
      },
    };
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    effect(() => {
      this.ctx.key();
      untracked(() => this.loadSources());
    });

    effect(() => {
      this.fSearch.set(this.q() ?? '');
      this.fSeverity.set(this.sev() ?? '');
    });

    toObservable(this.query)
      .pipe(
        filter((q): q is NonNullable<typeof q> => q !== null),
        tap(() => {
          this.loading.set(true);
          this.error.set(null);
        }),
        switchMap((q) =>
          this.api.errors(q.q).pipe(
            map((r) => ({ ok: r as ErrorsPage | null, err: null as string | null })),
            catchError((err) => of({ ok: null, err: errorMessage(err) })),
          ),
        ),
        takeUntilDestroyed(destroyRef),
      )
      .subscribe((r) => {
        this.loading.set(false);
        this.updatedAt.set(new Date());
        if (r.ok) {
          this.result.set(r.ok);
          this.rememberSeen(r.ok.rows);
        }
        if (r.err) this.error.set(r.err);
      });

    // Recurring tab.
    effect(() => {
      if (this.tab() !== 'recurring') return;
      const range = resolveRange(this.rangeKey(), this.from(), this.to());
      const source = this.source();
      this.ctx.key();
      this.reload();
      untracked(() => this.loadRecurring(range, source));
    });
  }

  protected sourceLabel(id: string): string {
    return this.sources().find((s) => s.id === id)?.label ?? id;
  }

  /** dbo.ma_ApplicationErrorT -> ma_ApplicationErrorT (msdb tables keep their database prefix). */
  protected shortTable(name: string): string {
    return name.startsWith('dbo.') ? name.slice(4) : name;
  }

  protected historyFor(sourceId: string): string | null {
    return this.sources().find((s) => s.id === sourceId)?.historyTable ?? null;
  }

  protected isNew(r: ErrorRow): boolean {
    return !!r.at && !!this.lastSeen() && r.at > this.lastSeen();
  }

  navigate(params: Record<string, string | number | null | undefined>): void {
    this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge' });
  }

  setSource(id: string | null): void {
    this.navigate({ source: id, page: 1 });
  }

  setTab(tab: 'recent' | 'recurring'): void {
    this.navigate({ tab: tab === 'recent' ? null : tab });
  }

  apply(): void {
    this.navigate({
      q: this.fSearch().trim() || null,
      sev: this.fSeverity() || null,
      page: 1,
    });
  }

  clear(): void {
    this.navigate({ q: null, sev: null, page: 1 });
  }

  setRange(c: RangeChange): void {
    this.navigate({ range: c.range === '7d' ? null : c.range, from: c.from, to: c.to, page: 1 });
  }

  refreshAll(): void {
    this.loadSources(true);
    this.reload.update((n) => n + 1);
  }

  drill(r: RecurringError): void {
    const text = (r.message ?? '').split(/\r?\n/)[0].slice(0, 80);
    this.navigate({ tab: null, source: r.source, q: text || null, page: 1 });
  }

  similar(r: ErrorRow): void {
    const text = (r.message ?? '').split(/\r?\n/)[0].slice(0, 80);
    this.selected.set(null);
    this.navigate({ source: r.source, q: text || null, page: 1 });
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  private loadSources(refresh = false): void {
    this.api.errorSources(refresh).subscribe({
      next: (r) => {
        this.sources.set(r.sources);
        this.grantScript.set(r.agentGrantScript);
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  private loadRecurring(range: { from?: string; to?: string }, source: string | undefined): void {
    this.recurringLoading.set(true);
    this.api.recurringErrors(range, source || undefined).subscribe({
      next: (r) => {
        this.recurring.set(r.rows);
        this.recurringLoading.set(false);
        this.updatedAt.set(new Date());
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.recurringLoading.set(false);
        this.updatedAt.set(new Date());
      },
    });
  }

  private readLastSeen(): string {
    try {
      return localStorage.getItem(LAST_SEEN_KEY) ?? '';
    } catch {
      return '';
    }
  }

  /** Store the newest error time seen so the next visit can flag newer rows as NEW. */
  private rememberSeen(rows: ErrorRow[]): void {
    const newest = rows.reduce((m, r) => (r.at && r.at > m ? r.at : m), '');
    if (!newest) return;
    try {
      const stored = localStorage.getItem(LAST_SEEN_KEY) ?? '';
      if (newest > stored) localStorage.setItem(LAST_SEEN_KEY, newest);
    } catch {
      /* storage unavailable */
    }
  }
}
