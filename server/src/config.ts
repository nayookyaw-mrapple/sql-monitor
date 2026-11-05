import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see server/.env.example)`);
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int('PORT', 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',
  db: {
    /**
     * 'windows' = Windows Authentication (Trusted_Connection) as the account running the Node process,
     * via the msnodesqlv8 ODBC driver. 'sql' = SQL login with DB_USER / DB_PASSWORD.
     */
    auth: (process.env.DB_AUTH ?? 'sql').toLowerCase() === 'windows' ? ('windows' as const) : ('sql' as const),
    /** ODBC driver used for Windows Authentication. */
    odbcDriver: process.env.DB_ODBC_DRIVER ?? 'ODBC Driver 18 for SQL Server',
    user: (process.env.DB_AUTH ?? 'sql').toLowerCase() === 'windows' ? '' : required('DB_USER'),
    password: (process.env.DB_AUTH ?? 'sql').toLowerCase() === 'windows' ? '' : required('DB_PASSWORD'),
    encrypt: (process.env.DB_ENCRYPT ?? 'true') === 'true',
    trustServerCertificate: (process.env.DB_TRUST_SERVER_CERTIFICATE ?? 'true') === 'true',
    /** Timeout for data queries. Large unindexed History tables can take minutes to sort. */
    requestTimeoutMs: int('DB_REQUEST_TIMEOUT_MS', 300_000),
  },
  /**
   * SQL Servers to search for databases (comma-separated). Every database on them that the login can open
   * and that has *HistoryT tables can be offered in the Database selector. (DB_SERVER is still accepted.)
   */
  servers: (() => {
    const list = [
      ...new Set(
        [...(process.env.DB_SERVERS ?? '').split(','), process.env.DB_SERVER ?? '']
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.toUpperCase()),
      ),
    ];
    if (list.length === 0) throw new Error('Set DB_SERVERS in server/.env (comma-separated SQL Server names)');
    return list;
  })(),
  /**
   * Databases shown in the Database selector, in order (comma-separated, case-insensitive). Each entry is a
   * database name ("MrApple") or "server/database" ("hq-sql-sites-01/MrApple"). The FIRST one found is the
   * default. Empty = every database with History tables. (A legacy DB_DATABASE is treated as the first entry.)
   */
  databases: [
    ...new Set(
      [process.env.DB_SERVER && process.env.DB_DATABASE ? `${process.env.DB_SERVER}/${process.env.DB_DATABASE}` : '', ...(process.env.DB_DATABASES ?? '').split(',')]
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ],
  /** Monitoring of a database stops after this long without anyone viewing it. */
  targetIdleMs: int('TARGET_IDLE_MS', 60 * 60_000),
  /** Site used when the client sends no X-Site-Id header. */
  defaultSiteId: int('DEFAULT_SITE_ID', 1),
  /**
   * Optional separate login for SQL Agent job history in msdb (needs SELECT on msdb.dbo.sysjobs,
   * sysjobhistory, sysjobsteps). When not set, the main DB login is used.
   */
  msdb: {
    user: process.env.MSDB_USER || process.env.DB_USER!,
    password: process.env.MSDB_PASSWORD || process.env.DB_PASSWORD!,
  },
  /** Only tables whose name matches this LIKE pattern are exposed. */
  tablePattern: process.env.TABLE_PATTERN ?? '%HistoryT',
  /** How often row counts are polled to detect new history rows (cheap metadata query). */
  activityPollMs: int('ACTIVITY_POLL_MS', 15_000),
  /** How often the catalog (tables/columns) is reloaded. */
  catalogRefreshMs: int('CATALOG_REFRESH_MS', 10 * 60_000),
  /** Tables at or below this row count get their "last change" time computed in the background. */
  lastChangeScanMaxRows: int('LAST_CHANGE_SCAN_MAX_ROWS', 1_000_000),
  /** Full refresh interval for the background "last change" scan. */
  lastChangeRefreshMs: int('LAST_CHANGE_REFRESH_MS', 15 * 60_000),
  /** Tables at or above this row count are flagged as "large" in the UI. */
  largeTableRows: int('LARGE_TABLE_ROWS', 1_000_000),
  /** Read with READ UNCOMMITTED so long monitoring scans never block application writes. */
  readUncommitted: (process.env.READ_UNCOMMITTED ?? 'true') === 'true',
};
