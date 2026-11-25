# SQL Monitor

Read-only monitor for the `*HistoryT` audit tables in **MrApple_DEV** (MRA-SQL-UAT-01).

- `server/` – Node.js + TypeScript + Express + `mssql` API (GET only)
- `client/` – Angular 22 app (Dashboard, Latest changes, Live activity, All tables, per-module menus, table viewer)

## Run (development)

```bash
npm run install:all
npm run dev:server     # API on http://localhost:3000
npm run dev:client     # UI  on http://localhost:4200 (proxies /api to :3000)
```

Connection settings live in `server/.env` (copy from `server/.env.example`). `.env` is git-ignored.

### Windows Authentication

Set `DB_AUTH=windows` in `server/.env` (no user/password needed). The server then connects as the Windows
account **running the Node process** (`Trusted_Connection`) through the `msnodesqlv8` ODBC driver, using
`DB_ODBC_DRIVER` (default `ODBC Driver 18 for SQL Server`, already installed on this PC). Set `DB_AUTH=sql` to go
back to `DB_USER` / `DB_PASSWORD`. The header shows which login is in use. If the server is later run as a
Windows service, it connects as that service account, so grant that account read access.

## Run (single server)

```bash
npm run build && npm start   # UI + API on http://localhost:3000
```

## Choosing the database

The **Database** selector in the header is set up with two lines in `server/.env`:

```
DB_SERVERS=MRA-SQL-UAT-01,hq-sql-sites-01
DB_DATABASES=MrApple_DEV,MrApple,MrApple_UAT_MTM
```

`DB_SERVERS` lists the SQL Servers to search. `DB_DATABASES` lists the databases to show, and **the first one found
is the default** (opened first). Entries are database names, or `server/database` when the same name exists on
several servers. Leave `DB_DATABASES` empty to show every database with `*HistoryT` tables. Databases that aren't
listed are hidden and the API refuses them. The choice is sent on every request as the `X-Target` header, and
Site/Season are remembered separately for each database.

- Every database, the default included, is only monitored (row-count polling, last-change scan) while someone is
  viewing it, and monitoring stops after `TARGET_IDLE_MS` (default 1 hour; 10 minutes in this project's .env) with
  nobody viewing it. When nobody has the app open, the backend doesn't query SQL Server, except for the
  always-on activity history on the servers in `HISTORY_SERVERS` (see "Activity history" below).
- Site/Season is only shown for databases that use row-level security. The per-site databases on
  hq-sql-sites-01 don't, so they show "All sites & seasons".
- Error sources whose table doesn't exist in the selected database are hidden automatically.
- The database list is refreshed every 30 minutes; restart the server after changing `DB_SERVERS` or `DB_DATABASES`.

## Site and Season (row-level security)

275 of the 530 history tables have SQL Server row-level security filtering on `SiteID` and/or `Season`
via `SESSION_CONTEXT`. Without a context, SQL defaults to HQ (SiteID 1) and the current calendar year,
so most tables look empty.

The **Site** and **Season** selectors in the header are sent on every request as `X-Site-Id` / `X-Season`
headers. The server validates them against `sw_Environment_Site_DBT` / `sw_SeasonT` and runs
`sp_set_session_context` at the start of every query batch (always resetting both keys, so pooled
connections never leak context).

## Read-only guarantees

The `maui` login is `db_owner`, so read-only is enforced by the service:

- only `GET`/`HEAD`/`OPTIONS` routes; anything else returns 405
- every statement comes from a fixed SELECT template; table/column names must exist in the catalog and are bracket-quoted
- all user values are bound parameters
- `assertReadOnly()` rejects any statement containing DML/DDL/EXEC keywords
- data queries use `READ UNCOMMITTED` so long scans never block application writes (set `READ_UNCOMMITTED=false` to change)

## Performance notes

- Rows are ordered by `HistoryDateTime DESC` (falls back to HistoryDate / ModifiedDateTime / CreatedDateTime / identity).
- **No history table has an index on `HistoryDateTime`**, and clustered keys are `newid()` GUIDs, so sorting needs a full
  scan. Small tables are instant. The 28 tables with 1M+ rows can take from seconds to minutes. Use the date-range filter,
  which is much faster. Navigating away or pressing *Cancel* cancels the SQL query.
- *Live activity* polls row counts from `sys.dm_db_partition_stats` (instant, all sites) to detect new history rows.
- *Latest changes* and *Last change* are computed in the background per Site/Season, for tables up to
  `LAST_CHANGE_SCAN_MAX_ROWS` (default 1M).

## Date range

Latest changes, Errors and the table viewer share one date filter: **24 h · 7 days (default) · 30 days · All time ·
Custom** (exact from/to date-times). Presets are rolling windows, recalculated on every refresh. The choice is
kept in the URL (`?range=30d`, `?range=custom&from=…&to=…`), so it can be bookmarked or shared.

## Errors & failures page

One feed (newest first, paginated, searchable, plus a "Recurring errors" tab that groups identical messages):

| Source | Table | Filtered by Site/Season |
|---|---|---|
| SQL Agent job failures (failed / retry / cancelled steps) | `msdb.dbo.sysjobhistory` + `sysjobs` + `sysjobsteps` | no (server-wide) |
| Application errors | `ma_ApplicationErrorT` | no |
| Packaging app errors | `pk_App_Error_LogT` | no |
| NAV transmission errors (status `E`) | `xml_NAV_TransmissionT` | season |
| XML load validation errors | `pk_xml_Load_Transaction_ErrorT` | no |
| XML monitor errors | `xml_Monitor_ErrorT` | season |
| Pallet errors | `ma_Pallet_ErrorT` | site + season |
| Production run errors | `pp_RunT.ErrorDesc` | season |
| HQ exceptions (warnings) | `hq_ExceptionT` | season |

Sources live in `server/src/errors.ts`. To add one, append an entry to `SOURCES`.

**SQL Agent access:** the `maui` login cannot read `msdb` job history. Either a DBA grants it
(the page shows the exact script) or set `MSDB_USER` / `MSDB_PASSWORD` in `server/.env` to a login that can.
Access is re-checked every 5 minutes, so no restart is needed after the grant.

## SQL activity & locks page

Live view of what SQL Server is doing, read from its own system views (needs `VIEW SERVER STATE`, which the
Windows login already has). Nothing is created or changed on the server. The scope selector switches between
**this database** and the **whole server**.

| Tab | Source | Shows |
| --- | --- | --- |
| Running now | `sys.dm_exec_requests`, `sys.dm_exec_sql_text` | Every executing request: stored procedure, current statement, running time, wait, blocked-by, CPU/reads, Agent job / app / login / host |
| Blocking & locks | `blocking_session_id`, `sys.dm_tran_*`, `sys.dm_tran_locks` | Blocking chains from the head blocker down (incl. idle sessions holding an open transaction), open transactions, locks grouped by session/object/mode |
| Deadlocks | `system_health` Extended Events files (`xml_deadlock_report`) | Victim and winner of each deadlock: procedure / SQL, lock wanted, objects, app. History as far back as SQL Server keeps the files (cached 60 s) |
| Procedure stats | `sys.dm_exec_procedure_stats` | Executions, average / slowest / last duration, CPU, reads per procedure since its plan was cached |

SQL Server does not record success/failure of individual procedure calls by default, so failures are only
visible through Agent job history and the application error tables on the Errors page.

### Activity history (who ran what)

Two more tabs keep a history in a local SQLite file (`server/data/history.db`, git-ignored). It is the only thing
SQL Monitor writes to; nothing is written to SQL Server. Rows are deleted after `HISTORY_RETENTION_DAYS` (30).

| Tab | Source | Complete? |
| --- | --- | --- |
| History (sampled) | Every `HISTORY_SAMPLE_MS` (5 s): what is running, plus the last batch each connected session finished since the previous poll | **No.** Quick queries are caught from the session afterwards, but only the newest batch per session per poll, and a session that connects, runs and disconnects between two polls is never seen. |
| Audit history | SQL Server Audit files, read with `sys.fn_get_audit_file` every `HISTORY_AUDIT_POLL_MS` (30 s) | **Yes**, for the audited databases: every INSERT / UPDATE / DELETE / EXECUTE with login, host, app, object and statement. |

- **Which servers:** `HISTORY_SERVERS` in `server/.env` (comma-separated, each also in `DB_SERVERS`). Empty = off.
  To add a server later, add its name and restart.
- **Always on:** unlike the rest of the app, the sampler and audit reader run all the time for those servers, even
  when nobody has the app open. The sampler is one small DMV query per interval, from the `master` database.
- **Two kinds of sampled row.** "Seen running" rows are one statement caught while executing, with CPU and reads.
  "After it finished" rows are the last batch a session sent (`sys.dm_exec_connections.most_recent_sql_handle`),
  picked up once it is idle: whole batch text, duration from the session's last request times, no CPU/reads; a
  procedure called directly shows only its name. To keep the file small, the same batch from the same login, host
  and app within one clock hour is one row with a count ("×N"), so an app repeating a query every few seconds does
  not add a row each time.
- **Sampled rows** hold login, host, client IP, app / Agent job, database, procedure, statement, action
  (INSERT / UPDATE / DELETE / …) and the tables named in the statement. Table names are a text match: they can
  include views or functions, and cannot see inside dynamic SQL or nested procedures. The monitor's own queries
  are left out.
- **Audit setup:** SQL Monitor never creates the audit. The Audit history tab shows a script, written for the
  selected database, that a DBA runs once (server audit `HISTORY_AUDIT_NAME`, default `SQL_Monitor_Audit`, plus a
  database audit specification covering every table and procedure). Until then the tab says "not set up" and
  rechecks every 5 minutes. The login needs `VIEW SERVER SECURITY AUDIT` (SQL Server 2022+) or `CONTROL SERVER`.
- **Filters:** date range, free-text search, action, a search over the Who column only, a login-type dropdown
  (domain users / Agent jobs / MAUI services, by the "Core Microsoft SqlClient" app name / other) and a domain-user
  dropdown that shows one login or hides a busy one (e.g. a label-printer account).
- **Export:** "Export…" loads every row matching the filters (newest 20,000 at most), previews it, then downloads
  Excel (all columns, full SQL, plus an "About" sheet with the filters) or a landscape PDF summary (newest 5,000
  rows, long SQL shortened). Files are built in the browser with ExcelJS and jsPDF, loaded only when exporting.
- **"Who" is the SQL login.** For applications and Agent jobs that is a service account, not a person.
- Audit records say who ran what against which object, not the before/after values; those are in the
  `*HistoryT` tables.
- Statement text can contain business data, so treat `history.db` like the database itself.
