import { promises as fs } from "fs";
import path from "path";
import { addDays, formatDate, parseIsoDate } from "./datadoe.dates";

/**
 * DataDoe Profit & Loss source of truth.
 *
 * The DataDoe export API (the one the rest of this backend uses) does NOT expose the P&L report's
 * "Net profit" — it is a proprietary roll-up computed inside the DataDoe web app and served only to
 * the authenticated browser session (GET api.datadoe.com/api/core/reports/profit-and-loss/details).
 * We therefore capture that exact live P&L output (per-date net_profit + sales, interval=DAY) and
 * archive it under `.cache/datadoe/pnl/*.json`. This module reads those archives and serves the
 * dashboard's Net Profit / Net Margin from DataDoe's OWN P&L numbers — never reconstructed, never
 * fabricated. net_profit is £/day (summable for any range); margin is recomputed as net_profit÷sales
 * for the requested window. A requested day with no archived P&L row is reported as missing (honest
 * partial/unavailable), never as £0.
 */

export interface PnlDayRow {
  date: string;
  netProfit: number;
  sales: number;
  // DataDoe P&L report line-item components (per day). null when the archived row predates the v2
  // schema (only net_profit/sales stored) — never coerced to 0, so an unknown never reads as a real
  // zero. Signs are DataDoe's own: advertising/amazonFees/refundCost/fbaChargeback are costs
  // (negative), lostDamaged is a reimbursement credit (usually positive).
  advertising: number | null;
  amazonFees: number | null;
  refundCost: number | null;
  fbaChargeback: number | null;
  lostDamaged: number | null;
  // DataDoe P&L's own "Units" (total_units_sold) — per DataDoe's schema, "Total quantity sold from
  // shipped order items" (Order Line Items table). null when the archived row predates the v3
  // schema (only net_profit/sales(/components) stored) — never coerced to 0.
  units: number | null;
}

export interface PnlRangeResult {
  netProfit: number;
  sales: number;
  marginPct: number | null;
  // Summed DataDoe P&L components over the covered days. All null (and componentsAvailable false)
  // when any covered day is missing component data (older archive) — an honest "unavailable", never a
  // partial/understated cost total.
  advertising: number | null;
  amazonFees: number | null;
  refundCost: number | null;
  fbaChargeback: number | null;
  lostDamaged: number | null;
  componentsAvailable: boolean;
  // Summed DataDoe P&L "Units" (shipped-order basis) over the covered days. null (and
  // unitsAvailable false) when any covered day lacks the v3 units column — an honest
  // "unavailable", never a partial/understated total.
  units: number | null;
  unitsAvailable: boolean;
  covered: { from: string; to: string }[];
  missing: { from: string; to: string }[];
  partial: boolean;
  earliest: string | null;
  latest: string | null;
  daily: PnlDayRow[];
  source: string;
}

function pnlDir(): string {
  const base = process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
  return path.join(base, "pnl");
}

interface PnlArchiveFile {
  sellerId: string;
  currency?: string;
  columns: string[];
  // v1 rows are [date, net_profit, sales]; v2 rows append the component columns. Read positionally by
  // the column index, so any superset column order is tolerated.
  rows: Array<Array<string | number>>;
  source?: string;
}

/**
 * Load every archived P&L file for a seller and fold into one date→row map (later files win on a
 * date collision, so a fresher capture supersedes an older one). Token-free disk read; returns an
 * empty map when nothing is archived yet.
 */
export async function loadPnlDaily(sellerId: string): Promise<Map<string, PnlDayRow>> {
  const map = new Map<string, PnlDayRow>();
  let files: string[] = [];
  try {
    files = (await fs.readdir(pnlDir())).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  } catch {
    return map;
  }
  files.sort(); // deterministic; later (lexically greater) filenames override earlier on collision
  for (const f of files) {
    let entry: PnlArchiveFile;
    try {
      entry = JSON.parse(await fs.readFile(path.join(pnlDir(), f), "utf8")) as PnlArchiveFile;
    } catch {
      continue; // torn/foreign file — skip, never throw
    }
    if (entry.sellerId !== sellerId || !Array.isArray(entry.rows)) continue;
    const iDate = entry.columns.indexOf("date");
    const iNp = entry.columns.indexOf("net_profit");
    const iSales = entry.columns.indexOf("sales");
    if (iDate < 0 || iNp < 0 || iSales < 0) continue;
    // Optional v2 component columns; -1 (absent) => the component reads null for these rows.
    const iAdv = entry.columns.indexOf("advertising_cost");
    const iFees = entry.columns.indexOf("amazon_fees");
    const iRef = entry.columns.indexOf("refund_cost");
    const iChg = entry.columns.indexOf("fba_shipping_chargeback");
    const iLost = entry.columns.indexOf("lost_damaged");
    // Optional v3 column; -1 (absent) => units reads null for these rows.
    const iUnits = entry.columns.indexOf("total_units_sold");
    const cell = (r: Array<string | number>, i: number): number | null =>
      i >= 0 && typeof r[i] === "number" ? (r[i] as number) : null;
    for (const r of entry.rows) {
      const date = r[iDate];
      if (typeof date !== "string" || date.length < 10) continue;
      map.set(date.slice(0, 10), {
        date: date.slice(0, 10),
        netProfit: typeof r[iNp] === "number" ? (r[iNp] as number) : 0,
        sales: typeof r[iSales] === "number" ? (r[iSales] as number) : 0,
        advertising: cell(r, iAdv),
        amazonFees: cell(r, iFees),
        refundCost: cell(r, iRef),
        fbaChargeback: cell(r, iChg),
        lostDamaged: cell(r, iLost),
        units: cell(r, iUnits),
      });
    }
  }
  return map;
}

/** Ascending calendar days in [from,to] inclusive. */
function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    const d = parseIsoDate(cur);
    if (!d) break;
    cur = formatDate(addDays(d, 1));
  }
  return out;
}

/** Coalesce a sorted list of ISO dates into inclusive intervals. */
function toIntervals(dates: string[]): { from: string; to: string }[] {
  const sorted = [...dates].sort();
  const out: { from: string; to: string }[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && formatDate(addDays(parseIsoDate(last.to)!, 1)) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

/**
 * Net profit / sales / margin for [from,to] summed from the archived DataDoe P&L (per-date). Only
 * days actually present in the archive contribute; absent days are reported in `missing` and make
 * `partial` true — they are never counted as £0. `marginPct` = netProfit ÷ sales × 100 over the
 * covered days. Returns null when the seller has no P&L archive at all.
 */
export async function getPnlRange(
  sellerId: string,
  from: string,
  to: string
): Promise<PnlRangeResult | null> {
  const map = await loadPnlDaily(sellerId);
  if (map.size === 0) return null;
  const wanted = daysInRange(from, to);
  const coveredDates: string[] = [];
  const missingDates: string[] = [];
  const daily: PnlDayRow[] = [];
  let netProfit = 0;
  let sales = 0;
  // Component accumulators; componentsAvailable stays true only if EVERY covered day carries all
  // component fields, so a range that straddles a v1-only day reports components as unavailable
  // rather than silently understating a cost.
  let advertising = 0;
  let amazonFees = 0;
  let refundCost = 0;
  let fbaChargeback = 0;
  let lostDamaged = 0;
  let componentsAvailable = true;
  let units = 0;
  let unitsAvailable = true;
  for (const d of wanted) {
    const row = map.get(d);
    if (row) {
      coveredDates.push(d);
      daily.push(row);
      netProfit += row.netProfit;
      sales += row.sales;
      if (
        row.advertising === null ||
        row.amazonFees === null ||
        row.refundCost === null ||
        row.fbaChargeback === null ||
        row.lostDamaged === null
      ) {
        componentsAvailable = false;
      } else {
        advertising += row.advertising;
        amazonFees += row.amazonFees;
        refundCost += row.refundCost;
        fbaChargeback += row.fbaChargeback;
        lostDamaged += row.lostDamaged;
      }
      if (row.units === null) {
        unitsAvailable = false;
      } else {
        units += row.units;
      }
    } else {
      missingDates.push(d);
    }
  }
  if (coveredDates.length === 0) {
    return {
      netProfit: 0,
      sales: 0,
      marginPct: null,
      advertising: null,
      amazonFees: null,
      refundCost: null,
      fbaChargeback: null,
      lostDamaged: null,
      componentsAvailable: false,
      units: null,
      unitsAvailable: false,
      covered: [],
      missing: toIntervals(missingDates),
      partial: true,
      earliest: null,
      latest: null,
      daily: [],
      source: "DataDoe P&L (archived)",
    };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  netProfit = round2(netProfit);
  sales = round2(sales);
  return {
    netProfit,
    sales,
    marginPct: sales !== 0 ? (netProfit / sales) * 100 : null,
    advertising: componentsAvailable ? round2(advertising) : null,
    amazonFees: componentsAvailable ? round2(amazonFees) : null,
    refundCost: componentsAvailable ? round2(refundCost) : null,
    fbaChargeback: componentsAvailable ? round2(fbaChargeback) : null,
    lostDamaged: componentsAvailable ? round2(lostDamaged) : null,
    componentsAvailable,
    units: unitsAvailable ? units : null,
    unitsAvailable,
    covered: toIntervals(coveredDates),
    missing: toIntervals(missingDates),
    partial: missingDates.length > 0,
    earliest: coveredDates[0],
    latest: coveredDates[coveredDates.length - 1],
    daily,
    source: "DataDoe P&L (archived)",
  };
}
