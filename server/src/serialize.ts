const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Format a Date in server-local wall-clock time (matches what SQL Server stored). */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function serializeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : formatDate(v);
  if (Buffer.isBuffer(v)) {
    const head = v.subarray(0, 32).toString('hex').toUpperCase();
    return `0x${head}${v.length > 32 ? `… (${v.length} bytes)` : ''}`;
  }
  if (typeof v === 'bigint') return v.toString();
  return v;
}

export function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = serializeValue(v);
  return out;
}

/**
 * Normalise a user date/time ("YYYY-MM-DD", "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm[:ss[.mmm]]") into the full
 * ISO 8601 form SQL Server converts unambiguously with CONVERT(datetime2, @p, 126), whatever the login's
 * language/DATEFORMAT. End-of-range values are made inclusive of the whole minute (or day).
 */
export function isoParam(v: string, end = false): string {
  const s = v.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${end ? '23:59:59.999' : '00:00:00'}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:${end ? '59.999' : '00'}`;
  return s;
}
