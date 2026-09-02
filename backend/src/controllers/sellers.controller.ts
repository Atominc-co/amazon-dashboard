import { Request, Response } from "express";
import { getSellersAndVendors, DataDoeApiError } from "../services/datadoe";
import {
  ExportFailedError,
  ExportTimeoutError,
  RangeNotSynchronizedError,
  RangeUnavailableError,
  SourceNotFoundError,
  getSellerSourceData,
  getSellerSources as fetchSellerSources,
  getStoredCoverage,
  listLocalSellers,
} from "../services/amazon-catalog.service";
import {
  addDays,
  daysBetweenIso,
  formatDate,
  isValidIsoDate,
  parseIsoDate,
  todayIso,
} from "../services/datadoe/datadoe.dates";
import { dashboardHistoryBoundary } from "../services/datadoe/datadoe.history";
import { getPnlRange } from "../services/datadoe/datadoe.pnl";
import { getOrdersRange } from "../services/datadoe/datadoe.orders";
import { getLiveProducts } from "../services/datadoe/datadoe.liveproducts";
import { getInventoryHealth } from "../services/datadoe/datadoe.inventoryhealth";

const SELLER_SEARCH_MAX_PAGES = 20;
const SELLER_SEARCH_PAGE_SIZE = 100;

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// A "?refresh=1" (or true/yes) query param forces a fresh DataDoe export ("Sync"), bypassing the
// cache-first read. Anything else (including absence) serves cached data when present — the
// token-saving default.
function parseRefresh(req: Request): boolean {
  const raw = req.query.refresh;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "1" || v === "true" || v === "yes";
}

export async function getSellers(req: Request, res: Response): Promise<void> {
  const page = parseOptionalNumber(req.query.page);
  const pageSize = parseOptionalNumber(req.query.pageSize);

  try {
    // Local-first: serve the connected seller list straight from the local cache (token-free, zero
    // DataDoe). Only when nothing is cached yet do we fall back to a live lookup — so a normal
    // dashboard load, which is the only thing that hits this endpoint, never calls DataDoe.
    const local = await listLocalSellers();
    if (local.length > 0) {
      res.status(200).json({
        data: local,
        meta: {
          currentPageSize: local.length,
          pageSize: local.length,
          currentPage: 1,
          totalPages: 1,
          hasPreviousPage: false,
          hasNextPage: false,
          results: local.length,
          totalResults: local.length,
        },
      });
      return;
    }
    const result = await getSellersAndVendors({ page, pageSize });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof DataDoeApiError) {
      res.status(error.status).json({
        message: error.message,
        requestId: error.requestId,
      });
      return;
    }

    res.status(502).json({
      message: error instanceof Error ? error.message : "Failed to reach DataDoe API",
    });
  }
}

function handleServiceError(error: unknown, res: Response): void {
  if (error instanceof DataDoeApiError) {
    res.status(error.status).json({ message: error.message, requestId: error.requestId });
    return;
  }
  if (error instanceof SourceNotFoundError) {
    res.status(404).json({ message: error.message });
    return;
  }
  if (error instanceof RangeUnavailableError) {
    // Requested range is outside the supported history — an honest range-limit state, not an
    // error and never zero/fabricated data. 422 (Unprocessable Entity): the request was
    // well-formed but the dates cannot be satisfied.
    res.status(422).json({
      message: error.message,
      status: "range_unavailable",
      availableHistory: { earliest: error.earliest, latest: error.latest },
    });
    return;
  }
  if (error instanceof RangeNotSynchronizedError) {
    // In-boundary but not yet in the local cache, and this was a normal (non-Sync) read — under
    // strict-local we never auto-fetch. HTTP 200 with an explicit status so the frontend renders
    // "Data not synchronized for this period" + a Sync prompt (distinct from an error/402). Never
    // zero/fabricated data. `missing` tells a subsequent Sync exactly which interval(s) to fetch.
    res.status(200).json({
      status: "not_synchronized",
      message: error.message,
      dateRangeRequested: { from: error.from, to: error.to },
      missing: error.missing,
    });
    return;
  }
  if (error instanceof ExportTimeoutError) {
    res
      .status(202)
      .json({ message: error.message, exportId: error.exportId, status: "IN_PROGRESS" });
    return;
  }
  if (error instanceof ExportFailedError) {
    res.status(502).json({ message: error.message, exportId: error.exportId, status: error.status });
    return;
  }

  res.status(502).json({
    message: error instanceof Error ? error.message : "Failed to reach DataDoe API",
  });
}

function parsePositiveIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return parsed > 0 ? parsed : undefined;
}

function parseValidatedPagination(
  req: Request,
  res: Response
): { page?: number; pageSize?: number } | null {
  const pageRaw = req.query.page;
  const pageSizeRaw = req.query.pageSize;

  const page = parsePositiveIntOrUndefined(pageRaw);
  const pageSize = parsePositiveIntOrUndefined(pageSizeRaw);

  if (pageRaw !== undefined && page === undefined) {
    res.status(400).json({ message: "page must be a positive integer" });
    return null;
  }
  if (pageSizeRaw !== undefined && pageSize === undefined) {
    res.status(400).json({ message: "pageSize must be a positive integer" });
    return null;
  }

  return { page, pageSize };
}

function requireSellerId(req: Request, res: Response): string | null {
  const { sellerId } = req.params;
  if (!sellerId || sellerId.trim().length === 0) {
    res.status(400).json({ message: "sellerId path parameter is required" });
    return null;
  }
  return sellerId;
}

async function findSellerById(sellerId: string) {
  // Local-first (token-free, zero DataDoe): resolve from the cached seller list when present.
  const local = await listLocalSellers();
  const localMatch = local.find((item) => item.id === sellerId);
  if (localMatch) {
    return localMatch;
  }
  let page = 1;
  while (page <= SELLER_SEARCH_MAX_PAGES) {
    const result = await getSellersAndVendors({ page, pageSize: SELLER_SEARCH_PAGE_SIZE });
    const match = result.data.find((item) => item.id === sellerId);
    if (match) {
      return match;
    }
    if (!result.meta.hasNextPage) {
      return null;
    }
    page += 1;
  }
  return null;
}

export async function getSellerById(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }

  try {
    const seller = await findSellerById(sellerId);
    if (!seller) {
      res.status(404).json({ message: `Seller ${sellerId} not found` });
      return;
    }
    res.status(200).json({ data: seller });
  } catch (error) {
    if (error instanceof DataDoeApiError) {
      res.status(error.status).json({ message: error.message, requestId: error.requestId });
      return;
    }
    res.status(502).json({
      message: error instanceof Error ? error.message : "Failed to reach DataDoe API",
    });
  }
}

/**
 * Dashboard-level available history for the calendar: the earliest and latest selectable dates
 * and the per-source documented limits behind them. Pure computation — no DataDoe export, so it
 * is free of tokens and works even while the account is 402/token-limited. The frontend uses
 * `earliest`/`latest` as the Custom calendar's min/max.
 */
export async function getSellerHistory(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const boundary = dashboardHistoryBoundary();
  // Actual locally-synchronized coverage (token-free disk read). `availableHistory` is the
  // selectable calendar boundary (documented 730-day window); `localCoverage` is what has actually
  // been synced so far, so the UI can distinguish "selectable" from "already synchronized locally".
  const localCoverage = await getStoredCoverage(sellerId);
  res.status(200).json({
    sellerId,
    availableHistory: { earliest: boundary.earliest, latest: boundary.latest },
    maxHistoryDays: boundary.maxHistoryDays,
    today: todayIso(),
    sources: boundary.sources,
    localCoverage: {
      earliest: localCoverage.earliest,
      latest: localCoverage.latest,
      synced: localCoverage.earliest !== null,
      sources: localCoverage.sources,
    },
  });
}

export async function getSellerSources(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }

  try {
    const result = await fetchSellerSources(sellerId);
    res.status(200).json(result);
  } catch (error) {
    handleServiceError(error, res);
  }
}

export async function getSellerProducts(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const pagination = parseValidatedPagination(req, res);
  if (!pagination) {
    return;
  }

  try {
    const result = await getSellerSourceData({
      sellerId,
      sourceName: "Product Catalog by ASIN",
      page: pagination.page,
      pageSize: pagination.pageSize,
      refresh: parseRefresh(req),
    });
    res.status(200).json(result);
  } catch (error) {
    handleServiceError(error, res);
  }
}

export async function getSellerListings(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const pagination = parseValidatedPagination(req, res);
  if (!pagination) {
    return;
  }

  try {
    // Listings is a snapshot source with no server-side total-count field (proven across many
    // investigations — DataDoe returns no total alongside a page). Requesting the FULL set
    // (all:true, no skip/limit) is the only way to know the true seller-wide status counts, and
    // costs the same one export as any other fetch of this source. `pagination` above still
    // validates the query params for backward compatibility but is no longer used to cap rows.
    const result = await getSellerSourceData({
      sellerId,
      sourceName: "Listings",
      all: true,
      refresh: parseRefresh(req),
    });
    res.status(200).json(result);
  } catch (error) {
    handleServiceError(error, res);
  }
}

interface InventoryRow {
  child_asin?: string;
  sku?: string;
  date?: string;
  quantity_for_local_fulfillment?: number;
  [key: string]: unknown;
}

const INVENTORY_SOURCE_NAME = "FBA Inventory by ASIN & Country";
const INVENTORY_WINDOW_DAYS = 3;
const INVENTORY_DEFAULT_PAGE_SIZE = 500;

// formatDate / addDays now live in services/datadoe/datadoe.dates (single source of truth for
// the dashboard's LOCAL-calendar date semantics — the reason documented there is that
// toISOString() would shift the day back in timezones ahead of UTC). Imported above.

function recentDateRange(windowDays: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - windowDays);
  return { from: formatDate(from), to: formatDate(to) };
}

/**
 * The source is a daily per-ASIN snapshot, so the requested date window can contain
 * multiple rows per ASIN. Keep only the most recent row per ASIN so "units on hand"
 * reflects a single point-in-time snapshot rather than double-counting across days.
 */
function latestRowPerAsin<T extends { child_asin?: string; sku?: string; date?: string }>(
  rows: T[]
): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = row.child_asin || row.sku;
    if (!key) continue;
    const existing = latest.get(key);
    if (!existing || (row.date || "") > (existing.date || "")) {
      latest.set(key, row);
    }
  }
  return Array.from(latest.values());
}

export async function getSellerInventory(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const pagination = parseValidatedPagination(req, res);
  if (!pagination) {
    return;
  }

  const { from, to } = recentDateRange(INVENTORY_WINDOW_DAYS);

  try {
    const result = await getSellerSourceData<InventoryRow>({
      sellerId,
      sourceName: INVENTORY_SOURCE_NAME,
      pageSize: pagination.pageSize || INVENTORY_DEFAULT_PAGE_SIZE,
      from,
      to,
      refresh: parseRefresh(req),
    });

    const rows = latestRowPerAsin(result.rows);
    const snapshotDate = rows.reduce<string | null>((max, r) => {
      const d = r.date || null;
      return d && (!max || d > max) ? d : max;
    }, null);
    const unitsOnHand = rows.reduce(
      (total, r) => total + (typeof r.quantity_for_local_fulfillment === "number" ? r.quantity_for_local_fulfillment : 0),
      0
    );

    res.status(200).json({
      source: result.source,
      exportId: result.exportId,
      cache: result.cache,
      dateRangeRequested: { from, to },
      snapshotDate,
      unitsOnHand,
      rows,
      meta: { ...result.meta, rowCount: rows.length },
    });
  } catch (error) {
    handleServiceError(error, res);
  }
}

/**
 * Premium DataDoe source. Optional/additive only — never used as a substitute for
 * INVENTORY_SOURCE_NAME above. If this account loses access to the Premium source,
 * getSellerSourceData throws SourceNotFoundError/DataDoeApiError like any other source
 * and getSellerInventory (free) is entirely unaffected.
 */
interface InventoryHealthRow {
  child_asin?: string;
  sku?: string;
  date?: string;
  product_name?: string;
  days_of_supply?: number | null;
  available?: number;
  alert?: string | null;
  recommended_action?: string | null;
  [key: string]: unknown;
}

const INVENTORY_HEALTH_SOURCE_NAME = "FBA Inventory Health";

export async function getSellerInventoryHealth(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const pagination = parseValidatedPagination(req, res);
  if (!pagination) {
    return;
  }

  const { from, to } = recentDateRange(INVENTORY_WINDOW_DAYS);

  try {
    const result = await getSellerSourceData<InventoryHealthRow>({
      sellerId,
      sourceName: INVENTORY_HEALTH_SOURCE_NAME,
      pageSize: pagination.pageSize || INVENTORY_DEFAULT_PAGE_SIZE,
      from,
      to,
      refresh: parseRefresh(req),
    });

    const rows = latestRowPerAsin(result.rows);
    const snapshotDate = rows.reduce<string | null>((max, r) => {
      const d = r.date || null;
      return d && (!max || d > max) ? d : max;
    }, null);

    // Days of cover is a single account-wide KPI but days_of_supply is per-ASIN, so it is
    // rolled up as a units-weighted average (ASINs with more available stock weigh more),
    // mirroring how "Units on hand" already sums across ASINs from the free source.
    // ASINs missing a numeric days_of_supply or with zero available units are excluded
    // rather than treated as zero, so they don't silently drag the average down.
    let weightedSum = 0;
    let weightTotal = 0;
    let contributingAsinCount = 0;
    for (const r of rows) {
      const dos = typeof r.days_of_supply === "number" ? r.days_of_supply : null;
      const units = typeof r.available === "number" ? r.available : 0;
      if (dos !== null && units > 0) {
        weightedSum += dos * units;
        weightTotal += units;
        contributingAsinCount += 1;
      }
    }
    const daysOfCoverValue = weightTotal > 0 ? weightedSum / weightTotal : null;

    // DataDoe's own "alert" column is used verbatim as the trigger for "needs a decision" —
    // no locally-invented thresholds. If DataDoe reports no alerts, this is an empty array,
    // same honest-empty-state convention as listingIssues.
    const alerts = rows
      .filter((r): r is InventoryHealthRow & { alert: string } => typeof r.alert === "string" && r.alert.trim().length > 0)
      .map((r) => ({
        asin: r.child_asin || r.sku || "",
        name: r.product_name || r.child_asin || r.sku || "",
        note: r.alert,
        metric: r.recommended_action || "",
      }));

    res.status(200).json({
      source: result.source,
      exportId: result.exportId,
      cache: result.cache,
      dateRangeRequested: { from, to },
      snapshotDate,
      daysOfCover: {
        value: daysOfCoverValue,
        method: "units_weighted_average",
        asinCount: contributingAsinCount,
      },
      alerts,
      meta: { ...result.meta, rowCount: rows.length },
    });
  } catch (error) {
    handleServiceError(error, res);
  }
}

/**
 * Free DataDoe source "Sales & Traffic by ASIN & Date" (amazon_sales_and_traffic_with_cogs),
 * derived from Amazon's GET_SALES_AND_TRAFFIC_REPORT. total_sales/total_units/total_orders are
 * per-ASIN-per-date; summing across all ASINs/dates in the window gives the account-level
 * totals below. Fetched with all:true (no skip/limit) because a paginated page would silently
 * truncate the sum for sellers with more rows than one page — verified against this account's
 * real data (a 30-day window returned 876 rows, well past the 500-row page cap).
 */
interface SalesTrafficRow {
  date?: string;
  child_asin?: string;
  product_name?: string;
  total_sales?: number;
  total_units?: number;
  total_orders?: number;
  session?: number;
  buybox_percentage?: number;
  [key: string]: unknown;
}

const SALES_SOURCE_NAME = "Sales & Traffic by ASIN & Date";
const SALES_RANGES = ["Today", "7d", "30d", "MTD"] as const;
type SalesRange = (typeof SALES_RANGES)[number];

function isSalesRange(value: unknown): value is SalesRange {
  return typeof value === "string" && (SALES_RANGES as readonly string[]).includes(value);
}

function salesWindowForRange(range: SalesRange): { from: Date; to: Date; windowDays: number } {
  const to = new Date();
  to.setHours(0, 0, 0, 0);
  if (range === "Today") {
    return { from: to, to, windowDays: 1 };
  }
  if (range === "7d") {
    return { from: addDays(to, -6), to, windowDays: 7 };
  }
  if (range === "MTD") {
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    const windowDays = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
    return { from, to, windowDays };
  }
  return { from: addDays(to, -29), to, windowDays: 30 };
}

/**
 * The resolved window a summary endpoint should query: the selected range's [from,to], its
 * length, and the immediately-preceding comparison window (or null when that comparison window
 * would fall before the supported historical boundary — in which case the endpoint simply shows
 * no prior-period delta rather than failing or fabricating one).
 */
interface ResolvedWindow {
  range: string;
  from: string;
  to: string;
  windowDays: number;
  prev: { from: string; to: string } | null;
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

export type ComputeWindowResult =
  | { ok: true; window: ResolvedWindow }
  | { ok: false; message: string; availableHistory: { earliest: string; latest: string } };

/**
 * Pure resolver from raw query values to a window. Handles Today/7d/30d/MTD (existing semantics,
 * unchanged) and Custom (from/to). Malformed/out-of-order/future/pre-boundary Custom ranges fail
 * with an `ok:false` range-limit result BEFORE any DataDoe work; the per-source historical
 * boundary is additionally enforced deeper in the service. Exported so the exact date semantics
 * (Today = actual current day, MTD = current month-to-date, Custom prev-period) are unit-testable
 * offline without an HTTP round-trip.
 */
export function computeWindow(
  rangeParam: string | undefined,
  fromRaw?: string,
  toRaw?: string
): ComputeWindowResult {
  const boundary = dashboardHistoryBoundary();
  const availableHistory = { earliest: boundary.earliest, latest: boundary.latest };

  if (rangeParam === "Custom") {
    const from = fromRaw ?? "";
    const to = toRaw ?? "";
    if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
      return { ok: false, message: "Custom range requires valid from/to dates (YYYY-MM-DD)", availableHistory };
    }
    if (from > to) {
      return { ok: false, message: "Start date is after end date", availableHistory };
    }
    if (to > boundary.latest) {
      return { ok: false, message: "End date is in the future", availableHistory };
    }
    if (from < boundary.earliest) {
      return {
        ok: false,
        message: `Start date is before the earliest available history (${boundary.earliest})`,
        availableHistory,
      };
    }
    const windowDays = (daysBetweenIso(from, to) ?? 0) + 1;
    const prevToDate = addDays(parseIsoDate(from)!, -1);
    const prevFromDate = addDays(prevToDate, -(windowDays - 1));
    const prevFrom = formatDate(prevFromDate);
    const prev = prevFrom >= boundary.earliest ? { from: prevFrom, to: formatDate(prevToDate) } : null;
    return { ok: true, window: { range: "Custom", from, to, windowDays, prev } };
  }

  const range: SalesRange = isSalesRange(rangeParam) ? rangeParam : "30d";
  const w = salesWindowForRange(range);
  const from = formatDate(w.from);
  const to = formatDate(w.to);
  const prevToDate = addDays(w.from, -1);
  const prevFromDate = addDays(prevToDate, -(w.windowDays - 1));
  return {
    ok: true,
    window: {
      range,
      from,
      to,
      windowDays: w.windowDays,
      prev: { from: formatDate(prevFromDate), to: formatDate(prevToDate) },
    },
  };
}

/**
 * HTTP wrapper over computeWindow: writes a 422 range-limit response on failure and returns null,
 * otherwise returns the resolved window.
 */
function resolveWindow(req: Request, res: Response): ResolvedWindow | null {
  const result = computeWindow(
    firstQueryValue(req.query.range),
    firstQueryValue(req.query.from),
    firstQueryValue(req.query.to)
  );
  if (!result.ok) {
    res.status(422).json({
      message: result.message,
      status: "range_unavailable",
      availableHistory: result.availableHistory,
    });
    return null;
  }
  return result.window;
}

/**
 * Fetch the prior-period rows for a delta comparison, or an empty stand-in when there is no
 * valid comparison window (Custom range whose previous period predates the supported history).
 * An empty stand-in yields zero previous-totals and null deltas — never a fabricated comparison.
 */
async function fetchPreviousWindow<T = Record<string, unknown>>(
  base: { sellerId: string; sourceName: string; all?: boolean; columns?: string[]; refresh?: boolean },
  prev: { from: string; to: string } | null
): Promise<{ rows: T[]; meta: { rowCount: number } }> {
  if (!prev) return { rows: [], meta: { rowCount: 0 } };
  try {
    // Always a cache-only read (refresh:false), even during a Sync: the current-window Sync above
    // already populated the FULL rolling window on the same dataset (which contains this prior
    // period), so reading it needs zero extra exports. Any still-missing prior period simply
    // yields no delta (caught below) rather than triggering another DataDoe call.
    const r = await getSellerSourceData<T>({ ...base, refresh: false, from: prev.from, to: prev.to });
    // Only compare against a FULLY-covered prior period. A partially-cached prior window would make
    // the delta compare a complete current period against an incomplete base — a misleading %. When
    // the prior period is only partially (or not) synchronized, show no delta, exactly as before the
    // partial-serve change (which previously threw RangeNotSynchronizedError for any non-full range).
    if (r.coverage && r.coverage.partial) {
      return { rows: [], meta: { rowCount: 0 } };
    }
    return { rows: r.rows, meta: { rowCount: r.meta.rowCount } };
  } catch (error) {
    // The comparison window not being synchronized locally must not blank the (synchronized)
    // current period — just show no prior-period delta, same as when prev is null. Any other
    // error still propagates so the current section reports it honestly.
    if (error instanceof RangeNotSynchronizedError) {
      return { rows: [], meta: { rowCount: 0 } };
    }
    throw error;
  }
}

interface SalesTotals {
  totalSales: number;
  totalUnits: number;
  totalOrders: number;
  sessions: number;
}

function aggregateSalesRows(rows: SalesTrafficRow[]): SalesTotals {
  let totalSales = 0;
  let totalUnits = 0;
  let totalOrders = 0;
  let sessions = 0;
  for (const r of rows) {
    totalSales += typeof r.total_sales === "number" ? r.total_sales : 0;
    totalUnits += typeof r.total_units === "number" ? r.total_units : 0;
    totalOrders += typeof r.total_orders === "number" ? r.total_orders : 0;
    sessions += typeof r.session === "number" ? r.session : 0;
  }
  return { totalSales, totalUnits, totalOrders, sessions };
}

function pctDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

interface AsinSalesTotals {
  asin: string;
  name: string;
  units: number;
  sales: number;
  buyboxPct: number | null;
}

/**
 * Per-ASIN breakdown from the same rows already fetched for the account-level totals above —
 * no extra DataDoe call. buyboxPct uses only the most recent dated row per ASIN (via the same
 * latestRowPerAsin helper used for inventory) since buybox_percentage is a point-in-time
 * ownership figure; summing or averaging it across the whole window would not mean anything.
 */
function aggregateSalesByAsin(rows: SalesTrafficRow[]): AsinSalesTotals[] {
  const totals = new Map<string, { name: string; units: number; sales: number }>();
  for (const r of rows) {
    if (!r.child_asin) continue;
    const existing = totals.get(r.child_asin) || { name: r.product_name || r.child_asin, units: 0, sales: 0 };
    existing.units += typeof r.total_units === "number" ? r.total_units : 0;
    existing.sales += typeof r.total_sales === "number" ? r.total_sales : 0;
    if (r.product_name) existing.name = r.product_name;
    totals.set(r.child_asin, existing);
  }
  const latestBuybox = new Map<string, number | null>();
  for (const r of latestRowPerAsin(rows)) {
    if (r.child_asin) {
      latestBuybox.set(r.child_asin, typeof r.buybox_percentage === "number" ? r.buybox_percentage : null);
    }
  }
  return Array.from(totals.entries()).map(([asin, t]) => ({
    asin,
    name: t.name,
    units: t.units,
    sales: t.sales,
    buyboxPct: latestBuybox.get(asin) ?? null,
  }));
}

interface DailySalesPoint {
  date: string;
  totalSales: number;
  totalUnits: number;
}

function aggregateSalesByDate(rows: SalesTrafficRow[]): DailySalesPoint[] {
  const totals = new Map<string, { totalSales: number; totalUnits: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const existing = totals.get(r.date) || { totalSales: 0, totalUnits: 0 };
    existing.totalSales += typeof r.total_sales === "number" ? r.total_sales : 0;
    existing.totalUnits += typeof r.total_units === "number" ? r.total_units : 0;
    totals.set(r.date, existing);
  }
  return Array.from(totals.entries())
    .map(([date, t]) => ({ date, ...t }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getSellerSalesSummary(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }

  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to, windowDays, prev } = win;

  try {
    // Sequential, not concurrent: same org-wide DataDoe rate limit reason as the inventory
    // and listings calls above — two exports fired at once risked a 429 on one of them.
    const refresh = parseRefresh(req);
    const currentResult = await getSellerSourceData<SalesTrafficRow>({
      sellerId,
      sourceName: SALES_SOURCE_NAME,
      all: true,
      from,
      to,
      refresh,
    });
    const previousResult = await fetchPreviousWindow<SalesTrafficRow>(
      { sellerId, sourceName: SALES_SOURCE_NAME, all: true, refresh },
      prev
    );

    const current = aggregateSalesRows(currentResult.rows);
    const previous = aggregateSalesRows(previousResult.rows);

    const avgOrderValue = current.totalOrders > 0 ? current.totalSales / current.totalOrders : null;
    const unitsPerDay = windowDays > 0 ? current.totalUnits / windowDays : null;
    // Amazon's own "Unit Session Percentage" is units ordered ÷ sessions, not an average of
    // per-ASIN-per-date percentages (which would over-weight low-traffic ASIN/date rows).
    const unitSessionPercentage = current.sessions > 0 ? (current.totalUnits / current.sessions) * 100 : null;
    const byAsin = aggregateSalesByAsin(currentResult.rows);
    const daily = aggregateSalesByDate(currentResult.rows);

    res.status(200).json({
      source: currentResult.source,
      exportId: currentResult.exportId,
      cache: currentResult.cache,
      range,
      dateRangeRequested: { from, to },
      previousDateRange: prev,
      totals: current,
      previousTotals: previous,
      derived: { avgOrderValue, unitsPerDay, unitSessionPercentage },
      deltas: {
        totalSalesPct: pctDelta(current.totalSales, previous.totalSales),
        totalUnitsPct: pctDelta(current.totalUnits, previous.totalUnits),
        totalOrdersPct: pctDelta(current.totalOrders, previous.totalOrders),
      },
      byAsin,
      daily,
      coverage: currentResult.coverage,
      meta: { currentRowCount: currentResult.meta.rowCount, previousRowCount: previousResult.meta.rowCount },
    });
  } catch (error) {
    handleServiceError(error, res);
  }
}

function sumNumberField(rows: Array<Record<string, unknown>>, field: string): number {
  let total = 0;
  for (const r of rows) {
    const v = r[field];
    total += typeof v === "number" ? v : 0;
  }
  return total;
}

function firstCurrency(rows: Array<{ currency?: string }>): string | null {
  const row = rows.find((r) => typeof r.currency === "string" && r.currency.length > 0);
  return row ? (row.currency as string) : null;
}

interface DailyRevenuePoint {
  date: string;
  netRevenue: number;
}

// Daily net revenue from the same Settlements & P&L rows already fetched for the account-level
// total above — no extra DataDoe call.
function aggregateRevenueByDate(rows: SettlementRow[]): DailyRevenuePoint[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!r.date) continue;
    totals.set(r.date, (totals.get(r.date) || 0) + (typeof r.total === "number" ? r.total : 0));
  }
  return Array.from(totals.entries())
    .map(([date, netRevenue]) => ({ date, netRevenue }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Free DataDoe source "Settlements & P&L Components" (amazon_settlements_with_cogs), built
 * from Amazon Finances. `total` is "sum of all amounts in the row" per DataDoe's own column
 * description — i.e. the actual settled/net amount per line (ORDER, REFUND or OTHER type),
 * already inclusive of every Amazon fee, tax and refund. Summing it across the date window is
 * the real, verified equivalent of "net revenue" — this is what the dashboard's Net revenue
 * KPI always claimed to read from (Finances v0 financialEvents) but never actually did until
 * now. Fetched with all:true (no skip/limit) for the same truncation reason as Sales.
 */
interface SettlementRow {
  date?: string;
  total?: number;
  currency?: string;
  child_asin?: string;
  referral_fee?: number;
  fba_per_unit_fulfillment_fee?: number;
  fba_storage_fee?: number;
  long_term_storage_fee?: number;
  amazon_fees?: number;
  refunded_amount?: number;
  promotion_item_price?: number;
  promotion_fee?: number;
  promotion_shipping?: number;
  coupon_redemption_fee?: number;
  coupon_performance_fee?: number;
  coupon_participation_fee?: number;
  deal_performance_fee?: number;
  deal_participation_fee?: number;
  fba_customer_return_per_unit_fee?: number;
  shipping_label_purchase_for_return?: number;
  [key: string]: unknown;
}

const FINANCIALS_SOURCE_NAME = "Settlements & P&L Components";

// Verified directly against this account's real data (each tested individually as a live
// export): "promo_rebates" and "fba_customer_return_fee" are listed in the source's column
// catalog but the export API returns status ERROR whenever either is requested, even alone.
// Excluded rather than guessed around. Every other column below was confirmed to export
// successfully and its sign/behavior inspected on real ORDER/REFUND/OTHER settlement rows.
const SETTLEMENT_COLUMNS = [
  "date",
  "total",
  "currency",
  "child_asin",
  "referral_fee",
  "fba_per_unit_fulfillment_fee",
  "fba_storage_fee",
  "long_term_storage_fee",
  "amazon_fees",
  "refunded_amount",
  "promotion_item_price",
  "promotion_fee",
  "promotion_shipping",
  "coupon_redemption_fee",
  "coupon_performance_fee",
  "coupon_participation_fee",
  "deal_performance_fee",
  "deal_participation_fee",
  "fba_customer_return_per_unit_fee",
  "shipping_label_purchase_for_return",
];

/**
 * Fee/refund/promotion breakdown, all traced to individually-verified Settlements & P&L
 * Components columns (expenses are negative per the source's own column description, confirmed
 * on real rows):
 * - referralFee / fbaFulfilmentFee / fbaStorageFee / longTermStorageFee / otherAmazonFees:
 *   direct 1:1 columns (referral_fee, fba_per_unit_fulfillment_fee, fba_storage_fee,
 *   long_term_storage_fee, amazon_fees). Populated only on ORDER rows in real data.
 * - refunds: `refunded_amount` alone — the one column literally named for this concept.
 *   `refunded_referral_fee`/`refund_commission` (referral-fee-side refund adjustments) are
 *   deliberately NOT netted in here or into referralFee, to keep each category traceable to
 *   exactly the columns named in this comment rather than an invented netting rule.
 * - promotions: sum of promotion_item_price + promotion_fee + promotion_shipping +
 *   coupon_redemption_fee + coupon_performance_fee + coupon_participation_fee +
 *   deal_performance_fee + deal_participation_fee — every column whose name and description
 *   identify it as a promotion/coupon/deal cost, matching the existing UI's single combined
 *   "Promotions & coupons" line. The undocumented bare `promotion` column (no description in
 *   the source catalog) is deliberately excluded — its sign in real data (positive, unlike
 *   every other cost column here) couldn't be confidently interpreted.
 * - returnProcessing: fba_customer_return_per_unit_fee + shipping_label_purchase_for_return
 *   (fba_customer_return_fee excluded — see SETTLEMENT_COLUMNS comment). Verified real 0 in
 *   the last 30d for this account — a confirmed real zero, not a missing value.
 */
interface FeeBreakdown {
  referralFee: number;
  fbaFulfilmentFee: number;
  fbaStorageFee: number;
  longTermStorageFee: number;
  otherAmazonFees: number;
  refunds: number;
  promotions: number;
  returnProcessing: number;
}

function sumFeeBreakdown(rows: SettlementRow[]): FeeBreakdown {
  return {
    referralFee: sumNumberField(rows, "referral_fee"),
    fbaFulfilmentFee: sumNumberField(rows, "fba_per_unit_fulfillment_fee"),
    fbaStorageFee: sumNumberField(rows, "fba_storage_fee"),
    longTermStorageFee: sumNumberField(rows, "long_term_storage_fee"),
    otherAmazonFees: sumNumberField(rows, "amazon_fees"),
    refunds: sumNumberField(rows, "refunded_amount"),
    promotions:
      sumNumberField(rows, "promotion_item_price") +
      sumNumberField(rows, "promotion_fee") +
      sumNumberField(rows, "promotion_shipping") +
      sumNumberField(rows, "coupon_redemption_fee") +
      sumNumberField(rows, "coupon_performance_fee") +
      sumNumberField(rows, "coupon_participation_fee") +
      sumNumberField(rows, "deal_performance_fee") +
      sumNumberField(rows, "deal_participation_fee"),
    returnProcessing:
      sumNumberField(rows, "fba_customer_return_per_unit_fee") + sumNumberField(rows, "shipping_label_purchase_for_return"),
  };
}

/**
 * Same categories as sumFeeBreakdown, grouped by child_asin instead of totaled account-wide.
 * Verified live against this account: child_asin is populated on 170/178 real settlement rows
 * in a 30d window (a small remainder is null — e.g. non-order settlement lines — and those rows
 * are excluded here rather than guessed into an ASIN bucket). Feeds the existing per-product
 * "Per unit sold" cost slot on the Products cards, dividing by that ASIN's real units from the
 * Sales & Traffic source on the frontend — not computed here since this endpoint has no units.
 */
function sumFeeBreakdownByAsin(rows: SettlementRow[]): Record<string, FeeBreakdown> {
  const byAsin: Record<string, SettlementRow[]> = {};
  for (const r of rows) {
    if (!r.child_asin) continue;
    (byAsin[r.child_asin] ||= []).push(r);
  }
  const result: Record<string, FeeBreakdown> = {};
  for (const asin of Object.keys(byAsin)) {
    result[asin] = sumFeeBreakdown(byAsin[asin]);
  }
  return result;
}

// These fee/refund/promotion categories are consistently stored as negative numbers (expenses),
// so `previous` is always ≤ 0 and pctDelta's zero-or-negative-base guard would return null for
// every category, always. Delta is computed on magnitude instead (|current| vs |previous|) —
// positive means the cost grew, negative means it shrank — the standard way to express "cost
// changed by X%" for a naturally-negative-signed metric.
function feeBreakdownDeltaPct(current: FeeBreakdown, previous: FeeBreakdown): Partial<Record<keyof FeeBreakdown, number | null>> {
  const keys = Object.keys(current) as Array<keyof FeeBreakdown>;
  const result: Partial<Record<keyof FeeBreakdown, number | null>> = {};
  for (const k of keys) {
    result[k] = pctDelta(Math.abs(current[k]), Math.abs(previous[k]));
  }
  return result;
}

export async function getSellerFinancialsSummary(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }

  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to, prev } = win;

  try {
    // Settlements & P&L Components has 209 columns; DataDoe rejects export requests with more
    // than 128 (verified directly), so only the fields this endpoint actually uses are requested.
    const refresh = parseRefresh(req);
    const currentResult = await getSellerSourceData<SettlementRow>({
      sellerId,
      sourceName: FINANCIALS_SOURCE_NAME,
      all: true,
      columns: SETTLEMENT_COLUMNS,
      from,
      to,
      refresh,
    });
    const previousResult = await fetchPreviousWindow<SettlementRow>(
      { sellerId, sourceName: FINANCIALS_SOURCE_NAME, all: true, columns: SETTLEMENT_COLUMNS, refresh },
      prev
    );

    const netRevenue = sumNumberField(currentResult.rows, "total");
    const previousNetRevenue = sumNumberField(previousResult.rows, "total");
    const currency = firstCurrency(currentResult.rows) || firstCurrency(previousResult.rows);

    const feeBreakdown = sumFeeBreakdown(currentResult.rows);
    const previousFeeBreakdown = sumFeeBreakdown(previousResult.rows);
    const feeBreakdownByAsin = sumFeeBreakdownByAsin(currentResult.rows);
    const daily = aggregateRevenueByDate(currentResult.rows);

    res.status(200).json({
      source: currentResult.source,
      cache: currentResult.cache,
      range,
      dateRangeRequested: { from, to },
      previousDateRange: prev,
      netRevenue,
      previousNetRevenue,
      netRevenueDeltaPct: pctDelta(netRevenue, previousNetRevenue),
      currency,
      feeBreakdown,
      previousFeeBreakdown,
      feeBreakdownDeltaPct: feeBreakdownDeltaPct(feeBreakdown, previousFeeBreakdown),
      feeBreakdownByAsin,
      daily,
      coverage: currentResult.coverage,
      meta: { currentRowCount: currentResult.meta.rowCount, previousRowCount: previousResult.meta.rowCount },
    });
  } catch (error) {
    handleServiceError(error, res);
  }
}

/**
 * Premium DataDoe source "Profit by Date" (amazon_profit_by_date). `profit` is DataDoe's own
 * "total sales minus total_cost" (total_cost = settlement fees + COGS + ad spend) — a real,
 * pre-computed net profit figure, not derived here from manual cost-input guesses. `total_sales`
 * on this same source (shipped-order basis, via Order Line Items) is used as the margin
 * denominator so profit ÷ sales stays internally consistent within one source — it is NOT the
 * same figure as the free Sales KPI's "Gross sales" (that comes from the Sales & Traffic
 * report, an ordered-not-shipped basis) or this endpoint's own Net revenue (a settled/cash
 * basis), so the two are not mixed. Optional/additive only: any failure here (including no
 * Premium access) never touches getSellerFinancialsSummary above.
 */
interface ProfitByDateRow {
  date?: string;
  total_sales?: number;
  profit?: number;
  currency?: string;
  [key: string]: unknown;
}

const PROFIT_SOURCE_NAME = "Profit by Date";

// Verified live, individually, against this account's real data (each of the source's 39
// columns tested alone as a live export): requesting the full default column set makes DataDoe
// return export status ERROR for this account, with zero diagnostic detail in the response.
// Bisecting the column set isolated the cause to exactly four columns — refund_count,
// refund_cost, return_units, return_cogs — each of which independently triggers the same ERROR
// status; every other column (including this endpoint's own total_sales/profit/currency)
// completes normally. None of the four are read by this endpoint, so excluding them costs
// nothing functionally and turns a total, permanent failure into a working export — same
// column-narrowing pattern already used for Settlements & P&L Components above.
const PROFIT_COLUMNS = ["date", "total_sales", "profit", "currency"];

/**
 * Orders received in the selected window (one row per Amazon order, summing its line items), served
 * from the permanently-archived Order Line Items data (.cache/datadoe/orders, see datadoe.orders.ts).
 * Token-free disk read; never fabricates. Returns the full order list for the month plus totals so
 * the frontend can render a complete, compact, month-specific Orders list.
 */
export async function getSellerOrders(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to } = win;
  try {
    const result = await getOrdersRange(sellerId, from, to);
    res.status(200).json({ range, dateRangeRequested: { from, to }, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load orders";
    res.status(500).json({ error: message });
  }
}

/**
 * Live Products — driven by the seller's Active listings (one row per active listing), with all
 * month-sensitive metrics (Revenue, Margin, ACOS, Units, Buy Box) aggregated over the resolved
 * month window and Stock served from the latest inventory snapshot. Strict-local: renders from
 * cache with no provider export.
 */
export async function getSellerLiveProducts(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to } = win;
  try {
    const result = await getLiveProducts(sellerId, from, to);
    res.status(200).json({ range, dateRangeRequested: { from, to }, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load live products";
    res.status(500).json({ error: message });
  }
}

/**
 * Inventory Health — evidence-based inventory risks/opportunities for the 62 Active Listings.
 * Strict-local: renders from cache with no provider export. See datadoe.inventoryhealth.ts for
 * the full source-by-source provenance of every signal.
 */
export async function getSellerInventoryHealthDetailed(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }
  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to } = win;
  try {
    const result = await getInventoryHealth(sellerId, from, to);
    res.status(200).json({ range, dateRangeRequested: { from, to }, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load inventory health";
    res.status(500).json({ error: message });
  }
}

export async function getSellerFinancialsSummaryPremium(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }

  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to, prev } = win;

  try {
    // Net Profit / Net Margin are served from DataDoe's OWN P&L "net_profit" — captured live from the
    // DataDoe Reports UI and archived under .cache/datadoe/pnl (see datadoe.pnl.ts). The export API
    // does not expose the P&L, so this archived capture is the source of truth. net_profit is summed
    // per-date for the requested window; margin = net_profit ÷ sales over the covered days. A day with
    // no archived P&L row is reported missing (honest partial), never counted as £0.
    const pnl = await getPnlRange(sellerId, from, to);
    if (pnl !== null) {
      if (pnl.covered.length === 0) {
        // The P&L archive exists but holds no data for this range -> honest not-available.
        res.status(200).json({
          status: "not_synchronized",
          message: "DataDoe P&L not available for this period",
          dateRangeRequested: { from, to },
          missing: pnl.missing,
        });
        return;
      }
      const prevPnl = prev ? await getPnlRange(sellerId, prev.from, prev.to) : null;
      const prevFull = prevPnl && !prevPnl.partial && prevPnl.covered.length > 0 ? prevPnl : null;
      const previousProfit = prevFull ? prevFull.netProfit : 0;
      res.status(200).json({
        source: { id: "", name: "DataDoe P&L", tableName: "profit_and_loss", type: "SELLER_CENTRAL" },
        range,
        dateRangeRequested: { from, to },
        previousDateRange: prev,
        profit: pnl.netProfit,
        previousProfit,
        profitDeltaPct: prevFull ? pctDelta(pnl.netProfit, previousProfit) : null,
        totalSales: pnl.sales,
        marginPct: pnl.marginPct,
        previousMarginPct: prevFull ? prevFull.marginPct : null,
        // DataDoe P&L's own "Units" (total_units_sold): shipped-order basis, per DataDoe's Data
        // Scheme docs ("Total quantity sold from shipped order items", sourced from Order Line
        // Items) — a different pipeline than the free Sales KPI's ordered-basis Units Sold (Sales
        // & Traffic report). unitsAvailable is false (totalUnitsSold null) when any covered day
        // predates the v3 units capture — never a fabricated/understated total.
        totalUnitsSold: pnl.units,
        unitsAvailable: pnl.unitsAvailable,
        previousTotalUnitsSold: prevFull ? prevFull.units : null,
        previousTotalSales: prevFull ? prevFull.sales : null,
        currency: "GBP",
        basis: "DataDoe P&L net_profit (incl-VAT advertising)",
        unitsBasis: "DataDoe P&L · total_units_sold · shipped-order basis (Order Line Items)",
        // DataDoe P&L report line-item components (same source/definition as net_profit). Present only
        // when every covered day carries component data (v2 archive); null otherwise — never a
        // fabricated/understated total. These are DataDoe's own signed values; the dashboard renders
        // them verbatim. Identity: sales + advertising + amazonFees + refundCost + fbaChargeback +
        // lostDamaged = profit.
        components: {
          available: pnl.componentsAvailable,
          sales: pnl.sales,
          advertising: pnl.advertising,
          amazonFees: pnl.amazonFees,
          refundCost: pnl.refundCost,
          fbaChargeback: pnl.fbaChargeback,
          lostDamaged: pnl.lostDamaged,
          netProfit: pnl.netProfit,
        },
        coverage: {
          requested: { from, to },
          covered: pnl.covered,
          missing: pnl.missing,
          partial: pnl.partial,
          earliest: pnl.earliest,
          latest: pnl.latest,
        },
        // Per-day Sales/Units (same basis as the totals above) for the trend chart's Gross sales
        // line — keeps the chart and the headline KPI on one identical source, never two different
        // "Gross sales" definitions on the same page. totalUnitsSold is null on a day predating the
        // v3 units capture, matching the aggregate unitsAvailable guard above.
        daily: pnl.daily.map((d) => ({ date: d.date, totalSales: d.sales, totalUnitsSold: d.units })),
        meta: { currentRowCount: pnl.daily.length, previousRowCount: prevFull ? prevFull.daily.length : 0 },
      });
      return;
    }

    // No P&L archive for this seller -> fall back to the DataDoe "Profit by Date" export source
    // (previous behaviour), so a seller without a captured P&L still gets a real DataDoe profit figure.
    const refresh = parseRefresh(req);
    const currentResult = await getSellerSourceData<ProfitByDateRow>({
      sellerId,
      sourceName: PROFIT_SOURCE_NAME,
      all: true,
      columns: PROFIT_COLUMNS,
      from,
      to,
      refresh,
    });
    const previousResult = await fetchPreviousWindow<ProfitByDateRow>(
      { sellerId, sourceName: PROFIT_SOURCE_NAME, all: true, columns: PROFIT_COLUMNS, refresh },
      prev
    );

    const profit = sumNumberField(currentResult.rows, "profit");
    const previousProfit = sumNumberField(previousResult.rows, "profit");
    const totalSales = sumNumberField(currentResult.rows, "total_sales");
    const previousTotalSales = sumNumberField(previousResult.rows, "total_sales");
    const marginPct = totalSales !== 0 ? (profit / totalSales) * 100 : null;
    const previousMarginPct = previousTotalSales !== 0 ? (previousProfit / previousTotalSales) * 100 : null;
    const currency = firstCurrency(currentResult.rows) || firstCurrency(previousResult.rows);

    res.status(200).json({
      source: currentResult.source,
      cache: currentResult.cache,
      range,
      dateRangeRequested: { from, to },
      previousDateRange: prev,
      profit,
      previousProfit,
      profitDeltaPct: pctDelta(profit, previousProfit),
      totalSales,
      marginPct,
      previousMarginPct,
      currency,
      basis: "DataDoe Profit by Date · profit (fallback; no P&L archive)",
      coverage: currentResult.coverage,
      meta: { currentRowCount: currentResult.meta.rowCount, previousRowCount: previousResult.meta.rowCount },
    });
  } catch (error) {
    handleServiceError(error, res);
  }
}

/**
 * Free DataDoe source "Ad Performance by Campaign & Date" (amazon_ads_performance_by_campaign_by_date).
 * Per-campaign-per-date rows across all Amazon Ads campaign types (SPONSORED_PRODUCTS,
 * SPONSORED_BRANDS, SPONSORED_DISPLAY — verified live). The existing PPC section's UI badge is
 * hardcoded "Sponsored Products", so only ad_campaign_type === "SPONSORED_PRODUCTS" rows are
 * aggregated here to keep the numbers honest against that label; the other campaign types are
 * real but simply not surfaced by this endpoint since there's no existing UI for them.
 * ACOS/CPC/Conversion have no dedicated fields — they're standard ratios of verified fields
 * (ad_spend/ad_sales, ad_spend/ad_clicks, ad_orders/ad_clicks), the same way Amazon Ads itself
 * derives them, not fabricated.
 */
interface AdCampaignRow {
  date?: string;
  ad_campaign_type?: string;
  ad_campaign_id?: string;
  ad_campaign_name?: string;
  ad_spend?: number;
  ad_sales?: number;
  ad_clicks?: number;
  ad_impressions?: number;
  ad_orders?: number;
  [key: string]: unknown;
}

const PPC_SOURCE_NAME = "Ad Performance by Campaign & Date";
const PPC_CAMPAIGN_TYPE = "SPONSORED_PRODUCTS";
const PPC_COLUMNS = [
  "date",
  "ad_campaign_type",
  "ad_campaign_id",
  "ad_campaign_name",
  "ad_spend",
  "ad_sales",
  "ad_clicks",
  "ad_impressions",
  "ad_orders",
];

interface PpcTotals {
  adSpend: number;
  adSales: number;
  clicks: number;
  impressions: number;
  orders: number;
}

function aggregatePpcRows(rows: AdCampaignRow[]): PpcTotals {
  let adSpend = 0;
  let adSales = 0;
  let clicks = 0;
  let impressions = 0;
  let orders = 0;
  for (const r of rows) {
    if (r.ad_campaign_type !== PPC_CAMPAIGN_TYPE) continue;
    adSpend += typeof r.ad_spend === "number" ? r.ad_spend : 0;
    adSales += typeof r.ad_sales === "number" ? r.ad_sales : 0;
    clicks += typeof r.ad_clicks === "number" ? r.ad_clicks : 0;
    impressions += typeof r.ad_impressions === "number" ? r.ad_impressions : 0;
    orders += typeof r.ad_orders === "number" ? r.ad_orders : 0;
  }
  return { adSpend, adSales, clicks, impressions, orders };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator !== 0 ? numerator / denominator : null;
}

interface DailyAdSpendPoint {
  date: string;
  adSpend: number;
}

// Daily ad spend (SPONSORED_PRODUCTS only, same filter as the account-level totals above) from
// the same Ad Performance rows already fetched — no extra DataDoe call.
function aggregateAdSpendByDate(rows: AdCampaignRow[]): DailyAdSpendPoint[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.ad_campaign_type !== PPC_CAMPAIGN_TYPE || !r.date) continue;
    totals.set(r.date, (totals.get(r.date) || 0) + (typeof r.ad_spend === "number" ? r.ad_spend : 0));
  }
  return Array.from(totals.entries())
    .map(([date, adSpend]) => ({ date, adSpend }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function pctRatio(numerator: number, denominator: number): number | null {
  const r = ratio(numerator, denominator);
  return r === null ? null : r * 100;
}

export async function getSellerPpcSummary(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }

  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to, prev } = win;

  try {
    const refresh = parseRefresh(req);
    const currentResult = await getSellerSourceData<AdCampaignRow>({
      sellerId,
      sourceName: PPC_SOURCE_NAME,
      all: true,
      columns: PPC_COLUMNS,
      from,
      to,
      refresh,
    });
    const previousResult = await fetchPreviousWindow<AdCampaignRow>(
      { sellerId, sourceName: PPC_SOURCE_NAME, all: true, columns: PPC_COLUMNS, refresh },
      prev
    );

    const current = aggregatePpcRows(currentResult.rows);
    const previous = aggregatePpcRows(previousResult.rows);

    const acos = pctRatio(current.adSpend, current.adSales);
    const previousAcos = pctRatio(previous.adSpend, previous.adSales);
    const cpc = ratio(current.adSpend, current.clicks);
    const previousCpc = ratio(previous.adSpend, previous.clicks);
    const conversionRate = pctRatio(current.orders, current.clicks);
    const previousConversionRate = pctRatio(previous.orders, previous.clicks);

    // COMPLETE list of active SPONSORED_PRODUCTS campaigns for the period, sorted worst-ACOS
    // first (highest ad-cost-to-sales ratio at the top — the ones "burning margin"). No arbitrary
    // top-N cap: every campaign that actually spent in the period is returned so the count
    // reconciles to DataDoe's PPC-Campaigns report; the frontend presents them in a compact
    // fixed-height scrollable table so a large campaign count never inflates page height.
    // Zero-spend campaigns are excluded (inactive this period — a 0/0 ACOS is undefined, not a
    // real burn); this is the only filter and it is documented, not a business-rule invention.
    const byCampaign = new Map<
      string,
      { name: string; spend: number; sales: number; clicks: number; orders: number }
    >();
    for (const r of currentResult.rows) {
      if (r.ad_campaign_type !== PPC_CAMPAIGN_TYPE || !r.ad_campaign_id) continue;
      const existing = byCampaign.get(r.ad_campaign_id) || {
        name: r.ad_campaign_name || r.ad_campaign_id,
        spend: 0,
        sales: 0,
        clicks: 0,
        orders: 0,
      };
      existing.spend += typeof r.ad_spend === "number" ? r.ad_spend : 0;
      existing.sales += typeof r.ad_sales === "number" ? r.ad_sales : 0;
      existing.clicks += typeof r.ad_clicks === "number" ? r.ad_clicks : 0;
      existing.orders += typeof r.ad_orders === "number" ? r.ad_orders : 0;
      byCampaign.set(r.ad_campaign_id, existing);
    }
    const campaigns = Array.from(byCampaign.values())
      .filter((c) => c.spend > 0)
      .map((c) => ({ ...c, acos: pctRatio(c.spend, c.sales) }))
      .sort((a, b) => (b.acos ?? 0) - (a.acos ?? 0));
    const daily = aggregateAdSpendByDate(currentResult.rows);

    res.status(200).json({
      source: currentResult.source,
      cache: currentResult.cache,
      range,
      dateRangeRequested: { from, to },
      previousDateRange: prev,
      totals: current,
      previousTotals: previous,
      derived: { acos, cpc, conversionRate },
      deltas: {
        adSpendPct: pctDelta(current.adSpend, previous.adSpend),
        adSalesPct: pctDelta(current.adSales, previous.adSales),
        acosPtDelta: acos !== null && previousAcos !== null ? acos - previousAcos : null,
        cpcDelta: cpc !== null && previousCpc !== null ? cpc - previousCpc : null,
        conversionRatePtDelta:
          conversionRate !== null && previousConversionRate !== null ? conversionRate - previousConversionRate : null,
      },
      campaigns,
      daily,
      coverage: currentResult.coverage,
      meta: { currentRowCount: currentResult.meta.rowCount, previousRowCount: previousResult.meta.rowCount },
    });
  } catch (error) {
    handleServiceError(error, res);
  }
}

/**
 * Premium DataDoe source "Profit by SKU & Date" (amazon_profit_by_sku_and_date). Per-child_asin-
 * per-date rows. `total_sales` is this source's own shipped-order-basis revenue figure (Revenue
 * card), `profit` is DataDoe's own net-profit calc (total sales − settlement fees − COGS − ad
 * spend), and `ad_spend` is attributed ad spend — all summed per ASIN across the selected range.
 * Net margin (profit ÷ this same total_sales) and ACOS (ad_spend ÷ ad_sales) are period-level
 * applications of the exact ratios the source's own `profit`/`acos` column descriptions define,
 * not invented formulas — averaging the source's per-day `acos` values directly would be wrong
 * (unweighted across days with very different ad_sales), so the ratio is recomputed from the
 * summed period totals instead. No previous-period fetch here: the existing Product card stats
 * have no delta/sub slot to show one.
 */
interface SkuProfitRow {
  date?: string;
  child_asin?: string;
  total_sales?: number;
  profit?: number;
  ad_spend?: number;
  ad_sales?: number;
  [key: string]: unknown;
}

const SKU_PROFIT_SOURCE_NAME = "Profit by SKU & Date";
// "date" must be requested (and first, matching the other date-windowed sources above) because
// this source is routed through the coverage store (isHistoricalSource), which filters cached
// rows by their "date" field (datadoe.coverage.ts filterRowsInRange). Without it, rows carry no
// date at all and every date-range query silently filters down to zero rows regardless of range
// — confirmed directly against this account's real cached rows (0/2403 had a "date" key).
const SKU_PROFIT_COLUMNS = ["date", "child_asin", "total_sales", "profit", "ad_spend", "ad_sales"];

export async function getSellerSkuProfitSummary(req: Request, res: Response): Promise<void> {
  const sellerId = requireSellerId(req, res);
  if (!sellerId) {
    return;
  }

  const win = resolveWindow(req, res);
  if (!win) return;
  const { range, from, to } = win;

  try {
    const result = await getSellerSourceData<SkuProfitRow>({
      sellerId,
      sourceName: SKU_PROFIT_SOURCE_NAME,
      all: true,
      columns: SKU_PROFIT_COLUMNS,
      from,
      to,
      refresh: parseRefresh(req),
    });

    const byAsin = new Map<string, { revenue: number; profit: number; adSpend: number; adSales: number }>();
    for (const r of result.rows) {
      if (!r.child_asin) continue;
      const existing = byAsin.get(r.child_asin) || { revenue: 0, profit: 0, adSpend: 0, adSales: 0 };
      existing.revenue += typeof r.total_sales === "number" ? r.total_sales : 0;
      existing.profit += typeof r.profit === "number" ? r.profit : 0;
      existing.adSpend += typeof r.ad_spend === "number" ? r.ad_spend : 0;
      existing.adSales += typeof r.ad_sales === "number" ? r.ad_sales : 0;
      byAsin.set(r.child_asin, existing);
    }

    const products = Array.from(byAsin.entries()).map(([asin, t]) => ({
      asin,
      revenue: t.revenue,
      profit: t.profit,
      marginPct: t.revenue !== 0 ? (t.profit / t.revenue) * 100 : null,
      adSpend: t.adSpend,
      acos: t.adSales !== 0 ? (t.adSpend / t.adSales) * 100 : null,
    }));

    res.status(200).json({
      source: result.source,
      cache: result.cache,
      range,
      dateRangeRequested: { from, to },
      products,
      coverage: result.coverage,
      meta: { rowCount: result.meta.rowCount, distinctAsins: products.length },
    });
  } catch (error) {
    handleServiceError(error, res);
  }
}
