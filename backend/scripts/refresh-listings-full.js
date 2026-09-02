/*
 * Targeted, minimal Listings refresh: fetch ALL rows (all:true, no skip/limit) for the "Listings"
 * source so the true seller-wide active/inactive/incomplete count can be determined, instead of
 * only the first 100-row page. Uses the PRODUCTION export primitives from dist/. NO Sync (does
 * not touch any other source or the rolling-window logic), NO hardcoded values, NO manual number
 * edits. Writes to the EXACT-KEY cache location that getSellerSourceData({all:true}) would read,
 * computed with the same computeCacheKey() function the running server uses, so a normal
 * (non-refresh) read after this script + a server restart serves it with ZERO further exports.
 */
require("../dist/config/env"); // side-effect: dotenv.config() loads .env (API key never printed)
const {
  getExportSources,
  createExport,
  getExportStatus,
  fetchExportRawData,
} = require("../dist/services/datadoe/datadoe.exports.client");
const { archiveRawExport } = require("../dist/services/datadoe/datadoe.raw-archive");
const { computeCacheKey, writeCache, CACHE_SCHEMA_VERSION } = require("../dist/services/datadoe/datadoe.cache");

const SELLER_ID = "19076074-9461-4eb0-a762-5f27185f9e5b";
const SOURCE_NAME = "Listings";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusCounts(rows) {
  const counts = {};
  for (const r of rows) {
    const s = r.listing_status || "null";
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

(async () => {
  // Resolve source (non-token /exports/sources call) to get id/tableName/type + full column list,
  // mirroring exactly what fetchFromDataDoe() does when params.columns is undefined.
  const sourcesResp = await getExportSources([SELLER_ID]);
  const source = sourcesResp.sources.find((s) => s.name === SOURCE_NAME);
  if (!source) { console.error("ABORT: source not found:", SOURCE_NAME); process.exit(3); }
  console.log("source:", source.id, source.tableName, source.type);
  const columns = source.columns.map((c) => c.name);

  const key = computeCacheKey({
    sellerId: SELLER_ID,
    sourceName: SOURCE_NAME,
    columns: undefined, // undefined -> "__ALL__" sentinel, matching the controller's existing call (no columns filter)
    from: undefined,
    to: undefined,
    all: true,
    page: undefined,
    pageSize: undefined,
  });
  console.log("target cache key (all:true):", key);

  // THE SINGLE TOKEN-SPENDING CALL — one export, this source, ALL rows (skip/limit omitted).
  const created = await createExport({
    sellerOrVendorIds: [SELLER_ID],
    sourceId: source.id,
    columns,
    outputType: "JSON",
    sendToAllOrganizationMembers: false,
    skip: undefined,
    limit: undefined,
  });
  console.log("createExport id:", created.id, "status:", created.status);

  const deadline = Date.now() + 120000;
  let status = created.status;
  while (status === "PENDING" || status === "IN_PROGRESS") {
    if (Date.now() > deadline) { console.error("ABORT: export status timeout"); process.exit(4); }
    await sleep(1000);
    status = (await getExportStatus(created.id)).status;
  }
  console.log("final export status:", status);
  if (status !== "COMPLETED") { console.error("ABORT: export not COMPLETED:", status); process.exit(5); }

  let raw = await fetchExportRawData(created.id);
  const rawDeadline = Date.now() + 120000;
  while (raw.state === "pending") {
    if (Date.now() > rawDeadline) { console.error("ABORT: raw fetch timeout"); process.exit(6); }
    await sleep(1000);
    raw = await fetchExportRawData(created.id);
  }
  if (raw.state !== "ready") { console.error("ABORT: raw not ready:", raw.state); process.exit(7); }
  console.log("raw rows:", raw.rows.length, "byteLength:", Buffer.byteLength(raw.raw, "utf8"));
  console.log("status counts (from raw export):", JSON.stringify(statusCounts(raw.rows)));

  // Immutable raw archive (new file keyed by the new exportId — never overwrites anything).
  const archivePath = await archiveRawExport({
    exportId: created.id, sellerId: SELLER_ID, sourceName: SOURCE_NAME, sourceId: source.id,
    columns, from: undefined, to: undefined, status, rowCount: raw.rows.length,
    requestId: raw.requestId, rawPayload: raw.raw,
  });
  console.log("raw archive written:", archivePath);

  const entry = {
    key,
    schemaVersion: CACHE_SCHEMA_VERSION,
    sellerId: SELLER_ID,
    sourceName: SOURCE_NAME,
    source: { id: source.id, name: source.name, tableName: source.tableName, type: source.type },
    exportId: created.id,
    from: null,
    to: null,
    columns,
    all: true,
    page: null,
    pageSize: null,
    retrievedAt: new Date().toISOString(),
    status: "COMPLETED",
    rowCount: raw.rows.length,
    rows: raw.rows,
  };
  await writeCache(key, entry);
  console.log("cache written:", key, "rows:", entry.rowCount);
  console.log("DONE");
})().catch((e) => { console.error("ERROR:", e && e.message ? e.message : e); process.exit(1); });
