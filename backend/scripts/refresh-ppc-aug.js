/*
 * Targeted, minimal PPC Ad-Performance refresh for August 1-28, 2026 (seller Vertex trading UK).
 * Uses the PRODUCTION export primitives from dist/. NO broad Sync, NO aggregation-logic change,
 * NO hardcoded values, NO manual number edits. Fetches ONLY this one source + this one date range,
 * archives the raw response immutably (new file, never overwrites), then merges (replace-by-interval)
 * into the EXISTING coverage cache so 06-25..07-31 rows are preserved and 08-01..08-28 are replaced
 * with the freshly-matured values.
 */
require("../dist/config/env"); // side-effect: dotenv.config() loads .env (API key never printed)
const {
  getExportSources,
  createExport,
  getExportStatus,
  fetchExportRawData,
} = require("../dist/services/datadoe/datadoe.exports.client");
const { archiveRawExport } = require("../dist/services/datadoe/datadoe.raw-archive");
const {
  computeDatasetKey,
  readCoverage,
  writeCoverage,
  mergeRowsForInterval,
  coalesceIntervals,
} = require("../dist/services/datadoe/datadoe.coverage");

const SELLER_ID = "19076074-9461-4eb0-a762-5f27185f9e5b";
const SOURCE_NAME = "Ad Performance by Campaign & Date";
const COLUMNS = [
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
const FROM = "2026-08-01";
const TO = "2026-08-28";
const CAMPAIGN_TYPE = "SPONSORED_PRODUCTS";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function aggSP(rows) {
  let spend = 0, sales = 0, clicks = 0, impr = 0, orders = 0;
  const camps = new Set(), dates = new Set();
  for (const r of rows) {
    if (r.ad_campaign_type !== CAMPAIGN_TYPE) continue;
    const d = (r.date || "").slice(0, 10);
    if (d < FROM || d > TO) continue;
    dates.add(d); camps.add(r.ad_campaign_id);
    spend += +r.ad_spend || 0; sales += +r.ad_sales || 0;
    clicks += +r.ad_clicks || 0; impr += +r.ad_impressions || 0; orders += +r.ad_orders || 0;
  }
  return {
    campaigns: camps.size, days: dates.size,
    spend: +spend.toFixed(2), sales: +sales.toFixed(2), clicks, impressions: impr, orders,
    acos: +(spend / sales * 100).toFixed(2), cpc: +(spend / clicks).toFixed(4),
    ctr: +(clicks / impr * 100).toFixed(4), cvr: +(orders / clicks * 100).toFixed(2),
    roas: +(sales / spend).toFixed(4),
  };
}

(async () => {
  const datasetKey = computeDatasetKey({ sellerId: SELLER_ID, sourceName: SOURCE_NAME, columns: COLUMNS });
  console.log("datasetKey:", datasetKey);

  const existing = await readCoverage(datasetKey);
  if (!existing) {
    console.error("ABORT: no existing coverage for this datasetKey — columns/source mismatch. Not writing.");
    process.exit(2);
  }
  console.log("PRE  cov: intervals", JSON.stringify(existing.intervals), "rows", existing.rows.length,
    "fetchedAt", existing.fetchedAt, "lastExportId", existing.lastExportId);
  console.log("PRE  SP Aug1-28 (from existing cache):", JSON.stringify(aggSP(existing.rows)));

  // Resolve source (non-token /exports/sources call) to get id/tableName/type faithfully.
  const sourcesResp = await getExportSources([SELLER_ID]);
  const source = sourcesResp.sources.find((s) => s.name === SOURCE_NAME);
  if (!source) { console.error("ABORT: source not found:", SOURCE_NAME); process.exit(3); }
  console.log("source:", source.id, source.tableName, source.type);

  // THE SINGLE TOKEN-SPENDING CALL — one targeted export, this source, this range only.
  const created = await createExport({
    sellerOrVendorIds: [SELLER_ID],
    sourceId: source.id,
    columns: COLUMNS,
    outputType: "JSON",
    sendToAllOrganizationMembers: false,
    from: FROM,
    to: TO,
  });
  console.log("createExport id:", created.id, "status:", created.status);

  const deadline = Date.now() + 90000;
  let status = created.status;
  while (status === "PENDING" || status === "IN_PROGRESS") {
    if (Date.now() > deadline) { console.error("ABORT: export status timeout"); process.exit(4); }
    await sleep(1000);
    status = (await getExportStatus(created.id)).status;
  }
  console.log("final export status:", status);
  if (status !== "COMPLETED") { console.error("ABORT: export not COMPLETED:", status); process.exit(5); }

  let raw = await fetchExportRawData(created.id);
  const rawDeadline = Date.now() + 90000;
  while (raw.state === "pending") {
    if (Date.now() > rawDeadline) { console.error("ABORT: raw fetch timeout"); process.exit(6); }
    await sleep(1000);
    raw = await fetchExportRawData(created.id);
  }
  if (raw.state !== "ready") { console.error("ABORT: raw not ready:", raw.state); process.exit(7); }
  console.log("raw rows:", raw.rows.length, "byteLength:", Buffer.byteLength(raw.raw, "utf8"));

  // Immutable raw archive (new file keyed by the NEW exportId — never overwrites the prior a43f6944).
  const archivePath = await archiveRawExport({
    exportId: created.id, sellerId: SELLER_ID, sourceName: SOURCE_NAME, sourceId: source.id,
    columns: COLUMNS, from: FROM, to: TO, status, rowCount: raw.rows.length,
    requestId: raw.requestId, rawPayload: raw.raw,
  });
  console.log("raw archive written:", archivePath);

  console.log("FRESH SP Aug1-28 (from raw export):", JSON.stringify(aggSP(raw.rows)));

  // Merge: replace-by-interval (drops existing 08-01..08-28, keeps 06-25..07-31, appends fresh).
  const mergedRows = mergeRowsForInterval(existing.rows, raw.rows, FROM, TO, "date");
  const mergedIntervals = coalesceIntervals([...existing.intervals, { from: FROM, to: TO }]);
  const updated = {
    ...existing,
    source: { id: source.id, name: source.name, tableName: source.tableName, type: source.type },
    columns: COLUMNS,
    dateField: existing.dateField || "date",
    intervals: mergedIntervals,
    rows: mergedRows,
    fetchedAt: new Date().toISOString(),
    lastExportId: created.id,
  };
  await writeCoverage(datasetKey, updated);
  console.log("POST cov: intervals", JSON.stringify(updated.intervals), "rows", updated.rows.length,
    "fetchedAt", updated.fetchedAt, "lastExportId", updated.lastExportId);
  console.log("POST SP Aug1-28 (from rebuilt cache):", JSON.stringify(aggSP(updated.rows)));
  console.log("DONE");
})().catch((e) => { console.error("ERROR:", e && e.message ? e.message : e); process.exit(1); });
