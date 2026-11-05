import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import { ActivityEvent, MonitorStatus } from '../../core/models';
import { AgoPipe } from '../../shared/format';
import { AutoRefresh } from '../../shared/auto-refresh';
import { Pager } from '../../shared/pager';

@Component({
  selector: 'app-activity',
  imports: [RouterLink, DecimalPipe, AgoPipe, Pager, AutoRefresh],
  template: `
    <div class="page-head">
      <div>
        <h1>Live activity</h1>
        <p class="muted">
          New history rows detected across <strong>all sites and seasons</strong>, from row counts polled every
          {{ (monitor()?.pollIntervalMs ?? 15000) / 1000 }}s.
        </p>
      </div>
      <div class="toolbar">
        <input type="search" placeholder="Filter by table…" [value]="filter()" (input)="filter.set($any($event.target).value); page.set(1)" />
        <app-auto-refresh storageKey="activity" [defaultMs]="10000" [lastUpdated]="updatedAt()" [loading]="loading()" (refresh)="load()" />
      </div>
    </div>

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }
    @if (monitor()?.lastPollError; as pe) {
      <div class="banner error">Last poll failed: {{ pe }}</div>
    }

    <section class="card flush">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th>Detected</th>
              <th>Table</th>
              <th>Module</th>
              <th class="num">Rows added</th>
              <th class="num">Total rows</th>
            </tr>
          </thead>
          <tbody>
            @for (e of pageRows(); track e.id) {
              <tr>
                <td class="nowrap">{{ e.detectedAt.slice(0, 19) }} <span class="muted small">· {{ e.detectedAt | ago }}</span></td>
                <td><a [routerLink]="['/tables', e.table]">{{ e.table.replace('dbo.', '') }}</a></td>
                <td><span class="mod-chip">{{ e.module }}</span></td>
                <td class="num" [class.pos]="e.delta > 0" [class.neg]="e.delta < 0">{{ e.delta > 0 ? '+' : '' }}{{ e.delta | number }}</td>
                <td class="num">{{ e.rowCount | number }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="empty">
                  No changes detected since the monitor started{{ monitor() ? ' (' + monitor()!.startedAt.slice(0, 16) + ')' : '' }}. New rows
                  show up here within {{ (monitor()?.pollIntervalMs ?? 15000) / 1000 }} seconds.
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <app-pager
        [page]="page()"
        [pageSize]="pageSize()"
        [total]="filtered().length"
        [sizes]="[25, 50, 100, 200]"
        (pageChange)="page.set($event)"
        (pageSizeChange)="pageSize.set($event); page.set(1)"
      />
    </section>
    <p class="muted small">Last poll: {{ monitor()?.lastPollAt ?? '—' }}. The feed keeps the latest 1,000 events in memory on the server.</p>
  `,
})
export class Activity {
  private readonly api = inject(ApiService);
  protected readonly events = signal<ActivityEvent[]>([]);
  protected readonly monitor = signal<MonitorStatus | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly updatedAt = signal<Date | null>(null);
  protected readonly loading = signal(false);
  protected readonly filter = signal('');
  protected readonly page = signal(1);
  protected readonly pageSize = signal(50);

  protected readonly filtered = computed(() => {
    const f = this.filter().trim().toLowerCase();
    return f ? this.events().filter((e) => e.table.toLowerCase().includes(f)) : this.events();
  });
  protected readonly pageRows = computed(() => {
    const start = (this.page() - 1) * this.pageSize();
    return this.filtered().slice(start, start + this.pageSize());
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.activity(1000).subscribe({
      next: (a) => {
        this.events.set(a.events);
        this.monitor.set(a.monitor);
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
