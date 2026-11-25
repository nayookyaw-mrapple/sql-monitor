import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ActivityEvent, AgentJobDetail, AgentJobs,AuditEvent, HistoryPage, HistoryQuery, HistoryStatus, SampledActivity, Deadlock, LockRow, ProcStat, ProcUsageResult,SqlLive, SqlScope, ErrorSourceStatus, ErrorsPage, ErrorsQuery, LatestChangeRow, RecurringError, MonitorStatus, RowsPage, RowsQuery, Summary, TableDetail, TableSummary } from './models';

function params(obj: object): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
  }
  return p;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  summary(): Observable<Summary> {
    return this.http.get<Summary>('/api/summary');
  }

  tables(filter: { module?: string; search?: string } = {}): Observable<TableSummary[]> {
    return this.http.get<TableSummary[]>('/api/tables', { params: params(filter) });
  }

  table(name: string): Observable<TableDetail> {
    return this.http.get<TableDetail>(`/api/tables/${encodeURIComponent(name)}`);
  }

  actions(name: string): Observable<string[]> {
    return this.http.get<string[]>(`/api/tables/${encodeURIComponent(name)}/actions`);
  }

  rows(name: string, query: RowsQuery): Observable<RowsPage> {
    return this.http.get<RowsPage>(`/api/tables/${encodeURIComponent(name)}/rows`, { params: params(query) });
  }

  activity(limit = 300): Observable<{ monitor: MonitorStatus; events: ActivityEvent[] }> {
    return this.http.get<{ monitor: MonitorStatus; events: ActivityEvent[] }>('/api/activity', { params: params({ limit }) });
  }

  errorSources(refresh = false): Observable<{ sources: ErrorSourceStatus[]; agentGrantScript: string }> {
    return this.http.get<{ sources: ErrorSourceStatus[]; agentGrantScript: string }>('/api/errors/sources', {
      params: params({ refresh: refresh ? 1 : undefined }),
    });
  }

  errors(query: ErrorsQuery): Observable<ErrorsPage> {
    return this.http.get<ErrorsPage>('/api/errors', { params: params(query) });
  }

  recurringErrors(range: { from?: string; to?: string }, source?: string): Observable<{ rows: RecurringError[] }> {
    return this.http.get<{ rows: RecurringError[] }>('/api/errors/recurring', { params: params({ ...range, source }) });
  }

  /** Every SQL Agent job on the selected database's server. */
  jobs(refresh = false): Observable<{ result: AgentJobs; grantScript: string }> {
    return this.http.get<{ result: AgentJobs; grantScript: string }>('/api/jobs', { params: params({ refresh: refresh ? 1 : undefined }) });
  }

  /** Steps and recent runs of one SQL Agent job. */
  job(jobId: string): Observable<AgentJobDetail> {
    return this.http.get<AgentJobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  sqlLive(scope: SqlScope, background = false): Observable<SqlLive> {
    return this.http.get<SqlLive>('/api/sql/live', { params: params({ scope, background: background ? 1 : undefined }) });
  }

  sqlLocks(scope: SqlScope): Observable<{ rows: LockRow[] }> {
    return this.http.get<{ rows: LockRow[] }>('/api/sql/locks', { params: params({ scope }) });
  }

  sqlDeadlocks(scope: SqlScope, refresh = false): Observable<{ rows: Deadlock[]; oldest: string | null; readAt: string }> {
    return this.http.get<{ rows: Deadlock[]; oldest: string | null; readAt: string }>('/api/sql/deadlocks', {
      params: params({ scope, refresh: refresh ? 1 : undefined }),
    });
  }

  sqlProcedures(scope: SqlScope, sort: string): Observable<{ rows: ProcStat[] }> {
    return this.http.get<{ rows: ProcStat[] }>('/api/sql/procedures', { params: params({ scope, sort }) });
  }

  /** Every procedure of the selected database: when it was last used and by whom. */
  sqlProcedureUsage(): Observable<ProcUsageResult> {
    return this.http.get<ProcUsageResult>('/api/sql/procedure-usage');
  }

  historyStatus(): Observable<HistoryStatus> {
    return this.http.get<HistoryStatus>('/api/history/status');
  }

  historySampled(query: HistoryQuery): Observable<HistoryPage<SampledActivity>> {
    return this.http.get<HistoryPage<SampledActivity>>('/api/history/sampled', { params: params(query) });
  }

  historyAudit(query: HistoryQuery): Observable<HistoryPage<AuditEvent>> {
    return this.http.get<HistoryPage<AuditEvent>>('/api/history/audit', { params: params(query) });
  }

  /** Domain logins seen in a history log, busiest first. */
  historyLogins(kind: 'sampled' | 'audit', scope: SqlScope): Observable<{ logins: { login: string; rows: number }[] }> {
    return this.http.get<{ logins: { login: string; rows: number }[] }>(`/api/history/${kind}/logins`, { params: params({ scope }) });
  }

  /** Applications seen in a history log, busiest first. */
  historyApps(kind: 'sampled' | 'audit', scope: SqlScope): Observable<{ apps: { app: string; rows: number }[] }> {
    return this.http.get<{ apps: { app: string; rows: number }[] }>(`/api/history/${kind}/apps`, { params: params({ scope }) });
  }

  /** Every row matching the filter (up to the server's limit), for export. */
  historyExport<T>(kind: 'sampled' | 'audit', query: Omit<HistoryQuery, 'page' | 'pageSize'>): Observable<{ rows: T[]; total: number; limit: number }> {
    return this.http.get<{ rows: T[]; total: number; limit: number }>(`/api/history/${kind}/export`, { params: params(query) });
  }

  latestChanges(
    limit = 200,
    module?: string,
    range: { from?: string; to?: string } = {},
    filter: { action?: string; user?: string; table?: string } = {},
  ): Observable<{ monitor: MonitorStatus; rows: LatestChangeRow[]; scannedTables: number | null; perTable?: number; elapsedMs: number }> {
    return this.http.get<{ monitor: MonitorStatus; rows: LatestChangeRow[]; scannedTables: number | null; perTable?: number; elapsedMs: number }>(
      '/api/latest-changes',
      { params: params({ limit, module, from: range.from, to: range.to, ...filter }) },
    );
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the API server.';
    return err.error?.error ?? `${err.status} ${err.statusText}`;
  }
  return (err as Error)?.message ?? 'Unexpected error';
}
