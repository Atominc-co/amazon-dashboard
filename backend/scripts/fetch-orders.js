/*
 * One-time targeted retrieval of the "Order Line Items" source for 2026-07-01..2026-08-31
 * (seller Vertex trading UK) into a permanent local archive, mirroring the P&L-archive pattern
 * (self-contained JSON under .cache/datadoe/orders/, does NOT touch the coverage cache machinery).
 * Uses production export primitives. Archives the raw response immutably. No fabrication.
 */
require("../dist/config/env");
const fs = require("fs");
const path = require("path");
const { getExportSources, createExport, getExportStatus, fetchExportRawData } = require("../dist/services/datadoe/datadoe.exports.client");
const { archiveRawExport } = require("../dist/services/datadoe/datadoe.raw-archive");

const SELLER_ID = "19076074-9461-4eb0-a762-5f27185f9e5b";
const SOURCE_NAME = "Order Line Items";
const FROM = "2026-07-01";
const TO = "2026-08-31";
const COLUMNS = [
  "date", "amazon_order_id", "amazon_order_status", "fulfillment_channel",
  "child_asin", "sku", "product_name", "quantity", "item_price_value", "item_price_currency",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = (await getExportSources([SELLER_ID])).sources.find((s) => s.name === SOURCE_NAME);
  if (!src) { console.error("ABORT: source not found", SOURCE_NAME); process.exit(3); }
  console.log("source:", src.id, src.tableName, src.type);

  const created = await createExport({
    sellerOrVendorIds: [SELLER_ID], sourceId: src.id, columns: COLUMNS,
    outputType: "JSON", sendToAllOrganizationMembers: false, from: FROM, to: TO,
  });
  console.log("createExport", created.id, created.status);

  let status = created.status; const dl = Date.now() + 120000;
  while (status === "PENDING" || status === "IN_PROGRESS") { if (Date.now() > dl) { console.error("ABORT timeout"); process.exit(4); } await sleep(1000); status = (await getExportStatus(created.id)).status; }
  if (status !== "COMPLETED") { console.error("ABORT status", status); process.exit(5); }

  let raw = await fetchExportRawData(created.id); const rdl = Date.now() + 120000;
  while (raw.state === "pending") { if (Date.now() > rdl) { console.error("ABORT raw timeout"); process.exit(6); } await sleep(1000); raw = await fetchExportRawData(created.id); }
  if (raw.state !== "ready") { console.error("ABORT raw", raw.state); process.exit(7); }
  console.log("raw rows:", raw.rows.length, "bytes:", Buffer.byteLength(raw.raw, "utf8"));

  // Immutable raw archive (established convention).
  const archivePath = await archiveRawExport({
    exportId: created.id, sellerId: SELLER_ID, sourceName: SOURCE_NAME, sourceId: src.id,
    columns: COLUMNS, from: FROM, to: TO, status, rowCount: raw.rows.length,
    requestId: raw.requestId, rawPayload: raw.raw,
  });
  console.log("raw archive:", archivePath);

  // Keep only the narrowed, useful line-item fields; preserve every row faithfully (no dedup here —
  // dedup by amazon_order_id + line happens at read time in the backend module).
  const rows = raw.rows.map((r) => ({
    date: (r.date || r.order_date || "").slice(0, 10),
    orderId: r.amazon_order_id, status: r.amazon_order_status, channel: r.fulfillment_channel,
    childAsin: r.child_asin, sku: r.sku, productName: r.product_name,
    quantity: typeof r.quantity === "number" ? r.quantity : Number(r.quantity) || 0,
    itemValue: typeof r.item_price_value === "number" ? r.item_price_value : Number(r.item_price_value) || 0,
    currency: r.item_price_currency || "GBP",
  })).filter((r) => r.date >= FROM && r.date <= TO);

  const dates = rows.map((r) => r.date).sort();
  const orderIds = new Set(rows.map((r) => r.orderId));
  const dir = path.join(__dirname, "..", ".cache", "datadoe", "orders");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "orders-vertex-2026-07-01_2026-08-31.json");
  const doc = {
    schemaVersion: 1, source: SOURCE_NAME, sellerId: SELLER_ID, sellerName: "Vertex trading UK",
    from: FROM, to: TO, lastExportId: created.id, fetchedAt: new Date().toISOString(),
    lineItemRows: rows.length, distinctOrders: orderIds.size,
    firstDate: dates[0], lastDate: dates[dates.length - 1],
    columns: ["date", "orderId", "status", "channel", "childAsin", "sku", "productName", "quantity", "itemValue", "currency"],
    rows,
  };
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 0));
  console.log("wrote", outPath, "lineItems:", rows.length, "distinctOrders:", orderIds.size, "coverage:", dates[0], "->", dates[dates.length - 1]);
  // per-month distinct order counts
  const jul = new Set(rows.filter((r) => r.date <= "2026-07-31").map((r) => r.orderId));
  const aug = new Set(rows.filter((r) => r.date >= "2026-08-01").map((r) => r.orderId));
  console.log("July distinct orders:", jul.size, "August distinct orders:", aug.size);
  console.log("DONE");
})().catch((e) => { console.error("ERROR:", e && e.message ? e.message : e); process.exit(1); });
