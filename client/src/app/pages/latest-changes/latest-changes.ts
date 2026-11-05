import { KeyValuePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { LatestChangeRow, MODULE_NAMES, MonitorStatus } from '../../core/models';
import { AgoPipe, CellPipe, actionClass } from '../../shared/format';
import { AutoRefresh } from '../../shared/auto-refresh';
import { DateRange, RangeChange, normalizeRange, resolveRange } from '../../shared/date-range';
import { Pager } from '../../shared/pager';

@Component({
  selector: 'app-latest-changes',
  imports: [RouterLink, KeyValuePipe, AgoPipe, CellPipe, Pager, AutoRefresh, DateRange],
  template: `
    <div class="page-head">
      <div>
        <h1>Latest changes</h1>
        <p class="muted">
          Newest history rows across all tables · <strong>{{ ctx.scopeLabel() }}</strong>
        </p>
      </div>
      <div class="toolbar">
        <select [value]="module()" (change)="setModule($any($event.target).value)">
          <option value="">All modules</option>
          @for (m of modules; track m) {
            <option [value]="m" [selected]="m === module()">{{ m }} · {{ moduleNames[m] ?? m }}</option>
          }
        </select>
        <app-auto-refresh
          storageKey="latest-changes"
          [defaultMs]="15000"
          [lastUpdated]="updatedAt()"
          [loading]="loading()"
          (refresh)="load()"
        />
      </div>
    </div>

    <section class="card range-bar">
      <app-date-range [range]="rangeKey()" [from]="from()" [to]="to()" (rangeChange)="setRange($event)" />
    </section>

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }
    @if (monitor()?.lastChangeScanRunning) {
      <div class="banner info">Scanning tables for this site and season — the list fills in as it goes…</div>
    }

    <section class="card flush">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th>When</th>
              <th>Table</th>
              <th>Action</th>
              <th>User</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            @for (r of pageRows(); track $index) {
              <tr>
                <td class="nowrap" [title]="r.changedAt ?? ''">
                  {{ r.changedAt | cell }}
                  <div class="muted small">{{ r.changedAt | ago }}</div>
                </td>
                <td>
                  <a class="mono" [routerLink]="['/tables', r.table]" [title]="r.table">{{ r.table.replace('dbo.', '') }}</a>
                  <span class="mod-chip">{{ r.module }}</span>
                </td>
                <td>
                  @if (r.action) {
                    <span class="tag" [class]="actionClass(r.action)">{{ r.action }}</span>
                  }
                </td>
                <td class="nowrap">{{ r.user }}</td>
                <td class="summary">
                  @for (kv of r.summary | keyvalue: keep; track kv.key) {
                    <span class="kv"><span class="k">{{ kv.key }}</span> {{ kv.value | cell }}</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="empty">
                  @if (loading()) {
                    Loading…
                  } @else {
                    No changes in this period for this site and season.
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
      <app-pager
        [page]="page()"
        [pageSize]="pageSize()"
        [total]="rows().length"
        [sizes]="[25, 50, 100]"
        (pageChange)="page.set($event)"
        (pageSizeChange)="pageSize.set($event); page.set(1)"
      />
    </section>
    <p class="muted small">
      @if (rangeKey() === 'all') {
        All time shows the 5 newest rows of each table.
      } @else {
        Up to 25 rows per table in the selected period{{ scanned() !== null ? ' (' + scanned() + ' tables changed in this period)' : '' }}.
      }
      Covers tables up to {{ (monitor()?.lastChangeScanMaxRows ?? 0).toLocaleString() }} rows. The server
      checks for new history rows every {{ (monitor()?.pollIntervalMs ?? 15000) / 1000 }}s (last check
      {{ monitor()?.lastPollAt?.slice(11, 19) ?? '—' }}); this page picks them up on its next refresh. Very large tables are listed under
      <a routerLink="/activity">Live activity</a>.
    </p>
  `,
})
export class LatestChanges {
  // Query params (bound by withComponentInputBinding): ?range=24h|7d|30d|all|custom&from=&to=
  readonly range = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  protected readonly rangeKey = computed(() => normalizeRange(this.range()));
  protected readonly scanned = signal<number | null>(null);
  private readonly router = inject(Router);
  private sub?: Subscription;

  protected readonly ctx = inject(ContextService);
  private readonly api = inject(ApiService);
  protected readonly moduleNames = MODULE_NAMES;
  protected readonly modules = Object.keys(MODULE_NAMES);
  protected readonly actionClass = actionClass;
  protected readonly keep = () => 0;

  protected readonly rows = signal<LatestChangeRow[]>([]);
  protected readonly monitor = signal<MonitorStatus | null>(null);
  protected readonly module = signal('');
  protected readonly updatedAt = signal<Date | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly page = signal(1);
  protected readonly pageSize = signal(50);
  protected readonly pageRows = computed(() => {
    const start = (this.page() - 1) * this.pageSize();
    return this.rows().slice(start, start + this.pageSize());
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
    effect(() => {
      this.ctx.key();
      this.module();
      this.rangeKey();
      this.from();
      this.to();
      untracked(() => {
        this.page.set(1);
        this.load();
      });
    });
  }

  setRange(c: RangeChange): void {
    this.router.navigate([], {
      queryParams: { range: c.range === 'custom' || c.range !== '7d' ? c.range : null, from: c.from, to: c.to },
      queryParamsHandling: 'merge',
    });
  }

  setModule(m: string): void {
    this.module.set(m);
  }

  load(): void {
    this.loading.set(true);
    this.sub?.unsubscribe();
    const range = resolveRange(this.rangeKey(), this.from(), this.to());
    this.sub = this.api.latestChanges(1000, this.module() || undefined, range).subscribe({
      next: (r) => {
        this.rows.set(r.rows);
        this.scanned.set(r.scannedTables);
        this.monitor.set(r.monitor);
        this.error.set(null);
        this.loading.set(false);
        this.updatedAt.set(new Date());
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
        this.updatedAt.set(new Date());
      },
    });
  }
}
