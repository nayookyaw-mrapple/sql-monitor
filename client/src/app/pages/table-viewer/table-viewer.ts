import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, filter, map, of, switchMap, takeUntil, tap } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { RowsPage, RowsQuery, TableDetail } from '../../core/models';
import { CellPipe, CompactPipe, RLS_LABEL, actionClass } from '../../shared/format';
import { DateRange, RangeChange, normalizeRange, resolveRange } from '../../shared/date-range';
import { Pager } from '../../shared/pager';

@Component({
  selector: 'app-table-viewer',
  imports: [RouterLink, DecimalPipe, CellPipe, CompactPipe, Pager, DateRange],
  template: `
    <div class="page-head">
      <div>
        <div class="crumbs">
          <a routerLink="/tables">History tables</a> ›
          @if (detail(); as d) {
            <a [routerLink]="['/modules', d.module]">{{ d.module }}</a> ›
          }
        </div>
        <h1 class="mono">{{ detail()?.name ?? name() }}</h1>
        @if (detail(); as d) {
          <p class="muted">
            {{ d.columnCount }} columns · {{ d.rowCount | number }} rows across all sites ·
            newest first by <strong>{{ d.sortColumn }}</strong>
            @if (d.rls !== 'none') {
              · filtered by {{ rlsLabel[d.rls] }} (<strong>{{ ctx.site()?.siteName }}</strong>, {{ ctx.season() }})
            }
          </p>
        }
      </div>
      <div class="toolbar">
        <button type="button" class="btn" (click)="refresh()" [disabled]="loading()">↻ Refresh</button>
      </div>
    </div>

    @if (detailError(); as e) {
      <div class="banner error">{{ e }}</div>
    }

    @if (detail(); as d) {
      @if (d.isLarge) {
        <div class="banner warn">
          This table has {{ d.rowCount | compact }} rows and no index on {{ d.sortColumn }}, so sorting can take a while.
          A short date range keeps it fast; "All time" may take minutes.
        </div>
      }

      @if (d.dateColumn) {
        <section class="card range-bar">
          <app-date-range [range]="rangeKey()" [from]="from()" [to]="to()" (rangeChange)="setRange($event)" />
        </section>
      }

      <section class="card filters">
        @if (d.actionColumn) {
          <label>
            Action
            <select [value]="fAction()" (change)="fAction.set($any($event.target).value)">
              <option value="">Any</option>
              @for (a of actions(); track a) {
                <option [value]="a" [selected]="a === fAction()">{{ a }}</option>
              }
            </select>
          </label>
        }
        @if (d.userColumn) {
          <label>
            User
            <input type="search" placeholder="contains…" [value]="fUser()" (input)="fUser.set($any($event.target).value)" (keydown.enter)="apply()" />
          </label>
        }
        <label>
          Column
          <select [value]="fColumn()" (change)="fColumn.set($any($event.target).value)">
            <option value="">—</option>
            @for (c of d.columns; track c.name) {
              <option [value]="c.name" [selected]="c.name === fColumn()">{{ c.name }}</option>
            }
          </select>
        </label>
        <label>
          Value
          <input type="search" placeholder="e.g. record id" [value]="fValue()" (input)="fValue.set($any($event.target).value)" (keydown.enter)="apply()" />
        </label>
        <div class="filter-actions">
          <button type="button" class="btn primary" (click)="apply()">Apply</button>
          <button type="button" class="btn" (click)="clear()" [disabled]="!hasFilters()">Clear</button>
        </div>
      </section>

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }

      <section class="card flush">
        <div class="table-wrap tall" [class.dim]="loading()">
          @if (loading()) {
            <div class="overlay">
              <div class="spinner"></div>
              <div>Querying… {{ elapsed() }}s</div>
              <button type="button" class="btn" (click)="cancel()">Cancel</button>
            </div>
          }
          <table class="grid data">
            <thead>
              <tr>
                @for (c of d.columns; track c.name) {
                  <th
                    [class.sortable]="c.sortable"
                    [class.sorted]="c.name === sortCol()"
                    (click)="c.sortable && sortBy(c.name)"
                    [title]="c.type + (c.nullable ? ', nullable' : '')"
                  >
                    {{ c.name }}
                    @if (c.name === sortCol()) {
                      {{ sortDir() === 'desc' ? '▼' : '▲' }}
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of result()?.rows ?? []; track $index) {
                <tr (click)="selected.set(r)" [class.selected]="selected() === r">
                  @for (c of d.columns; track c.name) {
                    <td [class.num]="isNumeric(c.type)" [title]="r[c.name] ?? ''">
                      @if (c.name === d.actionColumn && r[c.name]) {
                        <span class="tag" [class]="actionClass($any(r[c.name]))">{{ r[c.name] }}</span>
                      } @else {
                        {{ r[c.name] | cell }}
                      }
                    </td>
                  }
                </tr>
              } @empty {
                <tr>
                  <td [attr.colspan]="d.columns.length" class="empty">
                    @if (loading()) {
                      Loading…
                    } @else {
                      No rows for this site, season, period and filter.
                      @if (d.dateColumn && rangeKey() !== 'all') {
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
            [estimate]="res.totalIsEstimate"
            (pageChange)="setPage($event)"
            (pageSizeChange)="setPageSize($event)"
          />
        }
      </section>
      @if (result(); as res) {
        <p class="muted small">Query took {{ (res.elapsedMs / 1000).toFixed(1) }}s · click a row to see all fields.</p>
      }
    } @else if (!detailError()) {
      <div class="loading">Loading…</div>
    }

    @if (selected(); as row) {
      <div class="drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <h2>Row detail</h2>
          <button type="button" class="btn" (click)="selected.set(null)">✕</button>
        </div>
        <dl>
          @for (c of detail()?.columns ?? []; track c.name) {
            <dt>{{ c.name }} <span class="muted small">{{ c.type }}</span></dt>
            <dd [class.null]="row[c.name] === null">{{ row[c.name] === null ? 'NULL' : (row[c.name] | cell) }}</dd>
          }
        </dl>
      </aside>
    }
  `,
})
export class TableViewer {
  // Route param + query params, bound by withComponentInputBinding.
  readonly name = input.required<string>();
  readonly page = input<string>();
  readonly size = input<string>();
  readonly sort = input<string>();
  readonly dir = input<string>();
  readonly range = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly action = input<string>();
  readonly user = input<string>();
  readonly fc = input<string>();
  readonly fv = input<string>();

  protected readonly ctx = inject(ContextService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly rlsLabel = RLS_LABEL;
  protected readonly actionClass = actionClass;
  /** Date range on the table's history date column; defaults to the last 7 days. */
  protected readonly rangeKey = computed(() => normalizeRange(this.range()));

  protected readonly detail = signal<TableDetail | null>(null);
  protected readonly detailError = signal<string | null>(null);
  protected readonly actions = signal<string[]>([]);
  protected readonly result = signal<RowsPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly elapsed = signal(0);
  protected readonly selected = signal<Record<string, unknown> | null>(null);

  // Filter form (applied to the URL on "Apply").
  protected readonly fAction = signal('');
  protected readonly fUser = signal('');
  protected readonly fColumn = signal('');
  protected readonly fValue = signal('');

  protected readonly sortCol = computed(() => this.sort() || this.detail()?.sortColumn || '');
  protected readonly sortDir = computed(() => (this.dir() === 'asc' ? 'asc' : 'desc'));
  protected readonly hasFilters = computed(() => !!(this.action() || this.user() || (this.fc() && this.fv())));

  private readonly cancel$ = new Subject<void>();
  private readonly reload$ = signal(0);

  private readonly query = computed<{ name: string; ctx: string; q: RowsQuery; n: number } | null>(() => {
    const d = this.detail();
    if (!d || d.fullName.toLowerCase() !== this.normalizedName().toLowerCase()) return null;
    // Presets are rolling windows, recomputed on each load/refresh. Ignored for tables without a date column.
    const range = d.dateColumn ? resolveRange(this.rangeKey(), this.from(), this.to()) : {};
    return {
      name: d.fullName,
      ctx: this.ctx.key(),
      n: this.reload$(),
      q: {
        page: Math.max(1, Number(this.page()) || 1),
        pageSize: Number(this.size()) || 50,
        sort: this.sort() || undefined,
        dir: this.sortDir(),
        from: range.from,
        to: range.to,
        action: this.action() || undefined,
        user: this.user() || undefined,
        filterColumn: this.fc() || undefined,
        filterValue: this.fv() || undefined,
      },
    };
  });

  private readonly normalizedName = computed(() => (this.name().includes('.') ? this.name() : `dbo.${this.name()}`));

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Load table metadata (and its distinct actions) whenever the table or Site/Season changes.
    effect(() => {
      const name = this.name();
      this.ctx.key();
      untracked(() => this.loadDetail(name));
    });

    // Mirror URL filters into the form.
    effect(() => {
      this.fAction.set(this.action() ?? '');
      this.fUser.set(this.user() ?? '');
      this.fColumn.set(this.fc() ?? '');
      this.fValue.set(this.fv() ?? '');
    });

    // Fetch rows; switchMap cancels the in-flight HTTP call (and the SQL query on the server) when anything changes.
    const stopTimer = () => this.stopTimer();
    toObservable(this.query)
      .pipe(
        filter((q): q is NonNullable<typeof q> => q !== null),
        tap(() => {
          this.loading.set(true);
          this.error.set(null);
          this.selected.set(null);
          this.elapsed.set(0);
          stopTimer();
          const started = Date.now();
          this.timer = setInterval(() => this.elapsed.set(Math.round((Date.now() - started) / 1000)), 1000);
        }),
        switchMap((q) =>
          this.api.rows(q.name, q.q).pipe(
            map((r) => ({ ok: r as RowsPage | null, err: null as string | null })),
            catchError((err) => of({ ok: null, err: errorMessage(err) })),
            takeUntil(this.cancel$.pipe(tap(() => this.error.set('Query cancelled.')))),
          ),
        ),
        takeUntilDestroyed(destroyRef),
      )
      .subscribe((r) => {
        stopTimer();
        this.loading.set(false);
        if (r.ok) this.result.set(r.ok);
        if (r.err) this.error.set(r.err);
      });

    destroyRef.onDestroy(() => {
      stopTimer();
      this.cancel$.next();
    });
  }

  protected isNumeric(type: string): boolean {
    return ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money'].includes(type);
  }

  private loadDetail(name: string): void {
    this.detailError.set(null);
    this.api.table(name).subscribe({
      next: (d) => {
        this.detail.set(d);
        this.actions.set([]);
        if (d.actionColumn) this.api.actions(d.fullName).subscribe({ next: (a) => this.actions.set(a), error: () => {} });
      },
      error: (err) => this.detailError.set(errorMessage(err)),
    });
  }

  private navigate(params: Record<string, string | number | null | undefined>): void {
    this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge', replaceUrl: false });
  }

  setPage(p: number): void {
    this.navigate({ page: p });
  }

  setPageSize(s: number): void {
    this.navigate({ size: s, page: 1 });
  }

  sortBy(col: string): void {
    const def = this.detail()?.sortColumn;
    const dir = col === this.sortCol() ? (this.sortDir() === 'desc' ? 'asc' : 'desc') : 'desc';
    this.navigate({ sort: col === def ? null : col, dir: dir === 'desc' ? null : dir, page: 1 });
  }

  apply(): void {
    this.navigate({
      action: this.fAction() || null,
      user: this.fUser().trim() || null,
      fc: this.fValue().trim() ? this.fColumn() || null : null,
      fv: this.fColumn() ? this.fValue().trim() || null : null,
      page: 1,
    });
  }

  clear(): void {
    this.navigate({ action: null, user: null, fc: null, fv: null, page: 1 });
  }

  setRange(c: RangeChange): void {
    this.navigate({ range: c.range === '7d' ? null : c.range, from: c.from, to: c.to, page: 1 });
  }

  refresh(): void {
    this.reload$.update((n) => n + 1);
  }

  cancel(): void {
    this.cancel$.next();
    this.stopTimer();
    this.loading.set(false);
  }

  private timer: ReturnType<typeof setInterval> | undefined;
  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
