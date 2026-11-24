import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { AuditEvent, HistoryStatus, SampledActivity, SqlScope } from '../../core/models';
import { DateRange, RangeChange, RangeKey, resolveRange } from '../../shared/date-range';
import { AgoPipe, actionClass, duration } from '../../shared/format';
import { Pager } from '../../shared/pager';

export type HistoryKind = 'sampled' | 'audit';

type Selected = { kind: 'sampled'; row: SampledActivity } | { kind: 'audit'; row: AuditEvent };

/**
 * Saved activity history, two flavours sharing one layout:
 *  - sampled: what the server-side sampler saw in "Running now" (incomplete: fast statements are missed)
 *  - audit:   SQL Server Audit records (complete, once a DBA has set the audit up)
 */
@Component({
  selector: 'app-sql-history',
  imports: [DecimalPipe, AgoPipe, DateRange, Pager],
  template: `
    @if (status(); as s) {
      @if (kind() === 'sampled') {
        @if (!s.sampler.enabled) {
          <div class="banner warn">
            History is not being recorded for <strong>{{ s.server }}</strong>. Add it to <span class="mono">HISTORY_SERVERS</span> in
            <span class="mono">server/.env</span> and restart the server.
          </div>
        } @else if (s.sampler.lastError) {
          <div class="banner error">Sampler error: {{ s.sampler.lastError }}</div>
        }
        <p class="muted small">
          <strong>Sampled, not complete.</strong> The server looks at "Running now" every {{ s.sampler.intervalMs / 1000 | number: '1.0-1' }} s and
          saves what it sees, so statements that finish faster than that are usually missing. Use Audit history for the full record.
          {{ s.totals.sampledRows | number }} rows saved{{ s.totals.sampledOldest ? ' since ' + s.totals.sampledOldest.slice(0, 16) : '' }}, kept
          {{ s.retentionDays }} days.
        </p>
      } @else {
        @if (!s.audit.enabled) {
          <div class="banner warn">
            Audit records are not being read for <strong>{{ s.server }}</strong>. Add it to <span class="mono">HISTORY_SERVERS</span> in
            <span class="mono">server/.env</span> and restart the server.
          </div>
        } @else if (s.audit.lastError) {
          <div class="banner error">Cannot read the audit: {{ s.audit.lastError }}</div>
        } @else if (s.audit.found && s.audit.auditEnabled === false) {
          <div class="banner warn">The audit <span class="mono">{{ s.audit.auditName }}</span> exists on {{ s.server }} but is switched off.</div>
        }
        @if (s.audit.found) {
          <p class="muted small">
            Every INSERT / UPDATE / DELETE / EXECUTE recorded by the SQL Server Audit <span class="mono">{{ s.audit.auditName }}</span>.
            {{ s.totals.auditRows | number }} records saved{{ s.totals.auditOldest ? ' since ' + s.totals.auditOldest.slice(0, 16) : '' }}, kept
            {{ s.retentionDays }} days{{ s.audit.lastReadAt ? '. Last read ' + s.audit.lastReadAt.slice(11, 19) : '' }}.
          </p>
        }
        @if (s.audit.enabled && s.audit.found !== true) {
          <section class="card">
            <div class="card-head"><strong>Audit not set up on {{ s.server }}</strong></div>
            <p class="muted">
              The complete record of who changed what comes from a SQL Server Audit named
              <span class="mono">{{ s.audit.auditName }}</span>. NAY-Monitor never creates it: a DBA runs the script below once. It is written for
              the database selected in the header ({{ ctx.target()?.database }}); change the folder first. NAY-Monitor rechecks every 5 minutes.
            </p>
            <pre class="script">{{ s.auditSetupScript }}</pre>
            <button type="button" class="btn" (click)="copy(s.auditSetupScript)">{{ copied() ? '✓ Copied' : 'Copy script' }}</button>
          </section>
        }
      }
    }

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }

    <section class="card range-bar">
      <app-date-range [range]="range()" [from]="from()" [to]="to()" (rangeChange)="setRange($event)" />
    </section>

    <div class="sub-toolbar">
      <input
        type="search"
        [placeholder]="kind() === 'sampled' ? 'Search login, host, app, table, procedure, SQL…' : 'Search login, host, app, table / procedure, SQL…'"
        [value]="search()"
        (input)="onSearch($any($event.target).value)"
      />
      <select [value]="action()" (change)="action.set($any($event.target).value); page.set(1)" aria-label="Action">
        <option value="">All actions</option>
        @for (a of actions(); track a) {
          <option [value]="a" [selected]="action() === a">{{ a }}</option>
        }
      </select>
      <button type="button" class="btn" (click)="reload()" [disabled]="loading()">{{ loading() ? 'Loading…' : 'Refresh' }}</button>
    </div>

    <section class="card flush">
      <div class="table-wrap">
        <table class="grid sql-grid">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              @if (kind() === 'sampled') {
                <th>Procedure / statement</th>
                <th>Tables (best effort)</th>
              } @else {
                <th>Table / procedure</th>
                <th>Statement</th>
              }
              <th>Database</th>
              @if (kind() === 'sampled') {
                <th class="num">Ran for</th>
              }
              <th>Who</th>
            </tr>
          </thead>
          <tbody>
            @if (kind() === 'sampled') {
              @for (r of sampled(); track r.id) {
                <tr (click)="selected.set({ kind: 'sampled', row: r })">
                  <td class="nowrap">{{ r.firstSeen.slice(0, 19) }}<div class="muted small">{{ r.firstSeen | ago }}</div></td>
                  <td><span class="tag" [class]="actionClass(r.action)">{{ r.action }}</span></td>
                  <td class="stmt">
                    @if (r.procName) {
                      <div class="proc">{{ r.procName }}</div>
                    } @else {
                      <div class="proc muted">(ad hoc)</div>
                    }
                    <div class="clamp mono small">{{ oneLine(r.statement) }}</div>
                  </td>
                  <td class="mono small who">{{ r.tables ?? '—' }}</td>
                  <td>{{ r.db }}</td>
                  <td class="num nowrap">{{ fmt(r.elapsedMs) }}</td>
                  <td class="who">
                    <div class="ellipsis">{{ r.jobName ? 'Agent job: ' + r.jobName : r.programName }}</div>
                    <div class="muted small ellipsis">{{ r.loginName }}{{ r.hostName ? ' @ ' + r.hostName : '' }}</div>
                  </td>
                </tr>
              }
            } @else {
              @for (r of audit(); track r.id) {
                <tr (click)="selected.set({ kind: 'audit', row: r })" [class.row-bad]="!r.succeeded">
                  <td class="nowrap">{{ r.eventTime.slice(0, 19) }}<div class="muted small">{{ r.eventTime | ago }}</div></td>
                  <td>
                    <span class="tag" [class]="actionClass(r.action)">{{ r.action }}</span>
                    @if (!r.succeeded) {
                      <div><span class="sev sev-error">denied / failed</span></div>
                    }
                  </td>
                  <td class="mono small">{{ objectLabel(r) }}</td>
                  <td class="stmt"><div class="clamp mono small">{{ oneLine(r.statement) }}</div></td>
                  <td>{{ r.db }}</td>
                  <td class="who">
                    <div class="ellipsis">{{ r.loginName ?? r.sessionLogin }}</div>
                    <div class="muted small ellipsis">{{ auditFrom(r) }}</div>
                  </td>
                </tr>
              }
            }
            @if (total() === 0) {
              <tr>
                <td [attr.colspan]="kind() === 'sampled' ? 7 : 6" class="empty">{{ loading() ? 'Loading…' : 'Nothing recorded for this filter.' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <app-pager [page]="page()" [pageSize]="pageSize()" [total]="total()" [sizes]="[25, 50, 100, 200]" (pageChange)="page.set($event)" (pageSizeChange)="pageSize.set($event); page.set(1)" />
    </section>

    @if (selected(); as s) {
      <div class="drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <h2>{{ s.row.action }} · {{ (s.kind === 'sampled' ? s.row.firstSeen : s.row.eventTime).slice(0, 19) }}</h2>
          <button type="button" class="btn" (click)="selected.set(null)">✕</button>
        </div>
        @if (s.kind === 'sampled') {
          <dl>
            <dt>Procedure</dt><dd>{{ s.row.procName ?? '(ad hoc ' + (s.row.command ?? '') + ')' }}</dd>
            <dt>Tables named in the statement (best effort)</dt><dd>{{ s.row.tables ?? '—' }}</dd>
            <dt>Database</dt><dd>{{ s.row.db }}</dd>
            <dt>Seen</dt>
            <dd>{{ s.row.samples | number }} time(s), {{ s.row.firstSeen }} → {{ s.row.lastSeen.slice(11) }} (request started {{ s.row.requestStart ?? '—' }})</dd>
            <dt>Request at last sighting: ran for / CPU / reads / writes / rows</dt>
            <dd>{{ fmt(s.row.elapsedMs) }} · {{ fmt(s.row.cpuMs) }} · {{ s.row.logicalReads | number }} · {{ s.row.writes | number }} · {{ s.row.rowsAffected | number }}</dd>
            <dt>Who</dt>
            <dd>{{ s.row.jobName ? 'Agent job: ' + s.row.jobName + '\n' : '' }}{{ s.row.programName }}
{{ s.row.loginName }}{{ s.row.hostName ? ' @ ' + s.row.hostName : '' }}{{ s.row.clientAddress ? ' (' + s.row.clientAddress + ')' : '' }} · session {{ s.row.sessionId }}</dd>
            <dt>Statement</dt><dd class="sql">{{ s.row.statement }}</dd>
          </dl>
        } @else {
          <dl>
            <dt>Table / procedure</dt><dd>{{ objectLabel(s.row) }}</dd>
            <dt>Database</dt><dd>{{ s.row.db }}</dd>
            <dt>Result</dt><dd>{{ s.row.succeeded ? 'Allowed' : 'Denied / failed permission check' }}</dd>
            <dt>Login</dt>
            <dd>{{ s.row.loginName ?? '—' }}{{ s.row.sessionLogin && s.row.sessionLogin !== s.row.loginName ? ' (session login ' + s.row.sessionLogin + ')' : '' }} · database user {{ s.row.dbUser ?? '—' }}</dd>
            <dt>From</dt><dd>{{ auditFrom(s.row) || '—' }} · session {{ s.row.sessionId }}</dd>
            <dt>Statement</dt><dd class="sql">{{ s.row.statement }}</dd>
          </dl>
        }
        <div class="drawer-actions">
          <button type="button" class="btn primary" (click)="copy(s.row.statement ?? '')">{{ copied() ? '✓ Copied' : 'Copy statement' }}</button>
        </div>
      </aside>
    }
  `,
})
export class SqlHistory {
  private readonly api = inject(ApiService);
  protected readonly ctx = inject(ContextService);

  readonly kind = input.required<HistoryKind>();
  readonly scope = input.required<SqlScope>();

  protected readonly status = signal<HistoryStatus | null>(null);
  protected readonly sampled = signal<SampledActivity[]>([]);
  protected readonly audit = signal<AuditEvent[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly selected = signal<Selected | null>(null);
  protected readonly copied = signal(false);

  protected readonly range = signal<RangeKey>('24h');
  protected readonly from = signal<string | null>(null);
  protected readonly to = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly action = signal('');
  protected readonly page = signal(1);
  protected readonly pageSize = signal(50);
  private readonly tick = signal(0);

  protected readonly actions = computed(() =>
    this.kind() === 'sampled'
      ? ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'SELECT', 'EXECUTE', 'TRUNCATE', 'DDL', 'OTHER']
      : ['INSERT', 'UPDATE', 'DELETE', 'EXECUTE'],
  );

  protected readonly fmt = duration;
  protected readonly actionClass = actionClass;

  private requestId = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // A different log, database or scope starts again from page 1.
    effect(() => {
      this.kind();
      this.scope();
      this.ctx.key();
      untracked(() => {
        this.page.set(1);
        this.action.set('');
        this.selected.set(null);
        this.sampled.set([]);
        this.audit.set([]);
        this.total.set(0);
      });
    });
    effect(() => {
      const kind = this.kind();
      const query = {
        scope: this.scope(),
        ...resolveRange(this.range(), this.from(), this.to()),
        action: this.action() || undefined,
        search: this.search().trim() || undefined,
        page: this.page(),
        pageSize: this.pageSize(),
      };
      this.ctx.key();
      this.tick();
      if (!this.ctx.ready()) return;
      untracked(() => this.load(kind, query));
    });
  }

  private load(kind: HistoryKind, query: Parameters<ApiService['historySampled']>[0]): void {
    const id = ++this.requestId;
    this.loading.set(true);
    this.api.historyStatus().subscribe({ next: (s) => id === this.requestId && this.status.set(s), error: () => undefined });
    const done = (total: number) => {
      this.total.set(total);
      this.error.set(null);
      this.loading.set(false);
    };
    const fail = (err: unknown) => {
      if (id !== this.requestId) return;
      this.error.set(errorMessage(err));
      this.loading.set(false);
    };
    if (kind === 'sampled') {
      this.api.historySampled(query).subscribe({
        next: (r) => {
          if (id !== this.requestId) return;
          this.sampled.set(r.rows);
          done(r.total);
        },
        error: fail,
      });
    } else {
      this.api.historyAudit(query).subscribe({
        next: (r) => {
          if (id !== this.requestId) return;
          this.audit.set(r.rows);
          done(r.total);
        },
        error: fail,
      });
    }
  }

  reload(): void {
    this.tick.update((n) => n + 1);
  }

  setRange(c: RangeChange): void {
    this.range.set(c.range);
    this.from.set(c.from);
    this.to.set(c.to);
    this.page.set(1);
  }

  onSearch(v: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.search.set(v);
      this.page.set(1);
    }, 350);
  }

  objectLabel(r: AuditEvent): string {
    return [r.schemaName, r.objectName].filter(Boolean).join('.') || '—';
  }

  /** Host, IP and application of an audit record (only recorded by newer SQL Server versions). */
  auditFrom(r: AuditEvent): string {
    return [r.hostName, r.clientIp && r.clientIp !== r.hostName ? r.clientIp : null, r.programName].filter(Boolean).join(' · ');
  }

  oneLine(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
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
}
