import { promises as fs } from "fs";
import path from "path";
import {
  createExport,
  fetchExportRawData,
  getExportSources,
  getExportStatus,
} from "./datadoe/datadoe.exports.client";
import { SellersAndVendorsItem } from "./datadoe/datadoe.types";
import { ExportSourceResponse, ExportStatus } from "./datadoe/datadoe.exports.types";
import {
  CACHE_SCHEMA_VERSION,
  CacheEntry,
  ServedStatus,
  classifyAge,
  computeCacheKey,
  fetchWithDedup,
  readCache,
  writeCache,
} from "./datadoe/datadoe.cache";
import {
  CoverageEntry,
  DateInterval,
  RECENT_WINDOW_DAYS,
  StoredCoverageSummary,
  classifyCoverageAge,
  coalesceIntervals,
  computeDatasetKey,
  coveredIntervals,
  filterRowsInRange,
  isFullyCovered,
  listStoredCoverage,
  mergeRowsForInterval,
  missingIntervals,
  newCoverageEntry,
  readCoverage,
  rowDateBounds,
  withDatasetLock,
  writeCoverage,
} from "./datadoe/datadoe.coverage";
import {
  earliestDateForSource,
  isHistoricalSource,
} from "./datadoe/datadoe.history";
import { archiveRawExport } from "./datadoe/datadoe.raw-archive";
import {
  addDays,
  formatDate,
  isValidIsoDate,
  todayIso,
  todayLocalMidnight,
} from "./datadoe/datadoe.dates";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 20000;
const MAX_PAGE_SIZE = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SourceNotFoundError extends Error {
  constructor(sourceName: string) {
    super(`DataDoe export source "${sourceName}" was not found for this seller`);
    this.name = "SourceNotFoundError";
  }
}

export class ExportTimeoutError extends Error {
  readonly exportId: string;

  constructor(exportId: string) {
    super("DataDoe export did not complete within the allotted time");
    this.name = "ExportTimeoutError";
    this.exportId = exportId;
  }
}

export class ExportFailedError extends Error {
  readonly exportId: string;
  readonly status: ExportStatus;

  constructor(exportId: string, status: ExportStatus) {
    super(`DataDoe export finished with non-completed status: ${status}`);
    this.name = "ExportFailedError";
    this.exportId = exportId;
    this.status = status;
  }
}

/**
 * A requested date range lies outside what the source can actually supply (before the supported
 * historical boundary, in the future, or malformed). Thrown BEFORE any DataDoe export so an
 * unsupported range never consumes a token — the controller maps it to an honest 422 range-limit
 * state, never to zero/fabricated data.
 */
export class RangeUnavailableError extends Error {
  readonly reason: string;
  readonly earliest: string;
  readonly latest: string;

  constructor(reason: string, earliest: string, latest: string) {
    super(reason);
    this.name = "RangeUnavailableError";
    this.reason = reason;
    this.earliest = earliest;
    this.latest = latest;
  }
}

/**
 * The requested range is WITHIN the supported historical boundary but is not (fully) present in
 * the local persistent cache yet, and this is a normal cache-only read (not an explicit Sync).
 * Under the strict-local architecture a normal read never calls DataDoe — so instead of silently
 * spending a token, the service raises this and the controller surfaces an honest
 * "Data not synchronized for this period" state that directs the user to press Sync. It is NOT an
 * error and NOT zero/fabricated data. `missing` lists the exact still-missing interval(s) so a
 * subsequent Sync fetches only those.
 */
export class RangeNotSynchronizedError extends Error {
  readonly from: string;
  readonly to: string;
  readonly missing: Array<{ from: string; to: string }>;

  constructor(from: string, to: string, missing: Array<{ from: string; to: string }>) {
    super("Data not synchronized for this period");
    this.name = "RangeNotSynchronizedError";
    this.from = from;
    this.to = to;
    this.missing = missing;
  }
}

export interface GetSellerSourceDataParams {
  sellerId: string;
  sourceName: string;
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  /**
   * When true, skip/limit are omitted from the export request so DataDoe returns every row
   * matching the from/to window instead of one page. Needed for aggregate sums (e.g. total
   * sales over a date range) where a truncated page would silently understate the total.
   */
  all?: boolean;
  /**
   * Explicit column subset to request instead of every column on the source. DataDoe rejects
   * export requests with more than 128 columns (verified directly against the API); sources
   * with more columns than that (e.g. Settlements & P&L Components, 209 columns) require
   * narrowing to just the fields actually needed. Defaults to all of the source's columns.
   */
  columns?: string[];
  /**
   * The ONLY flag that authorizes a DataDoe export. When true (an explicit "Sync"), the service
   * fetches the missing coverage and persists it. When false/omitted (every normal load and every
   * date-range change), the read is STRICTLY cache-only: a covered request is served from disk
   * with zero exports, and an uncovered request raises RangeNotSynchronizedError instead of
   * silently calling DataDoe. This is the strict-local architecture — date selection never spends
   * a token; only Sync does. A failed Sync never erases cached data (falls back to last good,
   * marked stale).
   */
  refresh?: boolean;
}

export interface GetSellerSourceDataResult<T = Record<string, unknown>> {
  source: Pick<ExportSourceResponse, "id" | "name" | "tableName" | "type">;
  exportId: string;
  rows: T[];
  meta: {
    page: number;
    pageSize: number;
    rowCount: number;
  };
  /**
   * Provenance/freshness of the returned rows so callers (and the UI) can distinguish live from
   * cached data and never present stale data as current:
   *  - "fresh"  : just fetched from DataDoe on this request
   *  - "cached" : served from the store, within the freshness window
   *  - "stale"  : served from the store, beyond the freshness window (or a failed refresh)
   */
  cache: {
    status: ServedStatus;
    retrievedAt: string;
    ageMs: number;
    key: string;
  };
  /**
   * Present only for date-windowed (coverage-store) sources. Describes how much of the requested
   * [from,to] window the LOCAL cache actually holds, so the caller can honestly show the real
   * cached portion and flag the missing portion as unavailable — never as fabricated zeros:
   *  - `covered`  : the sub-interval(s) of [from,to] we hold real rows for
   *  - `missing`  : the sub-interval(s) of [from,to] not synchronized locally
   *  - `partial`  : true when some (but not all) of the range is covered
   *  - earliest/latest: the actual min/max row date among the served rows (null when none)
   * A range with NO covered portion is never served here — it raises RangeNotSynchronizedError
   * instead — so `covered` is always non-empty when this field is present.
   */
  coverage?: ServedCoverage;
}

export interface ServedCoverage {
  requested: { from: string; to: string };
  covered: DateInterval[];
  missing: DateInterval[];
  partial: boolean;
  earliest: string | null;
  latest: string | null;
}

/**
 * The actual DataDoe export flow (sources lookup → create → poll → fetch raw), producing a
 * CacheEntry. Only reached on a cache miss or a forced refresh — never on a cache hit. The
 * sources lookup here is the cheap, non-token /exports/sources call; only createExport consumes
 * a token, so a cache hit (which skips this entirely) consumes zero tokens.
 */
async function fetchFromDataDoe<T>(
  params: GetSellerSourceDataParams,
  page: number,
  pageSize: number,
  all: boolean,
  window?: { from: string; to: string }
): Promise<CacheEntry<T>> {
  const sourcesResponse = await getExportSources([params.sellerId]);
  const source = sourcesResponse.sources.find((candidate) => candidate.name === params.sourceName);

  if (!source) {
    throw new SourceNotFoundError(params.sourceName);
  }

  const columns = params.columns ?? source.columns.map((column) => column.name);

  // When a specific coverage interval is being fetched, it overrides params.from/to; otherwise
  // the request's own window is used (exact-key path, unchanged).
  const from = window ? window.from : params.from;
  const to = window ? window.to : params.to;

  const created = await createExport({
    sellerOrVendorIds: [params.sellerId],
    sourceId: source.id,
    columns,
    outputType: "JSON",
    sendToAllOrganizationMembers: false,
    skip: all ? undefined : (page - 1) * pageSize,
    limit: all ? undefined : pageSize,
    from,
    to,
  });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status: ExportStatus = created.status;

  while (status === "PENDING" || status === "IN_PROGRESS") {
    if (Date.now() >= deadline) {
      throw new ExportTimeoutError(created.id);
    }
    await sleep(POLL_INTERVAL_MS);
    const polled = await getExportStatus(created.id);
    status = polled.status;
  }

  if (status !== "COMPLETED") {
    throw new ExportFailedError(created.id, status);
  }

  let raw = await fetchExportRawData<T>(created.id);
  const rawDeadline = Date.now() + POLL_TIMEOUT_MS;
  while (raw.state === "pending") {
    if (Date.now() >= rawDeadline) {
      throw new ExportTimeoutError(created.id);
    }
    await sleep(POLL_INTERVAL_MS);
    raw = await fetchExportRawData<T>(created.id);
  }

  if (raw.state === "not_found") {
    throw new ExportFailedError(created.id, status);
  }

  // Persist the UNTOUCHED raw export payload to the append-only raw archive. Best-effort: this
  // never throws and never mutates the normalized cache flow below (raw.raw was captured before
  // JSON.parse in fetchExportRawData). Purely additive — the returned CacheEntry is unchanged.
  await archiveRawExport({
    exportId: created.id,
    sellerId: params.sellerId,
    sourceName: params.sourceName,
    sourceId: source.id,
    columns,
    from: from ?? null,
    to: to ?? null,
    status,
    rowCount: raw.rows.length,
    requestId: raw.requestId,
    rawPayload: raw.raw,
  });

  return {
    key: "",
    schemaVersion: CACHE_SCHEMA_VERSION,
    sellerId: params.sellerId,
    sourceName: params.sourceName,
    source: { id: source.id, name: source.name, tableName: source.tableName, type: source.type },
    exportId: created.id,
    from: from ?? null,
    to: to ?? null,
    columns,
    all,
    page: all ? null : page,
    pageSize: all ? null : pageSize,
    retrievedAt: new Date().toISOString(),
    status: "COMPLETED",
    rowCount: raw.rows.length,
    rows: raw.rows,
  };
}

function toResult<T>(entry: CacheEntry<T>, status: ServedStatus): GetSellerSourceDataResult<T> {
  // entry.source.type is stored as a plain string in the cache (the cache module is decoupled
  // from the exports types); it originated from ExportSourceResponse["type"], so casting it back
  // to that union is safe.
  const source: Pick<ExportSourceResponse, "id" | "name" | "tableName" | "type"> = entry.source
    ? {
        id: entry.source.id,
        name: entry.source.name,
        tableName: entry.source.tableName,
        type: entry.source.type as ExportSourceResponse["type"],
      }
    : { id: "", name: entry.sourceName, tableName: "", type: "SELLER_CENTRAL" };
  return {
    source,
    exportId: entry.exportId ?? "",
    rows: entry.rows,
    meta: entry.all
      ? { page: 1, pageSize: entry.rows.length, rowCount: entry.rows.length }
      : { page: entry.page ?? 1, pageSize: entry.pageSize ?? entry.rows.length, rowCount: entry.rows.length },
    cache: {
      status,
      retrievedAt: entry.retrievedAt,
      ageMs: Date.now() - new Date(entry.retrievedAt).getTime(),
      key: entry.key,
    },
  };
}

/**
 * Cache-first accessor for a DataDoe source dataset.
 *
 * Default (refresh omitted): a matching cached entry is served with ZERO DataDoe exports;
 * only a genuine cache miss triggers one export (the implicit first sync), whose result is
 * then persisted. Forced refresh (refresh: true): always fetches fresh and overwrites the
 * cache, but if that fetch fails (402/429/timeout/etc.) it falls back to the last good cached
 * entry marked "stale" rather than erasing it — a failed Sync never destroys valid data.
 * Concurrent identical requests are de-duplicated onto a single in-flight export.
 */
export async function getSellerSourceData<T = Record<string, unknown>>(
  params: GetSellerSourceDataParams
): Promise<GetSellerSourceDataResult<T>> {
  const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
  const pageSize =
    params.pageSize && params.pageSize > 0
      ? Math.min(Math.floor(params.pageSize), MAX_PAGE_SIZE)
      : 100;
  const all = !!params.all;

  // Coverage-aware path: date-windowed historical sources fetched whole (all:true) share ONE
  // dataset across every range, so Today/7d/MTD/30d/Custom reuse already-stored rows instead of
  // each triggering a fresh export. Snapshot/non-historical sources (products, listings,
  // inventory) keep the exact-key path below unchanged.
  if (all && params.from && params.to && isHistoricalSource(params.sourceName)) {
    return getViaCoverage<T>(params, params.from, params.to);
  }

  const key = computeCacheKey({
    sellerId: params.sellerId,
    sourceName: params.sourceName,
    columns: params.columns,
    from: params.from,
    to: params.to,
    all,
    page,
    pageSize,
  });

  if (!params.refresh) {
    const cached = await readCache<T>(key);
    if (cached) {
      return toResult(cached, classifyAge(cached.retrievedAt));
    }
    // Rolling-window snapshot fallback (point-in-time sources requested with a recent from/to, i.e.
    // FBA inventory & inventory-health — NOT the coverage/historical sources, which return above).
    // These are queried over `today-N → today`; once "today" advances past the last sync the exact
    // key no longer matches even though the real snapshot rows are still on disk, wrongly blanking
    // the section. Serve the freshest cached snapshot for this seller+source so the ACTUAL cached
    // rows display (marked by their real retrieval age), never a fabricated value. Only a genuine
    // no-snapshot-ever case falls through to the honest not-synchronized state below.
    if (params.from && params.to && !isHistoricalSource(params.sourceName)) {
      const snap = await readLatestSnapshotEntry<T>(params.sellerId, params.sourceName);
      if (snap) {
        return toResult(snap, classifyAge(snap.retrievedAt));
      }
    }
    // Strict-local: a normal read never triggers a DataDoe export. A snapshot source with no
    // cached entry is "not synchronized" until an explicit Sync populates it.
    throw new RangeNotSynchronizedError(
      params.from ?? "",
      params.to ?? "",
      params.from && params.to ? [{ from: params.from, to: params.to }] : []
    );
  }

  try {
    const entry = await fetchWithDedup<T>(key, async () => {
      const fetched = await fetchFromDataDoe<T>(params, page, pageSize, all);
      fetched.key = key;
      await writeCache(key, fetched);
      return fetched;
    });
    return toResult(entry, "fresh");
  } catch (error) {
    // Preserve valid cached data across a failed fetch/refresh (Phase 6): serve the last good
    // entry, marked stale, instead of surfacing the error. Only when there is genuinely no
    // cached data does the error propagate (→ controller → honest "unavailable", never zero).
    const fallback = await readCache<T>(key);
    if (fallback) {
      return toResult(fallback, "stale");
    }
    throw error;
  }
}

/**
 * Reject a requested date range that the source cannot supply BEFORE any DataDoe export runs:
 * malformed dates, from-after-to, a future `to`, or a `from` older than the source's documented
 * historical boundary. Standard ranges (Today/7d/30d/MTD) are always within bounds, so this only
 * ever fires for an out-of-range Custom range.
 */
function validateHistoricalRange(sourceName: string, from: string, to: string): void {
  const earliest = earliestDateForSource(sourceName);
  const latest = todayIso();
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    throw new RangeUnavailableError("Invalid date format (expected YYYY-MM-DD)", earliest, latest);
  }
  if (from > to) {
    throw new RangeUnavailableError("Start date is after end date", earliest, latest);
  }
  if (to > latest) {
    throw new RangeUnavailableError("End date is in the future", earliest, latest);
  }
  if (from < earliest) {
    throw new RangeUnavailableError(
      `Start date is before the earliest available history (${earliest})`,
      earliest,
      latest
    );
  }
}

function coverageToResult<T>(
  entry: CoverageEntry<T>,
  rows: T[],
  status: ServedStatus,
  coverage?: ServedCoverage
): GetSellerSourceDataResult<T> {
  const source: Pick<ExportSourceResponse, "id" | "name" | "tableName" | "type"> = entry.source
    ? {
        id: entry.source.id,
        name: entry.source.name,
        tableName: entry.source.tableName,
        type: entry.source.type as ExportSourceResponse["type"],
      }
    : { id: "", name: entry.sourceName, tableName: "", type: "SELLER_CENTRAL" };
  return {
    source,
    exportId: entry.lastExportId ?? "",
    rows,
    meta: { page: 1, pageSize: rows.length, rowCount: rows.length },
    cache: {
      status,
      retrievedAt: entry.fetchedAt,
      ageMs: Date.now() - new Date(entry.fetchedAt).getTime(),
      key: entry.datasetKey,
    },
    coverage,
  };
}

/**
 * Coverage-aware accessor for date-windowed historical sources.
 *
 * Full coverage (default): serve filtered rows with ZERO exports. Partial coverage: fetch only
 * the still-missing interval(s), merge, persist, then serve. Forced refresh (Sync): re-fetch the
 * whole requested window and overwrite exactly those dates. A failed fetch never erases coverage —
 * if the requested range is still fully covered by what we already hold, it is served marked
 * "stale"; only a genuine no-data situation propagates the error (→ honest unavailable).
 */
async function getViaCoverage<T>(
  params: GetSellerSourceDataParams,
  from: string,
  to: string
): Promise<GetSellerSourceDataResult<T>> {
  validateHistoricalRange(params.sourceName, from, to);

  const datasetKey = computeDatasetKey({
    sellerId: params.sellerId,
    sourceName: params.sourceName,
    columns: params.columns,
  });

  return withDatasetLock(datasetKey, async () => {
    const existing = await readCoverage<T>(datasetKey);
    const intervals = existing?.intervals ?? [];
    const missing = missingIntervals(from, to, intervals);
    const covered = coveredIntervals(from, to, intervals);
    const fullyCovered = !!existing && missing.length === 0;

    // Describe how much of the requested window the local cache actually holds, so the caller can
    // show the real cached portion and flag the missing portion as unavailable (never as zeros).
    const dateField = existing?.dateField ?? "date";
    const buildCoverage = (servedRows: T[]): ServedCoverage => {
      const bounds = rowDateBounds(servedRows, dateField);
      return {
        requested: { from, to },
        covered,
        missing,
        partial: missing.length > 0,
        earliest: bounds.min,
        latest: bounds.max,
      };
    };

    // Pure cache hit: fully covered → serve from disk with no DataDoe export, refresh or not
    // (a Sync of an already-complete historical range shouldn't re-download it).
    if (fullyCovered) {
      const rows = filterRowsInRange(existing!.rows, from, to, existing!.dateField);
      // On a Sync, still refresh the recent mutable tail below; a fully-covered *historical*
      // range (nothing recent) is served straight from cache.
      if (!params.refresh) {
        return coverageToResult(
          existing!,
          rows,
          classifyCoverageAge(to, existing!.fetchedAt, false),
          buildCoverage(rows)
        );
      }
    }

    // Strict-local: a normal read NEVER calls DataDoe. ANY-OVERLAP availability using the ACTUAL
    // cached row dates as authoritative (this block is reached only when NOT fully covered):
    //   • zero overlap (no covered portion at all)  → not_synchronized (nothing here at all)
    //   • ANY overlap (leading gap, trailing gap, or
    //     a gap in the middle)                      → serve the REAL covered rows we hold and flag
    //     partial coverage (buildCoverage.partial=true) + the exact missing sub-interval(s). Valid
    //     cached data is never hidden regardless of which side of the range it falls on; the
    //     uncached portion is reported as missing, never shown as £0 or silently dropped.
    // 2026-09-01 (user-authorized): previously a LEADING gap (requested `from` before the earliest
    // cached date) blacked out the WHOLE range rather than serve the later covered slice, to avoid
    // ever implying a full-period total from partial data. That constraint is superseded — the
    // caller (frontend) now renders `coverage.covered`/`coverage.missing` as an explicit
    // "Partial — N of M days" label instead, so the real covered days are shown rather than
    // hidden, for a leading gap exactly as they already were for a trailing gap.
    if (!params.refresh) {
      if (existing && covered.length > 0) {
        const rows = filterRowsInRange(existing.rows, from, to, existing.dateField);
        return coverageToResult(
          existing,
          rows,
          classifyCoverageAge(to, existing.fetchedAt, false),
          buildCoverage(rows)
        );
      }
      throw new RangeNotSynchronizedError(from, to, missing);
    }

    // Sync (refresh:true) targets the FULL supported rolling window for this source (max 730-day
    // history → today), NOT just the displayed range, so ONE Sync makes every in-boundary date
    // selection (Today/7d/30d/MTD/any Custom) a local cache hit afterwards. It still fetches only
    // the STILL-MISSING gaps across that window, plus the recent mutable window (last
    // RECENT_WINDOW_DAYS, which can still change upstream) — completed historical dates already on
    // disk are never re-downloaded. The displayed range is served as a slice of this fuller cache
    // below, so its totals stay correct while the cache is fully populated.
    const syncFrom = earliestDateForSource(params.sourceName);
    const syncTo = todayIso();
    const gaps = missingIntervals(syncFrom, syncTo, existing?.intervals ?? []);
    const recentCutoff = formatDate(addDays(todayLocalMidnight(), -RECENT_WINDOW_DAYS));
    const recentFrom = syncFrom > recentCutoff ? syncFrom : recentCutoff;
    const recentOverlap = recentFrom <= syncTo ? [{ from: recentFrom, to: syncTo }] : [];
    const toFetch = coalesceIntervals([...gaps, ...recentOverlap]).filter(
      (iv) => iv.from <= syncTo && iv.to >= syncFrom
    );

    if (toFetch.length === 0 && existing) {
      const rows = filterRowsInRange(existing.rows, from, to, existing.dateField);
      return coverageToResult(existing, rows, classifyCoverageAge(to, existing.fetchedAt, false));
    }

    try {
      let working: CoverageEntry<T> | null = existing;
      for (const iv of toFetch) {
        const fetched = await fetchFromDataDoe<T>(params, 1, MAX_PAGE_SIZE, true, {
          from: iv.from,
          to: iv.to,
        });
        if (!working) {
          working = newCoverageEntry<T>({
            datasetKey,
            sellerId: params.sellerId,
            sourceName: params.sourceName,
            columns: fetched.columns,
            source: fetched.source,
          });
        }
        working.rows = mergeRowsForInterval(working.rows, fetched.rows, iv.from, iv.to, working.dateField);
        // Coverage must reflect ACTUAL row dates, not the requested/exported window: DataDoe can
        // (and does) return rows for a narrower span than [iv.from, iv.to] — e.g. an account whose
        // real history only goes back to 2025-06-24 still gets a 2024-08-28-to-today export request,
        // but the response only contains rows from 2025-06-24 on. Recording the full requested
        // interval as "covered" would let a later request for the unproven portion be served from
        // cache as a silent zero instead of an honest not-synchronized state. Undated rows are
        // ignored for this calculation (they carry no proof of a specific date) but are still merged
        // into working.rows above per the existing cache-merge contract.
        const fetchedBounds = rowDateBounds(fetched.rows, working.dateField);
        if (fetchedBounds.min !== null && fetchedBounds.max !== null) {
          const actualFrom = fetchedBounds.min > iv.from ? fetchedBounds.min : iv.from;
          const actualTo = fetchedBounds.max < iv.to ? fetchedBounds.max : iv.to;
          if (actualFrom <= actualTo) {
            working.intervals = coalesceIntervals([...working.intervals, { from: actualFrom, to: actualTo }]);
          }
        }
        // Zero dated rows → do not add iv to coverage at all; the interval stays uncovered so a
        // future request for it honestly reports not-synchronized rather than fabricating coverage.
        working.fetchedAt = new Date().toISOString();
        working.lastExportId = fetched.exportId;
        working.source = working.source ?? fetched.source;
        working.columns = fetched.columns;
        // Persist after EACH interval so a later interval's failure can't lose data already
        // fetched (atomic temp+rename write — a crash never truncates a prior valid entry).
        await writeCoverage(datasetKey, working);
      }
      const rows = filterRowsInRange(working!.rows, from, to, working!.dateField);
      return coverageToResult(working!, rows, classifyCoverageAge(to, working!.fetchedAt, true));
    } catch (error) {
      // Preserve valid coverage across a failed fetch/refresh: if the requested range is still
      // fully covered by what we already have, serve it marked stale rather than erasing it.
      if (existing && isFullyCovered(from, to, existing.intervals)) {
        const rows = filterRowsInRange(existing.rows, from, to, existing.dateField);
        return coverageToResult(existing, rows, "stale");
      }
      throw error;
    }
  });
}

export async function getSellerSources(sellerId: string) {
  return getExportSources([sellerId]);
}

function cacheDirPath(): string {
  return process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
}

/**
 * Freshest persisted exact-key snapshot for a seller+source, ignoring the (rolling) date window and
 * pagination — a token-free disk read. Used only as a fallback for point-in-time snapshot sources
 * whose rolling request window has advanced past the last-synced window, so the ACTUAL cached rows
 * still display instead of a false "not synchronized" state. Coverage (`.cov.json`) files and other
 * sellers/sources are skipped; the newest `retrievedAt` wins. Returns null when nothing is cached.
 */
async function readLatestSnapshotEntry<T>(
  sellerId: string,
  sourceName: string
): Promise<CacheEntry<T> | null> {
  const dir = cacheDirPath();
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".cov.json") && !f.endsWith(".tmp")
    );
  } catch {
    return null;
  }
  let best: CacheEntry<T> | null = null;
  for (const f of files) {
    let entry: CacheEntry<T>;
    try {
      entry = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as CacheEntry<T>;
    } catch {
      continue; // torn/foreign file — skip, never throw
    }
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) continue;
    if (entry.sellerId !== sellerId || entry.sourceName !== sourceName) continue;
    if (!best || (entry.retrievedAt || "") > (best.retrievedAt || "")) best = entry;
  }
  return best;
}

/**
 * Reconstruct the connected seller/vendor list purely from LOCALLY CACHED rows — a token-free,
 * zero-DataDoe read used to render the dashboard's seller picker offline. Every persisted cache
 * entry carries the `sellerId` it was fetched for, and the row payloads carry the human-facing
 * account identity (`seller_or_vendor_name`/`seller_name`) plus marketplace fields; this scans the
 * cache directory once and folds them into one item per distinct seller. Returns an empty array
 * when nothing is cached yet (the caller then falls back to a live lookup — the only path that
 * would touch DataDoe, and only when there is genuinely no local data to serve).
 */
export async function listLocalSellers(): Promise<SellersAndVendorsItem[]> {
  const dir = cacheDirPath();
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  } catch {
    return [];
  }
  const byId = new Map<string, SellersAndVendorsItem>();
  for (const f of files) {
    let entry: { sellerId?: unknown; rows?: unknown };
    try {
      entry = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
    } catch {
      continue; // torn/foreign file — skip, never throw
    }
    const sellerId = typeof entry.sellerId === "string" ? entry.sellerId : null;
    if (!sellerId || byId.has(sellerId)) continue;
    const rows = Array.isArray(entry.rows) ? (entry.rows as Array<Record<string, unknown>>) : [];
    let name = sellerId;
    let marketplaceId: string | null = null;
    let marketplaceCountryCode: string | null = null;
    let marketplaceCountryName: string | null = null;
    for (const r of rows) {
      const n = r["seller_or_vendor_name"] ?? r["seller_name"];
      if (typeof n === "string" && n.length > 0) {
        name = n;
        marketplaceId = typeof r["marketplace_id"] === "string" ? (r["marketplace_id"] as string) : null;
        marketplaceCountryCode =
          typeof r["marketplace_country_code"] === "string" ? (r["marketplace_country_code"] as string) : null;
        marketplaceCountryName =
          typeof r["marketplace_country_name"] === "string" ? (r["marketplace_country_name"] as string) : null;
        break;
      }
    }
    byId.set(sellerId, {
      id: sellerId,
      name,
      rowCount: rows.length,
      marketplaceId,
      marketplaceCountryCode,
      marketplaceCountryName,
      sellerCentralConnection: null,
      vendorCentralConnection: null,
      amazonAdsConnection: null,
    });
  }
  return Array.from(byId.values());
}

/**
 * Actual locally-synchronized coverage for a seller (token-free disk read). Returns the per-source
 * intervals plus the overall earliest/latest synchronized date across all date-windowed sources,
 * so the calendar can show what is already synced vs what still needs a Sync. Empty until the first
 * Sync populates the cache.
 */
export async function getStoredCoverage(
  sellerId: string
): Promise<{ earliest: string | null; latest: string | null; sources: StoredCoverageSummary[] }> {
  const sources = await listStoredCoverage(sellerId);
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const s of sources) {
    if (s.earliest && (earliest === null || s.earliest < earliest)) earliest = s.earliest;
    if (s.latest && (latest === null || s.latest > latest)) latest = s.latest;
  }
  return { earliest, latest, sources };
}
