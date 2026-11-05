import { Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';

const OPTIONS = [
  { ms: 0, label: 'Off' },
  { ms: 10_000, label: 'Every 10 s' },
  { ms: 15_000, label: 'Every 15 s' },
  { ms: 30_000, label: 'Every 30 s' },
  { ms: 60_000, label: 'Every 1 min' },
  { ms: 300_000, label: 'Every 5 min' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Auto-refresh picker with "Updated hh:mm:ss · next in Ns" status and a manual Refresh button.
 * The chosen interval is remembered per page (storageKey).
 */
@Component({
  selector: 'app-auto-refresh',
  template: `
    <div class="auto-refresh">
      <span class="ar-status" [class.ar-busy]="loading()" [title]="title()">
        <span class="ar-dot" [class.on]="intervalMs() > 0" [class.busy]="loading()"></span>
        {{ status() }}
      </span>
      <select [value]="intervalMs()" (change)="choose(+$any($event.target).value)" aria-label="Auto-refresh interval">
        @for (o of options; track o.ms) {
          <option [value]="o.ms" [selected]="o.ms === intervalMs()">{{ o.ms === 0 ? 'Auto-refresh off' : o.label }}</option>
        }
      </select>
      <button type="button" class="btn" (click)="fire()" [disabled]="loading()">↻ Refresh</button>
    </div>
  `,
})
export class AutoRefresh implements OnInit {
  /** Remember the chosen interval under this key (one per page). */
  readonly storageKey = input.required<string>();
  readonly defaultMs = input(30_000);
  /** When the page last finished loading (success or failure). */
  readonly lastUpdated = input<Date | null>(null);
  readonly loading = input(false);
  /** Hold auto-refresh, e.g. while a detail panel is open. */
  readonly paused = input(false);
  readonly refresh = output<void>();

  protected readonly options = OPTIONS;
  protected readonly intervalMs = signal(30_000);
  private readonly now = signal(Date.now());
  private readonly lastFired = signal(0);

  /** The next refresh is due one interval after the later of the last load and the last trigger. */
  private readonly dueAt = computed(() => {
    const base = Math.max(this.lastUpdated()?.getTime() ?? 0, this.lastFired());
    return base > 0 ? base + this.intervalMs() : 0;
  });

  protected readonly status = computed(() => {
    if (this.loading()) return 'Refreshing…';
    const updated = this.lastUpdated();
    const at = updated ? `Updated ${pad(updated.getHours())}:${pad(updated.getMinutes())}:${pad(updated.getSeconds())}` : 'Not loaded yet';
    if (this.intervalMs() === 0) return at;
    if (this.paused()) return `${at} · paused`;
    const secs = Math.max(0, Math.ceil((this.dueAt() - this.now()) / 1000));
    return `${at} · next in ${secs >= 60 ? `${Math.floor(secs / 60)}m ${pad(secs % 60)}s` : `${secs}s`}`;
  });

  protected readonly title = computed(() =>
    this.intervalMs() === 0 ? 'Auto-refresh is off' : `Refreshes automatically every ${this.intervalMs() / 1000} seconds`,
  );

  constructor() {
    const timer = setInterval(() => this.tick(), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  ngOnInit(): void {
    let ms = this.defaultMs();
    try {
      const saved = localStorage.getItem(this.key());
      if (saved !== null && OPTIONS.some((o) => o.ms === Number(saved))) ms = Number(saved);
    } catch {
      /* storage unavailable */
    }
    this.intervalMs.set(ms);
  }

  choose(ms: number): void {
    this.intervalMs.set(ms);
    try {
      localStorage.setItem(this.key(), String(ms));
    } catch {
      /* storage unavailable */
    }
  }

  fire(): void {
    this.lastFired.set(Date.now());
    this.refresh.emit();
  }

  private tick(): void {
    this.now.set(Date.now());
    if (this.intervalMs() === 0 || this.loading() || this.paused() || document.hidden) return;
    const due = this.dueAt();
    if (due > 0 && Date.now() >= due) this.fire();
  }

  private key(): string {
    return `nay-monitor.refresh.${this.storageKey()}`;
  }
}
