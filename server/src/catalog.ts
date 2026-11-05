import { config } from './config.js';
import { q, readQuery, sql } from './db.js';
import { currentTarget, targetState } from './target.js';

export interface ColumnInfo {
  name: string;
  type: string;
  maxLength: number;
  nullable: boolean;
  isIdentity: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  /** schema.name — the identifier used by the API. */
  fullName: string;
  /** Module prefix, e.g. "cs", "ma", "sw". */
  module: string;
  /** Name without module prefix and trailing "HistoryT", e.g. "FDC_Status". */
  displayName: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  /** Column used for "latest first" ordering. */
  sortColumn: string;
  /** True when the table has the standard HistoryDateTime / HistoryUserName / RecordAction audit columns. */
  hasAuditColumns: boolean;
  actionColumn: string | null;
  userColumn: string | null;
  /** Physical row count from partition metadata (all sites/seasons). */
  rowCount: number;
  /** Row-level security filter applied to this table, if any. */
  rls: 'none' | 'site' | 'season' | 'season_site' | 'other';
}

/** Catalog of the current database (one per target). */
const cat = () => targetState('catalog', () => ({ tables: new Map<string, TableInfo>(), loadedAt: null as Date | null }));

const DATE_TYPES = new Set(['datetime', 'datetime2', 'smalldatetime', 'date', 'datetimeoffset']);
const PREFERRED_SORT = ['HistoryDateTime', 'HistoryDate', 'ModifiedDateTime', 'DateModified', 'CreatedDateTime', 'CreateDateTime', 'CreateDate'];

function pickSortColumn(columns: ColumnInfo[], primaryKey: string[]): string {
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  for (const p of PREFERRED_SORT) {
    const c = byName.get(p.toLowerCase());
    if (c && DATE_TYPES.has(c.type)) return c.name;
  }
  const identity = columns.find((c) => c.isIdentity);
  if (identity) return identity.name;
  const anyDate = columns.find((c) => DATE_TYPES.has(c.type));
  if (anyDate) return anyDate.name;
  return primaryKey[0] ?? columns[0].name;
}

function splitName(name: string): { module: string; displayName: string } {
  const idx = name.indexOf('_');
  const module = idx > 0 ? name.slice(0, idx) : 'other';
  let rest = idx > 0 ? name.slice(idx + 1) : name;
  rest = rest.replace(/_?HistoryT$/i, '') || rest;
  return { module, displayName: rest };
}

export async function loadCatalog(): Promise<void> {
  const params = { pattern: { type: sql.NVarChar(256), value: config.tablePattern } };

  const [tableRows, columnRows, pkRows, countRows, rlsRows] = await Promise.all([
    readQuery<{ schemaName: string; tableName: string }>(
      `SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName
       FROM sys.tables t WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern`,
      { params },
    ),
    readQuery<{ schemaName: string; tableName: string; columnName: string; typeName: string; maxLength: number; isNullable: boolean; isIdentity: boolean }>(
      `SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName, c.name AS columnName,
              TYPE_NAME(c.system_type_id) AS typeName, c.max_length AS maxLength,
              c.is_nullable AS isNullable, c.is_identity AS isIdentity
       FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
       WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern
       ORDER BY t.object_id, c.column_id`,
      { params },
    ),
    readQuery<{ schemaName: string; tableName: string; columnName: string }>(
      `SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName, c.name AS columnName
       FROM sys.tables t
       JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern
       ORDER BY t.object_id, ic.key_ordinal`,
      { params },
    ),
    fetchRowCounts(),
    readQuery<{ schemaName: string; tableName: string; predicate: string }>(
      `SELECT SCHEMA_NAME(t.schema_id) AS schemaName, t.name AS tableName, pr.predicate_definition AS predicate
       FROM sys.security_predicates pr
       JOIN sys.security_policies sp ON sp.object_id = pr.object_id AND sp.is_enabled = 1
       JOIN sys.tables t ON t.object_id = pr.target_object_id
       WHERE pr.predicate_type = 0 AND t.name LIKE @pattern`,
      { params },
    ),
  ]);
  const rlsBy = new Map<string, TableInfo['rls']>();
  for (const r of rlsRows) {
    const p = r.predicate;
    rlsBy.set(
      `${r.schemaName}.${r.tableName}`,
      /Season_and_Site/i.test(p) ? 'season_site' : /Predicate_Season\b/i.test(p) ? 'season' : /Predicate_Site\b/i.test(p) ? 'site' : 'other',
    );
  }

  const key = (s: string, t: string) => `${s}.${t}`;
  const colsBy = new Map<string, ColumnInfo[]>();
  for (const r of columnRows) {
    const k = key(r.schemaName, r.tableName);
    if (!colsBy.has(k)) colsBy.set(k, []);
    colsBy.get(k)!.push({ name: r.columnName, type: r.typeName, maxLength: r.maxLength, nullable: r.isNullable, isIdentity: r.isIdentity });
  }
  const pkBy = new Map<string, string[]>();
  for (const r of pkRows) {
    const k = key(r.schemaName, r.tableName);
    if (!pkBy.has(k)) pkBy.set(k, []);
    pkBy.get(k)!.push(r.columnName);
  }

  const next = new Map<string, TableInfo>();
  for (const t of tableRows) {
    const fullName = key(t.schemaName, t.tableName);
    const columns = colsBy.get(fullName) ?? [];
    if (columns.length === 0) continue;
    const primaryKey = pkBy.get(fullName) ?? [];
    const names = new Set(columns.map((c) => c.name));
    const { module, displayName } = splitName(t.tableName);
    next.set(fullName.toLowerCase(), {
      schema: t.schemaName,
      name: t.tableName,
      fullName,
      module,
      displayName,
      columns,
      primaryKey,
      sortColumn: pickSortColumn(columns, primaryKey),
      hasAuditColumns: names.has('HistoryDateTime') && names.has('RecordAction'),
      actionColumn: names.has('RecordAction') ? 'RecordAction' : null,
      userColumn: names.has('HistoryUserName') ? 'HistoryUserName' : names.has('HistoryBy') ? 'HistoryBy' : null,
      rowCount: countRows.get(fullName.toLowerCase()) ?? 0,
      rls: rlsBy.get(fullName) ?? 'none',
    });
  }
  const c = cat();
  c.tables = next;
  c.loadedAt = new Date();
  const t = currentTarget();
  console.log(`[catalog] ${t.server}/${t.database}: loaded ${next.size} tables matching '${config.tablePattern}'`);
}

/** Row counts from partition metadata — instant, no table scan. Keyed by lower-case schema.name. */
export async function fetchRowCounts(): Promise<Map<string, number>> {
  const rows = await readQuery<{ fullName: string; totalRows: number | string }>(
    `SELECT SCHEMA_NAME(t.schema_id) + '.' + t.name AS fullName, SUM(p.row_count) AS totalRows
     FROM sys.tables t
     JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     WHERE t.is_ms_shipped = 0 AND t.name LIKE @pattern
     GROUP BY t.schema_id, t.name`,
    { params: { pattern: { type: sql.NVarChar(256), value: config.tablePattern } } },
  );
  return new Map(rows.map((r) => [r.fullName.toLowerCase(), Number(r.totalRows)]));
}

export function getTables(): TableInfo[] {
  return [...cat().tables.values()];
}

export function getTable(fullName: string): TableInfo | undefined {
  const key = fullName.includes('.') ? fullName : `dbo.${fullName}`;
  return cat().tables.get(key.toLowerCase());
}

export function catalogLoadedAt(): Date | null {
  return cat().loadedAt;
}

export function qualified(t: TableInfo): string {
  return `${q(t.schema)}.${q(t.name)}`;
}
