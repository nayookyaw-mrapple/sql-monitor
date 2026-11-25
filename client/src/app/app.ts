import { Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from './core/api.service';
import { ContextService } from './core/context.service';
import { MODULE_NAMES, ModuleSummary } from './core/models';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="shell" [class.nav-open]="navOpen()">
      <aside class="sidebar">
        <a class="brand" routerLink="/dashboard">
          <img class="brand-logo" src="logo-white.png" alt="Mr Apple" />
          <div class="brand-sub">SQL Monitor · read-only</div>
        </a>

        <nav class="menu" (click)="navOpen.set(false)">
          <div class="menu-title">Monitor</div>
          <a routerLink="/dashboard" routerLinkActive="active"><svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg><span class="menu-text">Dashboard</span></a>
          <a routerLink="/errors" routerLinkActive="active">
            <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5z" /><path d="M12 10v4.5" /><path d="M12 17.5v.01" /></svg><span class="menu-text">Errors &amp; failures</span>
            @if (errors24h() > 0) {
              <span class="menu-badge" title="Errors in the last 24 hours">{{ errors24h() }}</span>
            }
          </a>
          <a routerLink="/jobs" routerLinkActive="active"><svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg><span class="menu-text">SQL Agent jobs</span></a>
          <a routerLink="/procedures" routerLinkActive="active"><svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m13.5 5-3 14" /></svg><span class="menu-text">Procedure usage</span></a>
          <a routerLink="/sql" routerLinkActive="active"><svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v6.5c0 1.66 3.58 3 8 3s8-1.34 8-3V5.5" /><path d="M4 12v6.5c0 1.66 3.58 3 8 3s8-1.34 8-3V12" /></svg><span class="menu-text">SQL activity &amp; locks</span></a>
          <a routerLink="/latest-changes" routerLinkActive="active"><svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7.5V12l3 2" /></svg><span class="menu-text">Latest changes</span></a>
          <a routerLink="/activity" routerLinkActive="active"><svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg><span class="menu-text">Live activity</span></a>
          <a routerLink="/tables" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }"><svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M3 15h18" /><path d="M9 10v10" /></svg><span class="menu-text">All history tables</span></a>

          <div class="menu-title">Modules</div>
          @for (m of modules(); track m.module) {
            <a [routerLink]="['/modules', m.module]" routerLinkActive="active" [title]="moduleName(m.module)">
              <span class="mod-code">{{ m.module }}</span>
              <span class="mod-name">{{ moduleName(m.module) }}</span>
              <span class="mod-count">{{ m.tables }}</span>
            </a>
          }
        </nav>
      </aside>

      <div class="main">
        <header class="topbar">
          <button type="button" class="nav-toggle" (click)="navOpen.set(!navOpen())" aria-label="Toggle menu">☰</button>
          <label class="db-select">
            <span class="dot" [class.ok]="!ctx.loadError()" [title]="dbName()"></span>
            Database
            <select [value]="ctx.targetId()" (change)="switchTarget($any($event.target).value)" [disabled]="ctx.switching()">
              @for (g of ctx.servers(); track g.server) {
                <optgroup [label]="g.server">
                  @for (t of g.dbs; track t.id) {
                    <option [value]="t.id" [selected]="t.id === ctx.targetId()">
                      {{ t.database }}{{ t.isDefault ? ' (default)' : '' }}
                    </option>
                  }
                </optgroup>
              }
            </select>
          </label>
          <div class="db-label" [title]="dbName()">{{ ctx.switching() ? 'Opening database…' : login() }}</div>

          <div class="context">
            @if (ctx.options(); as opts) {
              @if (ctx.usesSiteSeason()) {
              <label>
                Site
                <select [value]="ctx.siteId()" (change)="ctx.setSite(+$any($event.target).value)">
                  @for (s of opts.sites; track s.siteId) {
                    <option [value]="s.siteId" [selected]="s.siteId === ctx.siteId()">{{ s.siteId }} · {{ s.siteName }}</option>
                  }
                </select>
              </label>
              <label>
                Season
                <select [value]="ctx.season()" (change)="ctx.setSeason(+$any($event.target).value)">
                  @for (s of opts.seasons; track s.season) {
                    <option [value]="s.season" [selected]="s.season === ctx.season()">
                      {{ s.season }}{{ s.isCurrent ? ' (current)' : '' }}
                    </option>
                  }
                </select>
              </label>
              <div class="ctx-note-wrap">
                <button
                  type="button"
                  class="btn info-btn"
                  (click)="ctxNote.set(!ctxNote())"
                  [attr.aria-expanded]="ctxNote()"
                  title="Which pages use Site and Season"
                  aria-label="Which pages use Site and Season"
                >ⓘ</button>
                @if (ctxNote()) {
                  <div class="ctx-note-backdrop" (click)="ctxNote.set(false)"></div>
                  <div class="ctx-note" role="note">
                    <strong>What Site and Season do</strong>
                    <p>
                      This database uses row-level security: many tables only return the rows of one site and season. These two boxes choose
                      which.
                    </p>
                    <dl>
                      <dt>Uses Site and Season</dt>
                      <dd>Dashboard, Latest changes, Live activity, History tables, the table viewer and the module pages.</dd>
                      <dt>Errors</dt>
                      <dd>Most error sources follow Season; a few follow Site as well. Server-wide sources ignore both.</dd>
                      <dt>Ignores both</dt>
                      <dd>SQL activity (Running now, Blocking &amp; locks, Deadlocks, Procedure stats, History, Audit history). It shows the whole server or database.</dd>
                    </dl>
                    <p class="muted">Tables without row-level security show all sites and seasons whatever is chosen here.</p>
                  </div>
                }
              </div>
              } @else {
                <span class="muted small" title="This database has no row-level security, so all sites and seasons are shown">
                  All sites &amp; seasons
                </span>
              }
            }
          </div>
        </header>

        @if (ctx.loadError(); as e) {
          <div class="banner error">
            {{ e }}
            <button type="button" (click)="retry()">Retry</button>
          </div>
        }

        <main class="content">
          @if (ctx.ready()) {
            <router-outlet />
          }
        </main>
      </div>
    </div>
  `,
})
export class App {
  protected readonly ctx = inject(ContextService);
  private readonly api = inject(ApiService);
  protected readonly modules = signal<ModuleSummary[]>([]);
  protected readonly dbName = signal('Connecting…');
  protected readonly navOpen = signal(false);
  /** The note explaining which pages use Site and Season is open. */
  protected readonly ctxNote = signal(false);

  protected readonly errors24h = signal(0);
  protected readonly login = signal('');

  constructor() {
    effect(() => {
      this.ctx.key();
      untracked(() => {
        this.loadModules();
        this.loadErrorCount();
      });
    });
    const timer = setInterval(() => this.loadErrorCount(), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private loadErrorCount(): void {
    if (!this.ctx.ready()) return;
    this.api.errorSources().subscribe({
      next: (r) => this.errors24h.set(r.sources.reduce((n, s) => n + s.last24h, 0)),
      error: () => {},
    });
  }

  protected moduleName(code: string): string {
    return MODULE_NAMES[code] ?? code.toUpperCase();
  }

  protected async retry(): Promise<void> {
    await this.ctx.load();
  }

  protected switchTarget(id: string): void {
    this.modules.set([]);
    this.errors24h.set(0);
    void this.ctx.setTarget(id);
  }

  private loadModules(): void {
    if (!this.ctx.ready()) return;
    this.api.summary().subscribe({
      next: (s) => {
        this.modules.set(s.modules);
        this.dbName.set(`${s.server} / ${s.database} · ${s.auth === 'windows' ? 'Windows auth' : 'SQL login'}: ${s.login}`);
        this.login.set(`${s.auth === 'windows' ? 'Windows' : 'SQL'}: ${s.login}`);
      },
      error: () => this.dbName.set('Disconnected'),
    });
  }
}
