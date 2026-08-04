/**
 * Display formatters.
 *
 * Pure and separate from components so they can be unit-tested — several of
 * these guard against a divide-by-zero or a zero-value timestamp that would
 * otherwise render as `NaN%` or `Invalid Date` on an operator's screen during
 * an incident.
 */

/** MiB → a human size. The fleet reports memory and disk in MiB throughout. */
export function mib(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} TiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GiB`;
  return `${Math.round(value)} MiB`;
}

/** Bytes → a human size. Goldens report bytes, not MiB. */
export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function usd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}

/**
 * A percentage from a part and a whole.
 *
 * Returns null on a zero denominator rather than NaN. A fleet host reporting
 * `memBudgetMib: 0` is a real state — it means the host never told us its cap
 * — and rendering `NaN%` for it is how a display bug gets mistaken for a
 * capacity problem.
 */
export function pct(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part == null || whole == null || !Number.isFinite(part) || !Number.isFinite(whole)) return null;
  if (whole <= 0) return null;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

export function pctLabel(part: number | null | undefined, whole: number | null | undefined): string {
  const value = pct(part, whole);
  return value == null ? '—' : `${Math.round(value)}%`;
}

/**
 * A short relative age: "12s", "4m", "3h", "2d".
 *
 * Nulls and Go zero-value timestamps (year 1) both render as "—". fleetd
 * serialises an unset `time.Time` rather than omitting it in some paths, and
 * "01/01/0001" on a dashboard reads as data corruption rather than "not yet".
 */
export function relativeAge(iso: string | null | undefined, now: number = Date.now()): string {
  const at = parseTime(iso);
  if (at == null) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Time remaining until a deadline, or "expired". */
export function countdown(iso: string | null | undefined, now: number = Date.now()): string {
  const at = parseTime(iso);
  if (at == null) return '—';
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Parsed epoch ms, or null for absent / unparseable / Go zero values. */
export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // A Go zero-value time.Time is year 1. Anything before 2000 is "never".
  if (new Date(ms).getUTCFullYear() < 2000) return null;
  return ms;
}

/** An absolute timestamp for a tooltip, where the relative one is ambiguous. */
export function absolute(iso: string | null | undefined): string {
  const ms = parseTime(iso);
  return ms == null ? '—' : new Date(ms).toLocaleString();
}

/** Truncate a sha for display without losing its usefulness as a prefix. */
export function shortSha(sha: string | null | undefined, length = 12): string {
  if (!sha) return '—';
  return sha.length <= length ? sha : sha.slice(0, length);
}
