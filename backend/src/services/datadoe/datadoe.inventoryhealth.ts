import { promises as fs } from "fs";
import path from "path";
import { getSellerSourceData } from "../amazon-catalog.service";
import { getUnitsByAsinRange } from "./datadoe.orders";
import { formatDate } from "./datadoe.dates";

/**
 * Inventory Health — evidence-based inventory risks and opportunities for the 62 Active
 * Listings, replacing the old "Needs attention" list.
 *
 * DRIVING TABLE: the seller's Active listings (same canonical identity as Live Products —
 * child_asin, no fuzzy matching). Every active listing produces exactly one row; a listing is
 * NEVER dropped because a joined dataset has no record for it.
 *
 * AUTHORITATIVE SOURCES USED (all read strict-local; a normal render triggers zero exports):
 *   - FBA Inventory by ASIN & Country -> Stock (quantity_for_local_fulfillment). Same source/field
 *     already used for Live Products' Stock and the existing Inventory KPI "Units on hand", so the
 *     stock figure is identical everywhere on the dashboard for the same product.
 *   - FBA Inventory Health -> aged-inventory buckets (inv_age_91_to_180/181_to_270/271_to_365 —
 *     the older non-overlapping 4-bucket scheme; the newer finer buckets reported alongside it are
 *     NOT summed together with these to avoid double-counting overlapping ranges).
 *   - FBA Restock Recommendations -> Amazon's OWN restock recommendation (recommended_replenishment_qty,
 *     recommended_ship_date, alert). Never confused with our own derived stockout logic below.
 *   - FBA Recommended Removals -> Amazon's OWN removal recommendation (sellable_removal_quantity).
 *     Queried and cached; currently 0 rows for this account (a genuine "no removals recommended"
 *     result, not a missing dataset).
 *   - FBA Inbound Shipments -> inbound shipment quantities. Queried and cached; currently 0 rows
 *     (genuine "no inbound shipments", not a missing dataset).
 *   - Order Line Items (via getUnitsByAsinRange) -> month-complete Units sold (same source as Live
 *     Products' Units, chosen because Sales & Traffic has a genuine leading coverage gap in July).
 *   - Profit by SKU & Date -> month-specific Revenue/Margin/Ad spend (same source/columns as Live
 *     Products).
 *   - Sales & Traffic by ASIN & Date -> month-specific Buy Box / Sessions / Page views / Conversion.
 *
 * STOCK IS A CURRENT SNAPSHOT, NEVER HISTORICAL: Amazon supplies no historical per-date inventory
 * for this account, so Stock and the aged-inventory buckets are always the latest cached snapshot,
 * labelled with their real snapshot date, regardless of whether July or August is selected — the
 * exact same convention already used for Stock in Live Products and the existing Inventory KPIs.
 * Only the sales/revenue/velocity overlay below is month-specific.
 *
 * NO FABRICATION: a field with no authoritative record stays null (rendered "Unavailable"). A
 * dataset that was queried and returned zero rows (Removals, Inbound) is reported as a genuine
 * zero/"none currently", which is different from "Unavailable" (never queried). "Amazon
 * restock/removal recommendation" labels are used ONLY for the two named Amazon datasets; the
 * stockout/high-demand signals below are clearly dashboard-derived, using a fixed, documented
 * threshold — never presented as an Amazon recommendation.
 */

const INVENTORY_SOURCE = "FBA Inventory by ASIN & Country";
const INVENTORY_HEALTH_SOURCE = "FBA Inventory Health";
const RESTOCK_SOURCE = "FBA Restock Recommendations";
const REMOVALS_SOURCE = "FBA Recommended Removals";
const INBOUND_SOURCE = "FBA Inbound Shipments";
const SKU_PROFIT_SOURCE = "Profit by SKU & Date";
const SKU_PROFIT_COLUMNS = ["date", "child_asin", "total_sales", "profit", "ad_spend", "ad_sales"];
const SALES_TRAFFIC_SOURCE = "Sales & Traffic by ASIN & Date";

// Dashboard-derived thresholds (ours, not Amazon's) for the stockout/high-demand signals.
// Fixed constants applied uniformly to every product — never a per-product override.
const DAYS_COVER_RISK_THRESHOLD = 14; // days of cover at/below this => at risk of running out
const HIGH_VELOCITY_UNITS_PER_DAY = 1; // >= this many units/day => "high demand"
const LOW_STOCK_ABS_UNITS = 5; // absolute-unit fallback trigger when velocity is 0 (can't compute days-of-cover)

export type InventoryCategory =
  | "out-of-stock"
  | "stockout-risk"
  | "high-demand-low-stock"
  | "aged-inventory"
  | "amazon-restock-recommendation"
  | "amazon-recommended-removal";

export interface InventoryHealthProduct {
  childAsin: string;
  sku: string;
  name: string;
  imageUrl: string | null;

  stock: number | null;
  hasStock: boolean;
  stockSnapshotDate: string | null;

  agedUnits: number | null; // sum of the 91-365 day buckets (older, non-overlapping scheme)
  hasAgedData: boolean;
  agedBucketLabel: string | null; // oldest non-zero bucket, e.g. "271-365 days"

  unitsSoldMonth: number | null;
  hasUnitsSoldMonth: boolean;
  revenueMonth: number | null;
  hasRevenueMonth: boolean;
  marginMonth: number | null;
  hasMarginMonth: boolean;
  buyBoxMonth: number | null;
  hasBuyBoxMonth: boolean;
  sessionsMonth: number | null;
  hasSessionsMonth: boolean;
  conversionMonth: number | null; // units_session_percentage, averaged over covered days
  hasConversionMonth: boolean;

  salesVelocity: number | null; // units/day for the selected month — dashboard-derived
  daysOfCoverDerived: number | null; // stock / velocity — dashboard-derived; null when N/A

  categories: InventoryCategory[]; // every category this product qualifies for (priority order)

  amazonRestockQty: number | null;
  amazonRestockShipDate: string | null;
  hasAmazonRestockRec: boolean;

  amazonRemovalUnits: number | null;
  hasAmazonRemovalRec: boolean;

  inboundUnits: number | null;
  hasInboundUnits: boolean;
}

export interface InventoryHealthCoverage {
  activeListingCount: number;
  stock: number;
  agedInventory: { datasetAvailable: boolean; flagged: number };
  stranded: { datasetAvailable: boolean; flagged: number };
  amazonRestockRecommendation: { datasetAvailable: boolean; flagged: number };
  amazonRecommendedRemoval: { datasetAvailable: boolean; flagged: number };
  inbound: { datasetAvailable: boolean; flagged: number };
  outOfStock: number;
  stockoutRisk: number;
  highDemandLowStock: number;
  unitsSoldMonth: number;
  revenueMonth: number;
  buyBoxMonth: number;
}

export interface InventoryHealthResult {
  from: string;
  to: string;
  activeListingCount: number;
  productCount: number;
  duplicateCanonicalCount: number;
  products: InventoryHealthProduct[];
  coverage: InventoryHealthCoverage;
  stockSnapshotDate: string | null;
  agedInventorySnapshotDate: string | null;
  restockRecommendationDate: string | null;
  available: boolean;
}

interface ListingRow {
  sku?: string;
  child_asin?: string;
  listing_name?: string;
  listing_status?: string;
  [k: string]: unknown;
}
interface CatalogImageEntry { imageUrl: string | null; name: string | null }
interface InventoryRow {
  child_asin?: string;
  date?: string;
  quantity_for_local_fulfillment?: number;
  [k: string]: unknown;
}
interface InventoryHealthRow {
  child_asin?: string;
  date?: string;
  inv_age_91_to_180_days?: number;
  inv_age_181_to_270_days?: number;
  inv_age_271_to_365_days?: number;
  [k: string]: unknown;
}
interface RestockRow {
  child_asin?: string;
  date?: string;
  available?: number;
  recommended_replenishment_qty?: number;
  recommended_ship_date?: string | null;
  alert?: string | null;
  [k: string]: unknown;
}
interface RemovalRow {
  child_asin?: string;
  sellable_removal_quantity?: number;
  [k: string]: unknown;
}
interface InboundRow {
  child_asin?: string;
  quantity?: number;
  [k: string]: unknown;
}
interface SkuProfitRow {
  date?: string;
  child_asin?: string;
  total_sales?: number;
  profit?: number;
  ad_spend?: number;
  ad_sales?: number;
  [k: string]: unknown;
}
interface SalesTrafficRow {
  date?: string;
  child_asin?: string;
  buybox_percentage?: number;
  session?: number;
  page_views?: number;
  units_session_percentage?: number;
  [k: string]: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function cacheDir(): string {
  return process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
}

/**
 * Any recent window works here: for non-historical (snapshot) sources, getSellerSourceData's
 * non-refresh path falls back to the freshest cached snapshot when the exact date range doesn't
 * match — the same mechanism already relied on by getSellerInventory/getSellerInventoryHealth.
 * Passing NO from/to at all skips that fallback entirely and throws RangeNotSynchronizedError
 * even though a valid cached snapshot exists, which is why every snapshot-style read below
 * supplies one.
 */
function recentWindow(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { from: formatDate(from), to: formatDate(to) };
}

function daysInRange(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/** Strict-local read of the driving table: all Active listings. Same identity as Live Products. */
async function loadActiveListings(sellerId: string): Promise<ListingRow[]> {
  const res = await getSellerSourceData<ListingRow>({ sellerId, sourceName: "Listings", all: true });
  return (res.rows || []).filter((r) => (r.listing_status || "").trim() === "Active");
}

/** Product image map, scanned the same way as the Live Products image join (largest catalog cache). */
async function loadCatalogImageMap(): Promise<Map<string, CatalogImageEntry>> {
  const map = new Map<string, CatalogImageEntry>();
  let files: string[] = [];
  try {
    files = (await fs.readdir(cacheDir())).filter((f) => f.endsWith(".json") && !f.endsWith(".cov.json"));
  } catch {
    return map;
  }
  let best: Array<{ child_asin?: string; product_image_url?: string; product_name?: string }> | null = null;
  for (const f of files) {
    let entry: { source?: { name?: string }; sourceName?: string; rows?: Array<{ child_asin?: string; product_image_url?: string; product_name?: string }> };
    try {
      entry = JSON.parse(await fs.readFile(path.join(cacheDir(), f), "utf8"));
    } catch {
      continue;
    }
    const name = entry.source?.name || entry.sourceName;
    if (name !== "Product Catalog by ASIN" || !Array.isArray(entry.rows)) continue;
    if (!best || entry.rows.length > best.length) best = entry.rows;
  }
  if (best) {
    for (const r of best) {
      const asin = (r.child_asin || "").trim();
      if (!asin) continue;
      const url = typeof r.product_image_url === "string" && r.product_image_url.trim() ? r.product_image_url.trim() : null;
      map.set(asin, { imageUrl: url, name: r.product_name || null });
    }
  }
  return map;
}

/** Current stock snapshot per child_asin — the SAME source/field as Live Products' Stock. */
async function loadStockByAsin(sellerId: string): Promise<{ byAsin: Map<string, number>; snapshotDate: string | null }> {
  const byAsin = new Map<string, number>();
  let snapshotDate: string | null = null;
  try {
    const { from, to } = recentWindow(3);
    const res = await getSellerSourceData<InventoryRow>({
      sellerId,
      sourceName: INVENTORY_SOURCE,
      from,
      to,
      pageSize: 500,
    });
    for (const r of res.rows || []) {
      const asin = (r.child_asin || "").trim();
      if (!asin) continue;
      byAsin.set(asin, (byAsin.get(asin) || 0) + num(r.quantity_for_local_fulfillment));
      if (typeof r.date === "string" && (!snapshotDate || r.date > snapshotDate)) snapshotDate = r.date;
    }
  } catch {
    /* inventory not synchronized -> stock stays Unavailable for every product */
  }
  return { byAsin, snapshotDate };
}

/** Latest-per-ASIN row from a snapshot-style source (Inventory Health / Restock Recommendations). */
async function loadLatestPerAsin<T extends { child_asin?: string; date?: string }>(
  sellerId: string,
  sourceName: string
): Promise<{ byAsin: Map<string, T>; latestDate: string | null }> {
  const byAsin = new Map<string, T>();
  let latestDate: string | null = null;
  try {
    const { from, to } = recentWindow(3);
    const res = await getSellerSourceData<T>({
      sellerId,
      sourceName,
      from,
      to,
      pageSize: 5000,
    });
    for (const r of res.rows || []) {
      const asin = (r.child_asin || "").trim();
      if (!asin) continue;
      const existing = byAsin.get(asin);
      if (!existing || (r.date || "") > (existing.date || "")) byAsin.set(asin, r);
      if (typeof r.date === "string" && (!latestDate || r.date > latestDate)) latestDate = r.date;
    }
  } catch {
    /* dataset not available locally -> caller treats as datasetAvailable:false */
  }
  return { byAsin, latestDate };
}

/** FBA Recommended Removals has no `date` column — plain snapshot read, aggregated by ASIN. */
async function loadRemovalsByAsin(sellerId: string): Promise<{ byAsin: Map<string, number>; datasetAvailable: boolean }> {
  const byAsin = new Map<string, number>();
  let datasetAvailable = false;
  try {
    const { from, to } = recentWindow(3);
    const res = await getSellerSourceData<RemovalRow>({ sellerId, sourceName: REMOVALS_SOURCE, from, to, pageSize: 5000 });
    datasetAvailable = true;
    for (const r of res.rows || []) {
      const asin = (r.child_asin || "").trim();
      if (!asin) continue;
      byAsin.set(asin, (byAsin.get(asin) || 0) + num(r.sellable_removal_quantity));
    }
  } catch {
    datasetAvailable = false;
  }
  return { byAsin, datasetAvailable };
}

/** FBA Inbound Shipments has no `date` column — plain snapshot read, summed by ASIN. */
async function loadInboundByAsin(sellerId: string): Promise<{ byAsin: Map<string, number>; datasetAvailable: boolean }> {
  const byAsin = new Map<string, number>();
  let datasetAvailable = false;
  try {
    // Strict-local (non-refresh) reads never call the remote API — from/to here only steers the
    // local snapshot-fallback lookup and is never sent to DataDoe, so it's safe even though this
    // source's export endpoint itself rejects a date filter (confirmed when it was first fetched).
    const { from, to } = recentWindow(3);
    const res = await getSellerSourceData<InboundRow>({ sellerId, sourceName: INBOUND_SOURCE, from, to, pageSize: 5000 });
    datasetAvailable = true;
    for (const r of res.rows || []) {
      const asin = (r.child_asin || "").trim();
      if (!asin) continue;
      byAsin.set(asin, (byAsin.get(asin) || 0) + num(r.quantity));
    }
  } catch {
    datasetAvailable = false;
  }
  return { byAsin, datasetAvailable };
}

async function loadSkuProfitByAsin(
  sellerId: string,
  from: string,
  to: string
): Promise<Map<string, { revenue: number; profit: number; rows: number }>> {
  const byAsin = new Map<string, { revenue: number; profit: number; rows: number }>();
  const res = await getSellerSourceData<SkuProfitRow>({
    sellerId,
    sourceName: SKU_PROFIT_SOURCE,
    all: true,
    columns: SKU_PROFIT_COLUMNS,
    from,
    to,
  });
  for (const r of res.rows || []) {
    const asin = (r.child_asin || "").trim();
    if (!asin) continue;
    const e = byAsin.get(asin) || { revenue: 0, profit: 0, rows: 0 };
    e.revenue += num(r.total_sales);
    e.profit += num(r.profit);
    e.rows += 1;
    byAsin.set(asin, e);
  }
  return byAsin;
}

async function loadSalesTrafficByAsin(
  sellerId: string,
  from: string,
  to: string
): Promise<Map<string, { bbSum: number; bbDays: number; sessions: number; pageViews: number; convSum: number; convDays: number }>> {
  const byAsin = new Map<string, { bbSum: number; bbDays: number; sessions: number; pageViews: number; convSum: number; convDays: number }>();
  try {
    const res = await getSellerSourceData<SalesTrafficRow>({ sellerId, sourceName: SALES_TRAFFIC_SOURCE, all: true, from, to });
    for (const r of res.rows || []) {
      const asin = (r.child_asin || "").trim();
      if (!asin) continue;
      const e = byAsin.get(asin) || { bbSum: 0, bbDays: 0, sessions: 0, pageViews: 0, convSum: 0, convDays: 0 };
      if (r.buybox_percentage != null) { e.bbSum += num(r.buybox_percentage); e.bbDays += 1; }
      e.sessions += num(r.session);
      e.pageViews += num(r.page_views);
      if (r.units_session_percentage != null) { e.convSum += num(r.units_session_percentage); e.convDays += 1; }
      byAsin.set(asin, e);
    }
  } catch {
    /* S&T not synchronized for this range -> Buy Box/Sessions/Conversion stay Unavailable */
  }
  return byAsin;
}

function oldestAgedBucketLabel(r: InventoryHealthRow | undefined): string | null {
  if (!r) return null;
  if (num(r.inv_age_271_to_365_days) > 0) return "271-365 days";
  if (num(r.inv_age_181_to_270_days) > 0) return "181-270 days";
  if (num(r.inv_age_91_to_180_days) > 0) return "91-180 days";
  return null;
}

/**
 * Assemble the Inventory Health result for the selected month window. Returns exactly one row
 * per Active listing (never fewer) with month-specific sales context and current-snapshot
 * stock/age/recommendation data.
 */
export async function getInventoryHealth(sellerId: string, from: string, to: string): Promise<InventoryHealthResult> {
  const [
    activeListings,
    imageMap,
    stock,
    invHealth,
    restock,
    removals,
    inbound,
    skuProfit,
    salesTraffic,
    orderUnits,
  ] = await Promise.all([
    loadActiveListings(sellerId),
    loadCatalogImageMap(),
    loadStockByAsin(sellerId),
    loadLatestPerAsin<InventoryHealthRow>(sellerId, INVENTORY_HEALTH_SOURCE),
    loadLatestPerAsin<RestockRow>(sellerId, RESTOCK_SOURCE),
    loadRemovalsByAsin(sellerId),
    loadInboundByAsin(sellerId),
    loadSkuProfitByAsin(sellerId, from, to),
    loadSalesTrafficByAsin(sellerId, from, to),
    getUnitsByAsinRange(sellerId, from, to),
  ]);

  const monthDays = daysInRange(from, to);
  const seen = new Set<string>();
  let duplicateCanonicalCount = 0;

  const products: InventoryHealthProduct[] = activeListings.map((l) => {
    const childAsin = (l.child_asin || "").trim();
    const sku = (l.sku || "").trim();
    const canonical = childAsin || sku;
    if (canonical) {
      if (seen.has(canonical)) duplicateCanonicalCount += 1;
      else seen.add(canonical);
    }

    const cat = childAsin ? imageMap.get(childAsin) : undefined;
    const stockVal = childAsin ? stock.byAsin.get(childAsin) : undefined;
    const hasStock = stockVal != null;

    const ih = childAsin ? invHealth.byAsin.get(childAsin) : undefined;
    const agedUnits = ih ? num(ih.inv_age_91_to_180_days) + num(ih.inv_age_181_to_270_days) + num(ih.inv_age_271_to_365_days) : null;
    const hasAgedData = !!ih;

    const sp = childAsin ? skuProfit.get(childAsin) : undefined;
    const hasRevenueMonth = !!sp && sp.rows > 0;
    const revenueMonth = hasRevenueMonth ? Math.round(sp!.revenue * 100) / 100 : null;
    const hasMarginMonth = hasRevenueMonth && sp!.revenue !== 0;
    const marginMonth = hasMarginMonth ? Math.round((sp!.profit / sp!.revenue) * 1000) / 10 : null;

    const st = childAsin ? salesTraffic.get(childAsin) : undefined;
    const hasBuyBoxMonth = !!st && st.bbDays > 0;
    const buyBoxMonth = hasBuyBoxMonth ? Math.round((st!.bbSum / st!.bbDays) * 10) / 10 : null;
    const hasSessionsMonth = !!st && st.sessions > 0;
    const sessionsMonth = hasSessionsMonth ? st!.sessions : null;
    const hasConversionMonth = !!st && st.convDays > 0;
    const conversionMonth = hasConversionMonth ? Math.round((st!.convSum / st!.convDays) * 100) / 100 : null;

    // Order Line Items is a complete account-wide feed for the whole month (not per-product
    // opt-in), so an active ASIN absent from unitsByAsin genuinely sold zero units that period —
    // NOT missing data. hasUnitsSoldMonth therefore tracks whether the Orders archive itself is
    // available for this window (orderUnits.available), not whether this specific ASIN has a map
    // entry, so a real zero-sales product is never rendered as "Unavailable".
    const unitsRaw = childAsin ? orderUnits.unitsByAsin.get(childAsin) : undefined;
    const hasUnitsSoldMonth = orderUnits.available;
    const unitsSoldMonth = unitsRaw ?? 0;

    const salesVelocity = Math.round((unitsSoldMonth / monthDays) * 100) / 100;
    let daysOfCoverDerived: number | null = null;
    if (hasStock && stockVal! > 0 && salesVelocity > 0) {
      daysOfCoverDerived = Math.round((stockVal! / salesVelocity) * 10) / 10;
    }

    const rs = childAsin ? restock.byAsin.get(childAsin) : undefined;
    const hasAmazonRestockRec = !!rs && num(rs.recommended_replenishment_qty) > 0;
    const amazonRestockQty = rs ? num(rs.recommended_replenishment_qty) : null;
    const amazonRestockShipDate = rs?.recommended_ship_date || null;

    const removalUnits = childAsin ? removals.byAsin.get(childAsin) : undefined;
    const hasAmazonRemovalRec = removalUnits != null && removalUnits > 0;

    const inboundUnitsVal = childAsin ? inbound.byAsin.get(childAsin) : undefined;
    const hasInboundUnits = inboundUnitsVal != null && inboundUnitsVal > 0;

    // Dashboard-derived categories (ours — never labelled as an Amazon recommendation).
    const categories: InventoryCategory[] = [];
    if (hasStock && stockVal === 0) {
      categories.push("out-of-stock");
    } else if (hasStock && stockVal! > 0) {
      const isLowByDaysCover = daysOfCoverDerived !== null && daysOfCoverDerived <= DAYS_COVER_RISK_THRESHOLD;
      const isLowByAbsoluteFloor = salesVelocity === 0 && stockVal! <= LOW_STOCK_ABS_UNITS;
      if (isLowByDaysCover && salesVelocity >= HIGH_VELOCITY_UNITS_PER_DAY) {
        categories.push("high-demand-low-stock");
      } else if (isLowByDaysCover || isLowByAbsoluteFloor) {
        categories.push("stockout-risk");
      }
    }
    if (hasAgedData && agedUnits! > 0) categories.push("aged-inventory");
    if (hasAmazonRestockRec) categories.push("amazon-restock-recommendation");
    if (hasAmazonRemovalRec) categories.push("amazon-recommended-removal");

    return {
      childAsin,
      sku,
      name: (l.listing_name || cat?.name || "").trim(),
      imageUrl: cat?.imageUrl || null,
      stock: hasStock ? stockVal! : null,
      hasStock,
      stockSnapshotDate: stock.snapshotDate,
      agedUnits,
      hasAgedData,
      agedBucketLabel: oldestAgedBucketLabel(ih),
      unitsSoldMonth: hasUnitsSoldMonth ? unitsSoldMonth : null,
      hasUnitsSoldMonth,
      revenueMonth,
      hasRevenueMonth,
      marginMonth,
      hasMarginMonth,
      buyBoxMonth,
      hasBuyBoxMonth,
      sessionsMonth,
      hasSessionsMonth,
      conversionMonth,
      hasConversionMonth,
      salesVelocity: hasUnitsSoldMonth ? salesVelocity : null,
      daysOfCoverDerived,
      categories,
      amazonRestockQty,
      amazonRestockShipDate,
      hasAmazonRestockRec,
      amazonRemovalUnits: removalUnits ?? null,
      hasAmazonRemovalRec,
      inboundUnits: inboundUnitsVal ?? null,
      hasInboundUnits,
    };
  });

  const coverage: InventoryHealthCoverage = {
    activeListingCount: activeListings.length,
    stock: products.filter((p) => p.hasStock).length,
    agedInventory: { datasetAvailable: true, flagged: products.filter((p) => p.categories.includes("aged-inventory")).length },
    stranded: { datasetAvailable: false, flagged: 0 },
    amazonRestockRecommendation: { datasetAvailable: true, flagged: products.filter((p) => p.hasAmazonRestockRec).length },
    amazonRecommendedRemoval: { datasetAvailable: removals.datasetAvailable, flagged: products.filter((p) => p.hasAmazonRemovalRec).length },
    inbound: { datasetAvailable: inbound.datasetAvailable, flagged: products.filter((p) => p.hasInboundUnits).length },
    outOfStock: products.filter((p) => p.categories.includes("out-of-stock")).length,
    stockoutRisk: products.filter((p) => p.categories.includes("stockout-risk")).length,
    highDemandLowStock: products.filter((p) => p.categories.includes("high-demand-low-stock")).length,
    unitsSoldMonth: products.filter((p) => p.hasUnitsSoldMonth).length,
    revenueMonth: products.filter((p) => p.hasRevenueMonth).length,
    buyBoxMonth: products.filter((p) => p.hasBuyBoxMonth).length,
  };

  return {
    from,
    to,
    activeListingCount: activeListings.length,
    productCount: products.length,
    duplicateCanonicalCount,
    products,
    coverage,
    stockSnapshotDate: stock.snapshotDate,
    agedInventorySnapshotDate: invHealth.latestDate,
    restockRecommendationDate: restock.latestDate,
    available: activeListings.length > 0,
  };
}
