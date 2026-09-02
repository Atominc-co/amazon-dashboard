// Offline regression suite for the DataDoe historical-cache + coverage + calendar-boundary system
// (src/services/datadoe/*.ts and their integration in src/services/amazon-catalog.service.ts and
// src/controllers/sellers.controller.ts). Runs against the COMPILED output in dist/, so `npm test`
// builds first. Everything is offline: a throwaway temp cache dir, an UNREACHABLE DataDoe host as a
// backstop, and — for the integration cases — a monkey-patched fake DataDoe exports client so we can
// count exactly how many exports ("tokens") each scenario would spend and control the rows returned.
// The TS `import { x } from "./exports.client"` compiles to a property read on the required module
// object at call time, so replacing that object's functions here is picked up by the service under
// test. Seed rows are obviously-synthetic, used only to exercise mechanics, and the temp dir is
// deleted at the end. No network, no tokens, fully offline.
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = path.join(os.tmpdir(), "dd-cache-test-" + process.pid);
process.env.DATADOE_CACHE_DIR = TMP;
process.env.DATADOE_API_BASE_URL = "http://127.0.0.1:59999"; // nothing listening -> ECONNREFUSED
process.env.DATADOE_API_KEY = "dummy_test_key_not_real";
process.env.DATADOE_CACHE_TTL_MS = "3600000";

const cache = require("../dist/services/datadoe/datadoe.cache");
const coverage = require("../dist/services/datadoe/datadoe.coverage");
const history = require("../dist/services/datadoe/datadoe.history");
const dates = require("../dist/services/datadoe/datadoe.dates");
const retry = require("../dist/services/datadoe/datadoe.retry-fetch");
const exportsClient = require("../dist/services/datadoe/datadoe.exports.client");
const clientMod = require("../dist/services/datadoe/datadoe.client");
const svc = require("../dist/services/amazon-catalog.service");
const controller = require("../dist/controllers/sellers.controller");

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log("  PASS: " + msg); } else { fail++; console.log("  FAIL: " + msg); } }

// ---- Fake DataDoe exports client -----------------------------------------------------------
const SALES = "Sales & Traffic by ASIN & Date";
const PRODUCTS = "Product Catalog by ASIN";
let ddExports = 0; // counts createExport = one export = one token spent
let lastBody = null;
let rowVersion = 1; // lets a re-fetch of the same dates return DIFFERENT values (refresh semantics)
let createExportImpl = null; // when set, overrides createExport (e.g. to simulate a failure)

const FAKE_SOURCES = {
  sources: [
    { id: "src-sales", name: SALES, tableName: "t_sales", type: "SELLER_CENTRAL",
      columns: [{ name: "date" }, { name: "child_asin" }, { name: "total_sales" }] },
    { id: "src-prod", name: PRODUCTS, tableName: "t_prod", type: "SELLER_CENTRAL",
      columns: [{ name: "asin" }, { name: "name" }] },
  ],
  recommendedSources: [],
};

function eachDate(from, to, cb) {
  let d = dates.parseIsoDate(from);
  const end = dates.parseIsoDate(to);
  while (d <= end) { cb(dates.formatDate(d)); d = dates.addDays(d, 1); }
}

exportsClient.getExportSources = async () => FAKE_SOURCES; // non-token lookup
exportsClient.createExport = async (body) => {
  if (createExportImpl) return createExportImpl(body);
  ddExports++;
  lastBody = body;
  return { id: "exp-" + ddExports, organizationId: "o", sellerOrVendorIds: body.sellerOrVendorIds, status: "COMPLETED", sourceId: body.sourceId, sourceName: "x" };
};
exportsClient.getExportStatus = async (id) => ({ id, organizationId: "o", sellerOrVendorIds: [], status: "COMPLETED", sourceId: "", sourceName: "x" });
exportsClient.fetchExportRawData = async () => {
  const rows = [];
  if (lastBody.sourceId === "src-sales") {
    eachDate(lastBody.from, lastBody.to, (d) => rows.push({ date: d, child_asin: "A1", total_sales: rowVersion }));
  } else {
    rows.push({ asin: "A1", name: "Prod" });
  }
  return { state: "ready", rows };
};

function resetAll() {
  cache.__resetMemory();
  coverage.__resetCoverageMemory();
  ddExports = 0; rowVersion = 1; createExportImpl = null;
}
function sumSales(rows) { return rows.reduce((s, r) => s + (typeof r.total_sales === "number" ? r.total_sales : 0), 0); }

(async () => {
  // =========================================================================================
  console.log("[A] exact-key cache module: keys, disk, corrupt/missing, freshness, dedup");
  const k1 = cache.computeCacheKey({ sellerId: "S", sourceName: "Src", from: "2026-08-01", to: "2026-08-07", all: true });
  const k2 = cache.computeCacheKey({ sellerId: "S", sourceName: "Src", from: "2026-08-01", to: "2026-08-07", all: true });
  const k3 = cache.computeCacheKey({ sellerId: "S", sourceName: "Src", from: "2026-08-01", to: "2026-08-08", all: true });
  assert(k1 === k2, "identical params -> identical key");
  assert(k1 !== k3, "different date range -> different key");
  const baseEntry = { key: k1, schemaVersion: 1, sellerId: "S", sourceName: "Src", source: { id: "x", name: "Src", tableName: "t", type: "SELLER_CENTRAL" }, exportId: "exp-1", from: "2026-08-01", to: "2026-08-07", columns: ["date", "total_sales"], all: true, page: null, pageSize: null, retrievedAt: new Date().toISOString(), status: "COMPLETED", rowCount: 1, rows: [{ date: "2026-08-01", total_sales: 10 }] };
  await cache.writeCache(k1, baseEntry);
  cache.__resetMemory();
  const rd = await cache.readCache(k1);
  assert(rd && rd.rows[0].total_sales === 10, "[18a] exact-key survives memory reset (disk-backed)");
  const corruptKey = "corrupt0000000000000000000000000000000000";
  fs.writeFileSync(path.join(TMP, corruptKey + ".json"), "{ not valid json ");
  cache.__resetMemory();
  assert((await cache.readCache(corruptKey)) === null, "[6a] corrupt exact-key file -> null (miss), never throws");
  assert((await cache.readCache("missing00000000000000000000000000000000")) === null, "[7a] missing exact-key file -> null (miss)");
  assert(cache.classifyAge(new Date().toISOString()) === "cached", "recent -> cached");
  assert(cache.classifyAge(new Date(Date.now() - 2 * 3600 * 1000).toISOString()) === "stale", "beyond TTL -> stale");
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { ...baseEntry, key: "dk", exportId: "dedup" }; };
  const [da, db] = await Promise.all([cache.fetchWithDedup("dk", fetcher), cache.fetchWithDedup("dk", fetcher)]);
  assert(calls === 1 && da.exportId === db.exportId, "in-flight de-dup: two concurrent identical -> one fetch");

  // =========================================================================================
  console.log("[B] coverage interval math (pure)");
  const cov = [{ from: "2026-08-10", to: "2026-08-20" }];
  assert(coverage.isFullyCovered("2026-08-12", "2026-08-18", cov), "[2] sub-range inside coverage -> fully covered");
  assert(coverage.isFullyCovered("2026-08-10", "2026-08-20", cov), "[2] exact coverage match -> fully covered");
  assert(!coverage.isFullyCovered("2026-08-05", "2026-08-15", cov), "[3] range extending before coverage -> NOT fully covered");
  const miss = coverage.missingIntervals("2026-08-05", "2026-08-25", cov);
  assert(miss.length === 2 && miss[0].from === "2026-08-05" && miss[0].to === "2026-08-09" && miss[1].from === "2026-08-21" && miss[1].to === "2026-08-25", "[3] missing intervals computed on both sides, disjoint from coverage");
  const coal = coverage.coalesceIntervals([{ from: "2026-08-10", to: "2026-08-20" }, { from: "2026-08-21", to: "2026-08-25" }, { from: "2026-08-01", to: "2026-08-03" }]);
  assert(coal.length === 2 && coal[0].from === "2026-08-01" && coal[1].to === "2026-08-25", "[4] adjacent intervals coalesce (Aug10-20 + Aug21-25 -> Aug10-25)");
  const rows = [{ date: "2026-08-10", total_sales: 1 }, { date: "2026-08-15", total_sales: 2 }, { date: "2026-08-25", total_sales: 3 }];
  assert(coverage.filterRowsInRange(rows, "2026-08-14", "2026-08-20", "date").length === 1, "filterRowsInRange keeps only in-window rows");
  const merged = coverage.mergeRowsForInterval(rows, [{ date: "2026-08-15", total_sales: 99 }], "2026-08-14", "2026-08-16", "date");
  assert(merged.length === 3 && merged.find((r) => r.date === "2026-08-15").total_sales === 99, "[5] merge REPLACES rows in the fetched interval (no duplicate row, value updated)");

  // =========================================================================================
  console.log("[C] history boundary (calendar min/max)");
  const b = history.dashboardHistoryBoundary();
  assert(b.latest === dates.todayIso(), "[12] latest selectable = today");
  assert(b.maxHistoryDays === history.AMAZON_TWO_YEAR_DAYS, "[12] effective history = documented 2-year floor");
  assert(b.earliest === dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -730)), "[12] earliest = today - 730 days");
  assert(history.isHistoricalSource(SALES) === true && history.isHistoricalSource(PRODUCTS) === false, "date-windowed vs snapshot sources classified");

  // =========================================================================================
  console.log("[D] date semantics: Today / MTD / 7d / 30d / Custom (computeWindow, pure)");
  const today = dates.todayIso();
  const wToday = controller.computeWindow("Today");
  assert(wToday.ok && wToday.window.from === today && wToday.window.to === today, "[13] Today -> from==to==actual current calendar day");
  const wMtd = controller.computeWindow("MTD");
  const firstOfMonth = today.slice(0, 8) + "01";
  assert(wMtd.ok && wMtd.window.from === firstOfMonth && wMtd.window.to === today, "[14] MTD -> first-of-month .. today");
  const w7 = controller.computeWindow("7d");
  assert(w7.ok && w7.window.from === dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -6)) && w7.window.windowDays === 7, "7d -> today-6 .. today (7 days)");
  const w30 = controller.computeWindow("30d");
  assert(w30.ok && w30.window.windowDays === 30, "30d -> 30-day window");
  const cFrom = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -100));
  const cTo = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -80));
  const wCustom = controller.computeWindow("Custom", cFrom, cTo);
  assert(wCustom.ok && wCustom.window.from === cFrom && wCustom.window.to === cTo && wCustom.window.windowDays === 21, "Custom valid range -> resolved window with correct length");
  assert(wCustom.window.prev && dates.daysBetweenIso(wCustom.window.prev.from, wCustom.window.prev.to) === 20, "Custom -> immediately-preceding comparison window of equal length");
  const tooOld = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -800));
  assert(controller.computeWindow("Custom", tooOld, cTo).ok === false, "[11][12] Custom before boundary -> rejected (ok:false)");
  assert(controller.computeWindow("Custom", cTo, cFrom).ok === false, "Custom reversed (from>to) -> rejected");
  const future = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), 5));
  assert(controller.computeWindow("Custom", cFrom, future).ok === false, "Custom future end date -> rejected");

  // =========================================================================================
  // Deterministic calendar-correctness for the edge cases the calendar must handle regardless of
  // when the suite runs (the today-relative asserts above can't pin these to specific dates):
  // leap day, non-leap Feb, 30/31-day month ends, and year boundaries. Exercises the pure LOCAL-
  // calendar helpers (parseIsoDate/addDays/formatDate/daysBetweenIso) that back every range.
  console.log("[D2] calendar edge cases: leap year / month-end / year boundary (pure, deterministic)");
  assert(dates.isValidIsoDate("2024-02-29") === true, "2024-02-29 is a valid leap day");
  assert(dates.isValidIsoDate("2025-02-29") === false, "2025-02-29 rejected (2025 not a leap year)");
  assert(dates.isValidIsoDate("2100-02-29") === false, "2100-02-29 rejected (century non-leap year)");
  assert(dates.isValidIsoDate("2000-02-29") === true, "2000-02-29 valid (400-divisible leap year)");
  assert(dates.isValidIsoDate("2025-04-31") === false, "2025-04-31 rejected (April has 30 days)");
  assert(dates.isValidIsoDate("2025-13-01") === false, "2025-13-01 rejected (no month 13)");
  assert(dates.isValidIsoDate("2025-00-10") === false, "2025-00-10 rejected (no month 0)");
  // addDays crosses Feb 28 -> 29 in a leap year, and the non-leap year skips straight to Mar 1.
  assert(dates.formatDate(dates.addDays(dates.parseIsoDate("2024-02-28"), 1)) === "2024-02-29", "addDays across leap-day: 2024-02-28 +1 -> 2024-02-29");
  assert(dates.formatDate(dates.addDays(dates.parseIsoDate("2024-02-29"), 1)) === "2024-03-01", "addDays off leap-day: 2024-02-29 +1 -> 2024-03-01");
  assert(dates.formatDate(dates.addDays(dates.parseIsoDate("2025-02-28"), 1)) === "2025-03-01", "addDays non-leap Feb-end: 2025-02-28 +1 -> 2025-03-01");
  // 30- and 31-day month ends.
  assert(dates.formatDate(dates.addDays(dates.parseIsoDate("2025-04-30"), 1)) === "2025-05-01", "addDays 30-day month-end: 2025-04-30 +1 -> 2025-05-01");
  assert(dates.formatDate(dates.addDays(dates.parseIsoDate("2025-01-31"), 1)) === "2025-02-01", "addDays 31-day month-end: 2025-01-31 +1 -> 2025-02-01");
  // Year boundary in both directions.
  assert(dates.formatDate(dates.addDays(dates.parseIsoDate("2025-12-31"), 1)) === "2026-01-01", "addDays year boundary fwd: 2025-12-31 +1 -> 2026-01-01");
  assert(dates.formatDate(dates.addDays(dates.parseIsoDate("2026-01-01"), -1)) === "2025-12-31", "addDays year boundary back: 2026-01-01 -1 -> 2025-12-31");
  // Inclusive day-count spans a leap year correctly (2024 has 366 days).
  assert(dates.daysBetweenIso("2024-01-01", "2024-12-31") === 365, "daysBetweenIso spans leap year 2024 (365 diff = 366 inclusive days)");
  assert(dates.daysBetweenIso("2025-01-01", "2025-12-31") === 364, "daysBetweenIso spans non-leap 2025 (364 diff = 365 inclusive days)");

  // =========================================================================================
  console.log("[E] STRICT-LOCAL + FULL-WINDOW Sync: normal read never fetches; ONE Sync covers every in-boundary range");
  resetAll();
  const seller = "SELLER-COV";
  const d30from = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -29));
  const d7from = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -6));
  const d400from = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -399));
  const fullFrom = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -730)); // max-history boundary

  // 1. Normal (non-Sync) read on an EMPTY cache -> NotSynchronized, ZERO exports (no silent DataDoe).
  let ns1 = null;
  try { await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: d30from, to: today }); } catch (e) { ns1 = e; }
  assert(ns1 && ns1.name === "RangeNotSynchronizedError" && ddExports === 0, "normal read on empty cache -> NotSynchronized, ZERO exports (never auto-fetches)");
  assert(ns1.missing.length === 1 && ns1.missing[0].from === d30from && ns1.missing[0].to === today, "NotSynchronized lists the whole requested range as the missing interval");

  // 2. Sync while viewing 30d -> fetches the FULL max-history (730d) window in ONE export; returns the 30d slice.
  const synced30 = await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: d30from, to: today, refresh: true });
  assert(ddExports === 1, "[1] Sync fetches the FULL supported window in exactly ONE export (single contiguous gap)");
  assert(synced30.cache.status === "fresh" && sumSales(synced30.rows) === 30, "[2] Sync returns the displayed 30d slice (30 rows) from the fuller cache");
  assert(lastBody.from === fullFrom && lastBody.to === today, "Sync export targeted the FULL max-history window (today-730 .. today), not just the displayed 30d");
  const covFull = await coverage.readCoverage(coverage.computeDatasetKey({ sellerId: seller, sourceName: SALES }));
  assert(covFull.intervals.length === 1 && covFull.rows.length === 731, "[4] Sync populated the FULL 730-day window (731 daily rows) in ONE interval");

  // 3. DATE CHANGE to 7d on a NORMAL read -> served from local cache, ZERO exports.
  const sub = await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: d7from, to: today });
  assert(ddExports === 1 && sub.cache.status === "cached" && sumSales(sub.rows) === 7, "[19] date change to 7d -> ZERO exports, served from local cache");

  // 4. DATE CHANGE to a WIDE 400-day custom range -> ALSO served from cache, ZERO exports (one Sync covered it).
  const r400 = await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: d400from, to: today });
  assert(ddExports === 1 && sumSales(r400.rows) === 400, "[3][19] ANY in-boundary range (400d) is a cache hit after ONE Sync -> ZERO exports");

  // 5. BROWSER RELOAD (30d) on a normal read -> ZERO exports.
  await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: d30from, to: today });
  assert(ddExports === 1, "reload of a covered range -> ZERO exports");

  // 6. Incremental Sync (window already full) -> re-fetches ONLY the recent mutable window (1 export), no history re-download.
  rowVersion = 9;
  const before6 = ddExports;
  const inc = await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: d7from, to: today, refresh: true });
  assert(ddExports === before6 + 1, "[20] incremental Sync of a fully-covered window re-fetches ONLY the recent mutable window (1 export)");
  assert(sumSales(inc.rows) === 4 * 1 + 3 * 9, "[5][20] only recent dates refreshed in place; older history preserved (no duplicates, no re-download)");
  const covAfter = await coverage.readCoverage(coverage.computeDatasetKey({ sellerId: seller, sourceName: SALES }));
  assert(covAfter.rows.length === 731, "[5] coverage still 731 rows after incremental refresh (in-place replace, no duplication)");

  // =========================================================================================
  console.log("[F] failed Sync preserves coverage; unsupported range never fetches; coverage report");
  createExportImpl = () => { throw new clientMod.DataDoeApiError(402, "Payment Required (no tokens)", "req-1"); };
  const failResult = await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: d7from, to: today, refresh: true });
  assert(failResult.cache.status === "stale", "[8] failed Sync -> served STALE from existing coverage (not erased)");
  assert(sumSales(failResult.rows) === 4 * 1 + 3 * 9, "[8] preserved coverage rows intact after failed Sync (not zeroed, not fabricated)");
  createExportImpl = null;

  const exportsBefore = ddExports;
  let rangeErr = null;
  try {
    await svc.getSellerSourceData({ sellerId: seller, sourceName: SALES, all: true, from: tooOld, to: today });
  } catch (e) { rangeErr = e; }
  assert(rangeErr && rangeErr.name === "RangeUnavailableError", "[11][12] range before the 730-day boundary -> RangeUnavailableError");
  assert(ddExports === exportsBefore, "[11] unsupported range made ZERO DataDoe export calls");

  // token-free local coverage report reflects the actual synced window (full 730-day window after Sync).
  const storedCov = await svc.getStoredCoverage(seller);
  assert(storedCov.earliest === fullFrom && storedCov.latest === today, "getStoredCoverage reports the full synced window earliest/latest (token-free)");

  // [F2] "Synced locally" must report ACTUAL returned-row coverage, NOT the queried interval.
  // Regression for the calendar display defect: a dataset queried across a wide span but holding
  // rows only for a narrow slice must report the narrow slice; a dataset whose rows carry no date
  // must report null (excluded from the synced range) rather than inflating it to the queried span.
  coverage.__resetCoverageMemory();
  const covSeller = "SELLER-DISPLAY";
  const widerInterval = [{ from: "2024-08-28", to: "2026-08-28" }];
  const narrowKey = coverage.computeDatasetKey({ sellerId: covSeller, sourceName: SALES, columns: ["date", "total_sales"] });
  await coverage.writeCoverage(narrowKey, {
    datasetKey: narrowKey, schemaVersion: coverage.COVERAGE_SCHEMA_VERSION, sellerId: covSeller,
    sourceName: SALES, source: null, columns: ["date", "total_sales"], dateField: "date",
    intervals: widerInterval, // queried span claims 2 years...
    rows: [{ date: "2026-07-20", total_sales: 1 }, { date: "2026-08-24", total_sales: 2 }], // ...but rows only cover a recent slice
    fetchedAt: new Date().toISOString(), lastExportId: "e",
  });
  const datelessKey = coverage.computeDatasetKey({ sellerId: covSeller, sourceName: "Profit by SKU & Date", columns: ["child_asin"] });
  await coverage.writeCoverage(datelessKey, {
    datasetKey: datelessKey, schemaVersion: coverage.COVERAGE_SCHEMA_VERSION, sellerId: covSeller,
    sourceName: "Profit by SKU & Date", source: null, columns: ["child_asin"], dateField: "date",
    intervals: widerInterval, rows: [{ child_asin: "A1" }, { child_asin: "A2" }], // rows have NO date field
    fetchedAt: new Date().toISOString(), lastExportId: "e",
  });
  const displayCov = await svc.getStoredCoverage(covSeller);
  assert(displayCov.earliest === "2026-07-20" && displayCov.latest === "2026-08-24", "[F2] Synced-locally reports ACTUAL row slice (2026-07-20..2026-08-24), not the queried 2-year span");
  const salesSummary = displayCov.sources.find((s) => s.sourceName === SALES);
  assert(salesSummary && salesSummary.intervals[0].from === "2024-08-28", "[F2] queried interval (2024-08-28..) still preserved separately for distinction");
  const skuSummary = displayCov.sources.find((s) => s.sourceName === "Profit by SKU & Date");
  assert(skuSummary && skuSummary.earliest === null && skuSummary.latest === null && skuSummary.rowCount === 2, "[F2] dateless rows -> null actual coverage (excluded from synced range), rowCount still reported");
  coverage.__resetCoverageMemory();

  // =========================================================================================
  console.log("[J] getViaCoverage records ACTUAL row-date bounds, not the requested/exported window");
  // Regression for the false-superset-coverage defect: DataDoe can (and does, on real accounts)
  // return rows for a narrower span than the requested/exported [from,to] window — e.g. a Sync
  // asks for the full 730-day boundary but the account's real history starts much later. Coverage
  // must be trimmed to what the returned rows actually prove, never the requested window.

  // [J-A] Sync requests the full 730-day window; DataDoe returns rows for a much narrower slice.
  resetAll();
  const sellerJA = "SELLER-ROWBOUND-A";
  const narrowFrom = "2026-07-20", narrowTo = "2026-08-24";
  const savedFetchRawA = exportsClient.fetchExportRawData;
  exportsClient.fetchExportRawData = async () => ({
    state: "ready",
    rows: [
      { date: narrowFrom, child_asin: "A1", total_sales: 1 },
      { date: narrowTo, child_asin: "A1", total_sales: 2 },
    ],
  });
  await svc.getSellerSourceData({ sellerId: sellerJA, sourceName: SALES, all: true, from: d30from, to: today, refresh: true });
  assert(ddExports === 1, "[J-A] Sync makes exactly ONE export for the requested/full window");
  const covJA = await coverage.readCoverage(coverage.computeDatasetKey({ sellerId: sellerJA, sourceName: SALES }));
  assert(
    covJA.intervals.length === 1 && covJA.intervals[0].from === narrowFrom && covJA.intervals[0].to === narrowTo,
    "[J-A] coverage interval reflects ACTUAL row dates (" + narrowFrom + ".." + narrowTo + "), NOT the requested/exported window (" + fullFrom + ".." + today + ")"
  );
  exportsClient.fetchExportRawData = savedFetchRawA;
  // HYBRID rule — TRAILING gap: a range whose START is covered but which extends PAST the latest
  // cached date is served for the covered portion (real rows only) + partial flag; the uncached
  // tail is reported as missing, never fabricated as zero rows.
  const partJA = await svc.getSellerSourceData({ sellerId: sellerJA, sourceName: SALES, all: true, from: d30from, to: today });
  assert(
    partJA.coverage && partJA.coverage.partial === true,
    "[J-A] a range extending past the proven row dates is served as PARTIAL coverage, not hidden"
  );
  assert(
    partJA.coverage.covered.length === 1 && partJA.coverage.covered[0].from === d30from && partJA.coverage.covered[0].to === narrowTo,
    "[J-A] covered portion is the real slice inside the requested range (" + d30from + ".." + narrowTo + ")"
  );
  assert(
    partJA.coverage.missing.length === 1 && partJA.coverage.missing[0].from > narrowTo && partJA.coverage.missing[0].to === today,
    "[J-A] missing portion is the uncached tail (after " + narrowTo + " through " + today + ")"
  );
  assert(
    partJA.rows.every((r) => r.date >= d30from && r.date <= narrowTo) && sumSales(partJA.rows) === 2,
    "[J-A] only REAL rows inside the covered portion are served — no fabricated zero rows for the missing dates"
  );
  // REVERSED 2026-09-01 (user-authorized): a range whose START is BEFORE the earliest cached date
  // is now served for whatever real covered portion exists inside the requested range (never
  // fabricating the missing head) with an explicit partial flag — matching the trailing-gap rule
  // instead of blacking out the whole range.
  const leadJA = await svc.getSellerSourceData({ sellerId: sellerJA, sourceName: SALES, all: true, from: "2026-07-10", to: "2026-08-01" });
  assert(leadJA.coverage && leadJA.coverage.partial === true, "[J-A] a leading gap is now served as PARTIAL coverage, not blacked out");
  assert(
    leadJA.coverage.covered.length === 1 && leadJA.coverage.covered[0].from === narrowFrom && leadJA.coverage.covered[0].to === "2026-08-01",
    "[J-A] covered portion is the real slice inside the requested range (" + narrowFrom + "..2026-08-01)"
  );
  assert(
    leadJA.coverage.missing.length === 1 && leadJA.coverage.missing[0].from === "2026-07-10" && leadJA.coverage.missing[0].to === "2026-07-19",
    "[J-A] leading-gap missing head interval is exactly [requested-from .. day-before-earliest-cached]"
  );
  assert(
    leadJA.rows.every((r) => r.date >= narrowFrom && r.date <= "2026-08-01") && sumSales(leadJA.rows) === 1,
    "[J-A] only REAL rows inside the covered portion are served for a leading gap — no fabricated zero rows for the missing head"
  );
  // A range with NO overlap at all (entirely past the proven rows) is still honestly not-synchronized.
  let nsJA = null;
  try { await svc.getSellerSourceData({ sellerId: sellerJA, sourceName: SALES, all: true, from: "2026-08-25", to: today }); } catch (e) { nsJA = e; }
  assert(nsJA && nsJA.name === "RangeNotSynchronizedError", "[J-A] a range with NO cached overlap is honestly not-synchronized, never a fabricated zero");
  // A range fully inside the proven row bounds IS a genuine cache hit.
  const insideJA = await svc.getSellerSourceData({ sellerId: sellerJA, sourceName: SALES, all: true, from: narrowFrom, to: narrowTo });
  assert(insideJA.cache.status === "cached" && sumSales(insideJA.rows) === 3, "[J-A] a range fully inside the proven row dates is served from cache normally");
  assert(insideJA.coverage && insideJA.coverage.partial === false, "[J-A] a fully-covered range reports non-partial coverage");

  // [J-B] DataDoe returns ZERO dated rows -> no coverage interval is recorded at all.
  resetAll();
  const sellerJB = "SELLER-ROWBOUND-B";
  const savedFetchRawB = exportsClient.fetchExportRawData;
  exportsClient.fetchExportRawData = async () => ({ state: "ready", rows: [] });
  const syncedJB = await svc.getSellerSourceData({ sellerId: sellerJB, sourceName: SALES, all: true, from: d30from, to: today, refresh: true });
  assert(ddExports === 1 && syncedJB.rows.length === 0, "[J-B] Sync still makes one export; zero rows returned, none fabricated");
  const covJB = await coverage.readCoverage(coverage.computeDatasetKey({ sellerId: sellerJB, sourceName: SALES }));
  assert(covJB && covJB.intervals.length === 0, "[J-B] zero dated rows -> NO coverage interval recorded");
  exportsClient.fetchExportRawData = savedFetchRawB;
  let nsJB = null;
  try { await svc.getSellerSourceData({ sellerId: sellerJB, sourceName: SALES, all: true, from: d30from, to: today }); } catch (e) { nsJB = e; }
  assert(nsJB && nsJB.name === "RangeNotSynchronizedError", "[J-B] subsequent normal read for the still-uncovered range stays honestly not-synchronized");

  // [J-C] Mirrors the real persisted "Profit by SKU & Date" cache: requested the full 730-day
  // window, DataDoe actually returns rows only from well inside it through today.
  resetAll();
  const sellerJC = "SELLER-ROWBOUND-C";
  const realWorldFrom = dates.formatDate(dates.addDays(dates.todayLocalMidnight(), -400)); // real data starts later than the 730d boundary
  const savedFetchRawC = exportsClient.fetchExportRawData;
  exportsClient.fetchExportRawData = async () => ({
    state: "ready",
    rows: [
      { date: realWorldFrom, child_asin: "A1", total_sales: 1 },
      { date: today, child_asin: "A1", total_sales: 2 },
    ],
  });
  await svc.getSellerSourceData({ sellerId: sellerJC, sourceName: SALES, all: true, from: d30from, to: today, refresh: true });
  exportsClient.fetchExportRawData = savedFetchRawC;
  const covJC = await coverage.readCoverage(coverage.computeDatasetKey({ sellerId: sellerJC, sourceName: SALES }));
  assert(
    covJC.intervals.length === 1 && covJC.intervals[0].from === realWorldFrom && covJC.intervals[0].to === today,
    "[J-C] real-world-shaped case: coverage earliest reflects the actual earliest row date (" + realWorldFrom + "), NOT the claimed " + fullFrom + " (730d) boundary"
  );
  assert(covJC.intervals[0].from !== fullFrom, "[J-C] coverage no longer falsely claims the full 730-day boundary as covered");

  // =========================================================================================
  console.log("[G] exact-key path: hit -> 0 exports; normal miss -> NotSynchronized; Sync miss+402 -> honest 402");
  resetAll();
  // pre-seed an exact-key entry for products; a NORMAL read hits it -> zero exports.
  const prodKey = cache.computeCacheKey({ sellerId: "SP", sourceName: PRODUCTS, columns: undefined, from: undefined, to: undefined, all: false, page: 1, pageSize: 100 });
  await cache.writeCache(prodKey, { key: prodKey, schemaVersion: 1, sellerId: "SP", sourceName: PRODUCTS, source: { id: "src-prod", name: PRODUCTS, tableName: "t_prod", type: "SELLER_CENTRAL" }, exportId: "e", from: null, to: null, columns: ["asin"], all: false, page: 1, pageSize: 100, retrievedAt: new Date().toISOString(), status: "COMPLETED", rowCount: 1, rows: [{ asin: "A1", name: "Prod" }] });
  const prodHit = await svc.getSellerSourceData({ sellerId: "SP", sourceName: PRODUCTS });
  assert(ddExports === 0 && prodHit.cache.status === "cached", "[1] exact-key hit (products) -> zero exports, served cached");

  // NORMAL read miss on a snapshot source -> NotSynchronized, ZERO exports (no auto-fetch here either).
  let nsProd = null;
  try { await svc.getSellerSourceData({ sellerId: "NOCACHE", sourceName: PRODUCTS }); } catch (e) { nsProd = e; }
  assert(nsProd && nsProd.name === "RangeNotSynchronizedError" && ddExports === 0, "normal read miss on snapshot source -> NotSynchronized, ZERO exports");

  // Rolling-window SNAPSHOT fallback: a point-in-time source (non-historical) seeded for one recent
  // window must still serve those real cached rows when the request window rolls forward (e.g. "today"
  // advances) — instead of falsely reporting not-synchronized. Zero exports; no fabrication.
  const INVENTORY = "FBA Inventory by ASIN & Country";
  const invKey = cache.computeCacheKey({ sellerId: "SNAP", sourceName: INVENTORY, columns: undefined, from: "2026-08-25", to: "2026-08-28", all: false, page: 1, pageSize: 500 });
  await cache.writeCache(invKey, { key: invKey, schemaVersion: 1, sellerId: "SNAP", sourceName: INVENTORY, source: { id: "src-inv", name: INVENTORY, tableName: "t_inv", type: "SELLER_CENTRAL" }, exportId: "e", from: "2026-08-25", to: "2026-08-28", columns: ["child_asin", "date", "quantity_for_local_fulfillment"], all: false, page: 1, pageSize: 500, retrievedAt: new Date().toISOString(), status: "COMPLETED", rowCount: 2, rows: [{ child_asin: "A1", date: "2026-08-28", quantity_for_local_fulfillment: 5 }, { child_asin: "A2", date: "2026-08-28", quantity_for_local_fulfillment: 7 }] });
  const invRoll = await svc.getSellerSourceData({ sellerId: "SNAP", sourceName: INVENTORY, from: "2026-08-26", to: "2026-08-29", pageSize: 500 });
  assert(ddExports === 0 && invRoll.rows.length === 2 && invRoll.rows[0].child_asin === "A1", "[SNAP] rolling-window snapshot miss serves the freshest cached snapshot (real rows), ZERO exports");
  // A snapshot source with NO cached entry at all still honestly reports not-synchronized.
  let nsSnap = null;
  try { await svc.getSellerSourceData({ sellerId: "NOSNAP", sourceName: INVENTORY, from: "2026-08-26", to: "2026-08-29", pageSize: 500 }); } catch (e) { nsSnap = e; }
  assert(nsSnap && nsSnap.name === "RangeNotSynchronizedError", "[SNAP] a snapshot source with no cache at all is honestly not-synchronized (no fabrication)");

  // Sync (refresh) of a genuine miss that 402s -> propagates honest 402 (never zero, never fabricated).
  createExportImpl = () => { throw new clientMod.DataDoeApiError(402, "Payment Required", "req-x"); };
  let unavailErr = null;
  try { await svc.getSellerSourceData({ sellerId: "NOCACHE", sourceName: PRODUCTS, refresh: true }); } catch (e) { unavailErr = e; }
  assert(unavailErr instanceof clientMod.DataDoeApiError && unavailErr.status === 402, "[9] Sync on a genuine miss that 402s -> propagates honest 402 (never zero)");
  createExportImpl = null;

  // =========================================================================================
  console.log("[H] 429 bounded retry; non-429 not retried (retry-fetch unit)");
  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; return new Response("", { status: 429, headers: { "retry-after": "0" } }); };
  const r429 = await retry.datadoeFetch("http://x/");
  assert(r429.status === 429, "[10] persistent 429 returns the 429 (does not hang / infinite loop)");
  assert(fetchCalls === 4, "[10] 429 retried a BOUNDED number of times (1 initial + 3 retries = 4)");
  fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; return new Response("", { status: 402 }); };
  const r402 = await retry.datadoeFetch("http://x/");
  assert(r402.status === 402 && fetchCalls === 1, "[10] non-429 (402) returned immediately, NOT retried");
  global.fetch = realFetch;

  // =========================================================================================
  console.log("[I] restart survival + no credentials in cache + rapid-switch serialization");
  // [18] coverage survives a process restart (disk-backed): reset memory, read back.
  coverage.__resetCoverageMemory();
  const restart = await coverage.readCoverage(coverage.computeDatasetKey({ sellerId: seller, sourceName: SALES }));
  assert(restart && restart.rows.length > 0, "[18] coverage entry re-read from disk after memory reset (survives restart)");

  // [17] no credentials anywhere in any persisted cache file.
  let leaked = false;
  for (const f of fs.readdirSync(TMP)) {
    const contents = fs.readFileSync(path.join(TMP, f), "utf8");
    if (contents.indexOf(process.env.DATADOE_API_KEY) !== -1) leaked = true;
  }
  assert(!leaked, "[17] no cache/coverage file contains the DATADOE_API_KEY");

  // [15][16][19] After ONE Sync, rapid concurrent date switching on the SAME covered dataset makes
  // ZERO further exports — every switch is served from local cache and the final state is consistent.
  resetAll();
  const s2 = "SELLER-RAPID";
  await svc.getSellerSourceData({ sellerId: s2, sourceName: SALES, all: true, from: d30from, to: today, refresh: true });
  const afterSync = ddExports; // exactly 1 (single Sync populated 30d)
  const [rToday, r7, r30] = await Promise.all([
    svc.getSellerSourceData({ sellerId: s2, sourceName: SALES, all: true, from: today, to: today }),
    svc.getSellerSourceData({ sellerId: s2, sourceName: SALES, all: true, from: d7from, to: today }),
    svc.getSellerSourceData({ sellerId: s2, sourceName: SALES, all: true, from: d30from, to: today }),
  ]);
  assert(afterSync === 1 && ddExports === afterSync, "[15][16][19] rapid concurrent date switches on a covered dataset -> ZERO further exports");
  assert(sumSales(rToday.rows) === 1 && sumSales(r7.rows) === 7 && sumSales(r30.rows) === 30, "[15] each concurrent caller gets correct, range-appropriate rows from local cache");

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST CRASH", e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
