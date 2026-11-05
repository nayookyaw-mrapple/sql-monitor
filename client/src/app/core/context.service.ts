import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ContextOptions, TargetInfo, TargetsResponse } from './models';

const STORAGE_KEY = 'nay-monitor.context';

interface Saved {
  target?: string;
  /** Site/Season remembered per database. */
  perTarget?: Record<string, { siteId: number; season: number }>;
}

/**
 * What the user is looking at: the database (server + database) and, for databases with row-level
 * security, the Site + Season. Sent on every API call as X-Target / X-Site-Id / X-Season.
 */
@Injectable({ providedIn: 'root' })
export class ContextService {
  private readonly http = inject(HttpClient);

  readonly targets = signal<TargetInfo[]>([]);
  readonly targetId = signal<string | null>(null);
  readonly options = signal<ContextOptions | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly switching = signal(false);
  readonly siteId = signal<number | null>(null);
  readonly season = signal<number | null>(null);

  readonly ready = computed(() => this.targetId() !== null && this.siteId() !== null && this.season() !== null && !this.switching());
  /** Changes whenever database, Site or Season changes; pages reload data when it does. */
  readonly key = computed(() => `${this.targetId()}|${this.siteId()}:${this.season()}`);
  readonly site = computed(() => this.options()?.sites.find((s) => s.siteId === this.siteId()) ?? null);
  readonly target = computed(() => this.targets().find((t) => t.id === this.targetId()) ?? null);
  /** Site/Season only matter when the database filters rows with row-level security. */
  readonly usesSiteSeason = computed(() => (this.options()?.rlsTables ?? 0) > 0);
  /** "Site · season 2026" for databases with row-level security, otherwise "Database · all sites & seasons". */
  readonly scopeLabel = computed(() => {
    const t = this.target();
    const db = t ? `${t.database} (${t.server})` : '';
    return this.usesSiteSeason() ? `${db} · ${this.site()?.siteName ?? ''} · season ${this.season()}` : `${db} · all sites & seasons`;
  });
  /** Databases grouped by server for the selector. */
  readonly servers = computed(() => {
    const map = new Map<string, TargetInfo[]>();
    for (const t of this.targets()) {
      if (!map.has(t.server)) map.set(t.server, []);
      map.get(t.server)!.push(t);
    }
    return [...map.entries()].map(([server, dbs]) => ({ server, dbs }));
  });

  async load(): Promise<void> {
    try {
      const res = await firstValueFrom(this.http.get<TargetsResponse>('/api/targets'));
      this.targets.set(res.targets);
      const saved = this.readSaved();
      const target = res.targets.some((t) => t.id === saved.target) ? saved.target! : res.default;
      await this.selectTarget(target);
      this.loadError.set(null);
    } catch (err) {
      this.loadError.set('Cannot reach the NAY-Monitor API. Is the server running on port 3000?');
      console.error(err);
    }
  }

  async setTarget(id: string): Promise<void> {
    if (id === this.targetId()) return;
    try {
      await this.selectTarget(id);
      this.loadError.set(null);
    } catch (err) {
      const msg = (err as { error?: { error?: string } })?.error?.error ?? (err as Error).message;
      this.loadError.set(`Cannot open that database: ${msg}`);
    }
  }

  /** Load the database's Site/Season lists (this also starts its monitoring on the server), then switch to it. */
  private async selectTarget(id: string): Promise<void> {
    this.switching.set(true);
    try {
      const opts = await firstValueFrom(
        this.http.get<ContextOptions>('/api/context', { headers: new HttpHeaders({ 'X-Target': encodeURIComponent(id) }) }),
      );
      const remembered = this.readSaved().perTarget?.[id];
      const siteOk = remembered && opts.sites.some((s) => s.siteId === remembered.siteId);
      const seasonOk = remembered && opts.seasons.some((s) => s.season === remembered.season);
      this.options.set(opts);
      this.siteId.set(siteOk ? remembered!.siteId : opts.defaults.siteId);
      this.season.set(seasonOk ? remembered!.season : opts.defaults.season);
      this.targetId.set(id);
      this.save();
    } finally {
      this.switching.set(false);
    }
  }

  setSite(siteId: number): void {
    this.siteId.set(siteId);
    this.save();
  }

  setSeason(season: number): void {
    this.season.set(season);
    this.save();
  }

  private save(): void {
    const id = this.targetId();
    if (!id) return;
    try {
      const saved = this.readSaved();
      saved.target = id;
      saved.perTarget = { ...(saved.perTarget ?? {}), [id]: { siteId: this.siteId()!, season: this.season()! } };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* storage unavailable — selection just won't persist */
    }
  }

  private readSaved(): Saved {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const v = raw ? JSON.parse(raw) : {};
      return typeof v === 'object' && v ? v : {};
    } catch {
      return {};
    }
  }
}
