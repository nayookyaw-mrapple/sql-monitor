import { Pipe, PipeTransform } from '@angular/core';

/** Parse the server's "YYYY-MM-DD HH:mm:ss.SSS" (database-local time) string. */
export function parseDbDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function timeAgo(v: string | null | undefined, now = Date.now()): string {
  const d = parseDbDate(v);
  if (!d) return '—';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} months ago`;
  return `${Math.round(months / 12)} years ago`;
}

@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(v: string | null | undefined): string {
    return timeAgo(v);
  }
}

/** Compact number: 1234567 → 1.2M */
@Pipe({ name: 'compact' })
export class CompactPipe implements PipeTransform {
  private readonly fmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  transform(v: number | null | undefined): string {
    return v == null ? '—' : this.fmt.format(v);
  }
}

/** Short date-time for grid cells: drops ".000" milliseconds. */
@Pipe({ name: 'cell' })
export class CellPipe implements PipeTransform {
  transform(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.000$/.test(s)) return s.slice(0, 19);
    if (/^\d{4}-\d{2}-\d{2} 00:00:00\.000$/.test(s)) return s.slice(0, 10);
    return s;
  }
}

export function actionClass(action: string | null | undefined): string {
  const a = (action ?? '').toLowerCase();
  if (a.includes('insert') || a.includes('add') || a.includes('creat')) return 'tag-insert';
  if (a.includes('delet') || a.includes('remov')) return 'tag-delete';
  if (a.includes('updat') || a.includes('modif') || a.includes('chang')) return 'tag-update';
  return 'tag-other';
}

export const RLS_LABEL: Record<string, string> = {
  none: '',
  site: 'Site',
  season: 'Season',
  season_site: 'Season + Site',
  other: 'Filtered',
};

/** "850 ms", "12.4 s", "3 min 05 s", "2 h 14 min". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
