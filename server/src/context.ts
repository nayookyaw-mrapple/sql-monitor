import type { Request } from 'express';
import { getTables } from './catalog.js';
import { config } from './config.js';
import { readQuery, type DataContext } from './db.js';
import { currentTarget, targetState } from './target.js';

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

/** Sites and seasons of the current database (one per target). */
const opts = () => targetState('context', () => ({ sites: [] as Site[], seasons: [] as Season[] }));

/** Builds "<expr> AS alias" when the column exists, otherwise a constant — site databases can be on older schemas. */
async function columnsOf(table: string): Promise<Set<string>> {
  const rows = await readQuery<{ name: string }>(
    `SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('${table}')`,
  );
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

export async function loadContextOptions(): Promise<void> {
  const o = opts();
  try {
    const siteCols = await columnsOf('dbo.sw_Environment_Site_DBT');
    // Only the id/name/type columns — this table also holds integration credentials.
    o.sites = siteCols.has('siteid')
      ? (
          await readQuery<{ SiteID: number; SiteName: string | null; SiteType: string | null }>(
            `SELECT SiteID, ${siteCols.has('sitename') ? 'SiteName' : 'CAST(NULL AS varchar(1))'} AS SiteName,
                    ${siteCols.has('sitetype') ? 'SiteType' : 'CAST(NULL AS varchar(1))'} AS SiteType
             FROM dbo.sw_Environment_Site_DBT ORDER BY SiteID`,
          )
        ).map((r) => ({ siteId: r.SiteID, siteName: r.SiteName ?? `Site ${r.SiteID}`, siteType: r.SiteType }))
      : [];
  } catch (err) {
    console.warn(`[context] sites unavailable: ${(err as Error).message}`);
    o.sites = [];
  }
  try {
    const c = await columnsOf('dbo.sw_SeasonT');
    if (!c.has('season')) {
      o.seasons = [];
    } else {
      const col = (name: string, fallback: string) => (c.has(name.toLowerCase()) ? name : fallback);
      const where = c.has('availableforsessioncontextflag') ? 'WHERE AvailableForSessionContextFlag = 1' : '';
      const rows = await readQuery<{ Season: number; SeasonDesc: string | null; CurrentSeason: boolean; DefaultSeasonFlag: boolean }>(
        `SELECT Season, ${col('SeasonDesc', 'CAST(NULL AS varchar(1))')} AS SeasonDesc,
                ${col('CurrentSeason', 'CAST(0 AS bit)')} AS CurrentSeason,
                ${col('DefaultSeasonFlag', 'CAST(0 AS bit)')} AS DefaultSeasonFlag
         FROM dbo.sw_SeasonT ${where} ORDER BY Season DESC`,
      );
      o.seasons = rows.map((r) => ({ season: r.Season, description: r.SeasonDesc, isCurrent: !!r.CurrentSeason, isDefault: !!r.DefaultSeasonFlag }));
    }
  } catch (err) {
    console.warn(`[context] seasons unavailable: ${(err as Error).message}`);
    o.seasons = [];
  }
  const t = currentTarget();
  console.log(`[context] ${t.server}/${t.database}: ${o.sites.length} sites, ${o.seasons.length} seasons`);
}

export function defaultContext(): DataContext {
  const { sites, seasons } = opts();
  const siteId = sites.some((s) => s.siteId === config.defaultSiteId) ? config.defaultSiteId : (sites[0]?.siteId ?? 1);
  const season = (seasons.find((s) => s.isDefault) ?? seasons.find((s) => s.isCurrent) ?? seasons[0])?.season ?? new Date().getFullYear();
  return { siteId, season };
}

export function contextOptions() {
  const { sites, seasons } = opts();
  const rlsTables = getTables().filter((t) => t.rls !== 'none').length;
  return { sites, seasons, defaults: defaultContext(), rlsTables };
}

export class ContextError extends Error {}

/**
 * Site/Season from the X-Site-Id / X-Season headers (or ?siteId= / ?season=). Values that don't exist in
 * the selected database (e.g. right after switching databases) fall back to that database's defaults.
 */
export function contextFrom(req: Request): DataContext {
  const def = defaultContext();
  const { sites, seasons } = opts();
  const rawSite = req.get('x-site-id') ?? (req.query.siteId as string | undefined);
  const rawSeason = req.get('x-season') ?? (req.query.season as string | undefined);
  const siteId = rawSite ? Number.parseInt(rawSite, 10) : Number.NaN;
  const season = rawSeason ? Number.parseInt(rawSeason, 10) : Number.NaN;
  return {
    siteId: sites.some((s) => s.siteId === siteId) ? siteId : def.siteId,
    season: seasons.some((s) => s.season === season) ? season : def.season,
  };
}

export function contextKey(c: DataContext): string {
  return `${c.siteId}:${c.season}`;
}
