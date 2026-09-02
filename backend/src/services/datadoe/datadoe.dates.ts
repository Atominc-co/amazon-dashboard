/**
 * Shared calendar-date helpers for DataDoe date-windowed sources.
 *
 * These are the single source of truth for the dashboard's date semantics. They intentionally
 * use the Date object's LOCAL calendar fields (getFullYear/getMonth/getDate), never
 * toISOString()'s UTC fields — round-tripping through UTC shifts the calendar day back whenever
 * the server runs in a timezone ahead of UTC (verified live on this host, Asia/Calcutta/UTC+5:30:
 * "Today" otherwise resolved to yesterday and returned all-zero totals). The controllers'
 * formatDate/addDays previously duplicated this logic; both now delegate here so "Today"/"MTD"/
 * range math can never drift between the request layer and the cache/coverage layer.
 */

/** ISO yyyy-mm-dd string from a Date's LOCAL calendar fields. */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A new Date `days` after `d` (local calendar), without mutating the input. */
export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** The actual current calendar day at local midnight. */
export function todayLocalMidnight(): Date {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

/** Today's calendar date as an ISO string — the maximum selectable/queryable date. */
export function todayIso(): string {
  return formatDate(todayLocalMidnight());
}

/** Parse a yyyy-mm-dd string to a local-midnight Date, or null if malformed. */
export function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  // Reject impossible calendar dates (e.g. 2026-02-31 would roll over to March).
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

/** True when `value` is a well-formed, real calendar date (yyyy-mm-dd). */
export function isValidIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** Inclusive whole-day difference between two ISO dates (to - from), or null if either is bad. */
export function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}
