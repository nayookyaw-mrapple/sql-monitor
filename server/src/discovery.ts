import { config } from './config.js';
import { q, readQuery } from './db.js';
import { makeTarget, setDefaultTarget, setKnownTargets, type TargetInfo } from './target.js';

export interface ServerStatus {
  server: string;
  ok: boolean;
  error: string | null;
  databases: number;
}

let serverStatus: ServerStatus[] = [];

/** SQL string literal for a database name (names come from sys.databases, but quote them anyway). */
function lit(v: string): string {
  return `N'${v.replace(/'/g, "''")}'`;
}

/** Databases on one server that this login can open and that contain *HistoryT tables. */
async function discoverServer(server: string): Promise<TargetInfo[]> {
  const dbs = await readQuery<{ name: string }>(
    `SELECT name FROM sys.databases
     WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 AND source_database_id IS NULL
     ORDER BY name`,
    { pool: 'master', server },
  );
  if (dbs.length === 0) return [];
  const pattern = config.tablePattern.replace(/'/g, "''");
  const union = dbs
    .map((d) => `SELECT ${lit(d.name)} AS name, (SELECT COUNT(*) FROM ${q(d.name)}.sys.tables WHERE name LIKE N'${pattern}') AS n`)
    .join(' UNION ALL ');
  const rows = await readQuery<{ name: string; n: number }>(`SELECT name, n FROM (${union}) x WHERE n > 0 ORDER BY name`, {
    pool: 'master',
    server,
  });
  return rows.map((r) => {
    const t = makeTarget(server, r.name);
    return { ...t, historyTables: r.n, isDefault: false };
  });
}

export async function discoverTargets(): Promise<void> {
  const all: TargetInfo[] = [];
  const status: ServerStatus[] = [];
  await Promise.all(
    config.servers.map(async (server) => {
      try {
        const found = await discoverServer(server);
        all.push(...found);
        status.push({ server, ok: true, error: null, databases: found.length });
      } catch (err) {
        console.error(`[discovery] ${server}: ${(err as Error).message}`);
        status.push({ server, ok: false, error: (err as Error).message, databases: 0 });
      }
    }),
  );
  // Keep only the databases in DB_DATABASES (by name, or server/name), in DB_SERVERS order.
  const allowed = config.databases;
  const serverRank = (t: TargetInfo) => config.servers.indexOf(t.server.toUpperCase());
  all.sort((a, b) => serverRank(a) - serverRank(b) || a.database.localeCompare(b.database));
  const matches = (t: TargetInfo, entry: string) => t.id === entry || t.database.toLowerCase() === entry;
  const visible = allowed.length ? all.filter((t) => allowed.some((e) => matches(t, e))) : all;

  // Default = the first DB_DATABASES entry that exists (or the first database found when the list is empty).
  const def = allowed.length ? allowed.map((e) => visible.find((t) => matches(t, e))).find(Boolean) : visible[0];
  for (const t of visible) t.isDefault = t.id === def?.id;
  setDefaultTarget(def ? makeTarget(def.server, def.database) : null);

  visible.sort((a, b) => a.server.localeCompare(b.server) || a.database.localeCompare(b.database));
  setKnownTargets(visible);
  for (const name of allowed) {
    if (!visible.some((t) => t.database.toLowerCase() === name || t.id === name)) {
      console.warn(`[discovery] DB_DATABASES entry '${name}' not found on ${config.servers.join(', ')}`);
    }
  }
  serverStatus = status.sort((a, b) => a.server.localeCompare(b.server));
  console.log(`[discovery] showing ${visible.length} of ${all.length} databases on ${config.servers.join(', ')}; default ${def ? `${def.server}/${def.database}` : 'none'}`);
}

export function discoveryStatus(): ServerStatus[] {
  return serverStatus;
}
