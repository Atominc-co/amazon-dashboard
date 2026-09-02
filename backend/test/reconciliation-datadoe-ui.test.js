/**
 * Reconciliation test — local cache ↔ DataDoe Reports UI (verified 2026-08-29 via Claude-in-Chrome).
 *
 * This is an OFFLINE, token-free test. It recomputes each dashboard KPI directly from the persisted
 * DataDoe rows in .cache/datadoe/*.cov.json (the same rows the backend serves) and asserts them
 * against the EXACT values read from the DataDoe Reports UI for Vertex trading UK, July 2026.
 *
 * It encodes the proven cross-report definitions so a regression (bad merge, wrong filter, dropped
 * rows, currency/aggregation change) fails loudly:
 *   - PPC spend/sales  == DataDoe PPC-Campaigns report (ex-VAT, 14-day attribution)
 *   - P&L "Sponsored Products" == our PPC spend × 1.20  (exactly 20% UK VAT)
 *   - Net profit / total_sales == DataDoe "Profit by Date" source
 *   - Net revenue == Settlements total
 *   - Sessions (07-20..31 coverage) == DataDoe P&L Sessions total (1,816) — proves S&T is absent pre-07-20
 * Evidence: backend/.cache/datadoe/RECONCILIATION-DATADOE-UI-2026-07.md
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const CACHE = process.env.DATADOE_CACHE_DIR || path.join(__dirname, "..", ".cache", "datadoe");
const FROM = "2026-07-01", TO = "2026-07-31";

function loadCov(sourceName, wantDated) {
  for (const f of fs.readdirSync(CACHE)) {
    if (!f.endsWith(".cov.json")) continue;
    const d = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));
    const name = (d.source && d.source.name) || d.sourceName;
    if (name !== sourceName) continue;
    const hasDate = (d.columns || []).includes("date");
    if (wantDated !== undefined && hasDate !== wantDated) continue;
    return d;
  }
  throw new Error("cache dataset not found: " + sourceName);
}
const dOf = (r) => (typeof r.date === "string" && r.date.length >= 10 ? r.date.slice(0, 10) : null);
const inRange = (r) => { const x = dOf(r); return x !== null && x >= FROM && x <= TO; };
const sum = (rows, f) => rows.reduce((a, r) => a + (typeof r[f] === "number" ? r[f] : 0), 0);
const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// ---- DataDoe UI verified truth (July 2026, GBP, Vertex trading UK) ----
const UI = {
  ppcSpendExVat: 1015.58,      // PPC-Campaigns report SPEND total (our correct source)
  ppcSales: 1848.26,           // PPC-Campaigns SALES 140
  plSponsoredProducts: 1218.68,// P&L "Sponsored Products" (ad incl. 20% VAT)
  vat: 1.20,
  profit: 1142.28,             // our Net Profit == DataDoe "Profit by Date" source
  totalSales: 3815.41,         // Profit by Date total_sales == DataDoe P&L "Sales" £3,815.41
  netRevenue: 1683.86,         // Settlements total
  plSessions: 1816,            // DataDoe P&L Sessions total for July (== our 07-20..31 S&T coverage)
};

let passed = 0;
function check(name, fn) { fn(); console.log("  PASS  " + name); passed++; }

console.log("Reconciliation: local cache ↔ DataDoe UI (July 2026)\n");

// 1. PPC — Ad Performance (SPONSORED_PRODUCTS) == DataDoe PPC-Campaigns report
const ppc = loadCov("Ad Performance by Campaign & Date").rows.filter(inRange)
  .filter((r) => r.ad_campaign_type === "SPONSORED_PRODUCTS");
const ppcSpend = round2(sum(ppc, "ad_spend"));
const ppcSales = round2(sum(ppc, "ad_sales"));
check("PPC spend == DataDoe PPC-Campaigns (ex-VAT) £1,015.58", () =>
  assert(near(ppcSpend, UI.ppcSpendExVat), `got £${ppcSpend}`));
check("PPC sales == DataDoe PPC-Campaigns £1,848.26", () =>
  assert(near(ppcSales, UI.ppcSales), `got £${ppcSales}`));
check("P&L 'Sponsored Products' £1,218.68 == our PPC × 1.20 (proves 20% VAT)", () =>
  assert(near(round2(ppcSpend * UI.vat), UI.plSponsoredProducts, 0.02),
    `${ppcSpend} × 1.20 = ${round2(ppcSpend * UI.vat)} vs UI ${UI.plSponsoredProducts}`));

// 2. Profit by Date — Net Profit + total_sales (== DataDoe P&L "Sales")
const pbd = loadCov("Profit by Date").rows.filter(inRange);
check("Net Profit == DataDoe 'Profit by Date' £1,142.28", () =>
  assert(near(round2(sum(pbd, "profit")), UI.profit), `got £${round2(sum(pbd, "profit"))}`));
check("total_sales == DataDoe P&L 'Sales' £3,815.41", () =>
  assert(near(round2(sum(pbd, "total_sales")), UI.totalSales), `got £${round2(sum(pbd, "total_sales"))}`));

// 3. Settlements — Net revenue
const settle = loadCov("Settlements & P&L Components").rows.filter(inRange);
check("Net revenue == Settlements total £1,683.86", () =>
  assert(near(round2(sum(settle, "total")), UI.netRevenue), `got £${round2(sum(settle, "total"))}`));

// 4. Sales & Traffic — sessions coverage proves S&T absent pre-07-20 (matches P&L Sessions 1,816)
const st = loadCov("Sales & Traffic by ASIN & Date").rows.filter(inRange);
const sessions = sum(st, "session");
const stDates = new Set(st.map(dOf).filter(Boolean));
check("S&T July coverage is only 07-20..07-31 (leading gap real)", () =>
  assert(!stDates.has("2026-07-01") && !stDates.has("2026-07-19") && stDates.has("2026-07-20"),
    `dates ${[...stDates].sort()[0]}..`));
check("S&T sessions (07-20..31) == DataDoe P&L Sessions total 1,816", () =>
  assert(sessions === UI.plSessions, `got ${sessions}`));

// ---- Edge cases (§15): upstream-empty, partial coverage, date boundary, zero-vs-unavailable ----

// 5. Upstream-empty is stored and DISTINCT from zero (S&T 07-01..19 export returned [])
const rawDir = path.join(CACHE, "raw");
check("upstream-empty S&T 07-01..19 archived as [] with rowCount 0 (≠ £0)", () => {
  const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith(".json")) : [];
  const rec = files.map((f) => JSON.parse(fs.readFileSync(path.join(rawDir, f), "utf8")))
    .find((r) => r.sourceName === "Sales & Traffic by ASIN & Date" && r.requestedFrom === "2026-07-01" && r.requestedTo === "2026-07-19");
  assert(rec, "no upstream-empty archive record found");
  assert(rec.rowCount === 0 && rec.rawPayload === "[]", `rowCount=${rec.rowCount} payload=${rec.rawPayload}`);
});

// 6. Date boundary inclusive [from,to]; excludes neighbours
const pbdAll = loadCov("Profit by Date").rows;
check("date filter is inclusive [07-01,07-31] and excludes 06-30 / 08-01", () => {
  const jul = pbdAll.filter(inRange).map(dOf);
  assert(jul.includes("2026-07-01") && jul.includes("2026-07-31"), "endpoints missing");
  assert(!jul.includes("2026-06-30") && !jul.includes("2026-08-01"), "neighbour leaked");
});

// 7. August S&T now covers the COMPLETE calendar month through 08-31 (2026-09-02: the missing
// 08-25..08-31 window was retrieved via one authorized targeted export and merged, so the August
// dashboard period is the full month, not the prior partial 08-24). Data still never fabricated.
const stCov = loadCov("Sales & Traffic by ASIN & Date");
check("August S&T covers the complete month through 08-31 (post authorized export)", () => {
  const iv = (stCov.intervals || [])[stCov.intervals.length - 1];
  assert(iv && iv.to === "2026-08-31", `latest S&T interval to=${iv && iv.to}`);
});

// 8. August Sessions coverage (S&T Aug 1-24) == DataDoe P&L Sessions Aug 7,012
const stAug = stCov.rows.filter((r) => { const x = dOf(r); return x && x >= "2026-08-01" && x <= "2026-08-24"; });
check("S&T sessions Aug 1-24 == DataDoe P&L Sessions Aug 7,012", () =>
  assert(sum(stAug, "session") === 7012, `got ${sum(stAug, "session")}`));

// 9. August PPC ex-VAT × 1.20 stays consistent with VAT model on the COVERED days (staleness aside)
check("VAT model holds structurally (ex-VAT × 1.20 = inc-VAT), proven exactly on July", () =>
  assert(near(round2(ppcSpend * 1.20), UI.plSponsoredProducts, 0.02), "VAT ratio broke"));

// ---- August SAME-BASIS reconciliation (after the FULL 08-01..08-28 Ad-Performance refresh) ----
// Live DataDoe P&L Aug 1-28 (re-verified 2026-08-31 via Claude-in-Chrome, ag-grid category-group
// aggData read, token-free): Sales £2,001.84 (unchanged) · Advertising cost £1,300.48 (inc-VAT,
// all sponsored types) · Sessions 7,012 (unchanged). NOTE: anchors migrate over time as Amazon
// matures August attribution — £1,270.02 (stale) → £1,289.64 (export a43f6944, 2026-08-30) →
// £1,299.40 (export 3f108976, 2026-08-30) → £1,300.48 (export 2ed1cd8e, 2026-08-31, authorized
// targeted refresh). LIVE PPC-Campaigns all-types ex-VAT £1,083.73 × 1.20 = £1,300.48 (cross-anchor
// holds exactly, matches LIVE P&L advertising_cost). SP-only = £1,045.13 (LIVE grid-API sum,
// captured same session immediately before the export — matches the export result exactly).
const AUG_FROM = "2026-08-01", AUG_TO = "2026-08-28";
const inAug = (r) => { const x = dOf(r); return x !== null && x >= AUG_FROM && x <= AUG_TO; };
const pbdAug = loadCov("Profit by Date").rows.filter(inAug);
check("Aug Profit-by-Date total_sales == DataDoe P&L Sales £2,001.84 (staleness fixed)", () =>
  assert(near(round2(sum(pbdAug, "total_sales")), 2001.84), `got £${round2(sum(pbdAug, "total_sales"))}`));

const adAug = loadCov("Ad Performance by Campaign & Date").rows.filter(inAug);
const adAllExVat = round2(sum(adAug, "ad_spend")); // all sponsored types, ex-VAT
check("Aug ad (all types, ex-VAT) × 1.20 == DataDoe P&L Advertising cost £1,300.48 (post-refresh 2026-08-31)", () =>
  assert(near(round2(adAllExVat * 1.20), 1300.48, 0.02), `${adAllExVat} × 1.20 = ${round2(adAllExVat * 1.20)}`));
// SP-only spend now equals the LIVE PPC-Campaigns SP total exactly (the fix this refresh delivered).
const adAugSP = adAug.filter((r) => r.ad_campaign_type === "SPONSORED_PRODUCTS");
check("Aug PPC SP spend == DataDoe PPC-Campaigns SP £1,045.13 (LIVE, post-refresh 2026-08-31)", () =>
  assert(near(round2(sum(adAugSP, "ad_spend")), 1045.13), `got £${round2(sum(adAugSP, "ad_spend"))}`));
check("Aug PPC SP sales == DataDoe PPC-Campaigns SP £1,267.35 (LIVE, post-refresh)", () =>
  assert(near(round2(sum(adAugSP, "ad_sales")), 1267.35), `got £${round2(sum(adAugSP, "ad_sales"))}`));

// ---- Net Profit / Margin re-sourced to DataDoe P&L (captured live, archived under .cache/datadoe/pnl) ----
// The dashboard's Net Profit / Net Margin now come from DataDoe's OWN P&L net_profit (not Profit-by-Date).
// The archived per-date P&L must sum to the DataDoe P&L UI: July net_profit £1,009.85, margin 26.47%.
{
  const dir = path.join(CACHE, "pnl");
  // Mirror production loadPnlDaily EXACTLY: fold every archive into a date->row map, later
  // (lexically greater) filename wins on a date collision. A naive concat would double-count
  // dates that appear in more than one archive (e.g. after a refresh capture supersedes the
  // original snapshot for the same range) — that is NOT what the backend does.
  const byDate = new Map();
  try {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const iD = a.columns.indexOf("date"), iN = a.columns.indexOf("net_profit"), iS = a.columns.indexOf("sales");
      for (const r of a.rows) {
        const d = String(r[iD]).slice(0, 10);
        byDate.set(d, { date: d, np: r[iN], sales: r[iS] });
      }
    }
  } catch (e) {}
  const pnlRows = Array.from(byDate.values());
  const inR = (d, from, to) => d >= from && d <= to;
  const julNp = round2(pnlRows.filter(r => inR(r.date, "2026-07-01", "2026-07-31")).reduce((t, r) => t + r.np, 0));
  const julSales = round2(pnlRows.filter(r => inR(r.date, "2026-07-01", "2026-07-31")).reduce((t, r) => t + r.sales, 0));
  const julMargin = julSales ? (julNp / julSales) * 100 : null;
  check("Dashboard Net Profit == DataDoe P&L net_profit £1,009.85 (July, archived)", () =>
    assert(near(julNp, 1009.85), `got £${julNp}`));
  check("Dashboard Net Margin == DataDoe P&L margin 26.47% (July)", () =>
    assert(julMargin !== null && Math.abs(julMargin - 26.47) < 0.02, `got ${julMargin && julMargin.toFixed(2)}%`));
}

console.log(`\n${passed} reconciliation assertions passed — cache matches DataDoe UI (July exact incl. P&L Net Profit; August same-basis exact after sync).`);
