import { getTable } from './catalog.js';
import { targetState } from './target.js';
import { contextKey } from './context.js';
import { readQuery, sql, type DataContext, type PoolName } from './db.js';
import { isoParam, serializeRow, serializeValue } from './serialize.js';

/**
 * A place in the database where errors are recorded. Every source is mapped onto the same
 * row shape so the UI can show one merged, time-ordered feed. All SQL fragments below are
 * fixed (never built from user input); user values are bound as parameters.
 */
interface ErrorSource {
  id: string;
  label: string;
  category: 'SQL Server' | 'Application' | 'Integration' | 'Business';
  description: string;
  /** Real table the error row lives in (shown in the UI so users can trace it back). */
  tableName: string;
  /** SQL expression producing the WHERE predicate that selects this exact row, e.g. 'ApplErrorID = 123'. */
  key: string;
  pool: PoolName;
  /** Rows depend on the selected Site/Season (row-level security). */
  rls: 'none' | 'season' | 'season_site' | 'server';
  from: string;
  where?: string;
  id_: string;
  time: string;
  origin: string;
  code: string;
  message: string;
  user: string;
  severity: string;
  /** Extra fields shown in the detail panel: label -> SQL expression. */
  extra: Record<string, string>;
}

const AGENT_TIME =
  "CONVERT(datetime, CONVERT(char(8), h.run_date)) + CAST(STUFF(STUFF(RIGHT('000000' + CAST(h.run_time AS varchar(6)), 6), 5, 0, ':'), 3, 0, ':') AS datetime)";

export const SOURCES: ErrorSource[] = [
  {
    id: 'agent',
    label: 'SQL Agent job failures',
    category: 'SQL Server',
    description: 'Failed, retried and cancelled SQL Server Agent job steps (msdb.dbo.sysjobhistory), e.g. sqlXMLLoad queue jobs.',
    tableName: 'msdb.dbo.sysjobhistory',
    key: "'instance_id = ' + CAST(h.instance_id AS varchar(12))",
    pool: 'msdb',
    rls: 'server',
    from: 'msdb.dbo.sysjobhistory h JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id LEFT JOIN msdb.dbo.sysjobsteps s ON s.job_id = h.job_id AND s.step_id = h.step_id',
    where: 'h.step_id > 0 AND h.run_status IN (0, 2, 3)',
    id_: 'h.instance_id',
    time: AGENT_TIME,
    origin: 'j.name',
    code: "CASE h.run_status WHEN 0 THEN 'Failed' WHEN 2 THEN 'Retry' WHEN 3 THEN 'Cancelled' END + CASE WHEN h.sql_message_id > 0 THEN ' · Msg ' + CAST(h.sql_message_id AS varchar(12)) ELSE '' END",
    message: 'h.message',
    user: 'CAST(NULL AS varchar(1))',
    severity: "CASE WHEN h.run_status = 0 THEN 'error' ELSE 'warning' END",
    extra: {
      Step: "CAST(h.step_id AS varchar(10)) + ' · ' + h.step_name",
      'Step database': 's.database_name',
      'Step command': 'LEFT(s.command, 4000)',
      'Duration (hhmmss)': 'h.run_duration',
      'SQL severity': 'h.sql_severity',
      Server: 'h.server',
      'Retries attempted': 'h.retries_attempted',
    },
  },
  {
    id: 'app',
    label: 'Application errors',
    category: 'Application',
    description: 'Errors logged by Mr Apple desktop/service applications (ma_ApplicationErrorT).',
    tableName: 'dbo.ma_ApplicationErrorT',
    key: "'ApplErrorID = ' + CAST(e.ApplErrorID AS varchar(12))",
    pool: 'main',
    rls: 'none',
    from: 'dbo.ma_ApplicationErrorT e',
    id_: 'e.ApplErrorID',
    time: 'e.ErrorDateTime',
    origin: 'e.Application',
    code: 'CAST(e.ErrorNo AS varchar(20))',
    message: 'e.ErrorDesc',
    user: 'e.UserLogon',
    severity: "'error'",
    extra: { Version: 'e.Version', Form: 'e.FormName', Function: 'e.FunctionName', SiteID: 'e.SiteID', Season: 'e.Season' },
  },
  {
    id: 'pk_app',
    label: 'Packaging app errors',
    category: 'Application',
    description: 'Errors logged by the Mr Apple Packaging application (pk_App_Error_LogT).',
    tableName: 'dbo.pk_App_Error_LogT',
    key: "'AppErrorLogID = ' + CAST(e.AppErrorLogID AS varchar(12))",
    pool: 'main',
    rls: 'none',
    from: 'dbo.pk_App_Error_LogT e',
    id_: 'e.AppErrorLogID',
    time: 'e.ErrorDateTime',
    origin: 'e.AppName',
    code: 'e.ErrorNo',
    message: 'e.ErrorDesc',
    user: 'e.UserName',
    severity: "CASE WHEN e.ErrorDesc LIKE 'Application Started%' THEN 'info' ELSE 'error' END",
    extra: { Version: 'e.VersionNo', Host: 'e.HostName', Form: 'e.FormName', Function: 'e.FunctionName' },
  },
  {
    id: 'nav',
    label: 'NAV transmission errors',
    category: 'Integration',
    description: 'XML transmissions to NAV that came back with status E (xml_NAV_TransmissionT).',
    tableName: 'dbo.xml_NAV_TransmissionT',
    key: "'xmlNAVTransmissionID = ' + CAST(n.xmlNAVTransmissionID AS varchar(12))",
    pool: 'main',
    rls: 'season',
    from: 'dbo.xml_NAV_TransmissionT n',
    where: "n.TransmissionStatus = 'E'",
    id_: 'n.xmlNAVTransmissionID',
    time: 'COALESCE(n.ResponseDateTime, n.SentDateTime, n.CreatedDateTime)',
    origin: "n.xmlNAVTransmissionType + ISNULL(' · ' + n.TransmissionAction, '')",
    code: "'Status E'",
    message: "ISNULL(n.TransmissionStatusDetail, ISNULL(n.Note, ''))",
    user: 'n.CreatedByUserName',
    severity: "'error'",
    extra: {
      'Transfer no': 'n.TransferNo',
      'Run no': 'n.RunNo',
      'Batch no': 'n.BatchNo',
      'Purchase order': 'n.PurchaseOrderID',
      'Load in': 'n.LoadInID',
      'Sent at': 'n.SentDateTime',
      'Response at': 'n.ResponseDateTime',
      Retries: 'n.SentNoOfRetries',
      Note: 'n.Note',
      Season: 'n.Season',
    },
  },
  {
    id: 'xml_load',
    label: 'XML load validation errors',
    category: 'Integration',
    description: 'Validation failures when loading supplier XML transactions (pk_xml_Load_Transaction_ErrorT).',
    tableName: 'dbo.pk_xml_Load_Transaction_ErrorT',
    key: "'XMLTransErrorID = ' + CAST(x.XMLTransErrorID AS varchar(12))",
    pool: 'main',
    rls: 'none',
    from: 'dbo.pk_xml_Load_Transaction_ErrorT x',
    id_: 'x.XMLTransErrorID',
    time: 'x.CreatedDateTime',
    origin: "'XML trans ' + CAST(x.XMLTransID AS varchar(12))",
    code: "CAST(NULL AS varchar(1))",
    message: 'x.ValidationErrorMsg',
    user: 'x.CreatedByUserName',
    severity: "'error'",
    extra: { 'XML trans id': 'x.XMLTransID' },
  },
  {
    id: 'xml_monitor',
    label: 'XML monitor errors',
    category: 'Integration',
    description: 'Errors raised by the XML monitor (xml_Monitor_ErrorT).',
    tableName: 'dbo.xml_Monitor_ErrorT',
    key: "'xmlErrorID = ' + CAST(m.xmlErrorID AS varchar(12))",
    pool: 'main',
    rls: 'season',
    from: 'dbo.xml_Monitor_ErrorT m',
    id_: 'm.xmlErrorID',
    time: 'COALESCE(m.ErrorDateTime, m.CreatedDateTime)',
    origin: "'xmlID ' + CAST(m.xmlID AS varchar(12))",
    code: "CAST(NULL AS varchar(1))",
    message: 'CAST(m.Description AS varchar(max))',
    user: 'm.CreatedByUserName',
    severity: "'error'",
    extra: { 'xml id': 'm.xmlID', Resolution: 'm.Resolution', Contact: 'm.Contact', Season: 'm.Season' },
  },
  {
    id: 'pallet',
    label: 'Pallet errors',
    category: 'Business',
    description: 'Pallet processing errors (ma_Pallet_ErrorT).',
    tableName: 'dbo.ma_Pallet_ErrorT',
    key: "'PalletID = ' + CAST(p.PalletID AS varchar(12))",
    pool: 'main',
    rls: 'season_site',
    from: 'dbo.ma_Pallet_ErrorT p',
    id_: 'p.PalletID',
    time: 'p.CreatedDateTime',
    origin: "'Pallet ' + CAST(p.PalletID AS varchar(12))",
    code: "CAST(NULL AS varchar(1))",
    message: 'p.ErrorMsg',
    user: 'p.CreatedByUserName',
    severity: "'error'",
    extra: { 'Pallet id': 'p.PalletID', SiteID: 'p.SiteID', Season: 'p.Season' },
  },
  {
    id: 'pp_run',
    label: 'Production run errors',
    category: 'Business',
    description: 'Production runs with an error description (pp_RunT.ErrorDesc).',
    tableName: 'dbo.pp_RunT',
    key: "'RunRecordID = ' + CAST(r.RunRecordID AS varchar(12))",
    pool: 'main',
    rls: 'season',
    from: 'dbo.pp_RunT r',
    where: "r.ErrorDesc IS NOT NULL AND r.ErrorDesc <> ''",
    id_: 'r.RunRecordID',
    time: 'r.CreatedDateTime',
    origin: "'Run ' + CAST(r.RunNo AS varchar(12)) + ISNULL(' · ' + r.SLoc, '')",
    code: "CAST(NULL AS varchar(1))",
    message: 'r.ErrorDesc',
    user: 'r.CreatedByUserName',
    severity: "'error'",
    extra: { RPin: 'r.RPin', Variety: 'r.Variety', 'Pack date': 'r.PackDate', Season: 'r.Season' },
  },
  {
    id: 'hq_exception',
    label: 'HQ exceptions',
    category: 'Business',
    description: 'Business exceptions raised by HQ processes, e.g. stock balance checks (hq_ExceptionT).',
    tableName: 'dbo.hq_ExceptionT',
    key: "'ExceptionID = ' + CAST(x.ExceptionID AS varchar(12))",
    pool: 'main',
    rls: 'season',
    from: 'dbo.hq_ExceptionT x',
    id_: 'x.ExceptionID',
    time: 'x.CreatedDateTime',
    origin: 'x.ExceptionType',
    code: "CAST(NULL AS varchar(1))",
    message: 'x.ExceptionMsg',
    user: 'x.CreatedByUserName',
    severity: "'warning'",
    extra: { 'Exception date': 'x.ExceptionDate', 'Exception time': 'x.ExceptionTime', Season: 'x.Season' },
  },
  {
    id: 'edi',
    label: 'EDI delivery failures',
    category: 'Integration',
    description: 'EDI messages to partners whose delivery recorded an error (edi_DeliveryT.LastError). Times converted to NZ local time.',
    tableName: 'dbo.edi_DeliveryT',
    key: "'DeliveryID = ''' + CAST(d.DeliveryID AS varchar(36)) + ''''",
    pool: 'main',
    rls: 'none',
    from: 'dbo.edi_DeliveryT d',
    where: "d.LastError IS NOT NULL AND d.LastError <> ''",
    id_: 'CAST(d.DeliveryID AS varchar(36))',
    time: 'COALESCE(CAST(SWITCHOFFSET(d.CompletedAt, DATEPART(TZOFFSET, SYSDATETIMEOFFSET())) AS datetime2(3)), CAST(SWITCHOFFSET(d.CreatedAt, DATEPART(TZOFFSET, SYSDATETIMEOFFSET())) AS datetime2(3)))',
    origin: "d.Partner + ' · ' + d.MessageType",
    code: 'd.Status',
    message: 'd.LastError',
    user: 'd.RequestedBy',
    severity: "'error'",
    extra: {
      'Business key': 'd.BusinessKey',
      Attempts: 'd.AttemptCount',
      'Partner reference': 'd.PartnerReference',
      'Source subject': 'd.SourceSubject',
      'Request id': 'd.RequestID',
      SiteID: 'd.SiteID',
      Season: 'd.Season',
    },
  },
  {
    id: 'caspa_outbox',
    label: 'Caspa event outbox failures',
    category: 'Integration',
    description: 'Caspa events that failed to dispatch or were dead-lettered (Caspa_EventOutbox). Times shown as stored.',
    tableName: 'dbo.Caspa_EventOutbox',
    key: "'id = ' + CAST(o.id AS varchar(20))",
    pool: 'main',
    rls: 'none',
    from: 'dbo.Caspa_EventOutbox o',
    where: "(o.lastError IS NOT NULL AND o.lastError <> '') OR o.deadLetteredAt IS NOT NULL",
    id_: 'o.id',
    time: 'COALESCE(o.deadLetteredAt, o.dispatchedAt, o.createdAt)',
    origin: 'o.subject',
    code: "CASE WHEN o.deadLetteredAt IS NOT NULL THEN 'Dead-lettered' ELSE 'Retrying' END",
    message: "ISNULL(o.lastError, '')",
    user: 'CAST(NULL AS varchar(1))',
    severity: "CASE WHEN o.deadLetteredAt IS NOT NULL THEN 'error' ELSE 'warning' END",
    extra: { 'Event id': 'o.eventId', Attempts: 'o.attemptCount', 'Created at': 'o.createdAt', 'Correlation id': 'o.correlationId' },
  },
  {
    id: 'usda',
    label: 'USDA lot failures',
    category: 'Business',
    description: 'USDA inspection lots with a fail reason (sw_USDA_LotNoT.FailReason).',
    tableName: 'dbo.sw_USDA_LotNoT',
    key: "'USDALotNo = ''' + u.USDALotNo + ''''",
    pool: 'main',
    rls: 'season',
    from: 'dbo.sw_USDA_LotNoT u',
    where: "u.FailReason IS NOT NULL AND u.FailReason <> ''",
    id_: 'u.USDALotNo',
    time: 'COALESCE(u.InspectDate, u.CreatedDateTime)',
    origin: "'Lot ' + u.USDALotNo + ISNULL(' · ' + u.PackhouseSLoc, '')",
    code: 'u.Status',
    message: 'u.FailReason',
    user: 'u.CreatedByUserName',
    severity: "'error'",
    extra: { 'Coolstore SLoc': 'u.CoolstoreSLoc', Pallets: 'u.NoOfPallets', Samples: 'u.NoOfSamples', Comment: 'u.Comment', Season: 'u.Season' },
  },
];

export interface ErrorFilters {
  from?: string;
  to?: string;
  search?: string;
  severity?: string;
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
  severity: string;
  extra: Record<string, unknown>;
  /** Real table the row lives in, e.g. dbo.ma_ApplicationErrorT. */
  table: string;
  /** Predicate selecting this exact row, e.g. ApplErrorID = 329616. */
  key: string | null;
  /** Ready-to-run SQL (with session context when the table uses row-level security) to find the row in SSMS. */
  traceSql: string | null;
}

export interface SourceStatus {
  id: string;
  label: string;
  category: string;
  description: string;
  tableName: string;
  /** Matching *_HistoryT table that NAY-Monitor can browse, if one exists. */
  historyTable: string | null;
  rls: ErrorSource['rls'];
  available: boolean;
  unavailableReason: string | null;
  total: number;
  last24h: number;
  last7d: number;
  lastAt: string | null;
}

const PERMISSION_ERRORS = new Set([229, 230, 262, 297, 916, 4060, 18456]);

/** Invalid object / column name: the source's table isn't in this database (e.g. older site databases). */
const MISSING_ERRORS = new Set([207, 208]);

/**
 * Sources that can't be read in the current database, re-checked later: permission errors after 5 minutes,
 * missing tables after 30 minutes. Kept per database (target).
 */
const unavailable = () =>
  targetState('errors.unavailable', () => new Map<string, { reason: string; until: number; missing: boolean }>());

function errorNumber(err: unknown): number | undefined {
  const e = err as { number?: number; code?: number; originalError?: { info?: { number?: number } } };
  return e.number ?? e.originalError?.info?.number ?? (typeof e.code === 'number' ? e.code : undefined);
}

function unavailableKind(err: unknown): 'permission' | 'missing' | null {
  const n = errorNumber(err);
  const msg = (err as Error)?.message ?? '';
  if ((n !== undefined && MISSING_ERRORS.has(n)) || /invalid (object|column) name/i.test(msg)) return 'missing';
  if ((n !== undefined && PERMISSION_ERRORS.has(n)) || /permission was denied|login failed|cannot open database/i.test(msg)) return 'permission';
  return null;
}

/** Remember a source as unreadable when the error says so; returns true if it did. */
function markIfUnavailable(s: ErrorSource, err: unknown): boolean {
  const kind = unavailableKind(err);
  if (!kind) return false;
  unavailable().set(s.id, {
    reason: kind === 'missing' ? 'Not in this database' : (err as Error).message,
    until: Date.now() + (kind === 'missing' ? 30 : 5) * 60_000,
    missing: kind === 'missing',
  });
  return true;
}

function isMissing(s: ErrorSource): boolean {
  return !!unavailable().get(s.id)?.missing && unavailableReason(s) !== null;
}

export function getSource(id: string): ErrorSource | undefined {
  return SOURCES.find((s) => s.id === id);
}

function unavailableReason(s: ErrorSource): string | null {
  const u = unavailable().get(s.id);
  if (!u) return null;
  if (Date.now() > u.until) {
    unavailable().delete(s.id);
    return null;
  }
  return u.reason;
}

function buildWhere(s: ErrorSource, f: ErrorFilters) {
  const where: string[] = [];
  const params: Record<string, { type: sql.ISqlType; value: unknown }> = {};
  if (s.where) where.push(`(${s.where})`);
  if (f.from) {
    where.push(`${s.time} >= CONVERT(datetime2, @from, 126)`);
    params.from = { type: sql.VarChar(30), value: isoParam(f.from) };
  }
  if (f.to) {
    where.push(`${s.time} <= CONVERT(datetime2, @to, 126)`);
    params.to = { type: sql.VarChar(30), value: isoParam(f.to, true) };
  }
  if (f.search) {
    where.push(`(${s.message} LIKE @search OR ${s.origin} LIKE @search OR ISNULL(${s.code}, '') LIKE @search)`);
    params.search = { type: sql.NVarChar(400), value: `%${f.search}%` };
  }
  if (f.severity) {
    where.push(`${s.severity} = @severity`);
    params.severity = { type: sql.VarChar(10), value: f.severity };
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function selectList(s: ErrorSource): string {
  const extras = Object.entries(s.extra).map(([label, expr], i) => `${expr} AS [x${i}]`);
  return [
    `${s.id_} AS id`,
    `${s.time} AS at`,
    `${s.origin} AS origin`,
    `${s.code} AS code`,
    `${s.message} AS message`,
    `${s.user} AS userName`,
    `${s.severity} AS severity`,
    `${s.key} AS traceKey`,
    ...extras,
  ].join(', ');
}

/** History table for an error table, e.g. dbo.hq_ExceptionT -> dbo.hq_Exception_HistoryT. */
export function historyTableFor(s: ErrorSource): string | null {
  if (s.pool !== 'main') return null;
  const base = s.tableName.replace(/T$/, '');
  for (const candidate of [`${base}_HistoryT`, `${base}HistoryT`]) {
    const t = getTable(candidate);
    if (t) return t.fullName;
  }
  return null;
}

function traceSql(s: ErrorSource, key: string | null, ctx: DataContext): string | null {
  if (!key) return null;
  const lines: string[] = [];
  if (s.pool === 'msdb') lines.push('USE msdb;');
  if (s.rls === 'season' || s.rls === 'season_site') {
    lines.push('-- Row-level security: set the same site/season NAY-Monitor used');
    if (s.rls === 'season_site') lines.push(`EXEC sys.sp_set_session_context @key = N'SiteID', @value = ${ctx.siteId};`);
    lines.push(`EXEC sys.sp_set_session_context @key = N'Season', @value = ${ctx.season};`);
  }
  lines.push(`SELECT * FROM ${s.tableName} WHERE ${key};`);
  return lines.join('\n');
}

function toRow(s: ErrorSource, r: Record<string, unknown>, ctx: DataContext): ErrorRow {
  const v = serializeRow(r);
  const extra: Record<string, unknown> = {};
  Object.keys(s.extra).forEach((label, i) => {
    const x = v[`x${i}`];
    if (x !== null && x !== undefined && x !== '') extra[label] = x;
  });
  return {
    source: s.id,
    sourceLabel: s.label,
    category: s.category,
    id: v.id,
    at: (v.at as string) ?? null,
    origin: (v.origin as string) ?? null,
    code: (v.code as string) ?? null,
    message: typeof v.message === 'string' ? v.message.trim() : ((v.message as string) ?? null),
    user: (v.userName as string) ?? null,
    severity: String(v.severity ?? 'error'),
    extra,
    table: s.tableName,
    key: (v.traceKey as string) ?? null,
    traceSql: traceSql(s, (v.traceKey as string) ?? null, ctx),
  };
}

async function querySource(
  s: ErrorSource,
  f: ErrorFilters,
  ctx: DataContext,
  offset: number,
  size: number,
  signal?: AbortSignal,
): Promise<{ rows: ErrorRow[]; total: number }> {
  const w = buildWhere(s, f);
  const opts = { context: s.rls === 'server' ? undefined : ctx, pool: s.pool, dirty: true, signal };
  const [rows, count] = await Promise.all([
    readQuery<Record<string, unknown>>(
      `SELECT ${selectList(s)} FROM ${s.from} ${w.sql} ORDER BY at DESC, id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`,
      { ...opts, params: { ...w.params, offset: { type: sql.Int, value: offset }, size: { type: sql.Int, value: size } } },
    ),
    readQuery<{ n: number | string }>(`SELECT COUNT_BIG(*) AS n FROM ${s.from} ${w.sql}`, { ...opts, params: w.params }),
  ]);
  return { rows: rows.map((r) => toRow(s, r, ctx)), total: Number(count[0]?.n ?? 0) };
}

/** Errors from one source (OFFSET paging) or from all sources merged by time. */
export async function queryErrors(
  sourceId: string | undefined,
  f: ErrorFilters,
  ctx: DataContext,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
) {
  const targets = sourceId ? SOURCES.filter((s) => s.id === sourceId) : SOURCES;
  const offset = (page - 1) * pageSize;
  const skipped: { source: string; reason: string }[] = [];

  const results = await Promise.all(
    targets.map(async (s) => {
      const reason = unavailableReason(s);
      if (reason) {
        if (!isMissing(s)) skipped.push({ source: s.id, reason });
        return { rows: [] as ErrorRow[], total: 0 };
      }
      try {
        // Merged view: each source returns its newest (offset + size) rows; the merge keeps the right page.
        return sourceId ? await querySource(s, f, ctx, offset, pageSize, signal) : await querySource(s, f, ctx, 0, offset + pageSize, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        markIfUnavailable(s, err);
        if (!isMissing(s)) skipped.push({ source: s.id, reason: (err as Error).message });
        return { rows: [] as ErrorRow[], total: 0 };
      }
    }),
  );

  const total = results.reduce((n, r) => n + r.total, 0);
  let rows = results.flatMap((r) => r.rows);
  if (!sourceId) {
    rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    rows = rows.slice(offset, offset + pageSize);
  }
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), rows, skipped };
}

const statsCache = () => targetState('errors.stats', () => new Map<string, { at: number; data: SourceStatus[] }>());

export async function sourceStatuses(ctx: DataContext, force = false): Promise<SourceStatus[]> {
  const key = contextKey(ctx);
  const cached = statsCache().get(key);
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.data;

  const data = await Promise.all(
    SOURCES.map(async (s): Promise<SourceStatus> => {
      const base = {
        id: s.id,
        label: s.label,
        category: s.category,
        description: s.description,
        tableName: s.tableName,
        historyTable: historyTableFor(s),
        rls: s.rls,
      };
      const reason = unavailableReason(s);
      if (reason) return { ...base, available: false, unavailableReason: reason, total: 0, last24h: 0, last7d: 0, lastAt: null };
      try {
        const where = s.where ? `WHERE ${s.where}` : '';
        const [r] = await readQuery<{ total: number | string; h24: number | null; d7: number | null; lastAt: Date | null }>(
          `SELECT COUNT_BIG(*) AS total,
                  SUM(CASE WHEN ${s.time} >= DATEADD(HOUR, -24, GETDATE()) THEN 1 ELSE 0 END) AS h24,
                  SUM(CASE WHEN ${s.time} >= DATEADD(DAY, -7, GETDATE()) THEN 1 ELSE 0 END) AS d7,
                  MAX(${s.time}) AS lastAt
           FROM ${s.from} ${where}`,
          { context: s.rls === 'server' ? undefined : ctx, pool: s.pool, dirty: true },
        );
        return {
          ...base,
          available: true,
          unavailableReason: null,
          total: Number(r?.total ?? 0),
          last24h: Number(r?.h24 ?? 0),
          last7d: Number(r?.d7 ?? 0),
          lastAt: (serializeValue(r?.lastAt) as string) ?? null,
        };
      } catch (err) {
        markIfUnavailable(s, err);
        return { ...base, available: false, unavailableReason: (err as Error).message, total: 0, last24h: 0, last7d: 0, lastAt: null };
      }
    }),
  );
  // Hide sources whose table doesn't exist in this database (site databases don't have every table).
  const visible = data.filter((d) => !SOURCES.some((s) => s.id === d.id && isMissing(s)));
  statsCache().set(key, { at: Date.now(), data: visible });
  return visible;
}

/** Most frequent error messages in the last N days, grouped per source. */
export async function recurringErrors(
  sourceId: string | undefined,
  range: { from?: string; to?: string },
  ctx: DataContext,
  signal?: AbortSignal,
) {
  const targets = sourceId ? SOURCES.filter((s) => s.id === sourceId) : SOURCES;
  const groups = await Promise.all(
    targets.map(async (s) => {
      if (unavailableReason(s)) return [];
      const conds = [...(s.where ? [`(${s.where})`] : [])];
      const params: Record<string, { type: sql.ISqlType; value: unknown }> = {};
      if (range.from) {
        conds.push(`${s.time} >= CONVERT(datetime2, @from, 126)`);
        params.from = { type: sql.VarChar(30), value: isoParam(range.from) };
      }
      if (range.to) {
        conds.push(`${s.time} <= CONVERT(datetime2, @to, 126)`);
        params.to = { type: sql.VarChar(30), value: isoParam(range.to, true) };
      }
      const where = conds.length ? conds.join(' AND ') : '1 = 1';
      try {
        const rows = await readQuery<{ origin: string | null; message: string | null; n: number | string; firstAt: Date; lastAt: Date }>(
          `SELECT TOP (25) ${s.origin} AS origin, LEFT(${s.message}, 300) AS message, COUNT_BIG(*) AS n, MIN(${s.time}) AS firstAt, MAX(${s.time}) AS lastAt
           FROM ${s.from} WHERE ${where}
           GROUP BY ${s.origin}, LEFT(${s.message}, 300)
           ORDER BY n DESC`,
          {
            context: s.rls === 'server' ? undefined : ctx,
            pool: s.pool,
            dirty: true,
            signal,
            params,
          },
        );
        return rows.map((r) => ({
          source: s.id,
          sourceLabel: s.label,
          category: s.category,
          table: s.tableName,
          origin: r.origin,
          message: r.message?.trim() ?? null,
          count: Number(r.n),
          firstAt: serializeValue(r.firstAt) as string,
          lastAt: serializeValue(r.lastAt) as string,
        }));
      } catch (err) {
        if (signal?.aborted) throw err;
        markIfUnavailable(s, err);
        return [];
      }
    }),
  );
  return groups
    .flat()
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);
}

export function agentGrantScript(user: string): string {
  return [
    '-- Run as a sysadmin on the SQL Server that hosts the Agent jobs.',
    '-- Gives read-only access to job history; nothing else.',
    'USE msdb;',
    `IF USER_ID('${user}') IS NULL CREATE USER [${user}] FOR LOGIN [${user}];`,
    `GRANT SELECT ON dbo.sysjobs TO [${user}];`,
    `GRANT SELECT ON dbo.sysjobhistory TO [${user}];`,
    `GRANT SELECT ON dbo.sysjobsteps TO [${user}];`,
  ].join('\n');
}
