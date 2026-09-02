/*
 * Generic targeted, minimal export+merge for ONE source + ONE date range (seller Vertex trading UK).
 * Uses the PRODUCTION export primitives from dist/. Pre-flight asserts the datasetKey already exists
 * (columns/source match) BEFORE spending a token; archives the raw response immutably; merges
 * replace-by-interval into the EXISTING coverage cache (older rows preserved, [FROM..TO] replaced).
 * NO aggregation-logic change, NO hardcoded values, NO fabricated rows.
 *
 * Usage (env): SRC="Settlements & P&L Components" COLS='["date",...]' FROM=2026-08-29 TO=2026-08-31 node scripts/refresh-source.js
 * COLS omitted/empty => all-columns export (__ALL__ datasetKey).
 */
require("../dist/config/env");
const {
  getExportSources, createExport, getExportStatus, fetchExportRawData,
} = require("../dist/services/datadoe/datadoe.exports.client");
const { archiveRawExport } = require("../dist/services/datadoe/datadoe.raw-archive");
const {
  computeDatasetKey, readCoverage, writeCoverage, mergeRowsForInterval, coalesceIntervals,
} = require("../dist/services/datadoe/datadoe.coverage");

const SELLER_ID = "19076074-9461-4eb0-a762-5f27185f9e5b";
const SRC = process.env.SRC;
const COLS = process.env.COLS && process.env.COLS.trim() ? JSON.parse(process.env.COLS) : undefined;
const FROM = process.env.FROM;
const TO = process.env.TO;
if (!SRC || !FROM || !TO) { console.error("ABORT: need SRC, FROM, TO"); process.exit(9); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inRange = (r) => { const d = (r.date || "").slice(0,10); return d >= FROM && d <= TO; };

(async () => {
  const datasetKey = computeDatasetKey({ sellerId: SELLER_ID, sourceName: SRC, columns: COLS });
  console.log("SRC:", SRC, "| COLS:", COLS ? COLS.length + " cols" : "__ALL__", "| range:", FROM, "->", TO);
  console.log("datasetKey:", datasetKey);

  const existing = await readCoverage(datasetKey);
  if (!existing) { console.error("ABORT: no existing coverage for this datasetKey — mismatch. Not writing."); process.exit(2); }
  console.log("PRE  intervals:", JSON.stringify(existing.intervals), "rows:", existing.rows.length);
  const preInRange = existing.rows.filter(inRange).length;
  console.log("PRE  rows already in [" + FROM + ".." + TO + "]:", preInRange);

  const sourcesResp = await getExportSources([SELLER_ID]);
  const source = sourcesResp.sources.find((s) => s.name === SRC);
  if (!source) { console.error("ABORT: source not found:", SRC); process.exit(3); }
  console.log("source:", source.id, source.tableName, source.type);

  // All-columns (__ALL__ datasetKey) case: replicate the service — pass the source's FULL column
  // list to the export (createExport requires columns), while the datasetKey stays __ALL__.
  const exportColumns = COLS || (source.columns || []).map((c) => c.name);
  const exportReq = {
    sellerOrVendorIds: [SELLER_ID], sourceId: source.id, outputType: "JSON",
    sendToAllOrganizationMembers: false, from: FROM, to: TO, columns: exportColumns,
  };
  console.log("export columns:", exportColumns.length);

  const created = await createExport(exportReq); // THE token-spending call
  console.log("createExport id:", created.id, "status:", created.status);

  const deadline = Date.now() + 120000;
  let status = created.status;
  while (status === "PENDING" || status === "IN_PROGRESS") {
    if (Date.now() > deadline) { console.error("ABORT: status timeout"); process.exit(4); }
    await sleep(1000); status = (await getExportStatus(created.id)).status;
  }
  console.log("final status:", status);
  if (status !== "COMPLETED") { console.error("ABORT: not COMPLETED:", status); process.exit(5); }

  let raw = await fetchExportRawData(created.id);
  const rd = Date.now() + 120000;
  while (raw.state === "pending") { if (Date.now() > rd) { console.error("ABORT: raw timeout"); process.exit(6); } await sleep(1000); raw = await fetchExportRawData(created.id); }
  if (raw.state !== "ready") { console.error("ABORT: raw not ready:", raw.state); process.exit(7); }
  const freshInRange = raw.rows.filter(inRange).length;
  console.log("raw rows:", raw.rows.length, "| in-range:", freshInRange, "| bytes:", Buffer.byteLength(raw.raw, "utf8"));
  if (raw.rows.length) console.log("raw sample keys:", Object.keys(raw.rows[0]).slice(0, 25).join(","));

  const archivePath = await archiveRawExport({
    exportId: created.id, sellerId: SELLER_ID, sourceName: SRC, sourceId: source.id,
    columns: COLS || [], from: FROM, to: TO, status, rowCount: raw.rows.length,
    requestId: raw.requestId, rawPayload: raw.raw,
  });
  console.log("raw archive:", archivePath);

  const mergedRows = mergeRowsForInterval(existing.rows, raw.rows, FROM, TO, "date");
  const mergedIntervals = coalesceIntervals([...existing.intervals, { from: FROM, to: TO }]);
  const updated = {
    ...existing,
    source: { id: source.id, name: source.name, tableName: source.tableName, type: source.type },
    columns: COLS || existing.columns,
    dateField: existing.dateField || "date",
    intervals: mergedIntervals, rows: mergedRows,
    fetchedAt: new Date().toISOString(), lastExportId: created.id,
  };
  await writeCoverage(datasetKey, updated);
  console.log("POST intervals:", JSON.stringify(updated.intervals), "rows:", updated.rows.length);
  console.log("POST rows in [" + FROM + ".." + TO + "]:", updated.rows.filter(inRange).length);
  console.log("DONE", SRC);
})().catch((e) => { console.error("ERROR:", e && e.message ? e.message : e); process.exit(1); });
