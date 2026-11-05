import { config } from './config.js';
import { fetchRowCounts, getTable, getTables, loadCatalog, qualified, type TableInfo } from './catalog.js';
import { contextKey, loadContextOptions } from './context.js';
import { q, readQuery, sql, type DataContext } from './db.js';
import { formatDate, isoParam, serializeRow } from './serialize.js';
import { currentTarget, runInTarget, targetState, type Target } from './target.js';

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

/** Per Site/Season cache of each small table's newest rows. */
interface ContextCache {
  ctx: DataContext;
  lastChange: Map<string, string | null>;
  latestRows: Map<string, LatestChangeRow[]>;
  pending: Set<string>;
  scanning: boolean;
  lastScanAt: Date | null;
  lastUsed: number;
}

const MAX_EVENTS = 1000;
const MAX_CONTEXTS = 6;
/** A Site/Season cache nobody has viewed for this long is dropped and no longer rescanned. */
const CONTEXT_IDLE_MS = config.targetIdleMs;
const DATE_TYPES = new Set(['datetime', 'datetime2', 'smalldatetime', 'date', 'datetimeoffset']);
const AUDIT_COLS = /^(History|Created|Modified|DateModified|CreateDate|RecordAction|Season$|SiteID$)/i;

/** Monitoring state of the current database (one per target). */
const mon = () =>
  targetState('monitor', () => ({
    events: [] as ActivityEvent[],
    nextEventId: 1,
    lastCounts: new Map<string, number>(),
    lastPollAt: null as Date | null,
    lastPollError: null as string | null,
    startedAt: new Date(),
    caches: new Map<string, ContextCache>(),
    rangeCache: new Map<string, { at: number; rows: LatestChangeRow[]; scanned: number }>(),
  }));

/** Get (and start populating) the cache for a Site/Season. */
function cacheFor(ctx: DataContext): ContextCache {
  const { caches } = mon();
  const key = contextKey(ctx);
  let c = caches.get(key);
  if (!c) {
    if (caches.size >= MAX_CONTEXTS) {
      const oldest = [...caches.entries()].filter(([, v]) => !v.scanning).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) caches.delete(oldest[0]);
    }
    c = { ctx, lastChange: new Map(), latestRows: new Map(), pending: new Set(), scanning: false, lastScanAt: null, lastUsed: Date.now() };
    caches.set(key, c);
    void runScan(c);
  }
  c.lastUsed = Date.now();
  return c;
}

export function getEvents(limit: number, sinceId = 0): ActivityEvent[] {
  return mon()
    .events.filter((e) => e.id > sinceId)
    .slice(-limit)
    .reverse();
}

export function getLastChange(ctx: DataContext, fullName: string): string | null | undefined {
  return cacheFor(ctx).lastChange.get(fullName.toLowerCase());
}

export function monitorStatus(ctx?: DataContext) {
  const m = mon();
  const c = ctx ? cacheFor(ctx) : undefined;
  return {
    startedAt: formatDate(m.startedAt),
    lastPollAt: m.lastPollAt ? formatDate(m.lastPollAt) : null,
    lastPollError: m.lastPollError,
    pollIntervalMs: config.activityPollMs,
    lastChangeScanAt: c?.lastScanAt ? formatDate(c.lastScanAt) : null,
    lastChangeScanRunning: c?.scanning ?? false,
    lastChangeScannedTables: c?.lastChange.size ?? 0,
    lastChangeScanMaxRows: config.lastChangeScanMaxRows,
    eventsRecorded: m.nextEventId - 1,
  };
}

/**
 * Newest history rows inside a date range, across all tables up to the scan threshold.
 * Only tables whose newest change (from the background scan) falls inside the range are
 * queried, so "last 7 days" touches just the handful of tables that actually changed.
 */
export async function getLatestChangesInRange(
  ctx: DataContext,
  limit: number,
  module: string | undefined,
  from: string | undefined,
  to: string | undefined,
  signal?: AbortSignal,
): Promise<{ rows: LatestChangeRow[]; scannedTables: number }> {
  const { rangeCache } = mon();
  const key = `${contextKey(ctx)}|${module ?? ''}|${from ?? ''}|${to ?? ''}|${limit}`;
  const hit = rangeCache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return { rows: hit.rows, scannedTables: hit.scanned };

  const cache = cacheFor(ctx);
  const fromCmp = from?.replace('T', ' ');
  const candidates = getTables().filter((t) => {
    if (module && t.module !== module) return false;
    if (t.rowCount > config.lastChangeScanMaxRows) return false;
    if (!t.columns.some((c) => c.name === t.sortColumn && DATE_TYPES.has(c.type))) return false;
    const last = cache.lastChange.get(t.fullName.toLowerCase());
    if (last === null) return false; // table has no rows for this site/season
    if (last !== undefined && fromCmp && last < fromCmp) return false; // nothing newer than the range start
    return true;
  });

  const perTable = 25;
  const params: Record<string, { type: sql.ISqlType; value: unknown }> = {};
  if (from) params.from = { type: sql.VarChar(30), value: isoParam(from) };
  if (to) params.to = { type: sql.VarChar(30), value: isoParam(to, true) };

  const out: LatestChangeRow[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (i < candidates.length) {
        const t = candidates[i++];
        const col = q(t.sortColumn);
        const w: string[] = [];
        if (from) w.push(`${col} >= CONVERT(datetime2, @from, 126)`);
        if (to) w.push(`${col} <= CONVERT(datetime2, @to, 126)`);
        const tie = t.primaryKey.filter((k) => k !== t.sortColumn).map((k) => `${q(k)} DESC`);
        try {
          const rows = await readQuery<Record<string, unknown>>(
            `SELECT TOP (${perTable}) * FROM ${qualified(t)} ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY ${[`${col} DESC`, ...tie].join(', ')}`,
            { params, context: ctx, dirty: true, signal },
          );
          for (const raw of rows) out.push(toLatestRow(t, serializeRow(raw)));
        } catch (err) {
          if (signal?.aborted) throw err;
          console.warn(`[monitor] range query failed for ${t.fullName}: ${(err as Error).message}`);
        }
      }
    }),
  );
  out.sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? ''));
  const rows = out.slice(0, limit);
  rangeCache.set(key, { at: Date.now(), rows, scanned: candidates.length });
  if (rangeCache.size > 50) rangeCache.delete(rangeCache.keys().next().value!);
  return { rows, scannedTables: candidates.length };
}

function toLatestRow(t: TableInfo, r: Record<string, unknown>): LatestChangeRow {
  const v = r[t.sortColumn];
  return {
    table: t.fullName,
    module: t.module,
    displayName: t.displayName,
    changedAt: v == null ? null : String(v),
    action: t.actionColumn ? ((r[t.actionColumn] as string) ?? null) : null,
    user: t.userColumn ? ((r[t.userColumn] as string) ?? null) : null,
    summary: summaryOf(t, r),
  };
}

export function getLatestChanges(ctx: DataContext, limit: number, module?: string): LatestChangeRow[] {
  const all: LatestChangeRow[] = [];
  for (const rows of cacheFor(ctx).latestRows.values()) {
    for (const r of rows) if (!module || r.module === module) all.push(r);
  }
  all.sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? ''));
  return all.slice(0, limit);
}

async function pollRowCounts(): Promise<void> {
  const m = mon();
  try {
    const counts = await fetchRowCounts();
    const now = new Date();
    const changed: string[] = [];
    for (const [key, count] of counts) {
      const t = getTable(key);
      if (!t) continue;
      t.rowCount = count;
      const prev = m.lastCounts.get(key);
      if (m.lastCounts.size === 0 || prev === undefined || prev === count) continue;
      m.events.push({
        id: m.nextEventId++,
        table: t.fullName,
        module: t.module,
        displayName: t.displayName,
        delta: count - prev,
        rowCount: count,
        detectedAt: formatDate(now),
      });
      if (count <= config.lastChangeScanMaxRows) changed.push(key);
    }
    if (m.events.length > MAX_EVENTS) m.events.splice(0, m.events.length - MAX_EVENTS);
    m.lastCounts = counts;
    m.lastPollAt = now;
    m.lastPollError = null;
    // Refresh the newest rows of changed tables for every Site/Season someone is looking at.
    if (changed.length) {
      for (const c of m.caches.values()) {
        changed.forEach((k) => c.pending.add(k));
        if (!c.scanning) void runScan(c, [...c.pending]);
      }
    }
  } catch (err) {
    m.lastPollError = (err as Error).message;
    console.error(`[monitor] ${currentTarget().id}: row count poll failed:`, m.lastPollError);
  }
}

function summaryOf(t: TableInfo, row: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const c of t.columns) {
    if (Object.keys(summary).length >= 4) break;
    if (AUDIT_COLS.test(c.name) || c.type === 'uniqueidentifier') continue;
    const v = row[c.name];
    if (v === null || v === undefined || v === '') continue;
    summary[c.name] = v;
  }
  return summary;
}

async function scanTable(c: ContextCache, t: TableInfo): Promise<void> {
  const sortCol = t.sortColumn;
  const tie = t.primaryKey.filter((k) => k !== sortCol).map((k) => `${q(k)} DESC`);
  const rows = await readQuery<Record<string, unknown>>(
    `SELECT TOP (5) * FROM ${qualified(t)} ORDER BY ${[`${q(sortCol)} DESC`, ...tie].join(', ')}`,
    { dirty: true, context: c.ctx },
  );
  const key = t.fullName.toLowerCase();
  const serialized = rows.map(serializeRow);
  const newest = serialized[0]?.[sortCol];
  c.lastChange.set(key, newest == null ? null : String(newest));
  c.latestRows.set(
    key,
    serialized.map((r) => toLatestRow(t, r)),
  );
}

async function runScan(c: ContextCache, keys?: string[]): Promise<void> {
  if (c.scanning) return;
  c.scanning = true;
  try {
    const targets = (keys ? keys.map((k) => getTable(k)).filter((t): t is TableInfo => !!t) : getTables())
      .filter((t) => t.rowCount <= config.lastChangeScanMaxRows)
      .sort((a, b) => a.rowCount - b.rowCount);
    for (const k of keys ?? []) c.pending.delete(k);
    const concurrency = 3;
    let i = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (i < targets.length) {
          const t = targets[i++];
          try {
            await scanTable(c, t);
          } catch (err) {
            console.warn(`[monitor] last-change scan failed for ${t.fullName} (${contextKey(c.ctx)}): ${(err as Error).message}`);
          }
        }
      }),
    );
    if (!keys) {
      c.lastScanAt = new Date();
      console.log(`[monitor] ${currentTarget().id}: last-change scan finished for site:season ${contextKey(c.ctx)} (${c.lastChange.size} tables)`);
    }
  } finally {
    c.scanning = false;
  }
  if (c.pending.size > 0) void runScan(c, [...c.pending]);
}

/* ---------------- Activation per database ---------------- */

interface Activation {
  ready: Promise<void>;
  timers: NodeJS.Timeout[];
  lastUsed: number;
}

const activations = new Map<string, Activation>();

/**
 * Start monitoring a database the first time someone looks at it: load its catalog and site/season
 * lists, take a row-count baseline, and start the background timers. Databases nobody views are
 * stopped again (see stopIdleTargets) so production servers are only polled while someone is watching.
 */
export function ensureTarget(target: Target): Promise<void> {
  const existing = activations.get(target.id);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.ready;
  }
  const a: Activation = { ready: Promise.resolve(), timers: [], lastUsed: Date.now() };
  a.ready = runInTarget(target, async () => {
    await loadCatalog();
    await loadContextOptions();
    const m = mon();
    m.lastCounts = new Map(); // fresh baseline: don't report changes made while nobody was watching
    m.startedAt = new Date();
    await pollRowCounts();

    a.timers.push(setInterval(() => runInTarget(target, () => void pollRowCounts()), config.activityPollMs));
    a.timers.push(
      setInterval(
        () =>
          runInTarget(target, () => {
            const now = Date.now();
            for (const [key, c] of mon().caches) {
              if (now - c.lastUsed > CONTEXT_IDLE_MS) mon().caches.delete(key);
              else void runScan(c);
            }
          }),
        config.lastChangeRefreshMs,
      ),
    );
    a.timers.push(
      setInterval(
        () =>
          runInTarget(target, () =>
            void Promise.all([loadCatalog(), loadContextOptions()])
              .then(() => {
                for (const [key, count] of mon().lastCounts) {
                  const t = getTable(key);
                  if (t) t.rowCount = count;
                }
              })
              .catch((err) => console.error(`[catalog] ${target.id}: refresh failed`, err)),
          ),
        config.catalogRefreshMs,
      ),
    );
    a.timers.forEach((t) => t.unref());
  }).catch((err) => {
    activations.delete(target.id);
    throw err;
  });
  activations.set(target.id, a);
  return a.ready;
}

function stopIdleTargets(): void {
  const now = Date.now();
  for (const [id, a] of activations) {
    if (now - a.lastUsed < config.targetIdleMs) continue;
    a.timers.forEach(clearInterval);
    activations.delete(id);
    console.log(`[monitor] ${id}: stopped (idle)`);
  }
}

export async function startMonitor(): Promise<void> {
  setInterval(stopIdleTargets, 60_000).unref();
}

export function activeTargets(): string[] {
  return [...activations.keys()];
}
