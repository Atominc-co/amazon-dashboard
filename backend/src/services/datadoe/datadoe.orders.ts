import { promises as fs } from "fs";
import path from "path";

/**
 * Orders (Order Line Items) source of truth for the dashboard's Orders section.
 *
 * Retrieved once from the connected provider's "Order Line Items" source and archived permanently
 * under `.cache/datadoe/orders/*.json` (raw response also archived immutably under raw/). This
 * module reads those archives token-free and returns the orders that fall in the requested date
 * window, aggregated per Amazon order id (one row per order, summing its line items). Never
 * fabricates: a field absent in the source stays absent; an order with no line items in the window
 * simply does not appear.
 */

export interface OrderLineRow {
  date: string;
  orderId: string;
  status: string;
  channel: string;
  childAsin: string;
  sku: string;
  productName: string;
  quantity: number;
  itemValue: number;
  currency: string;
}

export interface OrderRow {
  date: string;
  orderId: string;
  status: string;
  channel: string;
  units: number;
  value: number;
  currency: string;
  itemCount: number;
  firstAsin: string;
  firstProduct: string;
}

export interface OrdersRangeResult {
  orders: OrderRow[];
  count: number;
  totalUnits: number;
  totalValue: number;
  currency: string;
  from: string;
  to: string;
  earliest: string | null;
  latest: string | null;
  available: boolean;
}

function ordersDir(): string {
  const base = process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
  return path.join(base, "orders");
}

interface OrdersArchiveFile {
  sellerId: string;
  rows: OrderLineRow[];
}

/** Load every archived orders line-item row for a seller (token-free disk read). */
async function loadOrderLines(sellerId: string): Promise<OrderLineRow[]> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(ordersDir())).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  } catch {
    return [];
  }
  files.sort();
  const all: OrderLineRow[] = [];
  for (const f of files) {
    let entry: OrdersArchiveFile;
    try {
      entry = JSON.parse(await fs.readFile(path.join(ordersDir(), f), "utf8")) as OrdersArchiveFile;
    } catch {
      continue;
    }
    if (entry.sellerId !== sellerId || !Array.isArray(entry.rows)) continue;
    for (const r of entry.rows) if (r && typeof r.date === "string") all.push(r);
  }
  return all;
}

/**
 * Orders whose date falls in [from, to], aggregated per Amazon order id (summing line items),
 * newest first. Currency is the archive's own per-line currency (GBP for this account).
 */
export async function getOrdersRange(sellerId: string, from: string, to: string): Promise<OrdersRangeResult> {
  const lines = await loadOrderLines(sellerId);
  const inWindow = lines.filter((r) => r.date >= from && r.date <= to);
  const allDates = lines.map((r) => r.date).sort();

  const byOrder = new Map<string, OrderRow>();
  for (const r of inWindow) {
    const key = r.orderId || r.date + "|" + r.sku;
    const existing = byOrder.get(key);
    if (existing) {
      existing.units += r.quantity || 0;
      existing.value += r.itemValue || 0;
      existing.itemCount += 1;
      if (r.date > existing.date) existing.date = r.date; // order date = latest line date
    } else {
      byOrder.set(key, {
        date: r.date,
        orderId: r.orderId,
        status: r.status,
        channel: r.channel,
        units: r.quantity || 0,
        value: r.itemValue || 0,
        currency: r.currency || "GBP",
        itemCount: 1,
        firstAsin: r.childAsin,
        firstProduct: r.productName,
      });
    }
  }
  const orders = Array.from(byOrder.values())
    .map((o) => ({ ...o, value: Math.round(o.value * 100) / 100 }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.orderId < b.orderId ? 1 : -1)));

  const totalUnits = orders.reduce((t, o) => t + o.units, 0);
  const totalValue = Math.round(orders.reduce((t, o) => t + o.value, 0) * 100) / 100;

  return {
    orders,
    count: orders.length,
    totalUnits,
    totalValue,
    currency: orders[0]?.currency || "GBP",
    from,
    to,
    earliest: allDates[0] || null,
    latest: allDates[allDates.length - 1] || null,
    available: lines.length > 0,
  };
}

export interface AsinUnitsRange {
  /** child_asin -> summed order-line quantity within [from, to]. */
  unitsByAsin: Map<string, number>;
  /** child_asin -> summed order-line item value within [from, to]. */
  valueByAsin: Map<string, number>;
  /** true when any archived order lines exist for the seller (distinguishes "no data" from "no orders"). */
  available: boolean;
}

/**
 * Product-level (per child_asin) units & value for orders whose date falls in [from, to].
 *
 * Used by Live Products as the month-complete Units source: Profit by SKU & Date has no units
 * column, and Sales & Traffic has a genuine leading coverage gap in July (upstream-empty before
 * 2026-07-20), whereas the archived Order Line Items cover the full month. Quantity is the real
 * ordered quantity per line (Canceled lines legitimately carry 0 — preserved, never fabricated).
 */
export async function getUnitsByAsinRange(sellerId: string, from: string, to: string): Promise<AsinUnitsRange> {
  const lines = await loadOrderLines(sellerId);
  const inWindow = lines.filter((r) => r.date >= from && r.date <= to);
  const unitsByAsin = new Map<string, number>();
  const valueByAsin = new Map<string, number>();
  for (const r of inWindow) {
    const asin = (r.childAsin || "").trim();
    if (!asin) continue;
    unitsByAsin.set(asin, (unitsByAsin.get(asin) || 0) + (r.quantity || 0));
    valueByAsin.set(asin, (valueByAsin.get(asin) || 0) + (r.itemValue || 0));
  }
  for (const [k, v] of valueByAsin) valueByAsin.set(k, Math.round(v * 100) / 100);
  return { unitsByAsin, valueByAsin, available: lines.length > 0 };
}
