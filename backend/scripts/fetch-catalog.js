/*
 * ONE-TIME Product Catalog retrieval to raise Live Products image coverage (seller Vertex trading UK).
 *
 * The locally-cached "Product Catalog by ASIN" snapshot was fetched at pageSize=5, so only 3 of the
 * 62 active listings had an authoritative product image. This runs ONE export of the full catalog
 * (all:true) via the PRODUCTION path (getSellerSourceData → fetchFromDataDoe), which:
 *   - creates a single export (the only token-spending call),
 *   - archives the UNTOUCHED raw payload immutably under .cache/datadoe/raw/,
 *   - writes the normalized exact-key cache (all:true) that loadCatalogImageMap already prefers
 *     (it scans catalog caches and picks the one with the most rows).
 * No existing cache is overwritten destructively (the old pageSize=5 entry keeps its own key).
 *
 * Deterministic image join is by child_asin only (no title/fuzzy matching). Prints before/after
 * image coverage for the 62 active ASINs and the exact ASINs still missing an authoritative image.
 *
 * Usage: node scripts/fetch-catalog.js
 */
require("../dist/config/env");
const fs = require("fs");
const path = require("path");
const { getSellerSourceData } = require("../dist/services/amazon-catalog.service");

const SELLER = "19076074-9461-4eb0-a762-5f27185f9e5b";
const CATALOG_SOURCE = "Product Catalog by ASIN";

function cacheDir() {
  return process.env.DATADOE_CACHE_DIR || path.join(process.cwd(), ".cache", "datadoe");
}

// Active ASINs from the local Listings cache (the driving table — never re-fetched here).
function activeAsins() {
  const dir = cacheDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".cov.json"));
  for (const f of files) {
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    const name = (e.source && e.source.name) || e.sourceName;
    if (name === "Listings" && e.all && Array.isArray(e.rows)) {
      return e.rows.filter((r) => (r.listing_status || "").trim() === "Active").map((r) => r.child_asin);
    }
  }
  return [];
}

// Current best local catalog image map (before the fetch), for the before-count.
function localCatalogImages() {
  const dir = cacheDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".cov.json"));
  let best = null;
  for (const f of files) {
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    const name = (e.source && e.source.name) || e.sourceName;
    if (name === CATALOG_SOURCE && Array.isArray(e.rows) && (!best || e.rows.length > best.length)) best = e.rows;
  }
  const m = new Map();
  if (best) for (const r of best) if (r.child_asin && r.product_image_url) m.set(r.child_asin, r.product_image_url);
  return m;
}

(async () => {
  const active = activeAsins();
  const activeSet = new Set(active);
  console.log("Active listings:", active.length);
  if (active.length !== 62) { console.error("ABORT: expected 62 active listings, got", active.length); process.exit(2); }

  const before = localCatalogImages();
  const beforeCov = active.filter((a) => before.has(a)).length;
  console.log("Image coverage BEFORE:", beforeCov, "/ 62");

  console.log("\nRunning ONE full Product Catalog export (all:true, refresh:true) — token-spending...");
  const res = await getSellerSourceData({ sellerId: SELLER, sourceName: CATALOG_SOURCE, all: true, refresh: true });
  console.log("export rows:", res.rows.length, "| cache key:", res.cache && res.cache.key, "| exportId:", res.exportId);
  if (res.rows[0]) console.log("row keys:", Object.keys(res.rows[0]).slice(0, 12).join(","));

  const after = new Map();
  for (const r of res.rows) if (r.child_asin && r.product_image_url) after.set(r.child_asin, r.product_image_url);
  const withImg = active.filter((a) => after.has(a));
  const without = active.filter((a) => !after.has(a));
  console.log("\nImage coverage AFTER:", withImg.length, "/ 62");
  console.log("catalog rows covering active ASINs:", active.filter((a) => res.rows.some((r) => r.child_asin === a)).length, "/ 62");

  // Identity checks
  const catalogAsins = res.rows.map((r) => r.child_asin).filter(Boolean);
  const dupImageIdentity = catalogAsins.length - new Set(catalogAsins).size;
  const nonUrl = [...after.entries()].filter(([, u]) => !/^https?:\/\//i.test(u)).map(([a]) => a);
  console.log("duplicate catalog ASIN rows:", dupImageIdentity);
  console.log("non-URL image values:", nonUrl.length);

  if (without.length) {
    console.log("\nActive ASINs still WITHOUT an authoritative image (", without.length, "):");
    console.log(without.join(", "));
  } else {
    console.log("\n62/62 active listings now have an authoritative catalog image.");
  }
  console.log("\nDONE");
})().catch((e) => { console.error("ERROR:", e && e.message ? e.message : e); process.exit(1); });
