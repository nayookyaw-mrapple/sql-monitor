import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { AuditEvent, HistoryQuery, HistoryStatus, SampledActivity, SqlScope } from '../../core/models';
import { DateRange, RangeChange, RangeKey, resolveRange } from '../../shared/date-range';
import { AgoPipe, actionClass, duration } from '../../shared/format';
import { Pager } from '../../shared/pager';
import { HistoryExport } from './history-export';
import { ExportInfo } from './history-export-files';

export type HistoryKind = 'sampled' | 'audit';

type Selected = { kind: 'sampled'; row: SampledActivity } | { kind: 'audit'; row: AuditEvent };

/**
 * Saved activity history, two flavours sharing one layout:
 *  - sampled: what the server-side sampler saw in "Running now" (incomplete: fast statements are missed)
 *  - audit:   SQL Server Audit records (complete, once a DBA has set the audit up)
 */
@Component({
  selector: 'app-sql-history',
  imports: [DecimalPipe, AgoPipe, DateRange, Pager, HistoryExport],
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
          <strong>Sampled, not complete.</strong> Every {{ s.sampler.intervalMs / 1000 | number: '1.0-1' }} s the server saves what is running, plus the
          last batch each connected session finished since the previous look. Several quick queries from one session within that time
          keep only the last one. Use Audit history for the full record.
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
              <span class="mono">{{ s.audit.auditName }}</span>. SQL Monitor never creates it: a DBA runs the script below once. It is written for
              the database selected in the header ({{ ctx.target()?.database }}); change the folder first. SQL Monitor rechecks every 5 minutes.
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
        [placeholder]="kind() === 'sampled' ? 'Search table, procedure, SQL…' : 'Search table / procedure, SQL…'"
        [value]="search()"
        (input)="onSearch($any($event.target).value)"
      />
      <select [value]="action()" (change)="action.set($any($event.target).value); page.set(1)" aria-label="Action">
        <option value="">All actions</option>
        @for (a of actions(); track a) {
          <option [value]="a" [selected]="action() === a">{{ a }}</option>
        }
      </select>
      <input
        type="search"
        class="who-search"
        placeholder="Who: login, host, app, job…"
        title="Searches only the Who column: login, host, application, Agent job and client address"
        [value]="who()"
        (input)="onWho($any($event.target).value)"
      />
      <select [value]="whoType()" (change)="whoType.set($any($event.target).value); page.set(1)" aria-label="Who type" title="Filter by the kind of login">
        <option value="" [selected]="whoType() === ''">Everyone</option>
        <option value="user" [selected]="whoType() === 'user'">Users (MRA\\…)</option>
        <option value="agent" [selected]="whoType() === 'agent'">Agent jobs</option>
        <option value="maui" [selected]="whoType() === 'maui'">MAUI (Core Microsoft SqlClient)</option>
        <option value="other" [selected]="whoType() === 'other'">Other logins</option>
      </select>
      <select [value]="loginChoice()" (change)="setLoginChoice($any($event.target).value)" aria-label="Domain user" title="Pick one domain user, or hide a busy one such as a label printer account">
        <option value="" [selected]="loginChoice() === ''">All domain users</option>
        <optgroup label="Show only">
          @for (l of logins(); track l.login) {
            <option [value]="'only:' + l.login" [selected]="loginChoice() === 'only:' + l.login">{{ l.login }} ({{ l.rows | number }})</option>
          }
        </optgroup>
        <optgroup label="Domain users except">
          @for (l of logins(); track l.login) {
            <option [value]="'not:' + l.login" [selected]="loginChoice() === 'not:' + l.login">Everyone except {{ l.login }}</option>
          }
        </optgroup>
      </select>
      <select [value]="app()" (change)="app.set($any($event.target).value); page.set(1)" aria-label="App" title="Show only one application: a service (from its pod name), SQL Agent, or a client program">
        <option value="" [selected]="app() === ''">All apps</option>
        @for (a of apps(); track a.app) {
          <option [value]="a.app" [selected]="app() === a.app">{{ a.app }} ({{ a.rows | number }})</option>
        }
      </select>
      @if (kind() === 'sampled') {
        <select [value]="capture()" (change)="capture.set($any($event.target).value); page.set(1)" aria-label="How it was captured" title="Seen running = caught while executing. After it finished = a quick query picked up from the session afterwards.">
          <option value="" [selected]="capture() === ''">Running + finished</option>
          <option value="running" [selected]="capture() === 'running'">Seen running</option>
          <option value="last" [selected]="capture() === 'last'">After it finished</option>
        </select>
      }
      <button type="button" class="btn" (click)="reload()" [disabled]="loading()">{{ loading() ? 'Loading…' : 'Refresh' }}</button>
      <button type="button" class="btn" (click)="openExport()" [disabled]="total() === 0" title="Export every row matching these filters to Excel or PDF, with a preview first">Export…</button>
      <button type="button" class="btn info-btn" (click)="guide.set(true)" title="What the columns, labels and filters mean" aria-label="Guide">ⓘ Guide</button>
    </div>

    <section class="card flush">
      <div class="table-wrap">
        <table class="grid sql-grid">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Who</th>
              <th>App</th>
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
            </tr>
          </thead>
          <tbody>
            @if (kind() === 'sampled') {
              @for (r of sampled(); track r.id) {
                <tr (click)="selected.set({ kind: 'sampled', row: r })">
                  <td class="nowrap">{{ r.firstSeen.slice(0, 19) }}<div class="muted small">{{ r.firstSeen | ago }}</div></td>
                  <td>
                    <span class="tag" [class]="actionClass(r.action)">{{ r.action }}</span>
                    @if (r.capture === 'last') {
                      <div class="muted small" title="Too quick to be seen running: this is the last batch the session had finished when the sampler looked. Repeats of the same batch by the same login, host and app within the hour are counted on one row.">after it finished{{ r.samples > 1 ? ' · ×' + r.samples : '' }}</div>
                    }
                  </td>
                  <td class="who">
                    <div class="who-login ellipsis">{{ r.loginName }}{{ r.hostName ? ' @ ' + r.hostName : '' }}</div>
                    <div class="muted small ellipsis">{{ r.jobName ? 'Agent job: ' + r.jobName : r.programName }}</div>
                  </td>
                  <td class="app" [title]="r.app ?? ''">{{ r.app ?? '—' }}</td>
                  <td class="stmt">
                    @if (r.procName) {
                      <div class="proc">{{ r.procName }}</div>
                    } @else {
                      <div class="proc muted" title="This SQL was sent directly, not run from inside a stored procedure">Direct SQL (no procedure)</div>
                    }
                    <div class="clamp mono small">{{ oneLine(r.statement) }}</div>
                  </td>
                  <td class="mono small who">{{ r.tables ?? '—' }}</td>
                  <td>{{ r.db }}</td>
                  <td class="num nowrap">{{ fmt(r.elapsedMs) }}</td>
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
                  <td class="who">
                    <div class="who-login ellipsis">{{ r.loginName ?? r.sessionLogin }}</div>
                    <div class="muted small ellipsis">{{ auditFrom(r) }}</div>
                  </td>
                  <td class="app" [title]="r.app ?? ''">{{ r.app ?? '—' }}</td>
                  <td class="mono small">{{ objectLabel(r) }}</td>
                  <td class="stmt"><div class="clamp mono small">{{ oneLine(r.statement) }}</div></td>
                  <td>{{ r.db }}</td>
                </tr>
              }
            }
            @if (total() === 0) {
              <tr>
                <td [attr.colspan]="kind() === 'sampled' ? 8 : 7" class="empty">{{ loading() ? 'Loading…' : 'Nothing recorded for this filter.' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <app-pager [page]="page()" [pageSize]="pageSize()" [total]="total()" [sizes]="[25, 50, 100, 200]" (pageChange)="page.set($event)" (pageSizeChange)="pageSize.set($event); page.set(1)" />
    </section>

    @if (guide()) {
      <div class="drawer-backdrop" (click)="guide.set(false)"></div>
      <aside class="drawer guide">
        <div class="drawer-head">
          <h2>Guide · {{ kind() === 'sampled' ? 'History (sampled)' : 'Audit history' }}</h2>
          <button type="button" class="btn" (click)="guide.set(false)">✕</button>
        </div>

        @if (kind() === 'sampled') {
          <p>
            A record of what ran on the server and who ran it, saved every few seconds. It is a <strong>sample</strong>: good for seeing who is
            doing what, but not a guaranteed record of every statement.
          </p>

          <h3>Action</h3>
          <dl>
            <dt><span class="tag tag-insert">INSERT</span> <span class="tag tag-update">UPDATE</span> <span class="tag tag-delete">DELETE</span> <span class="tag tag-other">MERGE</span></dt>
            <dd>Data was added, changed or removed. MERGE does a mix of the three in one statement.</dd>
            <dt><span class="tag tag-select">SELECT</span></dt>
            <dd>Data was only read. Nothing changed.</dd>
            <dt><span class="tag tag-other">EXECUTE</span></dt>
            <dd>
              A stored procedure was called. On an "after it finished" row only the procedure's name is known, not what it did inside. When the
              same procedure is caught while running, its rows show the actual INSERT / UPDATE / SELECT inside it.
            </dd>
            <dt><span class="tag tag-other">TRUNCATE</span></dt>
            <dd>A whole table was emptied.</dd>
            <dt><span class="tag tag-other">DDL</span></dt>
            <dd>The structure was changed: a table, procedure, view or index was created, altered or dropped.</dd>
            <dt><span class="tag tag-other">OTHER</span></dt>
            <dd>Anything else, such as setting a variable, a condition (IF), or waiting.</dd>
          </dl>

          <h3>How a row was captured</h3>
          <dl>
            <dt>No extra line under the action</dt>
            <dd>
              <strong>Seen running.</strong> The statement was executing at the moment the server looked. These rows have the exact statement,
              how long the request had been running, CPU and reads.
            </dd>
            <dt>after it finished</dt>
            <dd>
              The query was too quick to be seen running, so it was picked up afterwards from the session that ran it. The row shows the whole
              batch the session sent (or just the procedure name) and how long it took. CPU and reads are not available.
            </dd>
            <dt>×N (for example ×12)</dt>
            <dd>
              The same SQL from the same login, computer and application was seen N times within that clock hour. It is kept as one row so that
              an application repeating a query every few seconds does not flood the list. Click the row for the first and last time.
            </dd>
          </dl>

          <h3>Columns</h3>
          <dl>
            <dt>When</dt>
            <dd>When it was first seen running, or when it finished. Times are the SQL Server's local time.</dd>
            <dt>Who</dt>
            <dd>
              First line: the login, then &#64; the computer it connected from. Second line: the application name the client gave, or the SQL
              Agent job name. For applications and jobs the login is a shared service account, not a person.
            </dd>
            <dt>App</dt>
            <dd>
              Which application the row came from. For a service running in Kubernetes it is the service name, taken from the pod it
              connected from: <span class="mono">transfer-api-58b56785cc-hn82t</span> becomes <span class="mono">transfer-api</span>, so the
              name stays the same across deploys. Agent job steps show <strong>SQL Agent</strong>. Anything else shows the application
              name the program gave SQL Server, which is only as good as what that program sends. A dash means the program did not say
              what it is: it only sent settings such as <span class="mono">siteId=3&amp;season=2026</span>, which stay visible under Who.
            </dd>
            <dt>Procedure / statement</dt>
            <dd>
              A name in bold is the stored procedure the statement belongs to. <strong>Direct SQL (no procedure)</strong> means the SQL was sent
              as plain text, for example typed in SSMS, written directly in an Agent job step, or built by an application.
            </dd>
            <dt>Tables (best effort)</dt>
            <dd>
              Table names found by reading the SQL text, the changed table first. It can include views or functions, and cannot see inside
              dynamic SQL or a procedure called from the statement. Names starting with # are temporary tables.
            </dd>
            <dt>Ran for</dt>
            <dd>Seen running: how long the request had run when last seen. After it finished: how long it took.</dd>
          </dl>

          <h3>Filters</h3>
          <dl>
            <dt>Search / Who</dt>
            <dd>The first box searches everything, including the SQL. The Who box searches only login, computer, application and job name.</dd>
            <dt>Login type</dt>
            <dd>
              <strong>Users</strong>: Windows domain logins such as MRA\\name. <strong>Agent jobs</strong>: scheduled SQL Agent jobs.
              <strong>MAUI</strong>: the MAUI services (application name "Core Microsoft SqlClient Data Provider").
              <strong>Other logins</strong>: everything that is not a domain user or an Agent job.
            </dd>
            <dt>All domain users</dt>
            <dd>Pick one domain login to see only that person, or "Everyone except…" to hide a busy account such as a label printer.</dd>
            <dt>All apps</dt>
            <dd>Pick one application to see only what it ran. The number is how many saved rows it has.</dd>
            <dt>Running + finished</dt>
            <dd>Show only rows seen running, or only rows captured after they finished.</dd>
          </dl>

          <h3>What can be missing</h3>
          <ul>
            <li>Several quick queries from one session within a few seconds: only the last one is kept.</li>
            <li>A program that connects, runs one quick query and disconnects straight away.</li>
            <li>The values that were changed. For those, look at the history tables (Latest changes page).</li>
            <li>Queries made by SQL Monitor itself are left out on purpose.</li>
          </ul>
          <p>For a complete record of every change, use the Audit history tab once the audit has been set up.</p>
        } @else {
          <p>
            Records written by SQL Server Audit: a <strong>complete</strong> list of every INSERT, UPDATE, DELETE and procedure call on the audited
            databases, however quick. It only has data once a DBA has set the audit up on the server.
          </p>

          <h3>Action</h3>
          <dl>
            <dt><span class="tag tag-insert">INSERT</span> <span class="tag tag-update">UPDATE</span> <span class="tag tag-delete">DELETE</span></dt>
            <dd>Data in the named table was added, changed or removed. One statement that touches two tables gives two records.</dd>
            <dt><span class="tag tag-other">EXECUTE</span></dt>
            <dd>The named stored procedure or function was called. The changes it made inside appear as their own records.</dd>
            <dt><span class="sev sev-error">denied / failed</span></dt>
            <dd>The login tried the action but did not have permission. Rows without this label were allowed.</dd>
          </dl>

          <h3>Columns</h3>
          <dl>
            <dt>When</dt>
            <dd>When SQL Server recorded the action, in the server's local time.</dd>
            <dt>Who</dt>
            <dd>
              First line: the login. Second line: the computer, IP address and application, where the SQL Server version records them. For
              applications and jobs the login is a shared service account, not a person.
            </dd>
            <dt>App</dt>
            <dd>
              Which application the record came from: the service name (taken from the pod it connected from), <strong>SQL Agent</strong>, or
              the application name the program gave. A dash when the program only sent settings such as
              <span class="mono">SiteID=6</span>, or when the SQL Server version does not record the computer and application.
            </dd>
            <dt>Table / procedure</dt>
            <dd>The object the action was on. This comes from SQL Server itself, so it is exact.</dd>
            <dt>Statement</dt>
            <dd>The SQL that caused the record.</dd>
          </dl>

          <h3>Filters</h3>
          <dl>
            <dt>Search / Who</dt>
            <dd>The first box searches everything, including the SQL. The Who box searches only login, computer and application.</dd>
            <dt>Login type</dt>
            <dd>
              <strong>Users</strong>: Windows domain logins such as MRA\\name. <strong>Agent jobs</strong>: scheduled SQL Agent jobs.
              <strong>MAUI</strong>: the MAUI services. <strong>Other logins</strong>: everything that is not a domain user or an Agent job.
            </dd>
            <dt>All domain users</dt>
            <dd>Pick one domain login to see only that person, or "Everyone except…" to hide a busy account.</dd>
            <dt>All apps</dt>
            <dd>Pick one application to see only what it ran. The number is how many saved rows it has.</dd>
          </dl>

          <h3>What it does not show</h3>
          <ul>
            <li>Reads (SELECT), unless the DBA added them to the audit.</li>
            <li>The values before and after a change. For those, look at the history tables (Latest changes page).</li>
            <li>Anything that happened before the audit was switched on, or older than the retention period.</li>
          </ul>
        }
      </aside>
    }

    @if (exporting(); as x) {
      <app-history-export [kind]="kind()" [query]="x.query" [info]="x.info" (closed)="exporting.set(null)" />
    }

    @if (selected(); as s) {
      <div class="drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <h2>{{ s.row.action }} · {{ (s.kind === 'sampled' ? s.row.firstSeen : s.row.eventTime).slice(0, 19) }}</h2>
          <button type="button" class="btn" (click)="selected.set(null)">✕</button>
        </div>
        @if (s.kind === 'sampled') {
          <dl>
            <dt>Procedure</dt><dd>{{ s.row.procName ?? 'None: direct SQL, not run from a stored procedure' }}</dd>
            <dt>Tables named in the statement (best effort)</dt><dd>{{ s.row.tables ?? '—' }}</dd>
            <dt>Database</dt><dd>{{ s.row.db }}</dd>
            @if (s.row.capture === 'last') {
              <dt>Captured</dt>
              <dd>After it finished: too quick to be seen running, so this is the last batch the session had sent when the sampler looked. Other quick batches from the same session in the same few seconds are not recorded.</dd>
              <dt>Seen</dt>
              <dd>{{ s.row.samples | number }} time(s) this hour, {{ s.row.firstSeen }} → {{ s.row.lastSeen.slice(11) }}. Latest run took {{ fmt(s.row.elapsedMs) }}. CPU and reads are not available for finished requests.</dd>
            } @else {
              <dt>Seen</dt>
              <dd>{{ s.row.samples | number }} time(s), {{ s.row.firstSeen }} → {{ s.row.lastSeen.slice(11) }} (request started {{ s.row.requestStart ?? '—' }})</dd>
              <dt>Request at last sighting: ran for / CPU / reads / writes / rows</dt>
              <dd>{{ fmt(s.row.elapsedMs) }} · {{ fmt(s.row.cpuMs) }} · {{ s.row.logicalReads | number }} · {{ s.row.writes | number }} · {{ s.row.rowsAffected | number }}</dd>
            }
            <dt>App</dt><dd>{{ s.row.app ?? '—' }}</dd>
            <dt>Who</dt>
            <dd>{{ s.row.jobName ? 'Agent job: ' + s.row.jobName + '\n' : '' }}{{ s.row.programName }}
{{ s.row.loginName }}{{ s.row.hostName ? ' @ ' + s.row.hostName : '' }}{{ s.row.clientAddress ? ' (' + s.row.clientAddress + ')' : '' }} · session {{ s.row.sessionId }}</dd>
            <dt>{{ s.row.capture === 'last' ? 'Batch sent by the session' : 'Statement' }}</dt>
            <dd class="sql">{{ s.row.statement ?? (s.row.capture === 'last' ? 'Procedure called directly: the statements inside it are not recorded.' : '') }}</dd>
          </dl>
        } @else {
          <dl>
            <dt>Table / procedure</dt><dd>{{ objectLabel(s.row) }}</dd>
            <dt>Database</dt><dd>{{ s.row.db }}</dd>
            <dt>Result</dt><dd>{{ s.row.succeeded ? 'Allowed' : 'Denied / failed permission check' }}</dd>
            <dt>Login</dt>
            <dd>{{ s.row.loginName ?? '—' }}{{ s.row.sessionLogin && s.row.sessionLogin !== s.row.loginName ? ' (session login ' + s.row.sessionLogin + ')' : '' }} · database user {{ s.row.dbUser ?? '—' }}</dd>
            <dt>App</dt><dd>{{ s.row.app ?? '—' }}</dd>
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
  /** The guide panel (what the labels mean) is open. */
  protected readonly guide = signal(false);
  /** Set while the export dialog is open: the filters as they were when it was opened. */
  protected readonly exporting = signal<{ query: Omit<HistoryQuery, 'page' | 'pageSize'>; info: ExportInfo } | null>(null);

  protected readonly range = signal<RangeKey>('24h');
  protected readonly from = signal<string | null>(null);
  protected readonly to = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly action = signal('');
  protected readonly who = signal('');
  protected readonly whoType = signal<'' | 'agent' | 'user' | 'maui' | 'other'>('');
  /** Domain-user dropdown: '' = all, 'only:LOGIN' = just that login, 'not:LOGIN' = domain users except that login. */
  protected readonly loginChoice = signal('');
  protected readonly capture = signal<'' | 'running' | 'last'>('');
  protected readonly logins = signal<{ login: string; rows: number }[]>([]);
  /** App dropdown: '' = all, otherwise exactly that application. */
  protected readonly app = signal('');
  protected readonly apps = signal<{ app: string; rows: number }[]>([]);
  private readonly loginFilter = computed(() => {
    const c = this.loginChoice();
    return { login: c.startsWith('only:') ? c.slice(5) : undefined, notLogin: c.startsWith('not:') ? c.slice(4) : undefined };
  });
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
  private whoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // A different log, database or scope starts again from page 1.
    effect(() => {
      this.kind();
      this.scope();
      this.ctx.key();
      untracked(() => {
        this.page.set(1);
        this.action.set('');
        this.loginChoice.set('');
        this.app.set('');
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
        who: this.who().trim() || undefined,
        whoType: this.whoType() || undefined,
        ...this.loginFilter(),
        app: this.app() || undefined,
        capture: this.capture() || undefined,
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
    this.api.historyLogins(kind, query.scope).subscribe({ next: (r) => id === this.requestId && this.logins.set(r.logins), error: () => undefined });
    this.api.historyApps(kind, query.scope).subscribe({ next: (r) => id === this.requestId && this.apps.set(r.apps), error: () => undefined });
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

  /** Open the export dialog for exactly what the table is showing (all pages). */
  openExport(): void {
    const range = resolveRange(this.range(), this.from(), this.to());
    const query = {
      scope: this.scope(),
      ...range,
      action: this.action() || undefined,
      search: this.search().trim() || undefined,
      who: this.who().trim() || undefined,
      whoType: this.whoType() || undefined,
      ...this.loginFilter(),
      app: this.app() || undefined,
      capture: this.capture() || undefined,
    };
    const target = this.ctx.target();
    const server = target?.server ?? '';
    const sampled = this.kind() === 'sampled';
    const clock = (v?: string) => v?.replace('T', ' ');
    const period = !range.from && !range.to ? 'All time' : `${clock(range.from) ?? 'the beginning'} to ${clock(range.to) ?? 'now'}`;
    const loginTypes = { agent: 'Agent jobs', user: 'Users (domain logins)', maui: 'MAUI (Core Microsoft SqlClient)', other: 'Other logins' };
    const details: [string, string][] = [
      ['Server', server],
      ['Database', this.scope() === 'server' ? 'All databases' : (target?.database ?? '')],
      ['Period', period],
    ];
    if (query.action) details.push(['Action', query.action]);
    if (query.search) details.push(['Search', query.search]);
    if (query.who) details.push(['Who contains', query.who]);
    if (query.whoType) details.push(['Login type', loginTypes[query.whoType]]);
    if (query.login) details.push(['Login', query.login]);
    if (query.notLogin) details.push(['Excluding login', query.notLogin]);
    if (query.app) details.push(['App', query.app]);
    if (query.capture) details.push(['Captured', query.capture === 'last' ? 'After it finished' : 'While running']);
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
    const seconds = (this.status()?.sampler.intervalMs ?? 5000) / 1000;
    this.exporting.set({
      query,
      info: {
        title: `${sampled ? 'SQL activity history (sampled)' : 'SQL audit history'} — ${server}`,
        details,
        note: sampled
          ? `Sampled, not complete: the server looks at what is running every ${seconds} s, so statements that finish faster are usually missing. Table names are a best-effort text match.`
          : 'From SQL Server Audit: every INSERT / UPDATE / DELETE / EXECUTE on the audited databases.',
        fileBase: `sql-monitor-${sampled ? 'history-sampled' : 'audit-history'}-${server}-${stamp}`.replace(/[^\w.-]+/g, '_'),
      },
    });
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

  /** "Except X" only makes sense among the domain users, so it also switches the login type to Users. */
  setLoginChoice(v: string): void {
    this.loginChoice.set(v);
    if (v.startsWith('not:')) this.whoType.set('user');
    else if (v.startsWith('only:') && this.whoType() !== 'user') this.whoType.set('');
    this.page.set(1);
  }

  onWho(v: string): void {
    if (this.whoTimer) clearTimeout(this.whoTimer);
    this.whoTimer = setTimeout(() => {
      this.who.set(v);
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
