import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { ProcUsageResult } from '../../core/models';
import { AutoRefresh } from '../../shared/auto-refresh';
import { AgoPipe } from '../../shared/format';
import { Pager } from '../../shared/pager';

type View = 'latest' | 'least' | 'never';

const VIEW_KEY = 'nay-monitor.procedures.view';

@Component({
  selector: 'app-procedures',
  imports: [DecimalPipe, AgoPipe, AutoRefresh, Pager],
  template: `
    <div class="page-head">
      <div>
        <h1>Procedure usage</h1>
        <p class="muted">
          Every stored procedure in <strong>{{ data()?.database ?? ctx.target()?.database }}</strong> on
          <strong>{{ data()?.server ?? ctx.target()?.server }}</strong>: when it was last used and by whom. Nothing is changed.
        </p>
      </div>
      <div class="toolbar">
        <app-auto-refresh storageKey="procedures" [defaultMs]="60000" [lastUpdated]="updatedAt()" [loading]="loading()" (refresh)="load()" />
      </div>
    </div>

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }

    <div class="stats">
      <button type="button" class="stat stat-btn" [class.active]="view() === 'latest'" (click)="setView('latest')">
        <div class="stat-label">Latest used</div>
        <div class="stat-value">{{ data() ? counts().used : '—' }}</div>
        <div class="stat-foot ellipsis">{{ newest() ? newest()!.procName + ' · ' + (newest()!.lastUsed | ago) : 'procedures with a recorded use' }}</div>
      </button>
      <button type="button" class="stat stat-btn" [class.active]="view() === 'least'" (click)="setView('least')">
        <div class="stat-label">Least recently used</div>
        <div class="stat-value">{{ oldest() ? (oldest()!.lastUsed | ago) : '—' }}</div>
        <div class="stat-foot ellipsis">{{ oldest()?.procName ?? 'oldest recorded use first' }}</div>
      </button>
      <button type="button" class="stat stat-btn" [class.active]="view() === 'never'" (click)="setView('never')">
        <div class="stat-label">No use recorded</div>
        <div class="stat-value">{{ data() ? counts().never : '—' }}</div>
        <div class="stat-foot">not seen since recording began</div>
      </button>
      <div class="stat">
        <div class="stat-label">Used by someone known</div>
        <div class="stat-value">{{ data() ? counts().withWho : '—' }}</div>
        <div class="stat-foot">of {{ counts().total | number }} procedures</div>
      </div>
    </div>

    <div class="sub-toolbar">
      <input
        type="search"
        placeholder="Search procedure, login, app, job, host…"
        [value]="search()"
        (input)="search.set($any($event.target).value); page.set(1)"
        style="flex: 1; max-width: 480px"
      />
      <div class="seg" role="group" aria-label="Order">
        <button type="button" [class.active]="view() === 'latest'" (click)="setView('latest')">Latest used</button>
        <button type="button" [class.active]="view() === 'least'" (click)="setView('least')">Least recently used</button>
        <button type="button" [class.active]="view() === 'never'" (click)="setView('never')">No use recorded</button>
      </div>
      <span class="muted small">{{ filtered().length | number }} procedure(s)</span>
    </div>

    <p class="muted small">
      <strong>Last used</strong> is the later of SQL Server's own last-run time (<span class="table-name">sys.dm_exec_procedure_stats</span>) and
      the last time the activity history saw it. SQL Server forgets its times when it restarts
      @if (data()?.serverStart) {
        (last start {{ data()!.serverStart!.slice(0, 16) }})
      }
      or drops the plan from memory. <strong>Used by</strong> comes only from the activity history (SQL activity → History), which is sampled: a
      very short call can be missed, so a procedure can have a date but no name.
      @if (view() === 'never') {
        "No use recorded" means not seen since recording began; it does not prove the procedure is never used.
      }
    </p>

    @if (data() && !data()!.historyOn) {
      <div class="banner warn small">
        The activity history is not recording <strong>{{ data()!.server }}</strong>, so "Used by" is empty. Add the server to
        <span class="mono">HISTORY_SERVERS</span> in <span class="mono">server/.env</span>.
      </div>
    }

    <section class="card flush">
      <div class="table-wrap" [class.dim]="loading() && !data()">
        <table class="grid sql-grid usage-grid">
          <thead>
            <tr>
              <th>Procedure</th>
              <th>Last used</th>
              <th>Used by (last seen)</th>
              <th class="num" title="Executions SQL Server counted since the plan was cached">Executions</th>
              <th class="num" title="Times the activity history saw it, and by how many different logins">Seen in history</th>
              <th>Procedure changed</th>
            </tr>
          </thead>
          <tbody>
            @for (p of pageRows(); track p.procName) {
              <tr class="plain">
                <td class="mono small proc-cell">{{ p.procName }}</td>
                <td class="nowrap" [title]="p.lastUsed ?? ''">
                  @if (p.lastUsed) {
                    {{ p.lastUsed.slice(0, 19) }}
                    <div class="muted small">{{ p.lastUsed | ago }}</div>
                  } @else {
                    <span class="muted">no use recorded</span>
                  }
                </td>
                <td class="who">
                  @if (p.lastLogin) {
                    <div class="who-login ellipsis" [title]="p.lastLogin">{{ p.lastLogin }}</div>
                    <div class="muted small ellipsis">
                      {{ p.lastJob ? 'Agent job: ' + p.lastJob : (p.lastApp ?? '') }}{{ p.lastHost ? ' @ ' + p.lastHost : '' }}
                    </div>
                    <div class="muted small">{{ p.lastSeen?.slice(0, 19) }}</div>
                  } @else {
                    <span class="muted">{{ p.lastUsed ? 'not caught by the history' : '—' }}</span>
                  }
                </td>
                <td class="num">
                  {{ p.executions === null ? '—' : (p.executions | number) }}
                  @if (p.cachedAt) {
                    <div class="muted small">since {{ p.cachedAt.slice(0, 16) }}</div>
                  }
                </td>
                <td class="num">
                  {{ p.seen ? (p.seen | number) : '—' }}
                  @if (p.logins > 1) {
                    <div class="muted small">{{ p.logins }} logins</div>
                  }
                </td>
                <td class="nowrap muted small">{{ p.modifiedAt?.slice(0, 16) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="empty">{{ data() ? 'No procedure matches.' : 'Loading…' }}</td>
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
  `,
})
export class Procedures {
  private readonly api = inject(ApiService);
  protected readonly ctx = inject(ContextService);

  protected readonly data = signal<ProcUsageResult | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly updatedAt = signal<Date | null>(null);

  protected readonly search = signal('');
  protected readonly view = signal<View>(this.storedView());
  protected readonly page = signal(1);
  protected readonly pageSize = signal(50);

  /** Procedures with a recorded use, newest first. */
  private readonly used = computed(() =>
    (this.data()?.rows ?? [])
      .filter((p) => p.lastUsed)
      .sort((a, b) => b.lastUsed!.localeCompare(a.lastUsed!) || a.procName.localeCompare(b.procName)),
  );
  protected readonly newest = computed(() => this.used()[0] ?? null);
  protected readonly oldest = computed(() => this.used().at(-1) ?? null);
  protected readonly counts = computed(() => {
    const total = this.data()?.rows.length ?? 0;
    const used = this.used().length;
    return { total, used, never: total - used, withWho: this.used().filter((p) => p.lastLogin).length };
  });

  protected readonly filtered = computed(() => {
    const view = this.view();
    const f = this.search().trim().toLowerCase();
    const rows = view === 'never' ? (this.data()?.rows ?? []).filter((p) => !p.lastUsed) : view === 'least' ? [...this.used()].reverse() : this.used();
    return f ? rows.filter((p) => [p.procName, p.lastLogin, p.lastApp, p.lastJob, p.lastHost].some((v) => v?.toLowerCase().includes(f))) : rows;
  });
  protected readonly pageRows = computed(() => {
    const start = (this.page() - 1) * this.pageSize();
    return this.filtered().slice(start, start + this.pageSize());
  });

  constructor() {
    effect(() => {
      this.ctx.key();
      if (!this.ctx.ready()) return;
      untracked(() => {
        this.data.set(null);
        this.page.set(1);
        this.load();
      });
    });
  }

  load(): void {
    this.loading.set(true);
    this.api.sqlProcedureUsage().subscribe({
      next: (r) => {
        this.data.set(r);
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

  setView(v: View): void {
    this.view.set(v);
    this.page.set(1);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  }

  private storedView(): View {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'least' || v === 'never' ? v : 'latest';
    } catch {
      return 'latest';
    }
  }
}
