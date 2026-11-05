import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { catalogLoadedAt, getTable, getTables, qualified, type TableInfo } from './catalog.js';
import { ContextError, contextFrom, contextOptions } from './context.js';
import { CancelledError, q, readQuery, sql, type DataContext } from './db.js';
import { activeTargets, getEvents, getLastChange, getLatestChanges, getLatestChangesInRange, monitorStatus } from './monitor.js';
import { discoveryStatus } from './discovery.js';
import { currentTarget, defaultTarget, knownTargets, targetState, TargetError } from './target.js';
import { isoParam, serializeRow } from './serialize.js';
import { agentGrantScript, getSource, queryErrors, recurringErrors, sourceStatuses } from './errors.js';
import { deadlocks, liveActivity, lockSummary, procedureStats, procSortKeys, type Scope } from './sqlactivity.js';

export const api = Router();

const NUMERIC = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'bit']);
const DATE = new Set(['datetime', 'datetime2', 'smalldatetime', 'date', 'datetimeoffset']);
const UNSORTABLE = new Set(['text', 'ntext', 'image', 'xml', 'geography', 'geometry', 'hierarchyid', 'sql_variant', 'varbinary', 'binary']);
const PAGE_SIZES = [10, 25, 50, 100, 200, 500];

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function tableSummary(t: TableInfo, ctx: DataContext) {
  const last = getLastChange(ctx, t.fullName);
  return {
    fullName: t.fullName,
    name: t.name,
    schema: t.schema,
    module: t.module,
    displayName: t.displayName,
    rowCount: t.rowCount,
    columnCount: t.columns.length,
    sortColumn: t.sortColumn,
    hasAuditColumns: t.hasAuditColumns,
    rls: t.rls,
    isLarge: t.rowCount >= config.largeTableRows,
    lastChange: last ?? null,
    lastChangeKnown: last !== undefined,
  };
}

function requireTable(name: string): TableInfo {
  const t = getTable(name);
  if (!t) throw new HttpError(404, `Unknown table '${name}'`);
  return t;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function isLocalDateTime(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?$/.test(v);
}

/** Cancels the SQL request when the browser goes away (navigates, changes page, presses Cancel). */
function abortOnClose(res: Response): AbortSignal {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

api.get('/health', async (_req, res) => {
  const t0 = Date.now();
  await readQuery('SELECT 1 AS ok');
  res.json({ ok: true, database: currentTarget().database, server: currentTarget().server, dbLatencyMs: Date.now() - t0 });
});

/** Sites and seasons for the header selectors. */
api.get('/context', (_req, res) => {
  res.json(contextOptions());
});

/** The login NAY-Monitor is connected as: the SQL login, or DOMAIN\user with Windows Authentication. */
async function dbLogin(): Promise<string> {
  const s = targetState('login', () => ({ name: null as string | null }));
  if (!s.name) s.name = (await readQuery<{ l: string }>('SELECT SUSER_SNAME() AS l'))[0]?.l ?? '?';
  return s.name;
}

/** Databases offered in the header's Database selector. */
api.get('/targets', (_req, res) => {
  res.json({ targets: knownTargets(), servers: discoveryStatus(), default: defaultTarget().id, active: activeTargets() });
});

api.get('/summary', async (req, res) => {
  const ctx = contextFrom(req);
  const tables = getTables();
  const modules = new Map<string, { module: string; tables: number; rows: number }>();
  for (const t of tables) {
    const m = modules.get(t.module) ?? { module: t.module, tables: 0, rows: 0 };
    m.tables++;
    m.rows += t.rowCount;
    modules.set(t.module, m);
  }
  const recent = tables
    .map((t) => tableSummary(t, ctx))
    .filter((t) => t.lastChange)
    .sort((a, b) => (b.lastChange ?? '').localeCompare(a.lastChange ?? ''))
    .slice(0, 15);
  res.json({
    database: currentTarget().database,
    server: currentTarget().server,
    target: currentTarget().id,
    auth: config.db.auth,
    login: await dbLogin(),
    context: ctx,
    tablePattern: config.tablePattern,
    catalogLoadedAt: catalogLoadedAt(),
    tableCount: tables.length,
    rlsTableCount: tables.filter((t) => t.rls !== 'none').length,
    totalRows: tables.reduce((s, t) => s + t.rowCount, 0),
    largeTableCount: tables.filter((t) => t.rowCount >= config.largeTableRows).length,
    modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)),
    recentlyChangedTables: recent,
    monitor: monitorStatus(ctx),
  });
});

api.get('/tables', (req, res) => {
  const ctx = contextFrom(req);
  const module = str(req.query.module);
  const search = str(req.query.search)?.toLowerCase();
  const list = getTables()
    .filter((t) => !module || t.module === module)
    .filter((t) => !search || t.fullName.toLowerCase().includes(search))
    .map((t) => tableSummary(t, ctx))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(list);
});

api.get('/tables/:name', (req, res) => {
  const ctx = contextFrom(req);
  const t = requireTable(String(req.params.name));
  res.json({
    ...tableSummary(t, ctx),
    primaryKey: t.primaryKey,
    actionColumn: t.actionColumn,
    userColumn: t.userColumn,
    dateColumn: t.columns.some((c) => c.name === t.sortColumn && DATE.has(c.type)) ? t.sortColumn : null,
    columns: t.columns.map((c) => ({ ...c, sortable: !UNSORTABLE.has(c.type) })),
  });
});

api.get('/tables/:name/actions', async (req, res) => {
  const ctx = contextFrom(req);
  const t = requireTable(String(req.params.name));
  if (!t.actionColumn) {
    res.json([]);
    return;
  }
  if (t.rowCount > config.lastChangeScanMaxRows) {
    res.json(['Record Inserted', 'Record Updated', 'Record Deleted']);
    return;
  }
  const rows = await readQuery<{ v: string }>(
    `SELECT DISTINCT TOP (50) ${q(t.actionColumn)} AS v FROM ${qualified(t)} WHERE ${q(t.actionColumn)} IS NOT NULL ORDER BY v`,
    { dirty: true, context: ctx, signal: abortOnClose(res) },
  );
  res.json(rows.map((r) => r.v));
});

api.get('/tables/:name/rows', async (req, res) => {
  const ctx = contextFrom(req);
  const t = requireTable(String(req.params.name));
  const started = Date.now();

  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const requestedSize = Number.parseInt(String(req.query.pageSize ?? '50'), 10);
  const pageSize = PAGE_SIZES.includes(requestedSize) ? requestedSize : 50;

  const sortCol = t.columns.find((c) => c.name.toLowerCase() === (str(req.query.sort) ?? t.sortColumn).toLowerCase());
  if (!sortCol || UNSORTABLE.has(sortCol.type)) throw new HttpError(400, 'Invalid sort column');
  const dir = String(req.query.dir ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const where: string[] = [];
  const params: Record<string, { type: sql.ISqlTypeFactory | sql.ISqlType; value: unknown }> = {};
  const dateCol = t.columns.find((c) => c.name === t.sortColumn && DATE.has(c.type));

  const from = str(req.query.from);
  const to = str(req.query.to);
  if ((from || to) && !dateCol) throw new HttpError(400, 'This table has no date column to filter on');
  if (from) {
    if (!isLocalDateTime(from)) throw new HttpError(400, 'Invalid "from" date');
    where.push(`${q(dateCol!.name)} >= CONVERT(datetime2, @from, 126)`);
    params.from = { type: sql.VarChar(30), value: isoParam(from) };
  }
  if (to) {
    if (!isLocalDateTime(to)) throw new HttpError(400, 'Invalid "to" date');
    where.push(`${q(dateCol!.name)} <= CONVERT(datetime2, @to, 126)`);
    params.to = { type: sql.VarChar(30), value: isoParam(to, true) };
  }

  const action = str(req.query.action);
  if (action && t.actionColumn) {
    where.push(`${q(t.actionColumn)} = @action`);
    params.action = { type: sql.VarChar(50), value: action };
  }

  const user = str(req.query.user);
  if (user && t.userColumn) {
    where.push(`${q(t.userColumn)} LIKE @user`);
    params.user = { type: sql.NVarChar(260), value: `%${user}%` };
  }

  const filterColumn = str(req.query.filterColumn);
  const filterValue = str(req.query.filterValue);
  if (filterColumn && filterValue) {
    const fc = t.columns.find((c) => c.name.toLowerCase() === filterColumn.toLowerCase());
    if (!fc) throw new HttpError(400, 'Invalid filter column');
    if (NUMERIC.has(fc.type)) {
      if (!/^-?\d+(\.\d+)?$/.test(filterValue)) throw new HttpError(400, `"${fc.name}" is numeric — enter a number`);
      where.push(`${q(fc.name)} = TRY_CAST(@fv AS decimal(38, 10))`);
      params.fv = { type: sql.VarChar(60), value: filterValue };
    } else if (fc.type === 'uniqueidentifier') {
      where.push(`${q(fc.name)} = TRY_CAST(@fv AS uniqueidentifier)`);
      params.fv = { type: sql.VarChar(60), value: filterValue };
    } else if (DATE.has(fc.type)) {
      if (!isLocalDateTime(filterValue)) throw new HttpError(400, 'Use YYYY-MM-DD for date columns');
      where.push(`CAST(${q(fc.name)} AS date) = CAST(@fv AS date)`);
      params.fv = { type: sql.VarChar(30), value: filterValue };
    } else if (!UNSORTABLE.has(fc.type) || fc.type === 'text' || fc.type === 'ntext') {
      where.push(`CAST(${q(fc.name)} AS nvarchar(max)) LIKE @fv`);
      params.fv = { type: sql.NVarChar(4000), value: `%${filterValue}%` };
    } else {
      throw new HttpError(400, `Cannot filter on ${fc.type} column`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const tie = t.primaryKey.filter((k) => k !== sortCol.name).map((k) => `${q(k)} ${dir}`);
  const orderSql = [`${q(sortCol.name)} ${dir}`, ...tie].join(', ');
  const pageParams = {
    ...params,
    offset: { type: sql.Int, value: (page - 1) * pageSize },
    size: { type: sql.Int, value: pageSize },
  };

  const signal = abortOnClose(res);
  // Metadata row counts are only valid when nothing filters the rows (no WHERE, no row-level security).
  const exactCountNeeded = where.length > 0 || t.rls !== 'none';

  const [rows, countRows] = await Promise.all([
    readQuery<Record<string, unknown>>(
      `SELECT * FROM ${qualified(t)} ${whereSql} ORDER BY ${orderSql} OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`,
      { params: pageParams, signal, dirty: true, context: ctx },
    ),
    exactCountNeeded
      ? readQuery<{ n: number | string }>(`SELECT COUNT_BIG(*) AS n FROM ${qualified(t)} ${whereSql}`, { params, signal, dirty: true, context: ctx })
      : Promise.resolve([{ n: t.rowCount }]),
  ]);

  const total = Number(countRows[0]?.n ?? 0);
  res.json({
    table: t.fullName,
    context: ctx,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    totalIsEstimate: !exactCountNeeded,
    sort: sortCol.name,
    dir: dir.toLowerCase(),
    elapsedMs: Date.now() - started,
    rows: rows.map(serializeRow),
  });
});

api.get('/activity', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number.parseInt(String(req.query.limit ?? '200'), 10) || 200));
  const sinceId = Number.parseInt(String(req.query.sinceId ?? '0'), 10) || 0;
  res.json({ monitor: monitorStatus(), events: getEvents(limit, sinceId) });
});

api.get('/latest-changes', async (req, res) => {
  const ctx = contextFrom(req);
  const limit = Math.min(1000, Math.max(1, Number.parseInt(String(req.query.limit ?? '100'), 10) || 100));
  const module = str(req.query.module);
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (from && !isLocalDateTime(from)) throw new HttpError(400, 'Invalid "from" date');
  if (to && !isLocalDateTime(to)) throw new HttpError(400, 'Invalid "to" date');
  const started = Date.now();
  if (!from && !to) {
    // All time: newest 5 rows of every table, straight from the background cache.
    res.json({ context: ctx, monitor: monitorStatus(ctx), rows: getLatestChanges(ctx, limit, module), scannedTables: null, elapsedMs: 0 });
    return;
  }
  const r = await getLatestChangesInRange(ctx, limit, module, from, to, abortOnClose(res));
  res.json({ context: ctx, monitor: monitorStatus(ctx), rows: r.rows, scannedTables: r.scannedTables, elapsedMs: Date.now() - started });
});

/* ---------------- Errors & failures ---------------- */

api.get('/errors/sources', async (req, res) => {
  const ctx = contextFrom(req);
  const sources = await sourceStatuses(ctx, req.query.refresh === '1');
  res.json({ context: ctx, sources, agentGrantScript: agentGrantScript(config.db.auth === 'windows' ? await dbLogin() : config.msdb.user) });
});

api.get('/errors', async (req, res) => {
  const ctx = contextFrom(req);
  const source = str(req.query.source);
  if (source && !getSource(source)) throw new HttpError(400, `Unknown error source '${source}'`);
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const requestedSize = Number.parseInt(String(req.query.pageSize ?? '50'), 10);
  const pageSize = PAGE_SIZES.includes(requestedSize) ? requestedSize : 50;
  // The merged view fetches (offset + size) rows from every source, so cap how deep it can page.
  if (!source && page * pageSize > 10_000) throw new HttpError(400, 'Choose a single source or narrow the date range to page this far back');
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (from && !isLocalDateTime(from)) throw new HttpError(400, 'Invalid "from" date');
  if (to && !isLocalDateTime(to)) throw new HttpError(400, 'Invalid "to" date');
  const severity = str(req.query.severity);
  if (severity && !['error', 'warning', 'info'].includes(severity)) throw new HttpError(400, 'Invalid severity');

  const started = Date.now();
  const result = await queryErrors(source, { from, to, search: str(req.query.search), severity }, ctx, page, pageSize, abortOnClose(res));
  res.json({ ...result, context: ctx, elapsedMs: Date.now() - started });
});

api.get('/errors/recurring', async (req, res) => {
  const ctx = contextFrom(req);
  const source = str(req.query.source);
  if (source && !getSource(source)) throw new HttpError(400, `Unknown error source '${source}'`);
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (from && !isLocalDateTime(from)) throw new HttpError(400, 'Invalid "from" date');
  if (to && !isLocalDateTime(to)) throw new HttpError(400, 'Invalid "to" date');
  res.json({ rows: await recurringErrors(source, { from, to }, ctx, abortOnClose(res)) });
});

/* ---------------- SQL activity (running, locks, deadlocks, procedure stats) ---------------- */

function scopeOf(req: Request): Scope {
  return req.query.scope === 'server' ? 'server' : 'db';
}

api.get('/sql/live', async (req, res) => {
  res.json(await liveActivity(scopeOf(req), req.query.background === '1', abortOnClose(res)));
});

api.get('/sql/locks', async (req, res) => {
  res.json({ rows: await lockSummary(scopeOf(req), abortOnClose(res)) });
});


api.get('/sql/deadlocks', async (req, res) => {
  res.json(await deadlocks(scopeOf(req), req.query.refresh === '1', abortOnClose(res)));
});

api.get('/sql/procedures', async (req, res) => {
  const sort = str(req.query.sort) ?? 'total';
  if (!procSortKeys.includes(sort)) throw new HttpError(400, 'Invalid sort');
  res.json({ rows: await procedureStats(scopeOf(req), sort, abortOnClose(res)) });
});

// Express 5 forwards async errors here.
api.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
  if (err instanceof CancelledError) {
    if (!res.headersSent) res.status(499).end();
    return;
  }
  const status = err instanceof HttpError ? err.status : err instanceof ContextError || err instanceof TargetError ? 400 : 500;
  const message = (err as Error)?.message ?? 'Unexpected error';
  if (status >= 500) console.error('[api]', err);
  if (!res.headersSent) res.status(status).json({ error: message });
});
