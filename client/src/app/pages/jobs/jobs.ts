import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { AgentJob, AgentJobDetail, AgentJobs, JobStatus } from '../../core/models';
import { AutoRefresh } from '../../shared/auto-refresh';
import { AgoPipe, CellPipe, duration } from '../../shared/format';

type Filter = 'all' | 'failed' | 'running' | 'succeeded' | 'never' | 'disabled';
type SortKey = 'status' | 'name' | 'lastRunAt' | 'lastSeconds' | 'nextRunAt' | 'failed7d';

/** Default order: what needs attention first. */
const STATUS_RANK: Record<JobStatus, number> = { failed: 0, retry: 1, cancelled: 1, running: 2, succeeded: 3, never: 4 };

const STATUS_LABEL: Record<JobStatus, string> = {
  failed: 'Failed',
  retry: 'Retrying',
  cancelled: 'Cancelled',
  running: 'Running',
  succeeded: 'Succeeded',
  never: 'Never run',
};

const STATUS_CLASS: Record<JobStatus, string> = {
  failed: 'sev-error',
  retry: 'sev-warning',
  cancelled: 'sev-warning',
  running: 'sev-info',
  succeeded: 'sev-ok',
  never: 'sev-off',
};

const RUNS_SHOWN = 15;

@Component({
  selector: 'app-jobs',
  imports: [DecimalPipe, RouterLink, AgoPipe, CellPipe, AutoRefresh],
  template: `
    <div class="page-head">
      <div>
        <h1>SQL Agent jobs</h1>
        <p class="muted">
          Every SQL Server Agent job on <strong>{{ data()?.server ?? ctx.target()?.server }}</strong> with the outcome of its last run. Read
          from <span class="table-name">msdb.dbo.sysjobs</span> and <span class="table-name">sysjobhistory</span>. Nothing is changed and
          no job can be started or stopped from here.
        </p>
      </div>
      <div class="toolbar">
        <app-auto-refresh storageKey="jobs" [defaultMs]="30000" [lastUpdated]="updatedAt()" [loading]="loading()" [paused]="!!selected()" (refresh)="load(true)" />
      </div>
    </div>

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }

    @if (data(); as d) {
      @if (!d.available) {
        <section class="card setup">
          <h2>SQL Agent jobs need read access</h2>
          <p>
            The database login used by SQL Monitor can't read the job tables on <strong>{{ d.server }}</strong>:
            <span class="mono small">{{ d.reason }}</span>
          </p>
          <p>
            Ask a DBA to run this on that server. It gives read-only access to the job tables and nothing else. Alternatively, set
            <span class="mono">MSDB_USER</span> / <span class="mono">MSDB_PASSWORD</span> in <span class="mono">server/.env</span> to a login
            that already has it.
          </p>
          <pre class="script">{{ grantScript() }}</pre>
          <button type="button" class="btn" (click)="copy(grantScript())">{{ copied() ? '✓ Copied' : 'Copy script' }}</button>
        </section>
      } @else {
        <div class="retention">
          <span class="retention-tag">Data retention</span>
          <span>
            @if (d.historySince) {
              Run history on this server goes back to <strong>{{ d.historySince.slice(0, 10) }}</strong>
              ({{ d.historyRows | number }} rows).
            }
            SQL Server Agent keeps a fixed number of history rows, not a number of days, so busy jobs lose their older runs sooner.
          </span>
        </div>

        <div class="stats">
          <button type="button" class="stat stat-btn" [class.active]="filter() === 'all'" (click)="filter.set('all')">
            <div class="stat-label">Jobs</div>
            <div class="stat-value">{{ d.jobs.length }}</div>
            <div class="stat-foot">{{ counts().enabled }} enabled · {{ counts().disabled }} disabled</div>
          </button>
          <button type="button" class="stat stat-btn" [class.active]="filter() === 'failed'" [class.stat-bad]="counts().failed > 0" (click)="filter.set('failed')">
            <div class="stat-label">Last run failed</div>
            <div class="stat-value">{{ counts().failed }}</div>
            <div class="stat-foot">{{ counts().failed7d }} job(s) had a failure in 7 days</div>
          </button>
          <button type="button" class="stat stat-btn" [class.active]="filter() === 'running'" (click)="filter.set('running')">
            <div class="stat-label">Running now</div>
            <div class="stat-value">{{ d.extras ? counts().running : '—' }}</div>
            <div class="stat-foot">{{ d.extras ? (longestRunning() ?? 'nothing running') : 'no access, see note below' }}</div>
          </button>
          <button type="button" class="stat stat-btn" [class.active]="filter() === 'succeeded'" (click)="filter.set('succeeded')">
            <div class="stat-label">Last run succeeded</div>
            <div class="stat-value">{{ counts().succeeded }}</div>
            <div class="stat-foot">{{ counts().never }} never run</div>
          </button>
          <button type="button" class="stat stat-btn" [class.active]="filter() === 'disabled'" (click)="filter.set('disabled')">
            <div class="stat-label">Disabled</div>
            <div class="stat-value">{{ counts().disabled }}</div>
            <div class="stat-foot">will not run on schedule</div>
          </button>
        </div>

        <div class="sub-toolbar">
          <input
            type="search"
            placeholder="Search job, procedure, file, SQL text, owner, error…"
            [value]="search()"
            (input)="search.set($any($event.target).value)"
            style="flex: 1; max-width: 480px"
          />
          <select [value]="filter()" (change)="filter.set($any($event.target).value)" aria-label="Status">
            <option value="all" [selected]="filter() === 'all'">All jobs</option>
            <option value="failed" [selected]="filter() === 'failed'">Failed / cancelled</option>
            <option value="running" [selected]="filter() === 'running'">Running now</option>
            <option value="succeeded" [selected]="filter() === 'succeeded'">Succeeded</option>
            <option value="never" [selected]="filter() === 'never'">Never run</option>
            <option value="disabled" [selected]="filter() === 'disabled'">Disabled</option>
          </select>
          <span class="muted small">{{ rows().length }} of {{ d.jobs.length }} jobs · click a row for run history and step errors</span>
        </div>

        @if (!d.extras) {
          <div class="banner warn small">
            Running now, next run and category are not shown: the login cannot read
            <span class="mono">msdb.dbo.sysjobactivity</span> / <span class="mono">syscategories</span>.
            <button type="button" (click)="showScript.set(!showScript())">{{ showScript() ? 'Hide script' : 'Show the grant script' }}</button>
          </div>
          @if (showScript()) {
            <section class="card setup">
              <pre class="script">{{ grantScript() }}</pre>
              <button type="button" class="btn" (click)="copy(grantScript())">{{ copied() ? '✓ Copied' : 'Copy script' }}</button>
            </section>
          }
        }

        <section class="card flush">
          <div class="table-wrap tall" [class.dim]="loading() && !d.jobs.length">
            <table class="grid sql-grid jobs-grid">
              <thead>
                <tr>
                  <th class="sortable" [class.sorted]="sortKey() === 'name'" (click)="sortBy('name')">Job{{ arrow('name') }}</th>
                  <th title="Stored procedures, packages and files named in the job's steps">What it runs</th>
                  <th class="sortable" [class.sorted]="sortKey() === 'status'" (click)="sortBy('status')">Last outcome{{ arrow('status') }}</th>
                  <th class="sortable" [class.sorted]="sortKey() === 'lastRunAt'" (click)="sortBy('lastRunAt')">Last run{{ arrow('lastRunAt') }}</th>
                  <th class="sortable num" [class.sorted]="sortKey() === 'lastSeconds'" (click)="sortBy('lastSeconds')">Took{{ arrow('lastSeconds') }}</th>
                  <th class="sortable" [class.sorted]="sortKey() === 'nextRunAt'" (click)="sortBy('nextRunAt')">Next run{{ arrow('nextRunAt') }}</th>
                  <th class="sortable num" [class.sorted]="sortKey() === 'failed7d'" (click)="sortBy('failed7d')" title="Runs and failed runs in the last 7 days">
                    7 days{{ arrow('failed7d') }}
                  </th>
                  <th>Error / message</th>
                </tr>
              </thead>
              <tbody>
                @for (j of rows(); track j.jobId) {
                  <tr (click)="open(j)" [class.row-bad]="j.status === 'failed'" [class.row-warn]="j.status === 'retry' || j.status === 'cancelled'">
                    <td class="job">
                      <div class="proc">{{ j.name }}</div>
                      <div class="muted small job-sub" [title]="j.description ?? ''">
                        {{ j.category ?? '' }}{{ j.category && j.description ? ' · ' : '' }}{{ j.description ?? '' }}
                      </div>
                    </td>
                    <td class="what">
                      @for (p of j.procs.slice(0, 2); track p) {
                        <div class="what-item">{{ p }}</div>
                      }
                      @for (f of j.files.slice(0, j.procs.length ? 1 : 2); track f) {
                        <div class="what-item">{{ f }}</div>
                      }
                      @if (!j.procs.length && !j.files.length && j.preview) {
                        <div class="what-item clamp" [title]="j.preview">{{ j.preview }}</div>
                      }
                      <div class="muted small">
                        {{ j.kinds.join(', ') }}{{ more(j) ? ' · +' + more(j) + ' more' : '' }}
                      </div>
                    </td>
                    <td class="nowrap">
                      <span class="sev" [class]="statusClass(j.status)">{{ statusLabel(j.status) }}</span>
                      @if (!j.enabled) {
                        <span class="sev sev-off" title="The job is disabled: it will not run on its schedule">Disabled</span>
                      }
                      @if (j.runningSince) {
                        <div class="muted small">for {{ fmt(since(j.runningSince)) }}</div>
                      }
                    </td>
                    <td class="nowrap" [title]="j.lastRunAt ?? ''">
                      @if (j.lastRunAt) {
                        {{ j.lastRunAt | cell }}
                        <div class="muted small">{{ j.lastRunAt | ago }}</div>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num nowrap">{{ j.lastSeconds === null ? '—' : fmt(j.lastSeconds * 1000) }}</td>
                    <td class="nowrap">
                      @if (j.nextRunAt) {
                        {{ j.nextRunAt | cell }}
                      } @else {
                        <span class="muted">{{ !j.enabled ? 'disabled' : d.extras ? 'not scheduled' : '—' }}</span>
                      }
                    </td>
                    <td class="num nowrap">
                      {{ j.runs7d | number }}
                      @if (j.failed7d > 0) {
                        <div class="small neg">{{ j.failed7d | number }} failed</div>
                      }
                    </td>
                    <td class="msg">
                      @if (j.failedMessage) {
                        <div class="small"><strong>Step {{ j.failedStep }}</strong></div>
                      }
                      <div class="clamp small">{{ j.failedMessage ?? j.lastMessage }}</div>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="8" class="empty">{{ d.jobs.length ? 'No job matches this search.' : 'There are no SQL Agent jobs on this server.' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }

    @if (selected(); as j) {
      <div class="drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="drawer wide">
        <div class="drawer-head">
          <h2>{{ j.name }}</h2>
          <button type="button" class="btn" (click)="selected.set(null)">✕</button>
        </div>

        <section class="runs-box">
          <div class="runs-title">What it runs <span class="runs-kind">{{ j.kinds.join(', ') }}</span></div>
          @if (j.procs.length) {
            <div class="runs-label">Stored procedures</div>
            @for (p of j.procs; track p) {
              <div class="runs-item">{{ p }}</div>
            }
          }
          @if (j.files.length) {
            <div class="runs-label">Files, folders and packages</div>
            @for (f of j.files; track f) {
              <div class="runs-item">{{ f }}</div>
            }
          }
          @if (!j.procs.length && !j.files.length) {
            <div class="runs-label">{{ j.preview ? 'SQL / command (start)' : 'No command saved in its steps' }}</div>
            @if (j.preview) {
              <div class="runs-item">{{ j.preview }}</div>
            }
          }
        </section>

        <dl>
          <dt>Last outcome</dt>
          <dd>
            <span class="sev" [class]="statusClass(j.status)">{{ statusLabel(j.status) }}</span>
            @if (!j.enabled) {
              <span class="sev sev-off">Disabled</span>
            }
            @if (j.runningSince) {
              running since {{ j.runningSince | cell }} ({{ fmt(since(j.runningSince)) }})
            }
          </dd>
          @if (j.failedMessage) {
            <dt>Error · step {{ j.failedStep }}</dt>
            <dd class="message">{{ j.failedMessage }}</dd>
          }
          @if (j.lastMessage) {
            <dt>Job outcome message</dt>
            <dd class="message">{{ j.lastMessage }}</dd>
          }
          <dt>Last run</dt>
          <dd>{{ j.lastRunAt ? (j.lastRunAt | cell) + ' (' + (j.lastRunAt | ago) + ') · took ' + fmt((j.lastSeconds ?? 0) * 1000) : 'Never run (or its history was cleared)' }}</dd>
          <dt>Next run</dt>
          <dd>{{ j.nextRunAt ? (j.nextRunAt | cell) : !j.enabled ? 'Disabled' : 'Not scheduled' }}</dd>
          <dt>Last 7 days</dt>
          <dd>{{ j.runs7d | number }} run(s), {{ j.failed7d | number }} failed{{ j.lastFailedAt ? ' · last failure ' + (j.lastFailedAt | cell) : ' · no failure in the kept history' }}</dd>
          @if (j.description) {
            <dt>Description</dt>
            <dd>{{ j.description }}</dd>
          }
          <dt>Category · owner · last changed</dt>
          <dd>{{ j.category ?? '—' }} · {{ j.owner ?? '—' }} · {{ j.modifiedAt | cell }}</dd>
        </dl>

        <div class="drawer-actions">
          @if (j.failedMessage) {
            <button type="button" class="btn primary" (click)="copy(j.failedMessage)">{{ copied() ? '✓ Copied' : 'Copy error' }}</button>
          }
          <a class="btn" routerLink="/errors" [queryParams]="{ source: 'agent', q: j.name, range: 'all' }">All failures of this job</a>
        </div>

        @if (detailError(); as e) {
          <div class="banner error">{{ e }}</div>
        }

        <h3>Recent runs</h3>
        @if (detail(); as dt) {
          @for (r of shownRuns(); track $index) {
            <div class="dl-process" [class.victim]="r.status === 'failed'">
              <div class="dl-title">
                <span class="sev" [class]="statusClass(r.status)">{{ statusLabel(r.status) }}</span>
                <span class="mono">{{ r.at | cell }}</span>
                <span class="muted">{{ r.at | ago }}{{ r.seconds === null ? '' : ' · took ' + fmt(r.seconds * 1000) }}</span>
              </div>
              @for (s of r.steps; track $index) {
                <div class="run-step">
                  <span class="sev" [class]="statusClass(s.status)">{{ statusLabel(s.status) }}</span>
                  <strong>{{ s.stepId }} · {{ s.stepName }}</strong>
                  <span class="muted small">
                    {{ fmt(s.seconds * 1000) }}{{ s.retries ? ' · ' + s.retries + ' retries' : '' }}{{ s.sqlMessageId ? ' · Msg ' + s.sqlMessageId + ', severity ' + s.sqlSeverity : '' }}
                  </span>
                  @if (s.message) {
                    <div class="run-msg" [class.clamp]="s.status === 'succeeded'" [title]="s.status === 'succeeded' ? s.message : ''">{{ s.message }}</div>
                  }
                </div>
              } @empty {
                <div class="run-msg">{{ r.message ?? 'No step detail kept for this run.' }}</div>
              }
            </div>
          } @empty {
            <p class="muted">No run history is kept for this job.</p>
          }
          @if (dt.runs.length > shownRuns().length) {
            <button type="button" class="btn" (click)="allRuns.set(true)">Show all {{ dt.runs.length }} runs</button>
          }
          <p class="muted small">
            SQL Server Agent keeps a limited history (by default 100 rows per job and 1000 in total), so older runs disappear.
          </p>

          <h3>Steps ({{ dt.steps.length }}) · what each one runs</h3>
          <p class="muted small">
            The exact command saved in each step. Procedures and files are read from that text, so anything a procedure or package does
            inside itself is not listed here.
          </p>
          @for (s of dt.steps; track s.stepId) {
            <dl class="job-step">
              <dt>{{ s.stepId }} · {{ s.name }} <span class="muted">— {{ s.kind }}{{ s.db ? ' on ' + s.db : '' }}</span></dt>
              @if (s.procs.length) {
                <dd><span class="muted">Procedure:</span> {{ s.procs.join(', ') }}</dd>
              }
              @for (f of s.files; track f) {
                <dd><span class="muted">File:</span> {{ f }}</dd>
              }
              @if (s.outputFile) {
                <dd><span class="muted">Writes its log to:</span> {{ s.outputFile }}</dd>
              }
              <dd class="sql">{{ s.command }}</dd>
              <button type="button" class="btn small" (click)="copy(s.command ?? '')">Copy command</button>
            </dl>
          }
        } @else if (!detailError()) {
          <p class="muted">Loading…</p>
        }
      </aside>
    }
  `,
})
export class Jobs {
  private readonly api = inject(ApiService);
  protected readonly ctx = inject(ContextService);

  protected readonly data = signal<AgentJobs | null>(null);
  protected readonly grantScript = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly updatedAt = signal<Date | null>(null);

  protected readonly search = signal('');
  protected readonly filter = signal<Filter>('all');
  protected readonly sortKey = signal<SortKey>('status');
  protected readonly sortDesc = signal(false);

  protected readonly selected = signal<AgentJob | null>(null);
  protected readonly detail = signal<AgentJobDetail | null>(null);
  protected readonly detailError = signal<string | null>(null);
  protected readonly allRuns = signal(false);
  protected readonly showScript = signal(false);
  protected readonly copied = signal(false);

  protected readonly fmt = duration;

  protected readonly counts = computed(() => {
    const jobs = this.data()?.jobs ?? [];
    return {
      enabled: jobs.filter((j) => j.enabled).length,
      disabled: jobs.filter((j) => !j.enabled).length,
      failed: jobs.filter((j) => this.matches(j, 'failed')).length,
      failed7d: jobs.filter((j) => j.failed7d > 0).length,
      running: jobs.filter((j) => j.status === 'running').length,
      succeeded: jobs.filter((j) => j.status === 'succeeded').length,
      never: jobs.filter((j) => j.status === 'never').length,
    };
  });

  protected readonly longestRunning = computed(() => {
    const running = (this.data()?.jobs ?? []).filter((j) => j.runningSince);
    if (!running.length) return null;
    const j = running.reduce((a, b) => (a.runningSince! < b.runningSince! ? a : b));
    return `${j.name} · ${duration(this.since(j.runningSince))}`;
  });

  protected readonly rows = computed(() => {
    const f = this.search().trim().toLowerCase();
    const filter = this.filter();
    const key = this.sortKey();
    const dir = this.sortDesc() ? -1 : 1;
    return (this.data()?.jobs ?? [])
      .filter((j) => this.matches(j, filter))
      .filter(
        (j) =>
          !f ||
          [j.name, j.description, j.category, j.owner, j.failedStep, j.failedMessage, j.lastMessage, j.commandText, ...j.procs, ...j.files].some((v) => v?.toLowerCase().includes(f)),
      )
      .sort((a, b) => dir * this.compare(a, b, key) || a.name.localeCompare(b.name));
  });

  protected readonly shownRuns = computed(() => {
    const runs = this.detail()?.runs ?? [];
    return this.allRuns() ? runs : runs.slice(0, RUNS_SHOWN);
  });

  constructor() {
    effect(() => {
      this.ctx.key();
      if (!this.ctx.ready()) return;
      untracked(() => {
        this.selected.set(null);
        this.data.set(null);
        this.load();
      });
    });
  }

  load(refresh = false): void {
    this.loading.set(true);
    this.api.jobs(refresh).subscribe({
      next: (r) => {
        this.data.set(r.result);
        this.grantScript.set(r.grantScript);
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

  open(j: AgentJob): void {
    this.selected.set(j);
    this.detail.set(null);
    this.detailError.set(null);
    this.allRuns.set(false);
    this.api.job(j.jobId).subscribe({
      next: (d) => {
        if (this.selected() === j) this.detail.set(d);
      },
      error: (err) => {
        if (this.selected() === j) this.detailError.set(errorMessage(err));
      },
    });
  }

  sortBy(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDesc.update((d) => !d);
    } else {
      this.sortKey.set(key);
      // Times, durations and failure counts are most useful largest first.
      this.sortDesc.set(key === 'lastRunAt' || key === 'lastSeconds' || key === 'failed7d');
    }
  }

  protected arrow(key: SortKey): string {
    return this.sortKey() === key ? (this.sortDesc() ? ' ▼' : ' ▲') : '';
  }

  /** Procedures and files not shown in the row. */
  protected more(j: AgentJob): number {
    const procs = Math.min(2, j.procs.length);
    const files = Math.min(j.procs.length ? 1 : 2, j.files.length);
    return j.procs.length + j.files.length - procs - files;
  }

  protected statusLabel(s: JobStatus): string {
    return STATUS_LABEL[s] ?? s;
  }

  protected statusClass(s: JobStatus): string {
    return STATUS_CLASS[s] ?? 'sev-off';
  }

  /** Milliseconds since a database time. The database clock is taken to match this computer's. */
  protected since(at: string | null): number {
    return at ? Math.max(0, Date.now() - new Date(at.replace(' ', 'T')).getTime()) : 0;
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

  private matches(j: AgentJob, filter: Filter): boolean {
    switch (filter) {
      case 'failed':
        return j.status === 'failed' || j.status === 'cancelled' || j.status === 'retry';
      case 'disabled':
        return !j.enabled;
      case 'all':
        return true;
      default:
        return j.status === filter;
    }
  }

  private compare(a: AgentJob, b: AgentJob, key: SortKey): number {
    switch (key) {
      case 'name':
        return 0;
      case 'status':
        return STATUS_RANK[a.status] - STATUS_RANK[b.status] || Number(b.enabled) - Number(a.enabled);
      case 'lastSeconds':
        return (a.lastSeconds ?? -1) - (b.lastSeconds ?? -1);
      case 'failed7d':
        return a.failed7d - b.failed7d || a.runs7d - b.runs7d;
      default:
        return (a[key] ?? '').localeCompare(b[key] ?? '');
    }
  }
}
