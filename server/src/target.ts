import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';

/** A server + database NAY-Monitor can monitor. */
export interface Target {
  /** "server/database", lower-cased — used as the cache key and in the X-Target header. */
  id: string;
  server: string;
  database: string;
}

export interface TargetInfo extends Target {
  historyTables: number;
  isDefault: boolean;
}

export function makeTarget(server: string, database: string): Target {
  return { id: `${server}/${database}`.toLowerCase(), server, database };
}

let defaultT: Target | null = null;

/** The database opened first: the first DB_DATABASES entry found on the servers (set by discovery). */
export function defaultTarget(): Target {
  if (!defaultT) throw new TargetError('No databases available — check DB_SERVERS / DB_DATABASES in server/.env');
  return defaultT;
}

export function setDefaultTarget(t: Target | null): void {
  defaultT = t;
}

/**
 * The database the current request (or background job) is working on. Every module reads its
 * per-database state through this, so the same code serves many databases at once.
 */
const als = new AsyncLocalStorage<Target>();

export function currentTarget(): Target {
  return als.getStore() ?? defaultTarget();
}

export function runInTarget<T>(target: Target, fn: () => T): T {
  return als.run(target, fn);
}

/** Per-database state: one instance of each named bucket per target. */
const states = new Map<string, Map<string, unknown>>();

export function targetState<T>(bucket: string, init: () => T, target: Target = currentTarget()): T {
  let s = states.get(target.id);
  if (!s) {
    s = new Map();
    states.set(target.id, s);
  }
  if (!s.has(bucket)) s.set(bucket, init());
  return s.get(bucket) as T;
}

/* ---------------- Discovery ---------------- */

let known: TargetInfo[] = [];

export function setKnownTargets(list: TargetInfo[]): void {
  known = list;
}

export function knownTargets(): TargetInfo[] {
  return known;
}

export class TargetError extends Error {}

/** Resolve the X-Target header (or ?target=) against the discovered databases. */
export function targetFrom(req: Request): Target {
  const raw = req.get('x-target') ?? (req.query.target as string | undefined);
  if (!raw) return defaultTarget();
  const id = decodeURIComponent(raw).toLowerCase();
  const t = known.find((k) => k.id === id);
  if (!t) throw new TargetError(`Unknown or unavailable database '${raw}'`);
  return makeTarget(t.server, t.database);
}
