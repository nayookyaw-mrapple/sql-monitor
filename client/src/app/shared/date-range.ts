import { Component, computed, effect, input, output, signal } from '@angular/core';

export type RangeKey = '24h' | '7d' | '30d' | 'all' | 'custom';

export const DEFAULT_RANGE: RangeKey = '7d';

const PRESETS: { key: RangeKey; label: string; hours?: number }[] = [
  { key: '24h', label: '24 h', hours: 24 },
  { key: '7d', label: '7 days', hours: 24 * 7 },
  { key: '30d', label: '30 days', hours: 24 * 30 },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom…' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date-time in the format <input type="datetime-local"> and the API both use: YYYY-MM-DDTHH:mm */
export function localInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function normalizeRange(v: string | null | undefined): RangeKey {
  return PRESETS.some((p) => p.key === v) ? (v as RangeKey) : DEFAULT_RANGE;
}

/**
 * Turn a range into API from/to values. Presets are rolling windows, recalculated on every call,
 * so auto-refresh keeps "last 7 days" up to date.
 */
export function resolveRange(range: RangeKey, from?: string | null, to?: string | null): { from?: string; to?: string } {
  if (range === 'custom') return { from: from || undefined, to: to || undefined };
  const hours = PRESETS.find((p) => p.key === range)?.hours;
  if (!hours) return {};
  return { from: localInput(new Date(Date.now() - hours * 3600_000)) };
}

export interface RangeChange {
  range: RangeKey;
  from: string | null;
  to: string | null;
}

function pretty(v: string): string {
  return v.replace('T', ' ');
}

@Component({
  selector: 'app-date-range',
  template: `
    <div class="date-range">
      <div class="dr-presets" role="group" aria-label="Date range">
        @for (p of presets; track p.key) {
          <button type="button" [class.active]="range() === p.key" (click)="pick(p.key)">{{ p.label }}</button>
        }
      </div>
      @if (range() === 'custom') {
        <div class="dr-custom">
          <label>
            From
            <input type="datetime-local" [value]="draftFrom()" (input)="draftFrom.set($any($event.target).value)" />
          </label>
          <label>
            To
            <input type="datetime-local" [value]="draftTo()" (input)="draftTo.set($any($event.target).value)" />
          </label>
          <button type="button" class="btn primary" (click)="applyCustom()" [disabled]="!draftFrom() && !draftTo()">Apply</button>
        </div>
      }
      <span class="dr-summary">{{ summary() }}</span>
    </div>
  `,
})
export class DateRange {
  readonly range = input<RangeKey>(DEFAULT_RANGE);
  readonly from = input<string | null | undefined>(null);
  readonly to = input<string | null | undefined>(null);
  readonly rangeChange = output<RangeChange>();

  protected readonly presets = PRESETS;
  protected readonly draftFrom = signal('');
  protected readonly draftTo = signal('');

  protected readonly summary = computed(() => {
    const r = this.range();
    if (r === 'all') return 'Showing all time';
    if (r === 'custom') {
      const f = this.from();
      const t = this.to();
      if (f && t) return `Showing ${pretty(f)} → ${pretty(t)}`;
      if (f) return `Showing since ${pretty(f)}`;
      if (t) return `Showing up to ${pretty(t)}`;
      return 'Pick a start and/or end time';
    }
    const { from } = resolveRange(r);
    return `Showing since ${pretty(from!)}`;
  });

  constructor() {
    // Keep the custom inputs in sync with the applied range.
    effect(() => {
      this.draftFrom.set(this.from() ?? '');
      this.draftTo.set(this.to() ?? '');
    });
  }

  pick(key: RangeKey): void {
    if (key === 'custom') {
      // Start the custom range from the window currently shown, so the user only has to adjust it.
      if (!this.draftFrom() && !this.draftTo()) {
        this.draftFrom.set(resolveRange(this.range()).from ?? localInput(new Date(Date.now() - 7 * 86400_000)));
        this.draftTo.set(localInput(new Date()));
      }
      if (this.range() !== 'custom') this.rangeChange.emit({ range: 'custom', from: this.draftFrom() || null, to: this.draftTo() || null });
      return;
    }
    this.rangeChange.emit({ range: key, from: null, to: null });
  }

  applyCustom(): void {
    let f = this.draftFrom();
    let t = this.draftTo();
    if (f && t && f > t) [f, t] = [t, f];
    this.rangeChange.emit({ range: 'custom', from: f || null, to: t || null });
  }
}
