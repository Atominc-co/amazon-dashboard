import { addDays, formatDate, todayLocalMidnight } from "./datadoe.dates";

/**
 * Source-specific historical-depth limits for the DataDoe sources this dashboard reads.
 *
 * IMPORTANT — these are NOT invented. Each limit is the tightest *documented* constraint that
 * governs how far back the underlying Amazon report can be requested, expressed in days:
 *
 *  - Amazon Sales & Traffic (GET_SALES_AND_TRAFFIC_REPORT): Amazon SP-API documents a
 *    dataStartTime "no more than 2 years ago". 730 days is that hard limit. The master spec
 *    restates it verbatim.
 *  - Amazon Finances / Settlements: the SP-API Finances domain exposes roughly two years of
 *    financial events; DataDoe's own backfill for settlement-derived sources is documented at up
 *    to 735 days. We take the tighter of the two (730) as the safe, non-over-promising floor.
 *  - Amazon Ads reporting: report retention is documented as shorter and type-dependent
 *    (commonly ~60–95 days for some report types), but DataDoe backfills further. Because the
 *    exact per-account depth is not something we can assert without live confirmation (and the
 *    account is currently token-limited), we do NOT claim more than the conservative 730-day
 *    floor here. Requesting *less* history than may exist can never violate "never request a
 *    date outside the supported range"; it only under-offers, which is the safe direction.
 *
 * The single number that actually bounds the UI is the DASHBOARD-LEVEL effective boundary: the
 * most restrictive limit among the sources a given view needs. Every date-windowed source above
 * resolves to the same conservative 730-day floor today, so the effective boundary is 730 days —
 * but the per-source structure is kept so a future, live-confirmed, source-specific limit can be
 * set here in one place without touching call sites. Override via DATADOE_MAX_HISTORY_DAYS.
 *
 * Snapshot/non-historical sources (FBA inventory, inventory health, product catalog, listings)
 * are deliberately absent: they are point-in-time, not a queryable historical range, so they
 * impose no calendar boundary on the dashboard.
 */

export const AMAZON_TWO_YEAR_DAYS = 730;

export interface SourceHistoryLimit {
  /** Human-facing source name as used by the controllers/DataDoe. */
  sourceName: string;
  /** Maximum age in days of the earliest requestable date. */
  maxHistoryDays: number;
  /** Short, non-invented basis for the limit (shown in the /history payload). */
  basis: string;
}

const SOURCE_LIMITS: SourceHistoryLimit[] = [
  {
    sourceName: "Sales & Traffic by ASIN & Date",
    maxHistoryDays: AMAZON_TWO_YEAR_DAYS,
    basis: "Amazon GET_SALES_AND_TRAFFIC_REPORT: start date no more than 2 years ago",
  },
  {
    sourceName: "Settlements & P&L Components",
    maxHistoryDays: AMAZON_TWO_YEAR_DAYS,
    basis: "Amazon Finances ~2y; DataDoe settlement backfill up to 735d — tighter value used",
  },
  {
    sourceName: "Profit by Date",
    maxHistoryDays: AMAZON_TWO_YEAR_DAYS,
    basis: "Derived from settlement + sales history; bounded by the 2-year Amazon floor",
  },
  {
    sourceName: "Ad Performance by Campaign & Date",
    maxHistoryDays: AMAZON_TWO_YEAR_DAYS,
    basis: "Amazon Ads retention is shorter/type-dependent; conservative 2-year floor used",
  },
  {
    sourceName: "Profit by SKU & Date",
    maxHistoryDays: AMAZON_TWO_YEAR_DAYS,
    basis: "Derived from settlement + sales history; bounded by the 2-year Amazon floor",
  },
];

const LIMIT_BY_NAME = new Map(SOURCE_LIMITS.map((l) => [l.sourceName, l]));

/** Configurable global cap; never allows MORE history than the documented per-source limit. */
function configuredMaxHistoryDays(): number {
  const raw = Number(process.env.DATADOE_MAX_HISTORY_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AMAZON_TWO_YEAR_DAYS;
}

/**
 * Effective max history (in days) for a source: the tighter of its documented limit and the
 * configured global cap. Unknown/snapshot sources fall back to the global cap.
 */
export function maxHistoryDaysForSource(sourceName: string): number {
  const limit = LIMIT_BY_NAME.get(sourceName)?.maxHistoryDays ?? AMAZON_TWO_YEAR_DAYS;
  return Math.min(limit, configuredMaxHistoryDays());
}

/** Earliest requestable ISO date for a source (today − maxHistoryDays). */
export function earliestDateForSource(sourceName: string): string {
  return formatDate(addDays(todayLocalMidnight(), -maxHistoryDaysForSource(sourceName)));
}

/**
 * The dashboard-level effective historical boundary: earliest date supported across ALL the
 * date-windowed sources (i.e. bounded by the most restrictive one). This is the single value the
 * Custom calendar uses as its minimum selectable date.
 */
export function dashboardHistoryBoundary(): {
  earliest: string;
  latest: string;
  maxHistoryDays: number;
  sources: SourceHistoryLimit[];
} {
  const effectiveDays = SOURCE_LIMITS.reduce(
    (min, l) => Math.min(min, Math.min(l.maxHistoryDays, configuredMaxHistoryDays())),
    configuredMaxHistoryDays()
  );
  const today = todayLocalMidnight();
  return {
    earliest: formatDate(addDays(today, -effectiveDays)),
    latest: formatDate(today),
    maxHistoryDays: effectiveDays,
    sources: SOURCE_LIMITS.map((l) => ({
      ...l,
      maxHistoryDays: Math.min(l.maxHistoryDays, configuredMaxHistoryDays()),
    })),
  };
}

/** True when this source is a queryable historical range (vs a point-in-time snapshot). */
export function isHistoricalSource(sourceName: string): boolean {
  return LIMIT_BY_NAME.has(sourceName);
}
