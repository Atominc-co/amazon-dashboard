import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { addDays, formatDate, parseIsoDate } from "./datadoe.dates";
import { CACHE_SCHEMA_VERSION, StoredSource, cacheTtlMs } from "./datadoe.cache";

/**
 * Coverage-aware persistent store for DataDoe date-windowed sources.
 *
 * The plain exact-key cache (datadoe.cache.ts) keys on the precise {from,to}, so switching
 * Today → 7d → MTD → 30d → Custom produced a *different* key each time and therefore a fresh
 * DataDoe export every time — even though 7d/Today are entirely contained within a 30d window
 * already on disk. This layer instead keys a dataset on {seller, source, columns} WITHOUT the
 * date range, and records exactly which calendar intervals it holds complete rows for. A request
 * whose [from,to] is already covered is served by FILTERING the stored rows — zero exports. A
 * partially-covered request fetches only the still-missing interval(s) and merges them in.
 *
 * Rows are stored raw/verbatim (same contract as the exact-key cache). Merging replaces rows for
 * exactly the freshly-fetched date interval (so a manual Sync overwrites those dates rather than
 * appending duplicates) while preserving every row for dates outside it — this is correct even
 * for sources with many rows per date (e.g. multiple settlement lines per date/ASIN), because it
 * never keys on a per-row natural key it cannot guarantee, only on the fetched date interval.
 */

export const COVERAGE_SCHEMA_VERSION = 1;

/** Dates within this many days of today may still be updated upstream and are treated as "recent". */
export const RECENT_WINDOW_DAYS = 2;

function cacheDir(): string {
  return process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
}

export interface DatasetKeyParams {
  sellerId: string;
  sourceName: string;
  columns?: string[];
}

/** Deterministic dataset identity — everything that changes the row SHAPE, but NOT the dates. */
export function computeDatasetKey(p: DatasetKeyParams): string {
  const canonical = {
    sellerId: p.sellerId,
    sourceName: p.sourceName,
    columns: p.columns && p.columns.length ? [...p.columns].sort() : "__ALL__",
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 40);
}

export interface DateInterval {
  from: string; // inclusive ISO yyyy-mm-dd
  to: string; // inclusive ISO yyyy-mm-dd
}

export interface CoverageEntry<T = unknown> {
  datasetKey: string;
  schemaVersion: number;
  sellerId: string;
  sourceName: string;
  source: StoredSource | null;
  columns: string[];
  dateField: string; // row field holding the calendar date (always "date" for our sources)
  intervals: DateInterval[]; // sorted, non-overlapping, non-adjacent coverage
  rows: T[]; // raw rows spanning `intervals`
  fetchedAt: string; // ISO timestamp of the most recent successful fetch/merge
  lastExportId: string | null;
}

function filePath(datasetKey: string): string {
  return path.join(cacheDir(), datasetKey + ".cov.json");
}

const memory = new Map<string, CoverageEntry>();

export async function readCoverage<T>(datasetKey: string): Promise<CoverageEntry<T> | null> {
  const hot = memory.get(datasetKey);
  if (hot) return hot as CoverageEntry<T>;
  try {
    const buf = await fs.readFile(filePath(datasetKey), "utf8");
    const entry = JSON.parse(buf) as CoverageEntry<T>;
    if (entry.schemaVersion !== COVERAGE_SCHEMA_VERSION) return null;
    if (!Array.isArray(entry.intervals) || !Array.isArray(entry.rows)) return null;
    memory.set(datasetKey, entry as CoverageEntry);
    return entry;
  } catch {
    // Missing / torn / unreadable → safe miss (a fresh fetch rewrites it).
    return null;
  }
}

export async function writeCoverage<T>(datasetKey: string, entry: CoverageEntry<T>): Promise<void> {
  memory.set(datasetKey, entry as CoverageEntry);
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath(datasetKey) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(entry), "utf8");
  await fs.rename(tmp, filePath(datasetKey));
}

// ---- Interval math -------------------------------------------------------------------------

function iso(d: Date): string {
  return formatDate(d);
}

/** Sort, then merge overlapping OR adjacent (to+1day === next.from) intervals into a minimal set. */
export function coalesceIntervals(intervals: DateInterval[]): DateInterval[] {
  const valid = intervals
    .filter((i) => parseIsoDate(i.from) && parseIsoDate(i.to) && i.from <= i.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: DateInterval[] = [];
  for (const cur of valid) {
    const last = out[out.length - 1];
    if (last) {
      const lastToNext = iso(addDays(parseIsoDate(last.to)!, 1));
      if (cur.from <= lastToNext) {
        // overlapping or directly adjacent → extend
        if (cur.to > last.to) last.to = cur.to;
        continue;
      }
    }
    out.push({ from: cur.from, to: cur.to });
  }
  return out;
}

/** Portions of [from,to] NOT already inside `covered`. Returns disjoint, ascending intervals. */
export function missingIntervals(
  from: string,
  to: string,
  covered: DateInterval[]
): DateInterval[] {
  if (from > to) return [];
  const merged = coalesceIntervals(covered);
  const gaps: DateInterval[] = [];
  let cursor = from;
  for (const c of merged) {
    if (c.to < cursor) continue; // entirely before the part we still need
    if (c.from > to) break; // beyond what we need
    if (c.from > cursor) {
      // gap before this covered interval
      gaps.push({ from: cursor, to: iso(addDays(parseIsoDate(c.from)!, -1)) });
    }
    // advance cursor past this covered interval
    const nextCursor = iso(addDays(parseIsoDate(c.to)!, 1));
    if (nextCursor > cursor) cursor = nextCursor;
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps.filter((g) => g.from <= g.to);
}

/** True when [from,to] is fully inside `covered` (no missing intervals). */
export function isFullyCovered(from: string, to: string, covered: DateInterval[]): boolean {
  return missingIntervals(from, to, covered).length === 0;
}

/**
 * The portions of [from,to] that ARE inside `covered` — the exact complement of missingIntervals
 * within the requested window. Returns disjoint, ascending intervals (empty when nothing in the
 * range is covered). Used to serve the real cached portion of a partially-covered range instead
 * of hiding the whole range, and to tell the caller precisely which dates it actually holds.
 */
export function coveredIntervals(
  from: string,
  to: string,
  covered: DateInterval[]
): DateInterval[] {
  if (from > to) return [];
  const missing = missingIntervals(from, to, covered);
  const out: DateInterval[] = [];
  let cursor = from;
  for (const m of missing) {
    if (m.from > cursor) {
      out.push({ from: cursor, to: iso(addDays(parseIsoDate(m.from)!, -1)) });
    }
    const next = iso(addDays(parseIsoDate(m.to)!, 1));
    if (next > cursor) cursor = next;
  }
  if (cursor <= to) out.push({ from: cursor, to });
  return out.filter((g) => g.from <= g.to);
}

function dateOf(row: unknown, dateField: string): string | null {
  if (row && typeof row === "object") {
    const v = (row as Record<string, unknown>)[dateField];
    if (typeof v === "string" && v.length >= 10) return v.slice(0, 10);
  }
  return null;
}

export interface RowDateBounds {
  min: string | null;
  max: string | null;
}

/**
 * Actual min/max calendar date among `rows`' `dateField`, ignoring rows with no parseable date.
 * `{min: null, max: null}` when none of the rows are dated. This is the single source of truth
 * for "what dates do we actually have evidence of data for" — used both by the "Synced locally"
 * summary (listStoredCoverage below) and by the coverage-writing path in getViaCoverage, so a
 * fetched/requested interval can never be recorded as covered beyond what rows actually prove.
 */
export function rowDateBounds<T>(rows: T[], dateField: string): RowDateBounds {
  let min: string | null = null;
  let max: string | null = null;
  for (const r of rows) {
    const d = dateOf(r, dateField);
    if (d === null) continue;
    if (min === null || d < min) min = d;
    if (max === null || d > max) max = d;
  }
  return { min, max };
}

/** Rows of the dataset whose date falls within [from,to] (inclusive). Undated rows excluded. */
export function filterRowsInRange<T>(
  rows: T[],
  from: string,
  to: string,
  dateField: string
): T[] {
  return rows.filter((r) => {
    const d = dateOf(r, dateField);
    return d !== null && d >= from && d <= to;
  });
}

/**
 * Merge freshly-fetched rows for [from,to] into an existing row set: drop every existing row
 * whose date is inside [from,to] (superseded by the fresh fetch), keep the rest, then append the
 * fresh rows. Rows with no parseable date are always kept (never silently discarded). This is the
 * dedup rule — replacement by the fetched interval — so a re-fetch of the same dates overwrites
 * rather than duplicating, while distinct rows sharing a date are all preserved.
 */
export function mergeRowsForInterval<T>(
  existingRows: T[],
  fetchedRows: T[],
  from: string,
  to: string,
  dateField: string
): T[] {
  const kept = existingRows.filter((r) => {
    const d = dateOf(r, dateField);
    return d === null || d < from || d > to;
  });
  return kept.concat(fetchedRows);
}

// ---- Served-status classification ----------------------------------------------------------

export type CoverageServedStatus = "fresh" | "cached" | "stale";

/**
 * Classify a coverage-served response:
 *  - "fresh"  : at least one interval was fetched from DataDoe on this request.
 *  - "cached" : served entirely from the store and either within the freshness window OR the
 *               requested range is a fully-completed historical period (its latest date is older
 *               than the recent window), which never needs re-fetching.
 *  - "stale"  : served entirely from the store, beyond the freshness window, and the range still
 *               touches recent dates that may have been updated upstream.
 */
export function classifyCoverageAge(
  requestedTo: string,
  fetchedAt: string,
  fetchedThisRequest: boolean
): CoverageServedStatus {
  if (fetchedThisRequest) return "fresh";
  const recentCutoff = iso(addDays(new Date(), -RECENT_WINDOW_DAYS));
  const touchesRecent = requestedTo >= recentCutoff;
  if (!touchesRecent) return "cached"; // completed historical period — stable, no refresh needed
  const age = Date.now() - new Date(fetchedAt).getTime();
  return age <= cacheTtlMs() ? "cached" : "stale";
}

// ---- Per-dataset in-flight serialization ---------------------------------------------------
// Concurrent requests on the SAME dataset are serialized so two overlapping range switches can't
// each fire an export for the same missing dates. Distinct datasets stay fully parallel.

const chains = new Map<string, Promise<unknown>>();

export function withDatasetLock<R>(datasetKey: string, task: () => Promise<R>): Promise<R> {
  const prior = chains.get(datasetKey) ?? Promise.resolve();
  const next = prior.then(task, task);
  // Keep the chain alive but swallow rejections so one failure doesn't poison the lock.
  chains.set(
    datasetKey,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

export function newCoverageEntry<T>(params: {
  datasetKey: string;
  sellerId: string;
  sourceName: string;
  columns: string[];
  source: StoredSource | null;
  dateField?: string;
}): CoverageEntry<T> {
  return {
    datasetKey: params.datasetKey,
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    sellerId: params.sellerId,
    sourceName: params.sourceName,
    source: params.source,
    columns: params.columns,
    dateField: params.dateField ?? "date",
    intervals: [],
    rows: [],
    fetchedAt: new Date().toISOString(),
    lastExportId: null,
  };
}

export interface StoredCoverageSummary {
  sourceName: string;
  // ACTUAL returned-row coverage: the min/max calendar date among rows actually held on disk
  // (null when the dataset has no dated rows). This is deliberately NOT derived from `intervals`
  // — the queried interval records which dates were REQUESTED from DataDoe, which can be far wider
  // than the dates DataDoe actually returned rows for. The "Synced locally" display must reflect
  // real usable data, so it uses these fields; `intervals` (the queried span) is kept separately.
  earliest: string | null;
  latest: string | null;
  intervals: DateInterval[]; // queried/exported span (what was REQUESTED), not proof rows exist
  rowCount: number;
  fetchedAt: string;
}

/**
 * Actual on-disk coverage for a seller, read from the persisted `*.cov.json` files WITHOUT any
 * DataDoe call (token-free). Powers the calendar's "what is already synchronized locally" display
 * and the not-synchronized decision. Reads the hot memory layer first for any datasets already
 * loaded this process, then scans the cache directory for the rest, so it reflects data written by
 * an earlier run (survives restart). Malformed/foreign files are skipped, never thrown on.
 */
export async function listStoredCoverage(sellerId: string): Promise<StoredCoverageSummary[]> {
  const summaries = new Map<string, StoredCoverageSummary>();
  const add = (e: CoverageEntry) => {
    if (e.sellerId !== sellerId) return;
    const merged = coalesceIntervals(e.intervals);
    // earliest/latest = min/max ACTUAL row date (honest "Synced locally"), NOT the queried span.
    // A dataset queried across 730 days but holding rows only for a recent slice reports that
    // recent slice here; a dataset whose rows carry no parseable date (e.g. a source fetched
    // before its date column was requested) reports null and is excluded from the synced range.
    const rows = Array.isArray(e.rows) ? e.rows : [];
    const bounds = rowDateBounds(rows, e.dateField);
    summaries.set(e.datasetKey, {
      sourceName: e.sourceName,
      earliest: bounds.min,
      latest: bounds.max,
      intervals: merged,
      rowCount: rows.length,
      fetchedAt: e.fetchedAt,
    });
  };
  for (const e of memory.values()) add(e);
  let files: string[] = [];
  try {
    files = (await fs.readdir(cacheDir())).filter((f) => f.endsWith(".cov.json"));
  } catch {
    return Array.from(summaries.values()); // cache dir absent -> only whatever is in memory
  }
  for (const f of files) {
    try {
      const buf = await fs.readFile(path.join(cacheDir(), f), "utf8");
      const entry = JSON.parse(buf) as CoverageEntry;
      if (entry.schemaVersion !== COVERAGE_SCHEMA_VERSION) continue;
      if (summaries.has(entry.datasetKey)) continue; // memory copy already counted (fresher)
      add(entry);
    } catch {
      // torn/unreadable/foreign file -> skip
    }
  }
  return Array.from(summaries.values());
}

/** Test-only: clear the in-memory hot layer and in-flight chains (disk untouched). */
export function __resetCoverageMemory(): void {
  memory.clear();
  chains.clear();
}

// Re-exported so callers building a CoverageEntry.source stay consistent with the cache module.
export { CACHE_SCHEMA_VERSION };
