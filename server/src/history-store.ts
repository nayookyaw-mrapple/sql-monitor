/**
 * Local SQLite file that keeps the activity history (who ran what). This is the only thing NAY-Monitor
 * writes to, and it lives on the machine running the server — never on SQL Server.
 *
 *  - sampled_activity: what the sampler saw in "Running now" (incomplete by nature: fast statements are missed).
 *  - audit_event:      records copied from SQL Server Audit files (complete, when a DBA has set the audit up).
 *
 * Times are stored as "YYYY-MM-DD HH:mm:ss.SSS" in the SQL Server's local time, like everywhere else in the app.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { formatDate } from './serialize.js';

type Value = string | number | null;

export interface SampleRow {
  /** Identifies one statement of one request, so repeated sightings update the same row. */
  key: string;
  db: string | null;
  sessionId: number;
  requestStart: string | null;
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
}

export interface AuditRow {
  /** UTC time with full precision, only used to tell records apart. */
  eventUtc: string;
  eventTime: string;
  sequence: number;
  actionId: string;
  action: string;
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

let handle: DatabaseSync | null = null;

export function historyDbPath(): string {
  const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  return isAbsolute(config.history.dbPath) ? config.history.dbPath : join(serverDir, config.history.dbPath);
}

function db(): DatabaseSync {
  if (handle) return handle;
  const path = historyDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS sampled_activity (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      server TEXT NOT NULL,
      db TEXT,
      session_id INTEGER,
      request_start TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      samples INTEGER NOT NULL DEFAULT 1,
      action TEXT,
      command TEXT,
      proc_name TEXT,
      statement TEXT,
      tables TEXT,
      login_name TEXT,
      host_name TEXT,
      client_address TEXT,
      program_name TEXT,
      job_name TEXT,
      elapsed_ms INTEGER,
      cpu_ms INTEGER,
      logical_reads INTEGER,
      writes INTEGER,
      rows_affected INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_sampled_time ON sampled_activity (server, first_seen);
    CREATE TABLE IF NOT EXISTS audit_event (
      id INTEGER PRIMARY KEY,
      dedupe BLOB NOT NULL UNIQUE,
      server TEXT NOT NULL,
      event_time TEXT NOT NULL,
      action TEXT,
      action_id TEXT,
      succeeded INTEGER,
      session_id INTEGER,
      db TEXT,
      schema_name TEXT,
      object_name TEXT,
      class_type TEXT,
      login_name TEXT,
      session_login TEXT,
      db_user TEXT,
      host_name TEXT,
      client_ip TEXT,
      program_name TEXT,
      statement TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_audit_time ON audit_event (server, event_time);
    CREATE TABLE IF NOT EXISTS audit_state (
      server TEXT PRIMARY KEY,
      file_name TEXT,
      file_offset TEXT
    );
  `);
  handle = d;
  return d;
}

function inTransaction<T>(fn: () => T): T {
  const d = db();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/* ---------------- Writes ---------------- */

export function saveSamples(server: string, seenAt: string, rows: SampleRow[]): void {
  if (rows.length === 0) return;
  const st = db().prepare(
    `INSERT INTO sampled_activity (key, server, db, session_id, request_start, first_seen, last_seen, action, command, proc_name, statement,
       tables, login_name, host_name, client_address, program_name, job_name, elapsed_ms, cpu_ms, logical_reads, writes, rows_affected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET last_seen = excluded.last_seen, samples = samples + 1, elapsed_ms = excluded.elapsed_ms,
       cpu_ms = excluded.cpu_ms, logical_reads = excluded.logical_reads, writes = excluded.writes, rows_affected = excluded.rows_affected`,
  );
  inTransaction(() => {
    for (const r of rows) {
      st.run(
        r.key, server, r.db, r.sessionId, r.requestStart, seenAt, seenAt, r.action, r.command, r.procName, r.statement,
        r.tables, r.loginName, r.hostName, r.clientAddress, r.programName, r.jobName, r.elapsedMs, r.cpuMs, r.logicalReads, r.writes, r.rowsAffected,
      );
    }
  });
}

/** Returns how many of the rows were new (re-read records are ignored). */
export function saveAuditEvents(server: string, rows: AuditRow[]): number {
  if (rows.length === 0) return 0;
  const st = db().prepare(
    `INSERT OR IGNORE INTO audit_event (dedupe, server, event_time, action, action_id, succeeded, session_id, db, schema_name, object_name,
       class_type, login_name, session_login, db_user, host_name, client_ip, program_name, statement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return inTransaction(() => {
    let added = 0;
    for (const r of rows) {
      const dedupe = createHash('sha1')
        .update([server, r.eventUtc, r.sessionId, r.sequence, r.actionId, r.db, r.schemaName, r.objectName, r.classType, r.statement].join('\u0001'))
        .digest();
      const res = st.run(
        dedupe, server, r.eventTime, r.action, r.actionId, r.succeeded ? 1 : 0, r.sessionId, r.db, r.schemaName, r.objectName,
        r.classType, r.loginName, r.sessionLogin, r.dbUser, r.hostName, r.clientIp, r.programName, r.statement,
      );
      added += Number(res.changes);
    }
    return added;
  });
}

/** Where the audit reader got to (file + offset inside it), so each poll only reads new records. */
export function getAuditPosition(server: string): { fileName: string | null; offset: string | null } {
  const r = db().prepare('SELECT file_name AS fileName, file_offset AS offset FROM audit_state WHERE server = ?').get(server) as
    | { fileName: string | null; offset: string | null }
    | undefined;
  return { fileName: r?.fileName ?? null, offset: r?.offset ?? null };
}

export function setAuditPosition(server: string, fileName: string | null, offset: string | null): void {
  db()
    .prepare(
      `INSERT INTO audit_state (server, file_name, file_offset) VALUES (?, ?, ?)
       ON CONFLICT (server) DO UPDATE SET file_name = excluded.file_name, file_offset = excluded.file_offset`,
    )
    .run(server, fileName, offset);
}

/** Delete rows older than the retention period. */
export function pruneHistory(): { sampled: number; audit: number } {
  const cutoff = formatDate(new Date(Date.now() - config.history.retentionDays * 86_400_000));
  const sampled = Number(db().prepare('DELETE FROM sampled_activity WHERE last_seen < ?').run(cutoff).changes);
  const audit = Number(db().prepare('DELETE FROM audit_event WHERE event_time < ?').run(cutoff).changes);
  return { sampled, audit };
}

/* ---------------- Reads ---------------- */

export interface HistoryFilter {
  server: string;
  /** Only this database; undefined = the whole server. */
  db?: string;
  from?: string;
  to?: string;
  action?: string;
  search?: string;
  page: number;
  pageSize: number;
}

const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function page(table: string, timeCol: string, searchCols: string[], select: string, f: HistoryFilter) {
  const where = ['server = ?'];
  const params: Value[] = [f.server];
  if (f.db) {
    where.push('db = ? COLLATE NOCASE');
    params.push(f.db);
  }
  if (f.from) {
    where.push(`${timeCol} >= ?`);
    params.push(f.from.replace('T', ' '));
  }
  if (f.to) {
    where.push(`${timeCol} <= ?`);
    params.push(f.to.replace('T', ' '));
  }
  if (f.action) {
    where.push('action = ?');
    params.push(f.action);
  }
  if (f.search) {
    where.push(`(${searchCols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < searchCols.length; i++) params.push(like(f.search));
  }
  const whereSql = where.join(' AND ');
  const total = Number((db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereSql}`).get(...params) as { n: number }).n);
  const rows = db()
    .prepare(`SELECT ${select} FROM ${table} WHERE ${whereSql} ORDER BY ${timeCol} DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize);
  return { rows, total, totalPages: Math.max(1, Math.ceil(total / f.pageSize)) };
}

export function querySampled(f: HistoryFilter) {
  return page(
    'sampled_activity',
    'first_seen',
    ['statement', 'proc_name', 'tables', 'login_name', 'host_name', 'program_name', 'job_name', 'client_address'],
    `id, db, session_id AS sessionId, request_start AS requestStart, first_seen AS firstSeen, last_seen AS lastSeen, samples, action, command,
     proc_name AS procName, statement, tables, login_name AS loginName, host_name AS hostName, client_address AS clientAddress,
     program_name AS programName, job_name AS jobName, elapsed_ms AS elapsedMs, cpu_ms AS cpuMs, logical_reads AS logicalReads,
     writes, rows_affected AS rowsAffected`,
    f,
  );
}

export function queryAudit(f: HistoryFilter) {
  const r = page(
    'audit_event',
    'event_time',
    ['object_name', 'statement', 'login_name', 'session_login', 'db_user', 'host_name', 'client_ip', 'program_name'],
    `id, event_time AS eventTime, action, action_id AS actionId, succeeded, session_id AS sessionId, db, schema_name AS schemaName,
     object_name AS objectName, class_type AS classType, login_name AS loginName, session_login AS sessionLogin, db_user AS dbUser,
     host_name AS hostName, client_ip AS clientIp, program_name AS programName, statement`,
    f,
  );
  return { ...r, rows: r.rows.map((x) => ({ ...x, succeeded: x.succeeded === 1 })) };
}

/** Row counts and oldest row per log, for the status line. */
export function historyTotals(server: string) {
  const one = (table: string, col: string) =>
    db().prepare(`SELECT COUNT(*) AS n, MIN(${col}) AS oldest FROM ${table} WHERE server = ?`).get(server) as { n: number; oldest: string | null };
  const s = one('sampled_activity', 'first_seen');
  const a = one('audit_event', 'event_time');
  return { sampledRows: Number(s.n), sampledOldest: s.oldest, auditRows: Number(a.n), auditOldest: a.oldest };
}
