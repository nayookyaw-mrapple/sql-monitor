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

    <div class="sub-toolbar">
      <input
        type="search"
        placeholder="Search table, user, details…"
        title="Searches the rows loaded below: table, action, user and every value in Details"
        [value]="search()"
        (input)="search.set($any($event.target).value); page.set(1)"
      />
      <select [value]="action()" (change)="action.set($any($event.target).value)" aria-label="Action">
        <option value="">All actions</option>
        @for (a of actionOptions(); track a) {
          <option [value]="a" [selected]="a === action()">{{ a }}</option>
        }
      </select>
      <input
        type="search"
        list="lc-users"
        placeholder="User: pick or type…"
        title="Pick a user from the list, or type part of a name"
        [value]="user()"
        (input)="later('user', $any($event.target).value)"
      />
      <datalist id="lc-users">
        @for (u of userOptions(); track u) {
          <option [value]="u"></option>
        }
      </datalist>
      <input
        type="search"
        list="lc-tables"
        placeholder="Table: pick or type…"
        title="Pick a table from the list, or type part of a name"
        [value]="table()"
        (input)="later('table', $any($event.target).value)"
      />
      <datalist id="lc-tables">
        @for (t of tableOptions(); track t) {
          <option [value]="t"></option>
        }
      </datalist>
      @if (filtered()) {
        <button type="button" class="btn" (click)="clearFilters()">Clear filters</button>
        <span class="muted small">{{ shown().length.toLocaleString() }} rows match</span>
      }
    </div>

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
                    @if (filtered()) {
                      No changes match these filters in this period.
                      <button type="button" class="btn" (click)="clearFilters()">Clear filters</button>
                    } @else {
                      No changes in this period for this site and season.
                    }
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
        [total]="shown().length"
        [sizes]="[25, 50, 100]"
        (pageChange)="page.set($event)"
        (pageSizeChange)="pageSize.set($event); page.set(1)"
      />
    </section>
    <p class="muted small">
      @if (rangeKey() === 'all') {
        All time shows the 5 newest rows of each table.
      } @else {
        Up to {{ perTable() }} rows per table in the selected period{{ scanned() !== null ? ' (' + scanned() + ' tables changed in this period)' : '' }}.
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
  protected readonly perTable = signal(25);

  // Filters. Action, user and table are applied by the server (so matches are not cut off by the
  // per-table row cap); the search box filters the rows already loaded.
  protected readonly action = signal('');
  protected readonly user = signal('');
  protected readonly table = signal('');
  protected readonly search = signal('');
  protected readonly actionOptions = signal<string[]>([]);
  protected readonly userOptions = signal<string[]>([]);
  protected readonly tableOptions = signal<string[]>([]);
  private optionsFor = '';
  private timers: Record<string, ReturnType<typeof setTimeout>> = {};
  protected readonly filtered = computed(() => !!(this.action() || this.user() || this.table() || this.search().trim()));

  protected readonly shown = computed(() => {
    const words = this.search().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.rows();
    return this.rows().filter((r) => {
      const text = [r.table, r.module, r.action, r.user, ...Object.entries(r.summary).flat()].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });
  protected readonly pageRows = computed(() => {
    const start = (this.page() - 1) * this.pageSize();
    return this.shown().slice(start, start + this.pageSize());
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.sub?.unsubscribe();
      for (const t of Object.values(this.timers)) clearTimeout(t);
    });
    effect(() => {
      this.ctx.key();
      this.module();
      this.action();
      this.user();
      this.table();
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

  /** Applies a typed filter shortly after the last keystroke, so each letter is not a server query. */
  later(field: 'user' | 'table', value: string): void {
    clearTimeout(this.timers[field]);
    this.timers[field] = setTimeout(() => this[field].set(value.trim()), 350);
  }

  clearFilters(): void {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.action.set('');
    this.user.set('');
    this.table.set('');
    this.search.set('');
    this.page.set(1);
  }

  /** Dropdown choices: every action, user and table seen in this database / module / period so far. */
  private addOptions(rows: LatestChangeRow[]): void {
    const scope = [this.ctx.key(), this.module(), this.rangeKey(), this.from(), this.to()].join('|');
    const fresh = scope !== this.optionsFor;
    this.optionsFor = scope;
    const merge = (old: string[], values: (string | null)[]) =>
      [...new Set([...(fresh ? [] : old), ...values.filter((v): v is string => !!v)])].sort((a, b) => a.localeCompare(b));
    this.actionOptions.update((o) => merge(o, rows.map((r) => r.action)));
    this.userOptions.update((o) => merge(o, rows.map((r) => r.user)));
    this.tableOptions.update((o) => merge(o, rows.map((r) => r.table.replace('dbo.', ''))));
  }

  load(): void {
    this.loading.set(true);
    this.sub?.unsubscribe();
    const range = resolveRange(this.rangeKey(), this.from(), this.to());
    const filter = { action: this.action() || undefined, user: this.user() || undefined, table: this.table() || undefined };
    this.sub = this.api.latestChanges(1000, this.module() || undefined, range, filter).subscribe({
      next: (r) => {
        this.rows.set(r.rows);
        this.perTable.set(r.perTable ?? 25);
        this.addOptions(r.rows);
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
