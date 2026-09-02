/*
 * ONE-TIME retrieval of the three dedicated FBA inventory datasets needed for the rebuilt
 * Inventory Health section (seller Vertex trading UK): "FBA Restock Recommendations",
 * "FBA Recommended Removals", "FBA Inbound Shipments". None were previously cached locally
 * (confirmed by inspecting .cache/datadoe/raw/ and the normalized cache directory first).
 *
 * Uses the PRODUCTION path (getSellerSourceData -> fetchFromDataDoe), which for each source:
 *   - creates ONE export (the only token-spending call),
 *   - archives the untouched raw payload immutably under .cache/datadoe/raw/,
 *   - writes the normalized exact-key cache, reusable on every subsequent dashboard load
 *     with zero further provider calls.
 *
 * These are point-in-time FBA snapshot/recommendation sources (like the already-cached
 * "FBA Inventory Health"), not historical per-date time series, so a short recent window
 * (matching the existing Inventory/Inventory-Health endpoints' recentDateRange(3) convention)
 * is used with all:true to fetch the complete current dataset in one export each.
 *
 * Usage: node scripts/fetch-inventory-signals.js
 */
require("../dist/config/env");
const { getSellerSourceData } = require("../dist/services/amazon-catalog.service");
const { formatDate } = require("../dist/services/datadoe/datadoe.dates");

const SELLER = "19076074-9461-4eb0-a762-5f27185f9e5b";
const SOURCES = ["FBA Restock Recommendations", "FBA Recommended Removals", "FBA Inbound Shipments"];

function recentWindow(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { from: formatDate(from), to: formatDate(to) };
}

(async () => {
  const { from, to } = recentWindow(3);
  console.log("Window:", from, "..", to, "\n");

  for (const sourceName of SOURCES) {
    console.log("=== " + sourceName + " ===");
    try {
      const res = await getSellerSourceData({
        sellerId: SELLER,
        sourceName,
        all: true,
        from,
        to,
        refresh: true,
      });
      console.log("rows:", res.rows.length, "| cache key:", res.cache && res.cache.key, "| exportId:", res.exportId);
      if (res.rows[0]) console.log("row keys:", Object.keys(res.rows[0]).slice(0, 10).join(","));
    } catch (e) {
      console.error("FAILED:", sourceName, "-", e && e.message ? e.message : e);
    }
    console.log("");
  }
  console.log("DONE");
})().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
