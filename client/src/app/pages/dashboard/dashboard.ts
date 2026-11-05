import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { ActivityEvent, MODULE_NAMES, Summary } from '../../core/models';
import { AutoRefresh } from '../../shared/auto-refresh';
import { AgoPipe, CompactPipe } from '../../shared/format';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, DecimalPipe, AgoPipe, CompactPipe, AutoRefresh],
  template: `
    <div class="page-head">
      <div>
        <h1>Dashboard</h1>
        <p class="muted">
          Change history for
          <strong>{{ ctx.scopeLabel() }}</strong>
        </p>
      </div>
      <app-auto-refresh storageKey="dashboard" [defaultMs]="30000" [lastUpdated]="updatedAt()" [loading]="loading()" (refresh)="load()" />
    </div>

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }

    @if (summary(); as s) {
      <section class="stats">
        <div class="stat">
          <div class="stat-label">History tables</div>
          <div class="stat-value">{{ s.tableCount | number }}</div>
          <div class="stat-foot">{{ s.modules.length }} modules</div>
        </div>
        <div class="stat">
          <div class="stat-label">History rows (all sites)</div>
          <div class="stat-value">{{ s.totalRows | compact }}</div>
          <div class="stat-foot">{{ s.totalRows | number }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Filtered by Site / Season</div>
          <div class="stat-value">{{ s.rlsTableCount | number }}</div>
          <div class="stat-foot">tables use row-level security</div>
        </div>
        <div class="stat">
          <div class="stat-label">Changes detected</div>
          <div class="stat-value">{{ s.monitor.eventsRecorded | number }}</div>
          <div class="stat-foot">since {{ s.monitor.startedAt.slice(0, 16) }}</div>
        </div>
      </section>

      <div class="grid-2">
        <section class="card">
          <div class="card-head">
            <h2>Recently changed tables</h2>
            <a routerLink="/latest-changes">See all changes →</a>
          </div>
          @if (s.monitor.lastChangeScanRunning) {
            <p class="muted small">Scanning tables for this site and season… ({{ s.monitor.lastChangeScannedTables }} done)</p>
          }
          @if (s.recentlyChangedTables.length) {
            <table class="list">
              <thead>
                <tr><th>Table</th><th>Last change</th><th class="num">Rows</th></tr>
              </thead>
              <tbody>
                @for (t of s.recentlyChangedTables; track t.fullName) {
                  <tr>
                    <td>
                      <a [routerLink]="['/tables', t.fullName]">{{ t.name }}</a>
                      <span class="mod-chip">{{ t.module }}</span>
                    </td>
                    <td [title]="t.lastChange ?? ''">{{ t.lastChange | ago }}</td>
                    <td class="num">{{ t.rowCount | compact }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else if (!s.monitor.lastChangeScanRunning) {
            <p class="muted">No changes found for this site and season.</p>
          }
          <p class="muted small">
            Covers tables up to {{ s.monitor.lastChangeScanMaxRows | compact }} rows. The {{ s.largeTableCount }} larger tables show up in
            <a routerLink="/activity">Live activity</a>.
          </p>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Live activity</h2>
            <a routerLink="/activity">Open feed →</a>
          </div>
          @if (events().length) {
            <table class="list">
              <thead>
                <tr><th>Table</th><th class="num">Rows</th><th>Detected</th></tr>
              </thead>
              <tbody>
                @for (e of events(); track e.id) {
                  <tr>
                    <td><a [routerLink]="['/tables', e.table]">{{ e.table.replace('dbo.', '') }}</a></td>
                    <td class="num" [class.pos]="e.delta > 0" [class.neg]="e.delta < 0">{{ e.delta > 0 ? '+' : '' }}{{ e.delta | number }}</td>
                    <td>{{ e.detectedAt | ago }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted">
              No new history rows yet. Row counts are checked every {{ s.monitor.pollIntervalMs / 1000 }}s across all sites.
            </p>
          }
        </section>
      </div>

      <section class="card">
        <div class="card-head"><h2>Modules</h2></div>
        <div class="modules">
          @for (m of s.modules; track m.module) {
            <a class="module" [routerLink]="['/modules', m.module]">
              <span class="module-code">{{ m.module }}</span>
              <span class="module-name">{{ moduleName(m.module) }}</span>
              <span class="module-meta">{{ m.tables }} tables · {{ m.rows | compact }} rows</span>
            </a>
          }
        </div>
      </section>
    } @else if (loading()) {
      <div class="loading">Loading…</div>
    }
  `,
})
export class Dashboard {
  protected readonly ctx = inject(ContextService);
  private readonly api = inject(ApiService);
  protected readonly summary = signal<Summary | null>(null);
  protected readonly events = signal<ActivityEvent[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.ctx.key();
      untracked(() => this.load());
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.scanTimer));
  }

  protected readonly updatedAt = signal<Date | null>(null);
  private scanTimer: ReturnType<typeof setTimeout> | undefined;

  protected moduleName(code: string): string {
    return MODULE_NAMES[code] ?? code.toUpperCase();
  }

  load(silent = false): void {
    if (!silent) this.loading.set(true);
    this.api.summary().subscribe({
      next: (s) => {
        this.summary.set(s);
        this.error.set(null);
        this.loading.set(false);
        this.updatedAt.set(new Date());
        // While the background scan for this site/season is filling in, poll quickly so the list appears.
        clearTimeout(this.scanTimer);
        if (s.monitor.lastChangeScanRunning) this.scanTimer = setTimeout(() => this.load(true), 4000);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
        this.updatedAt.set(new Date());
      },
    });
    this.api.activity(10).subscribe({ next: (a) => this.events.set(a.events), error: () => {} });
  }
}
