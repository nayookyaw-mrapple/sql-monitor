import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { MODULE_NAMES, TableSummary } from '../../core/models';
import { AgoPipe, CompactPipe, RLS_LABEL } from '../../shared/format';
import { Pager } from '../../shared/pager';

type SortKey = 'name' | 'rowCount' | 'lastChange' | 'module';

@Component({
  selector: 'app-tables',
  imports: [RouterLink, DecimalPipe, AgoPipe, CompactPipe, Pager],
  template: `
    <div class="page-head">
      <div>
        <h1>{{ module() ? module() + ' · ' + (moduleNames[module()!] ?? module()) : 'All history tables' }}</h1>
        <p class="muted">{{ filtered().length | number }} tables · pick one to browse its history, newest first</p>
      </div>
      <div class="toolbar">
        <input type="search" placeholder="Search tables…" [value]="search()" (input)="search.set($any($event.target).value); page.set(1)" autofocus />
        <label class="check"><input type="checkbox" [checked]="onlyChanged()" (change)="onlyChanged.set(!onlyChanged()); page.set(1)" /> With data only</label>
      </div>
    </div>

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }

    <section class="card flush">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="sortable" (click)="sortBy('name')">Table {{ arrow('name') }}</th>
              @if (!module()) {
                <th class="sortable" (click)="sortBy('module')">Module {{ arrow('module') }}</th>
              }
              <th class="sortable num" (click)="sortBy('rowCount')">Rows (all sites) {{ arrow('rowCount') }}</th>
              <th class="sortable" (click)="sortBy('lastChange')">Last change (site/season) {{ arrow('lastChange') }}</th>
              <th>Ordered by</th>
              <th>Filtered by</th>
            </tr>
          </thead>
          <tbody>
            @for (t of pageRows(); track t.fullName) {
              <tr>
                <td>
                  <a [routerLink]="['/tables', t.fullName]">{{ t.name }}</a>
                  @if (t.isLarge) {
                    <span class="tag tag-warn" title="Large table — sorting without an index can be slow">large</span>
                  }
                </td>
                @if (!module()) {
                  <td><span class="mod-chip">{{ t.module }}</span></td>
                }
                <td class="num" [title]="(t.rowCount | number) ?? ''">{{ t.rowCount | compact }}</td>
                <td [title]="t.lastChange ?? ''">
                  @if (t.lastChangeKnown) {
                    {{ t.lastChange ? (t.lastChange | ago) : 'no rows' }}
                  } @else {
                    <span class="muted">{{ t.isLarge ? 'open to view' : 'scanning…' }}</span>
                  }
                </td>
                <td class="muted">{{ t.sortColumn }}</td>
                <td class="muted">{{ rlsLabel[t.rls] }}</td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="empty">{{ loading() ? 'Loading…' : 'No tables match.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
      <app-pager
        [page]="page()"
        [pageSize]="pageSize()"
        [total]="filtered().length"
        [sizes]="[25, 50, 100, 200, 500]"
        (pageChange)="page.set($event)"
        (pageSizeChange)="pageSize.set($event); page.set(1)"
      />
    </section>
  `,
})
export class Tables {
  /** Route param from /modules/:module (bound via withComponentInputBinding). */
  readonly module = input<string | undefined>();

  private readonly api = inject(ApiService);
  private readonly ctx = inject(ContextService);
  protected readonly moduleNames = MODULE_NAMES;
  protected readonly rlsLabel = RLS_LABEL;

  protected readonly tables = signal<TableSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly onlyChanged = signal(false);
  protected readonly sort = signal<SortKey>('name');
  protected readonly dir = signal<1 | -1>(1);
  protected readonly page = signal(1);
  protected readonly pageSize = signal(50);

  protected readonly filtered = computed(() => {
    const s = this.search().trim().toLowerCase();
    const key = this.sort();
    const dir = this.dir();
    return this.tables()
      .filter((t) => !s || t.name.toLowerCase().includes(s))
      .filter((t) => !this.onlyChanged() || t.lastChange || t.isLarge)
      .sort((a, b) => {
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * dir;
      });
  });
  protected readonly pageRows = computed(() => {
    const start = (this.page() - 1) * this.pageSize();
    return this.filtered().slice(start, start + this.pageSize());
  });

  constructor() {
    effect(() => {
      const module = this.module();
      this.ctx.key();
      untracked(() => {
        this.page.set(1);
        this.load(module);
      });
    });
  }

  sortBy(key: SortKey): void {
    if (this.sort() === key) this.dir.set(this.dir() === 1 ? -1 : 1);
    else {
      this.sort.set(key);
      this.dir.set(key === 'name' || key === 'module' ? 1 : -1);
    }
    this.page.set(1);
  }

  arrow(key: SortKey): string {
    return this.sort() === key ? (this.dir() === 1 ? '▲' : '▼') : '';
  }

  private load(module: string | undefined): void {
    this.loading.set(true);
    this.api.tables({ module }).subscribe({
      next: (t) => {
        this.tables.set(t);
        this.error.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }
}
