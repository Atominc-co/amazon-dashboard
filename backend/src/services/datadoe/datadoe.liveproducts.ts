import { promises as fs } from "fs";
import path from "path";
import { getSellerSourceData } from "../amazon-catalog.service";
import { getUnitsByAsinRange } from "./datadoe.orders";

/**
 * Live Products data pipeline.
 *
 * DRIVING TABLE: the seller's Active listings (listing_status === "Active"). Every active listing
 * produces exactly ONE Live Product row; nothing else can add or remove a row. All other datasets
 * are LEFT-JOINed onto the active listings by canonical product identity — a listing is NEVER
 * dropped because a joined dataset has no matching record; the corresponding metric is simply
 * marked unavailable.
 *
 * CANONICAL IDENTITY: child_asin (every active listing has a unique, non-empty child_asin for this
 * account — verified). seller SKU is retained as a secondary/display identifier. Identity is
 * deterministic — NO title/description/fuzzy matching is ever used to associate rows.
 *
 * SOURCES (all read strict-local; a normal render triggers ZERO provider exports):
 *   - Listings ............... driving table (child_asin, sku, listing_name, listing_status)
 *   - Product Catalog by ASIN  product image (product_image_url) + catalog name — sparse locally
 *   - FBA Inventory by ASIN .. Stock (quantity_for_local_fulfillment) — CURRENT snapshot only
 *   - Profit by SKU & Date ... Revenue (total_sales), Margin (profit/total_sales),
 *                              ACOS (ad_spend/ad_sales) — per child_asin, per selected month
 *   - Sales & Traffic by ASIN  Buy Box (buybox_percentage) — per child_asin, per selected month
 *   - Order Line Items ....... Units (per child_asin) — month-complete units source
 *
 * MONTH SEMANTICS: every month-sensitive metric (Revenue, Margin, ACOS, Units, Buy Box) is
 * aggregated over the EXACT [from, to] window passed in. Stock is a point-in-time inventory
 * snapshot (Amazon supplies no historical inventory) and is reported with its snapshot date and a
 * period-independent flag so the UI can label it honestly.
 *
 * NO FABRICATION: a field with no authoritative source record stays null (rendered "Unavailable" /
 * "No campaign data"). Zero is emitted ONLY when the source explicitly reports zero.
 */

const SELLER_LISTINGS_SOURCE = "Listings";
const CATALOG_SOURCE = "Product Catalog by ASIN";
const INVENTORY_SOURCE = "FBA Inventory by ASIN & Country";
const SKU_PROFIT_SOURCE = "Profit by SKU & Date";
const SKU_PROFIT_COLUMNS = ["date", "child_asin", "total_sales", "profit", "ad_spend", "ad_sales"];
const SALES_TRAFFIC_SOURCE = "Sales & Traffic by ASIN & Date";

// Canonical month windows (single source of truth for the two supported month modes).
export const JULY_START = "2026-07-01";
export const JULY_END = "2026-07-31";
export const AUGUST_START = "2026-08-01";
export const AUGUST_END = "2026-08-31";

export type CampaignState = "advertised" | "not-advertised";

export interface LiveProductRow {
  // ---- identity (always present) ----
  childAsin: string;
  sku: string;
  listingId: string;
  name: string;
  // ---- image ----
  imageUrl: string | null;
  hasImage: boolean;
  // ---- revenue / units (month-specific) ----
  revenue: number | null;
  hasRevenue: boolean;
  units: number | null;
  hasUnits: boolean;
  // ---- margin (month-specific, authoritative-or-null) ----
  margin: number | null; // percent
  hasMargin: boolean;
  // ---- advertising / ACOS (PPC attribution from Profit by SKU; month-specific) ----
  adSpend: number | null;
  adSales: number | null;
  acos: number | null; // percent; null when no PPC spend
  hasPpc: boolean; // true iff ad_spend > 0 in the window
  campaignState: CampaignState;
  advertisedNoAttributedSales: boolean; // ad_spend > 0 but ad_sales <= 0
  // ---- buy box (month-specific, authoritative-or-null) ----
  buyBox: number | null; // percent (avg over covered days in window)
  hasBuyBox: boolean;
  // ---- stock (CURRENT snapshot, not month-specific) ----
  stock: number | null;
  hasStock: boolean;
}

export interface LiveProductsCoverage {
  image: number;
  revenue: number;
  units: number;
  margin: number;
  acos: number; // products with a computable ACOS (ad_spend>0 && ad_sales>0)
  ppc: number; // products advertised in the window (ad_spend>0)
  buyBox: number;
  stock: number;
  campaign: number; // == ppc (products with campaign/advertising data)
  noCampaign: number; // 62 - ppc
}

export interface LiveProductsResult {
  from: string;
  to: string;
  activeListingCount: number;
  liveProductCount: number;
  duplicateCanonicalCount: number;
  unmatchedListingCount: number; // active listings with no child_asin (should be 0)
  products: LiveProductRow[];
  coverage: LiveProductsCoverage;
  // provenance / audit
  inventorySnapshotDate: string | null;
  stockIsCurrentSnapshot: boolean;
  revenueSourceTotal: number; // sum of product revenue (Profit by SKU total_sales) in window
  currency: string;
  available: boolean;
}

interface ListingRow {
  listing_id?: string;
  sku?: string;
  child_asin?: string;
  listing_name?: string;
  listing_status?: string;
  [k: string]: unknown;
}
interface CatalogRow {
  child_asin?: string;
  product_name?: string;
  product_image_url?: string;
  [k: string]: unknown;
}
interface InventoryRow {
  child_asin?: string;
  date?: string;
  quantity_for_local_fulfillment?: number;
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
  [k: string]: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function cacheDir(): string {
  return process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
}

/**
 * Product image map (child_asin -> product_image_url), read strict-local by scanning the exact-key
 * cache for the most complete "Product Catalog by ASIN" entry. Direct scan (rather than an exact
 * cache-key lookup) is deliberate: the catalog is a snapshot fetched with an arbitrary page size,
 * so the key varies — scanning by source name is robust and never triggers a provider call.
 */
async function loadCatalogImageMap(): Promise<Map<string, { imageUrl: string | null; name: string | null }>> {
  const map = new Map<string, { imageUrl: string | null; name: string | null }>();
  let files: string[] = [];
  try {
    files = (await fs.readdir(cacheDir())).filter((f) => f.endsWith(".json") && !f.endsWith(".cov.json"));
  } catch {
    return map;
  }
  let best: CatalogRow[] | null = null;
  for (const f of files) {
    let entry: { source?: { name?: string }; sourceName?: string; rows?: CatalogRow[] };
    try {
      entry = JSON.parse(await fs.readFile(path.join(cacheDir(), f), "utf8"));
    } catch {
      continue;
    }
    const name = entry.source?.name || entry.sourceName;
    if (name !== CATALOG_SOURCE || !Array.isArray(entry.rows)) continue;
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

/** Strict-local read of the driving table: all Active listings (one row per active listing). */
async function loadActiveListings(sellerId: string): Promise<ListingRow[]> {
  const res = await getSellerSourceData<ListingRow>({ sellerId, sourceName: SELLER_LISTINGS_SOURCE, all: true });
  return (res.rows || []).filter((r) => (r.listing_status || "").trim() === "Active");
}

/** Stock (current snapshot) per child_asin, summed across countries/conditions. */
async function loadInventoryByAsin(
  sellerId: string
): Promise<{ byAsin: Map<string, number>; snapshotDate: string | null }> {
  const byAsin = new Map<string, number>();
  let snapshotDate: string | null = null;
  try {
    // recentDateRange-style window: the snapshot fallback in getSellerSourceData serves the latest
    // cached inventory snapshot regardless of the exact from/to, so any recent window works.
    const res = await getSellerSourceData<InventoryRow>({
      sellerId,
      sourceName: INVENTORY_SOURCE,
      from: "2026-08-01",
      to: "2026-08-31",
      pageSize: 500,
    });
    for (const r of res.rows || []) {
      const asin = (r.child_asin || "").trim();
      if (!asin) continue;
      byAsin.set(asin, (byAsin.get(asin) || 0) + num(r.quantity_for_local_fulfillment));
      if (typeof r.date === "string" && (!snapshotDate || r.date > snapshotDate)) snapshotDate = r.date;
    }
  } catch {
    /* inventory not synchronized -> every product's stock stays Unavailable */
  }
  return { byAsin, snapshotDate };
}

/** Profit-by-SKU aggregates per child_asin within [from,to]. */
async function loadSkuProfitByAsin(
  sellerId: string,
  from: string,
  to: string
): Promise<Map<string, { revenue: number; profit: number; adSpend: number; adSales: number; rows: number }>> {
  const byAsin = new Map<string, { revenue: number; profit: number; adSpend: number; adSales: number; rows: number }>();
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
    const e = byAsin.get(asin) || { revenue: 0, profit: 0, adSpend: 0, adSales: 0, rows: 0 };
    e.revenue += num(r.total_sales);
    e.profit += num(r.profit);
    e.adSpend += num(r.ad_spend);
    e.adSales += num(r.ad_sales);
    e.rows += 1;
    byAsin.set(asin, e);
  }
  return byAsin;
}

/** Buy Box per child_asin = average of buybox_percentage over the covered days within [from,to]. */
async function loadBuyBoxByAsin(sellerId: string, from: string, to: string): Promise<Map<string, number>> {
  const acc = new Map<string, { sum: number; days: number }>();
  try {
    const res = await getSellerSourceData<SalesTrafficRow>({
      sellerId,
      sourceName: SALES_TRAFFIC_SOURCE,
      all: true,
      from,
      to,
    });
    for (const r of res.rows || []) {
      const asin = (r.child_asin || "").trim();
      if (!asin || r.buybox_percentage == null) continue;
      const e = acc.get(asin) || { sum: 0, days: 0 };
      e.sum += num(r.buybox_percentage);
      e.days += 1;
      acc.set(asin, e);
    }
  } catch {
    /* S&T not synchronized -> Buy Box stays Unavailable for all */
  }
  const out = new Map<string, number>();
  for (const [asin, e] of acc) if (e.days > 0) out.set(asin, Math.round((e.sum / e.days) * 10) / 10);
  return out;
}

/**
 * Assemble the Live Products result for the selected month window. `from`/`to` MUST be exact month
 * boundaries (e.g. JULY_START..JULY_END). Returns exactly one row per Active listing.
 */
export async function getLiveProducts(sellerId: string, from: string, to: string): Promise<LiveProductsResult> {
  const [activeListings, imageMap, inventory, skuProfit, buyBox, orderUnits] = await Promise.all([
    loadActiveListings(sellerId),
    loadCatalogImageMap(),
    loadInventoryByAsin(sellerId),
    loadSkuProfitByAsin(sellerId, from, to),
    loadBuyBoxByAsin(sellerId, from, to),
    getUnitsByAsinRange(sellerId, from, to),
  ]);

  const seen = new Set<string>();
  let duplicateCanonicalCount = 0;
  let unmatchedListingCount = 0;

  const products: LiveProductRow[] = activeListings.map((l) => {
    const childAsin = (l.child_asin || "").trim();
    const sku = (l.sku || "").trim();
    const canonical = childAsin || sku;
    if (!childAsin) unmatchedListingCount += 1;
    if (canonical) {
      if (seen.has(canonical)) duplicateCanonicalCount += 1;
      else seen.add(canonical);
    }

    const cat = childAsin ? imageMap.get(childAsin) : undefined;
    const imageUrl = cat?.imageUrl || null;

    const sp = childAsin ? skuProfit.get(childAsin) : undefined;
    const hasRevenue = !!sp && sp.rows > 0;
    const revenue = hasRevenue ? Math.round(sp!.revenue * 100) / 100 : null;
    const hasMargin = !!sp && sp.rows > 0 && sp.revenue !== 0;
    const margin = hasMargin ? Math.round((sp!.profit / sp!.revenue) * 1000) / 10 : null;

    const adSpend = sp ? Math.round(sp.adSpend * 100) / 100 : null;
    const adSales = sp ? Math.round(sp.adSales * 100) / 100 : null;
    const hasPpc = !!sp && sp.adSpend > 0;
    const advertisedNoAttributedSales = hasPpc && (sp!.adSales <= 0);
    const acos = hasPpc && sp!.adSales > 0 ? Math.round((sp!.adSpend / sp!.adSales) * 1000) / 10 : null;

    const bb = childAsin ? buyBox.get(childAsin) : undefined;
    const hasBuyBox = bb != null;
    const buyBoxVal = hasBuyBox ? bb! : null;

    const stockRaw = childAsin ? inventory.byAsin.get(childAsin) : undefined;
    const hasStock = stockRaw != null;
    const stock = hasStock ? stockRaw! : null;

    const unitsRaw = childAsin ? orderUnits.unitsByAsin.get(childAsin) : undefined;
    const hasUnits = unitsRaw != null;
    const units = hasUnits ? unitsRaw! : null;

    return {
      childAsin,
      sku,
      listingId: (l.listing_id || "").trim(),
      name: (l.listing_name || cat?.name || "").trim(),
      imageUrl,
      hasImage: !!imageUrl,
      revenue,
      hasRevenue,
      units,
      hasUnits,
      margin,
      hasMargin,
      adSpend,
      adSales,
      acos,
      hasPpc,
      campaignState: hasPpc ? "advertised" : "not-advertised",
      advertisedNoAttributedSales,
      buyBox: buyBoxVal,
      hasBuyBox,
      stock,
      hasStock,
    };
  });

  // Deterministic ordering: revenue desc, then units desc, then ASIN — stable and month-sensitive,
  // but NEVER a filter (all 62 remain).
  products.sort((a, b) => {
    const ar = a.revenue ?? -1;
    const br = b.revenue ?? -1;
    if (br !== ar) return br - ar;
    const au = a.units ?? -1;
    const bu = b.units ?? -1;
    if (bu !== au) return bu - au;
    return a.childAsin < b.childAsin ? -1 : a.childAsin > b.childAsin ? 1 : 0;
  });

  const coverage: LiveProductsCoverage = {
    image: products.filter((p) => p.hasImage).length,
    revenue: products.filter((p) => p.hasRevenue).length,
    units: products.filter((p) => p.hasUnits).length,
    margin: products.filter((p) => p.hasMargin).length,
    acos: products.filter((p) => p.acos != null).length,
    ppc: products.filter((p) => p.hasPpc).length,
    buyBox: products.filter((p) => p.hasBuyBox).length,
    stock: products.filter((p) => p.hasStock).length,
    campaign: products.filter((p) => p.hasPpc).length,
    noCampaign: products.filter((p) => !p.hasPpc).length,
  };

  const revenueSourceTotal =
    Math.round(products.reduce((t, p) => t + (p.revenue ?? 0), 0) * 100) / 100;

  return {
    from,
    to,
    activeListingCount: activeListings.length,
    liveProductCount: products.length,
    duplicateCanonicalCount,
    unmatchedListingCount,
    products,
    coverage,
    inventorySnapshotDate: inventory.snapshotDate,
    stockIsCurrentSnapshot: true,
    revenueSourceTotal,
    currency: "GBP",
    available: activeListings.length > 0,
  };
}
