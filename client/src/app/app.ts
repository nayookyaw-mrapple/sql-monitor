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
          <a routerLink="/dashboard" routerLinkActive="active">▦ Dashboard</a>
          <a routerLink="/errors" routerLinkActive="active">
            ⚠ Errors &amp; failures
            @if (errors24h() > 0) {
              <span class="menu-badge" title="Errors in the last 24 hours">{{ errors24h() }}</span>
            }
          </a>
          <a routerLink="/sql" routerLinkActive="active">⛁ SQL activity &amp; locks</a>
          <a routerLink="/latest-changes" routerLinkActive="active">⟲ Latest changes</a>
          <a routerLink="/activity" routerLinkActive="active">⚡ Live activity</a>
          <a routerLink="/tables" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">☰ All history tables</a>

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
