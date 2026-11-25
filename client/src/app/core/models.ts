export type RlsKind = 'none' | 'site' | 'season' | 'season_site' | 'other';

export interface Site {
  siteId: number;
  siteName: string;
  siteType: string | null;
}

export interface Season {
  season: number;
  description: string | null;
  isCurrent: boolean;
  isDefault: boolean;
}

export interface DataContext {
  siteId: number;
  season: number;
}

export interface ContextOptions {
  sites: Site[];
  seasons: Season[];
  defaults: DataContext;
  /** Number of History tables filtered by Site/Season (0 = Site/Season not used by this database). */
  rlsTables: number;
}

export interface TargetInfo {
  /** "server/database" lower-cased. */
  id: string;
  server: string;
  database: string;
  historyTables: number;
  isDefault: boolean;
}

export interface TargetsResponse {
  targets: TargetInfo[];
  servers: { server: string; ok: boolean; error: string | null; databases: number }[];
  default: string;
  active: string[];
}

export interface TableSummary {
  fullName: string;
  name: string;
  schema: string;
  module: string;
  displayName: string;
  rowCount: number;
  columnCount: number;
  sortColumn: string;
  hasAuditColumns: boolean;
  rls: RlsKind;
  isLarge: boolean;
  lastChange: string | null;
  lastChangeKnown: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  maxLength: number;
  nullable: boolean;
  isIdentity: boolean;
  sortable: boolean;
}

export interface TableDetail extends TableSummary {
  primaryKey: string[];
  actionColumn: string | null;
  userColumn: string | null;
  dateColumn: string | null;
  columns: ColumnInfo[];
}

export interface RowsPage {
  table: string;
  context: DataContext;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  totalIsEstimate: boolean;
  sort: string;
  dir: 'asc' | 'desc';
  elapsedMs: number;
  rows: Record<string, unknown>[];
}

export interface MonitorStatus {
  startedAt: string;
  lastPollAt: string | null;
  lastPollError: string | null;
  pollIntervalMs: number;
  lastChangeScanAt: string | null;
  lastChangeScanRunning: boolean;
  lastChangeScannedTables: number;
  lastChangeScanMaxRows: number;
  eventsRecorded: number;
}

export interface ModuleSummary {
  module: string;
  tables: number;
  rows: number;
}

export interface Summary {
  database: string;
  server: string;
  auth: 'sql' | 'windows';
  login: string;
  context: DataContext;
  tablePattern: string;
  tableCount: number;
  rlsTableCount: number;
  totalRows: number;
  largeTableCount: number;
  modules: ModuleSummary[];
  recentlyChangedTables: TableSummary[];
  monitor: MonitorStatus;
}

export interface ActivityEvent {
  id: number;
  table: string;
  module: string;
  displayName: string;
  delta: number;
  rowCount: number;
  detectedAt: string;
}

export interface LatestChangeRow {
  table: string;
  module: string;
  displayName: string;
  changedAt: string | null;
  action: string | null;
  user: string | null;
  summary: Record<string, unknown>;
}

export interface RowsQuery {
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  from?: string;
  to?: string;
  action?: string;
  user?: string;
  filterColumn?: string;
  filterValue?: string;
}

export const MODULE_NAMES: Record<string, string> = {
  cmr: 'Commercial Reports',
  cs: 'Coolstore',
  dash: 'Dashboards',
  edi: 'EDI',
  hq: 'Head Office',
  lab: 'Laboratory',
  lo: 'Logistics',
  ma: 'Packhouse (MA)',
  maui: 'MAUI',
  pk: 'Packing',
  pp: 'Production Planning',
  qa: 'Quality Assurance',
  scada: 'SCADA',
  sw: 'System / Shared',
  sys: 'System',
  vp: 'VP',
};

export type Severity = 'error' | 'warning' | 'info';

export interface ErrorSourceStatus {
  id: string;
  label: string;
  category: string;
  description: string;
  tableName: string;
  historyTable: string | null;
  rls: 'none' | 'season' | 'season_site' | 'server';
  available: boolean;
  unavailableReason: string | null;
  total: number;
  last24h: number;
  last7d: number;
  lastAt: string | null;
}

export interface ErrorRow {
  source: string;
  sourceLabel: string;
  category: string;
  id: unknown;
  at: string | null;
  origin: string | null;
  code: string | null;
  message: string | null;
  user: string | null;
  severity: Severity;
  extra: Record<string, unknown>;
  table: string;
  key: string | null;
  traceSql: string | null;
}

export interface ErrorsPage {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rows: ErrorRow[];
  skipped: { source: string; reason: string }[];
  elapsedMs: number;
}

export interface RecurringError {
  source: string;
  sourceLabel: string;
  category: string;
  table: string;
  origin: string | null;
  message: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface ErrorsQuery {
  source?: string;
  page: number;
  pageSize: number;
  from?: string;
  to?: string;
  search?: string;
  severity?: Severity;
}

/* ---------------- SQL activity ---------------- */

export type SqlScope = 'db' | 'server';

export interface RunningRequest {
  sessionId: number;
  db: string | null;
  status: string;
  command: string;
  procName: string | null;
  statement: string | null;
  batchText: string | null;
  startTime: string;
  elapsedMs: number;
  cpuMs: number;
  logicalReads: number;
  reads: number;
  writes: number;
  rowsAffected: number;
  waitType: string | null;
  waitMs: number;
  waitResource: string | null;
  lastWaitType: string | null;
  blockedBy: number | null;
  openTransactions: number;
  percentComplete: number;
  isolation: string;
  loginName: string;
  hostName: string | null;
  programName: string | null;
  jobName: string | null;
}

export interface BlockingSession {
  sessionId: number;
  status: string;
  db: string | null;
  loginName: string;
  hostName: string | null;
  programName: string | null;
  jobName: string | null;
  openTransactions: number;
  lastRequestStart: string | null;
  lastRequestEnd: string | null;
  blocking: number;
  blockedBy: number | null;
  lastSql: string | null;
}

export interface OpenTransaction {
  sessionId: number;
  status: string;
  db: string | null;
  transactionName: string | null;
  beganAt: string;
  openSeconds: number;
  logBytes: number;
  locks: number;
  loginName: string;
  hostName: string | null;
  programName: string | null;
  jobName: string | null;
  lastRequestEnd: string | null;
  lastSql: string | null;
}

export interface SqlLive {
  scope: SqlScope;
  server: { server: string; version: string; startedAt: string };
  at: string;
  running: RunningRequest[];
  blockers: BlockingSession[];
  transactions: OpenTransaction[];
}

export interface LockRow {
  sessionId: number;
  db: string | null;
  resourceType: string;
  mode: string;
  status: 'GRANT' | 'WAIT' | 'CONVERT';
  locks: number;
  objectName: string | null;
  loginName: string;
  programName: string | null;
  jobName: string | null;
  sessionStatus: string;
}

export interface DeadlockProcess {
  sessionId: number;
  isVictim: boolean;
  db: string | null;
  loginName: string | null;
  hostName: string | null;
  programName: string | null;
  jobName: string | null;
  lockMode: string | null;
  waitResource: string | null;
  waitMs: number | null;
  isolation: string | null;
  procName: string | null;
  lineNumber: number | null;
  inputBuffer: string | null;
}

export interface Deadlock {
  id: string;
  at: string;
  objects: string | null;
  dbs: string[];
  processes: DeadlockProcess[];
}

export interface ProcStat {
  db: string;
  procName: string;
  type: string;
  cachedAt: string;
  lastRun: string;
  executions: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  lastMs: number;
  avgCpuMs: number;
  avgReads: number;
  avgWrites: number;
}

/* ---------------- Activity history (saved locally by the server) ---------------- */

/** One statement the sampler saw executing. Sampled every few seconds, so fast statements are missing. */
export interface SampledActivity {
  id: number;
  db: string | null;
  sessionId: number;
  requestStart: string | null;
  firstSeen: string;
  lastSeen: string;
  samples: number;
  action: string;
  command: string | null;
  procName: string | null;
  statement: string | null;
  tables: string | null;
  loginName: string | null;
  hostName: string | null;
  clientAddress: string | null;
  programName: string | null;
  jobName: string | null;
  elapsedMs: number | null;
  cpuMs: number | null;
  logicalReads: number | null;
  writes: number | null;
  rowsAffected: number | null;
  /** running = seen while executing; last = the session's last finished batch, picked up afterwards. */
  capture: 'running' | 'last';
}

/** One SQL Server Audit record. */
export interface AuditEvent {
  id: number;
  eventTime: string;
  action: string;
  actionId: string;
  succeeded: boolean;
  sessionId: number | null;
  db: string | null;
  schemaName: string | null;
  objectName: string | null;
  classType: string | null;
  loginName: string | null;
  sessionLogin: string | null;
  dbUser: string | null;
  hostName: string | null;
  clientIp: string | null;
  programName: string | null;
  statement: string | null;
}

export interface HistoryPage<T> {
  rows: T[];
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
}

export interface HistoryQuery {
  scope: SqlScope;
  from?: string;
  to?: string;
  action?: string;
  search?: string;
  /** Text to find in the Who columns only. */
  who?: string;
  whoType?: 'agent' | 'user' | 'maui' | 'other';
  /** Only this login. */
  login?: string;
  /** Leave this login out. */
  notLogin?: string;
  /** Sampled log only: how the row was captured. */
  capture?: 'running' | 'last';
  page: number;
  pageSize: number;
}

export interface HistoryStatus {
  server: string;
  retentionDays: number;
  sampler: { enabled: boolean; intervalMs: number; lastPollAt: string | null; lastError: string | null };
  audit: {
    enabled: boolean;
    auditName: string;
    /** null = not checked yet. */
    found: boolean | null;
    auditEnabled: boolean | null;
    filePattern: string | null;
    lastReadAt: string | null;
    lastError: string | null;
  };
  totals: { sampledRows: number; sampledOldest: string | null; auditRows: number; auditOldest: string | null };
  auditSetupScript: string;
}