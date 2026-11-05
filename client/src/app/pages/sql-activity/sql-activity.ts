import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService, errorMessage } from '../../core/api.service';
import { ContextService } from '../../core/context.service';
import { BlockingSession, Deadlock, LockRow, OpenTransaction, ProcStat, RunningRequest, SqlLive, SqlScope } from '../../core/models';
import { AutoRefresh } from '../../shared/auto-refresh';
import { AgoPipe, parseDbDate } from '../../shared/format';
import { Pager } from '../../shared/pager';

type Tab = 'running' | 'locks' | 'deadlocks' | 'procs';

type Selected =
  | { kind: 'running'; row: RunningRequest }
  | { kind: 'blocker'; row: BlockingSession }
  | { kind: 'tx'; row: OpenTransaction }
  | { kind: 'deadlock'; row: Deadlock };

const SCOPE_KEY = 'nay-monitor.sql-scope';
const TAB_KEY = 'nay-monitor.sql-tab';

/** "850 ms", "12.4 s", "3 min 05 s", "2 h 14 min". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function bytes(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

@Component({
  selector: 'app-sql-activity',
  imports: [DecimalPipe, AgoPipe, AutoRefresh, Pager],
  template: `
    <div class="page-head">
      <div>
        <h1>SQL activity</h1>
        <p class="muted">
          What is running on <strong>{{ live()?.server?.server ?? ctx.target()?.server }}</strong> right now, who is blocking whom, and
          past deadlocks. Read live from SQL Server
          (<span class="table-name">sys.dm_exec_requests</span>, <span class="table-name">sys.dm_tran_locks</span>,
          <span class="table-name">system_health</span>). Nothing is changed.
        </p>
      </div>
      <div class="toolbar">
        <select [value]="scope()" (change)="setScope($any($event.target).value)" aria-label="Scope">
          <option value="db" [selected]="scope() === 'db'">This database: {{ ctx.target()?.database }}</option>
          <option value="server" [selected]="scope() === 'server'">Whole server: {{ ctx.target()?.server }}</option>
        </select>
        <app-auto-refresh storageKey="sql-activity" [defaultMs]="10000" [lastUpdated]="updatedAt()" [loading]="loading()" [paused]="!!selected()" (refresh)="load(true)" />
      </div>
    </div>

    @if (error(); as e) {
      <div class="banner error">{{ e }}</div>
    }

    <div class="stats">
      <button type="button" class="stat stat-btn" (click)="setTab('running')">
        <div class="stat-label">Running now</div>
        <div class="stat-value">{{ live()?.running?.length ?? '—' }}</div>
        <div class="stat-foot">{{ procCount() }} inside stored procedures</div>
      </button>
      <button type="button" class="stat stat-btn" [class.stat-bad]="blockedCount() > 0" (click)="setTab('locks')">
        <div class="stat-label">Blocked sessions</div>
        <div class="stat-value">{{ live() ? blockedCount() : '—' }}</div>
        <div class="stat-foot">
          @if (blockedCount() > 0) {
            longest wait {{ fmt(maxBlockedWaitMs()) }}
          } @else {
            no blocking right now
          }
        </div>
      </button>
      <button type="button" class="stat stat-btn" [class.stat-warn]="(longest()?.elapsedMs ?? 0) > 300000" (click)="setTab('running')">
        <div class="stat-label">Longest running</div>
        <div class="stat-value">{{ longest() ? fmt(longest()!.elapsedMs) : '—' }}</div>
        <div class="stat-foot ellipsis">{{ longest()?.procName ?? longest()?.command ?? 'nothing running' }}</div>
      </button>
      <button type="button" class="stat stat-btn" [class.stat-warn]="(oldestTx()?.openSeconds ?? 0) > 300" (click)="setTab('locks')">
        <div class="stat-label">Oldest open transaction</div>
        <div class="stat-value">{{ oldestTx() ? fmt(oldestTx()!.openSeconds * 1000) : '—' }}</div>
        <div class="stat-foot">
          {{ live()?.transactions?.length ?? 0 }} open
          @if (idleTxCount() > 0) {
            · <strong>{{ idleTxCount() }} idle</strong>
          }
        </div>
      </button>
      <button type="button" class="stat stat-btn" [class.stat-bad]="deadlocks24h() > 0" (click)="setTab('deadlocks')">
        <div class="stat-label">Deadlocks (7 days)</div>
        <div class="stat-value">{{ deadlocksLoaded() ? deadlocks7d() : '…' }}</div>
        <div class="stat-foot">{{ deadlocks24h() }} in the last 24 h</div>
      </button>
    </div>

    <div class="tabs">
      <button type="button" [class.active]="tab() === 'running'" (click)="setTab('running')">Running now ({{ live()?.running?.length ?? 0 }})</button>
      <button type="button" [class.active]="tab() === 'locks'" (click)="setTab('locks')">
        Blocking &amp; locks{{ blockedCount() ? ' (' + blockedCount() + ' blocked)' : '' }}
      </button>
      <button type="button" [class.active]="tab() === 'deadlocks'" (click)="setTab('deadlocks')">Deadlocks ({{ deadlockRows().length }})</button>
      <button type="button" [class.active]="tab() === 'procs'" (click)="setTab('procs')">Procedure stats</button>
    </div>

    @switch (tab()) {
      @case ('running') {
        <div class="sub-toolbar">
          <label class="check">
            <input type="checkbox" [checked]="background()" (change)="background.set($any($event.target).checked); load()" />
            Show idle background sessions (XE readers, Service Broker, WAITFOR)
          </label>
          <span class="muted small">Sessions currently executing something. Click a row for the full SQL.</span>
        </div>
        <section class="card flush">
          <div class="table-wrap">
            <table class="grid sql-grid">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Running for</th>
                  <th>Procedure / statement</th>
                  <th>Database</th>
                  <th>State</th>
                  <th class="num">CPU</th>
                  <th class="num">Reads</th>
                  <th>Started by</th>
                </tr>
              </thead>
              <tbody>
                @for (r of live()?.running ?? []; track r.sessionId) {
                  <tr (click)="selected.set({ kind: 'running', row: r })" [class.row-bad]="r.blockedBy" [class.row-warn]="!r.blockedBy && r.elapsedMs > 300000">
                    <td class="mono">{{ r.sessionId }}</td>
                    <td class="nowrap"><strong>{{ fmt(r.elapsedMs) }}</strong><div class="muted small">since {{ r.startTime.slice(11, 19) }}</div></td>
                    <td class="stmt">
                      @if (r.procName) {
                        <div class="proc">{{ r.procName }}</div>
                      } @else {
                        <div class="proc muted">{{ r.command }} (ad hoc)</div>
                      }
                      <div class="clamp mono small">{{ oneLine(r.statement) }}</div>
                    </td>
                    <td>{{ r.db }}</td>
                    <td class="nowrap">
                      @if (r.blockedBy) {
                        <span class="sev sev-error">Blocked by {{ r.blockedBy }}</span>
                        <div class="muted small">{{ r.waitType }} · {{ fmt(r.waitMs) }}</div>
                      } @else if (r.waitType) {
                        <span class="sev sev-warning">{{ r.status }}</span>
                        <div class="muted small">{{ r.waitType }} · {{ fmt(r.waitMs) }}</div>
                      } @else {
                        <span class="sev sev-info">{{ r.status }}</span>
                      }
                      @if (r.percentComplete > 0) {
                        <div class="muted small">{{ r.percentComplete | number: '1.0-1' }}% done</div>
                      }
                    </td>
                    <td class="num">{{ fmt(r.cpuMs) }}</td>
                    <td class="num">{{ r.logicalReads | number }}</td>
                    <td class="who">
                      <div class="ellipsis">{{ r.jobName ? 'Agent job: ' + r.jobName : r.programName }}</div>
                      <div class="muted small ellipsis">{{ r.loginName }}{{ r.hostName ? ' @ ' + r.hostName : '' }}</div>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="8" class="empty">{{ live() ? 'Nothing is running right now.' : 'Loading…' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @case ('locks') {
        <section class="card">
          <div class="card-head">
            <strong>Blocking chains</strong>
            <span class="muted small">Sessions holding locks that others are waiting for (<span class="table-name">sys.dm_exec_requests.blocking_session_id</span>)</span>
          </div>
          @for (b of headBlockers(); track b.sessionId) {
            <div class="chain">
              <div class="chain-head" (click)="selected.set({ kind: 'blocker', row: b })">
                <span class="sev sev-error">Head blocker</span>
                <span class="mono">session {{ b.sessionId }}</span>
                <span>{{ b.jobName ? 'Agent job: ' + b.jobName : b.programName }}</span>
                <span class="muted">{{ b.loginName }}{{ b.hostName ? ' @ ' + b.hostName : '' }} · {{ b.db }}</span>
                @if (b.status === 'sleeping' && b.openTransactions > 0) {
                  <span class="sev sev-warning" title="The session finished its last request but left a transaction open, so it still holds its locks.">
                    Idle with open transaction
                  </span>
                } @else {
                  <span class="sev sev-info">{{ b.status }}</span>
                }
                <div class="clamp mono small chain-sql">{{ oneLine(b.lastSql) }}</div>
              </div>
              <ul class="chain-waiters">
                @for (w of waitersOf(b.sessionId); track w.row.sessionId) {
                  <li [style.padding-left.px]="w.depth * 20" (click)="selected.set({ kind: 'running', row: w.row })">
                    ↳ <span class="mono">session {{ w.row.sessionId }}</span> waiting <strong>{{ fmt(w.row.waitMs) }}</strong>
                    for {{ w.row.waitType }} on <span class="mono small">{{ w.row.waitResource }}</span> —
                    {{ w.row.procName ?? w.row.command }} <span class="muted">({{ w.row.jobName ?? w.row.programName }})</span>
                  </li>
                }
              </ul>
            </div>
          } @empty {
            <p class="muted">No blocking right now.</p>
          }
        </section>

        <section class="card flush">
          <div class="card-head pad">
            <strong>Open transactions ({{ live()?.transactions?.length ?? 0 }})</strong>
            <span class="muted small">"Idle" = the session is not running anything but still holds its transaction and locks</span>
          </div>
          <div class="table-wrap">
            <table class="grid sql-grid">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Open for</th>
                  <th>Database</th>
                  <th>State</th>
                  <th class="num">Locks</th>
                  <th class="num">Log used</th>
                  <th>Started by</th>
                  <th>Last SQL</th>
                </tr>
              </thead>
              <tbody>
                @for (t of live()?.transactions ?? []; track $index) {
                  <tr (click)="selected.set({ kind: 'tx', row: t })" [class.row-warn]="isIdleTx(t)">
                    <td class="mono">{{ t.sessionId }}</td>
                    <td class="nowrap"><strong>{{ fmt(t.openSeconds * 1000) }}</strong><div class="muted small">since {{ t.beganAt.slice(11, 19) }}</div></td>
                    <td>{{ t.db }}</td>
                    <td>
                      @if (isIdleTx(t)) {
                        <span class="sev sev-warning">Idle</span>
                      } @else {
                        <span class="sev sev-info">{{ t.status }}</span>
                      }
                    </td>
                    <td class="num">{{ t.locks | number }}</td>
                    <td class="num">{{ bytes(t.logBytes) }}</td>
                    <td class="who">
                      <div class="ellipsis">{{ t.jobName ? 'Agent job: ' + t.jobName : t.programName }}</div>
                      <div class="muted small ellipsis">{{ t.loginName }}{{ t.hostName ? ' @ ' + t.hostName : '' }}</div>
                    </td>
                    <td class="stmt"><div class="clamp mono small">{{ oneLine(t.lastSql) }}</div></td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="8" class="empty">No open transactions.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="card flush">
          <div class="card-head pad">
            <strong>Locks ({{ locks().length }})</strong>
            <span class="muted small">Grouped by session, object and mode (<span class="table-name">sys.dm_tran_locks</span>). WAIT = requested, not granted yet.</span>
          </div>
          <div class="table-wrap">
            <table class="grid sql-grid">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Database</th>
                  <th>Object</th>
                  <th>Resource</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th class="num">Count</th>
                  <th>Session</th>
                  <th>Started by</th>
                </tr>
              </thead>
              <tbody>
                @for (l of locks(); track $index) {
                  <tr [class.row-bad]="l.status !== 'GRANT'">
                    <td class="mono">{{ l.sessionId }}</td>
                    <td>{{ l.db }}</td>
                    <td class="mono small">{{ l.objectName ?? '—' }}</td>
                    <td>{{ l.resourceType }}</td>
                    <td class="mono" [title]="lockModeHelp(l.mode)">{{ l.mode }}</td>
                    <td><span class="sev" [class.sev-error]="l.status !== 'GRANT'" [class.sev-info]="l.status === 'GRANT'">{{ l.status }}</span></td>
                    <td class="num">{{ l.locks | number }}</td>
                    <td>{{ l.sessionStatus }}</td>
                    <td class="who"><div class="ellipsis">{{ l.jobName ? 'Agent job: ' + l.jobName : l.programName }}</div><div class="muted small ellipsis">{{ l.loginName }}</div></td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="9" class="empty">{{ locksLoading() ? 'Loading…' : 'No locks held (besides database-level shared locks).' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @case ('deadlocks') {
        <div class="sub-toolbar">
          <input type="search" placeholder="Filter by table, procedure, login, app…" [value]="dlFilter()" (input)="dlFilter.set($any($event.target).value); dlPage.set(1)" />
          <span class="muted small">
            From SQL Server's built-in <span class="table-name">system_health</span> session files
            @if (deadlockOldest()) {
              — history available since {{ deadlockOldest()!.slice(0, 16) }} (older files roll over automatically).
            }
          </span>
        </div>
        <section class="card flush">
          <div class="table-wrap">
            <table class="grid sql-grid">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Database</th>
                  <th>Objects</th>
                  <th>Victim (rolled back)</th>
                  <th>Winner(s)</th>
                </tr>
              </thead>
              <tbody>
                @for (d of dlPageRows(); track d.id) {
                  <tr (click)="selected.set({ kind: 'deadlock', row: d })">
                    <td class="nowrap">{{ d.at.slice(0, 19) }}<div class="muted small">{{ d.at | ago }}</div></td>
                    <td>{{ d.dbs.join(', ') }}</td>
                    <td class="mono small">{{ shortObjects(d.objects) }}</td>
                    <td class="who">
                      @for (p of victims(d); track $index) {
                        <div class="ellipsis"><span class="sev sev-error">victim</span> {{ procLabel(p) }}</div>
                        <div class="muted small ellipsis">{{ p.jobName ?? p.programName }} · {{ p.hostName }}</div>
                      }
                    </td>
                    <td class="who">
                      @for (p of winners(d); track $index) {
                        <div class="ellipsis">{{ procLabel(p) }}</div>
                        <div class="muted small ellipsis">{{ p.jobName ?? p.programName }} · {{ p.hostName }}</div>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="empty">{{ deadlocksLoaded() ? 'No deadlocks recorded.' : 'Reading system_health files…' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <app-pager
            [page]="dlPage()"
            [pageSize]="dlPageSize()"
            [total]="dlFiltered().length"
            [sizes]="[25, 50, 100]"
            (pageChange)="dlPage.set($event)"
            (pageSizeChange)="dlPageSize.set($event); dlPage.set(1)"
          />
        </section>
      }

      @case ('procs') {
        <div class="sub-toolbar">
          <input type="search" placeholder="Filter procedures…" [value]="procFilter()" (input)="procFilter.set($any($event.target).value)" />
          <label class="muted small">
            Sort by
            <select [value]="procSort()" (change)="procSort.set($any($event.target).value); loadProcs()">
              <option value="total">Total time</option>
              <option value="avg">Average time</option>
              <option value="max">Slowest single run</option>
              <option value="count">Executions</option>
              <option value="cpu">Total CPU</option>
              <option value="reads">Total reads</option>
              <option value="last">Last run</option>
            </select>
          </label>
          <span class="muted small">
            From <span class="table-name">sys.dm_exec_procedure_stats</span>: counts since each procedure's plan was cached (see "Since"), reset when SQL
            Server recompiles it or restarts. Failures are not recorded here.
          </span>
        </div>
        <section class="card flush">
          <div class="table-wrap">
            <table class="grid sql-grid">
              <thead>
                <tr>
                  <th>Procedure</th>
                  <th>Database</th>
                  <th class="num">Executions</th>
                  <th class="num">Average</th>
                  <th class="num">Slowest</th>
                  <th class="num">Last</th>
                  <th class="num">Total time</th>
                  <th class="num">Avg CPU</th>
                  <th class="num">Avg reads</th>
                  <th>Last run</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                @for (p of procsFiltered(); track p.db + p.procName) {
                  <tr [class.row-warn]="p.avgMs > 10000">
                    <td class="mono small">{{ p.procName }}</td>
                    <td>{{ p.db }}</td>
                    <td class="num">{{ p.executions | number }}</td>
                    <td class="num"><strong>{{ fmt(p.avgMs) }}</strong></td>
                    <td class="num">{{ fmt(p.maxMs) }}</td>
                    <td class="num">{{ fmt(p.lastMs) }}</td>
                    <td class="num">{{ fmt(p.totalMs) }}</td>
                    <td class="num">{{ fmt(p.avgCpuMs) }}</td>
                    <td class="num">{{ p.avgReads | number }}</td>
                    <td class="nowrap">{{ p.lastRun | ago }}</td>
                    <td class="nowrap muted small">{{ p.cachedAt.slice(0, 16) }}</td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="11" class="empty">{{ procsLoading() ? 'Loading…' : 'No procedure statistics.' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    }

    @if (selected(); as s) {
      <div class="drawer-backdrop" (click)="selected.set(null)"></div>
      <aside class="drawer">
        <div class="drawer-head">
          <h2>
            @switch (s.kind) {
              @case ('running') { Session {{ s.row.sessionId }} · running }
              @case ('blocker') { Session {{ s.row.sessionId }} · head blocker }
              @case ('tx') { Session {{ s.row.sessionId }} · open transaction }
              @case ('deadlock') { Deadlock · {{ s.row.at.slice(0, 19) }} }
            }
          </h2>
          <button type="button" class="btn" (click)="selected.set(null)">✕</button>
        </div>

        @switch (s.kind) {
          @case ('running') {
            <dl>
              <dt>Procedure</dt><dd>{{ s.row.procName ?? '(ad hoc ' + s.row.command + ')' }}</dd>
              <dt>Database</dt><dd>{{ s.row.db }}</dd>
              <dt>Running for</dt><dd>{{ fmt(s.row.elapsedMs) }} (started {{ s.row.startTime }})</dd>
              <dt>Status / wait</dt>
              <dd>{{ s.row.status }}{{ s.row.waitType ? ' · ' + s.row.waitType + ' for ' + fmt(s.row.waitMs) : '' }}{{ s.row.waitResource ? ' on ' + s.row.waitResource : '' }}</dd>
              @if (s.row.blockedBy) {
                <dt>Blocked by</dt><dd>session {{ s.row.blockedBy }}</dd>
              }
              <dt>CPU / reads / writes / rows</dt>
              <dd>{{ fmt(s.row.cpuMs) }} · {{ s.row.logicalReads | number }} logical ({{ s.row.reads | number }} physical) · {{ s.row.writes | number }} · {{ s.row.rowsAffected | number }}</dd>
              <dt>Isolation · open transactions</dt><dd>{{ s.row.isolation }} · {{ s.row.openTransactions }}</dd>
              <dt>Started by</dt>
              <dd>{{ s.row.jobName ? 'Agent job: ' + s.row.jobName + '\n' : '' }}{{ s.row.programName }}
{{ s.row.loginName }}{{ s.row.hostName ? ' @ ' + s.row.hostName : '' }}</dd>
              <dt>Current statement</dt><dd class="sql">{{ s.row.statement }}</dd>
              <dt>Whole batch / procedure</dt><dd class="sql">{{ s.row.batchText }}</dd>
            </dl>
            <div class="drawer-actions">
              <button type="button" class="btn primary" (click)="copy(s.row.statement ?? '')">{{ copied() ? '✓ Copied' : 'Copy statement' }}</button>
            </div>
          }
          @case ('blocker') {
            <dl>
              <dt>Status</dt>
              <dd>{{ s.row.status }}{{ s.row.status === 'sleeping' && s.row.openTransactions > 0 ? ' — not running anything, but its open transaction still holds locks' : '' }}</dd>
              <dt>Blocking</dt><dd>{{ s.row.blocking }} session(s) directly</dd>
              <dt>Database</dt><dd>{{ s.row.db }}</dd>
              <dt>Open transactions</dt><dd>{{ s.row.openTransactions }}</dd>
              <dt>Last request</dt><dd>started {{ s.row.lastRequestStart ?? '—' }} · ended {{ s.row.lastRequestEnd ?? '—' }}</dd>
              <dt>Started by</dt>
              <dd>{{ s.row.jobName ? 'Agent job: ' + s.row.jobName + '\n' : '' }}{{ s.row.programName }}
{{ s.row.loginName }}{{ s.row.hostName ? ' @ ' + s.row.hostName : '' }}</dd>
              <dt>Last SQL sent by this session</dt><dd class="sql">{{ s.row.lastSql }}</dd>
            </dl>
            <div class="drawer-actions">
              <button type="button" class="btn primary" (click)="copy(s.row.lastSql ?? '')">{{ copied() ? '✓ Copied' : 'Copy SQL' }}</button>
            </div>
          }
          @case ('tx') {
            <dl>
              <dt>Open for</dt><dd>{{ fmt(s.row.openSeconds * 1000) }} (began {{ s.row.beganAt }})</dd>
              <dt>Database</dt><dd>{{ s.row.db }}</dd>
              <dt>State</dt><dd>{{ isIdleTx(s.row) ? 'Idle — session is not running anything but keeps the transaction open' : s.row.status }}</dd>
              <dt>Transaction</dt><dd>{{ s.row.transactionName }}</dd>
              <dt>Locks held · log used</dt><dd>{{ s.row.locks | number }} · {{ bytes(s.row.logBytes) }}</dd>
              <dt>Started by</dt>
              <dd>{{ s.row.jobName ? 'Agent job: ' + s.row.jobName + '\n' : '' }}{{ s.row.programName }}
{{ s.row.loginName }}{{ s.row.hostName ? ' @ ' + s.row.hostName : '' }}</dd>
              <dt>Last SQL sent by this session</dt><dd class="sql">{{ s.row.lastSql }}</dd>
            </dl>
            <div class="drawer-actions">
              <button type="button" class="btn primary" (click)="copy(s.row.lastSql ?? '')">{{ copied() ? '✓ Copied' : 'Copy SQL' }}</button>
            </div>
          }
          @case ('deadlock') {
            <p class="muted small">Objects: <span class="mono">{{ s.row.objects ?? '—' }}</span></p>
            @for (p of s.row.processes; track $index) {
              <div class="dl-process" [class.victim]="p.isVictim">
                <div class="dl-title">
                  @if (p.isVictim) {
                    <span class="sev sev-error">Victim — rolled back</span>
                  } @else {
                    <span class="sev sev-info">Completed</span>
                  }
                  <span class="mono">session {{ p.sessionId }}</span>
                </div>
                <dl>
                  <dt>Procedure</dt><dd>{{ procLabel(p) }}{{ p.lineNumber ? ' (line ' + p.lineNumber + ')' : '' }}</dd>
                  <dt>Wanted lock</dt><dd>{{ p.lockMode }} on {{ p.waitResource }} · waited {{ fmt(p.waitMs) }}</dd>
                  <dt>Isolation</dt><dd>{{ p.isolation }}</dd>
                  <dt>Started by</dt>
                  <dd>{{ p.jobName ? 'Agent job: ' + p.jobName + '\n' : '' }}{{ p.programName }}
{{ p.loginName }}{{ p.hostName ? ' @ ' + p.hostName : '' }} · {{ p.db }}</dd>
                  <dt>SQL</dt><dd class="sql">{{ p.inputBuffer }}</dd>
                </dl>
              </div>
            }
          }
        }
      </aside>
    }
  `,
})
export class SqlActivity {
  private readonly api = inject(ApiService);
  protected readonly ctx = inject(ContextService);

  protected readonly scope = signal<SqlScope>(this.readStored(SCOPE_KEY) === 'server' ? 'server' : 'db');
  protected readonly tab = signal<Tab>((['running', 'locks', 'deadlocks', 'procs'] as Tab[]).find((t) => t === this.readStored(TAB_KEY)) ?? 'running');
  protected readonly background = signal(false);

  protected readonly live = signal<SqlLive | null>(null);
  protected readonly locks = signal<LockRow[]>([]);
  protected readonly locksLoading = signal(false);
  protected readonly deadlockRows = signal<Deadlock[]>([]);
  protected readonly deadlockOldest = signal<string | null>(null);
  protected readonly deadlocksLoaded = signal(false);
  protected readonly procs = signal<ProcStat[]>([]);
  protected readonly procsLoading = signal(false);
  protected readonly procSort = signal('total');
  protected readonly procFilter = signal('');
  protected readonly dlFilter = signal('');
  protected readonly dlPage = signal(1);
  protected readonly dlPageSize = signal(25);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly updatedAt = signal<Date | null>(null);
  protected readonly selected = signal<Selected | null>(null);
  protected readonly copied = signal(false);

  protected readonly fmt = duration;
  protected readonly bytes = bytes;

  protected readonly procCount = computed(() => (this.live()?.running ?? []).filter((r) => r.procName).length);
  protected readonly blocked = computed(() => (this.live()?.running ?? []).filter((r) => r.blockedBy));
  protected readonly blockedCount = computed(() => this.blocked().length);
  protected readonly maxBlockedWaitMs = computed(() => Math.max(0, ...this.blocked().map((r) => r.waitMs)));
  protected readonly longest = computed(() => {
    const rows = this.live()?.running ?? [];
    return rows.length ? rows.reduce((a, b) => (b.elapsedMs > a.elapsedMs ? b : a)) : null;
  });
  protected readonly oldestTx = computed(() => this.live()?.transactions?.[0] ?? null);
  protected readonly idleTxCount = computed(() => (this.live()?.transactions ?? []).filter((t) => this.isIdleTx(t)).length);

  /** Blockers that are not themselves waiting on someone else — the start of each chain. */
  protected readonly headBlockers = computed(() => (this.live()?.blockers ?? []).filter((b) => !b.blockedBy).sort((a, b) => b.blocking - a.blocking));

  protected readonly deadlocks7d = computed(() => this.countDeadlocksSince(7 * 24));
  protected readonly deadlocks24h = computed(() => this.countDeadlocksSince(24));
  protected readonly dlFiltered = computed(() => {
    const f = this.dlFilter().trim().toLowerCase();
    if (!f) return this.deadlockRows();
    return this.deadlockRows().filter((d) =>
      [d.objects, ...d.dbs, ...d.processes.flatMap((p) => [p.procName, p.loginName, p.hostName, p.programName, p.jobName, p.inputBuffer])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(f)),
    );
  });
  protected readonly dlPageRows = computed(() => {
    const start = (this.dlPage() - 1) * this.dlPageSize();
    return this.dlFiltered().slice(start, start + this.dlPageSize());
  });
  protected readonly procsFiltered = computed(() => {
    const f = this.procFilter().trim().toLowerCase();
    return f ? this.procs().filter((p) => p.procName?.toLowerCase().includes(f)) : this.procs();
  });

  constructor() {
    effect(() => {
      this.ctx.key();
      this.scope();
      if (!this.ctx.ready()) return;
      untracked(() => {
        this.selected.set(null);
        this.live.set(null);
        this.locks.set([]);
        this.procs.set([]);
        this.deadlocksLoaded.set(false);
        this.load();
        this.loadDeadlocks(false);
      });
    });
  }

  setScope(s: SqlScope): void {
    this.scope.set(s);
    this.store(SCOPE_KEY, s);
  }

  setTab(t: Tab): void {
    if (t === this.tab()) return;
    this.tab.set(t);
    this.store(TAB_KEY, t);
    if (t === 'locks') this.loadLocks();
    if (t === 'procs' && !this.procs().length) this.loadProcs();
    if (t === 'deadlocks' && !this.deadlocksLoaded()) this.loadDeadlocks(false);
  }

  /** Live snapshot every time; plus whatever the open tab shows. */
  load(fromRefresh = false): void {
    this.loading.set(true);
    this.api.sqlLive(this.scope(), this.background()).subscribe({
      next: (r) => {
        this.live.set(r);
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
    if (this.tab() === 'locks') this.loadLocks();
    if (this.tab() === 'procs') this.loadProcs();
    if (fromRefresh && this.tab() === 'deadlocks') this.loadDeadlocks(false);
  }

  loadLocks(): void {
    this.locksLoading.set(true);
    this.api.sqlLocks(this.scope()).subscribe({
      next: (r) => {
        this.locks.set(r.rows);
        this.locksLoading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.locksLoading.set(false);
      },
    });
  }

  loadProcs(): void {
    this.procsLoading.set(true);
    this.api.sqlProcedures(this.scope(), this.procSort()).subscribe({
      next: (r) => {
        this.procs.set(r.rows);
        this.procsLoading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.procsLoading.set(false);
      },
    });
  }

  loadDeadlocks(refresh: boolean): void {
    this.api.sqlDeadlocks(this.scope(), refresh).subscribe({
      next: (r) => {
        this.deadlockRows.set(r.rows);
        this.deadlockOldest.set(r.oldest);
        this.deadlocksLoaded.set(true);
      },
      error: (err) => {
        this.error.set(`Deadlock history: ${errorMessage(err)}`);
        this.deadlocksLoaded.set(true);
      },
    });
  }

  /** Waiting sessions under a blocker, depth-first (a waiter can itself block others). */
  waitersOf(id: number, depth = 1, seen = new Set<number>()): { row: RunningRequest; depth: number }[] {
    const out: { row: RunningRequest; depth: number }[] = [];
    for (const r of this.blocked().filter((x) => x.blockedBy === id)) {
      if (seen.has(r.sessionId)) continue;
      seen.add(r.sessionId);
      out.push({ row: r, depth }, ...this.waitersOf(r.sessionId, depth + 1, seen));
    }
    return out;
  }

  isIdleTx(t: OpenTransaction): boolean {
    return t.status === 'sleeping' && t.openSeconds >= 30;
  }

  victims(d: Deadlock) {
    return d.processes.filter((p) => p.isVictim);
  }

  winners(d: Deadlock) {
    return d.processes.filter((p) => !p.isVictim);
  }

  procLabel(p: { procName: string | null; inputBuffer: string | null }): string {
    if (p.procName && p.procName !== 'adhoc' && p.procName !== 'unknown') return p.procName;
    return `ad hoc: ${this.oneLine(p.inputBuffer).slice(0, 80)}`;
  }

  shortObjects(o: string | null): string {
    return (o ?? '—')
      .split(', ')
      .map((x) => x.split('.').slice(-1)[0])
      .join(', ');
  }

  oneLine(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }

  lockModeHelp(mode: string): string {
    const m: Record<string, string> = {
      S: 'Shared (read)',
      X: 'Exclusive (write)',
      U: 'Update',
      IS: 'Intent shared',
      IX: 'Intent exclusive',
      SIX: 'Shared with intent exclusive',
      'Sch-S': 'Schema stability',
      'Sch-M': 'Schema modification',
      BU: 'Bulk update',
    };
    return m[mode] ?? mode;
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

  private countDeadlocksSince(hours: number): number {
    const since = Date.now() - hours * 3_600_000;
    return this.deadlockRows().filter((d) => (parseDbDate(d.at)?.getTime() ?? 0) >= since).length;
  }

  private readStored(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private store(key: string, v: string): void {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* storage unavailable */
    }
  }
}
