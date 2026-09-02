/*
 * Live Products validation / coverage report (offline; reads local caches only, no provider call).
 *
 * Prints the Section-21 coverage report for July and August: exactly 62 active listings, one Live
 * Product row each, per-field coverage counts, and any integrity anomalies (duplicate/unmatched
 * canonical identities, products removed by joins, suspicious duplicate revenue/units, invalid
 * image mappings). Run: node scripts/validate-live-products.js
 */
require("../dist/config/env");
const { getLiveProducts, JULY_START, JULY_END, AUGUST_START, AUGUST_END } = require("../dist/services/datadoe/datadoe.liveproducts");

const SELLER = "19076074-9461-4eb0-a762-5f27185f9e5b";

function pct(n) {
  return `${n}/62`;
}

async function reportMonth(label, from, to) {
  const r = await getLiveProducts(SELLER, from, to);
  const c = r.coverage;
  const withImage = c.image;
  const withoutImage = 62 - c.image;
  const withPpc = c.ppc;
  const withoutPpc = 62 - c.ppc;

  console.log(`\n${label}:`);
  console.log(`  Window:            ${r.from} .. ${r.to}`);
  console.log(`  Active listings:   ${r.activeListingCount}`);
  console.log(`  Live Products:     ${r.liveProductCount}`);
  console.log(`  With image:        ${pct(withImage)}`);
  console.log(`  Without image:     ${pct(withoutImage)}`);
  console.log(`  With PPC data:     ${pct(withPpc)}`);
  console.log(`  Without PPC data:  ${pct(withoutPpc)}`);
  console.log(`  With ACOS:         ${pct(c.acos)}   (advertised with attributed sales)`);
  console.log(`  With Buy Box:      ${pct(c.buyBox)}`);
  console.log(`  With stock:        ${pct(c.stock)}   (current snapshot ${r.inventorySnapshotDate || "n/a"})`);
  console.log(`  With margin:       ${pct(c.margin)}`);
  console.log(`  With revenue:      ${pct(c.revenue)}   (row present; may be an explicit £0)`);
  console.log(`  With units:        ${pct(c.units)}`);
  console.log(`  Revenue total (active, in-window): £${r.revenueSourceTotal.toFixed(2)}`);

  // Anomaly checks
  const anomalies = [];
  if (r.activeListingCount !== 62) anomalies.push(`active listing count is ${r.activeListingCount}, expected 62`);
  if (r.liveProductCount !== 62) anomalies.push(`live product count is ${r.liveProductCount}, expected 62`);
  if (r.duplicateCanonicalCount !== 0) anomalies.push(`duplicate canonical identities: ${r.duplicateCanonicalCount}`);
  if (r.unmatchedListingCount !== 0) anomalies.push(`unmatched (no child_asin) listings: ${r.unmatchedListingCount}`);

  // Products removed by joins == active - live (must be zero).
  const removedByJoins = r.activeListingCount - r.liveProductCount;
  if (removedByJoins !== 0) anomalies.push(`products removed by joins: ${removedByJoins}`);

  // Suspicious duplicate revenue/units: the bug this guards against is a BROADCAST — the same value
  // copied across ~all products (e.g. total P&L Sales assigned to every row). Genuine data legitimately
  // repeats small values (several distinct products each sell one unit at the same price, e.g. £14.99),
  // so only an implausibly high repeat count — a large fraction of the 62-row catalogue — is flagged.
  const revCounts = new Map();
  const unitCounts = new Map();
  for (const p of r.products) {
    if (typeof p.revenue === "number" && p.revenue > 0) revCounts.set(p.revenue, (revCounts.get(p.revenue) || 0) + 1);
    if (typeof p.units === "number" && p.units > 0) unitCounts.set(p.units, (unitCounts.get(p.units) || 0) + 1);
  }
  const BROADCAST_REV = 20; // >20 distinct products at the identical non-zero revenue ⇒ broadcast
  const BROADCAST_UNITS = 30; // units repeat naturally (many 1s/2s); only a near-catalogue repeat is a bug
  for (const [v, n] of revCounts) if (n > BROADCAST_REV) anomalies.push(`revenue £${v} repeats across ${n} products (possible broadcast)`);
  for (const [v, n] of unitCounts) if (n > BROADCAST_UNITS) anomalies.push(`units ${v} repeats across ${n} products (possible broadcast)`);

  // Invalid image mappings: an image URL present but not a plausible product image URL.
  for (const p of r.products) {
    if (p.imageUrl && !/^https?:\/\//i.test(p.imageUrl)) anomalies.push(`product ${p.childAsin} has a non-URL image value`);
  }

  if (anomalies.length) {
    console.log("  ANOMALIES:");
    for (const a of anomalies) console.log(`    - ${a}`);
  } else {
    console.log("  Anomalies:         none (0 duplicates, 0 unmatched, 0 removed by joins)");
  }
  return { r, anomalies };
}

(async () => {
  console.log("LIVE PRODUCTS — VALIDATION / COVERAGE REPORT");
  console.log("Active listings: 62 (listing_status === 'Active')");
  const jul = await reportMonth("July", JULY_START, JULY_END);
  const aug = await reportMonth("August", AUGUST_START, AUGUST_END);

  const allAnoms = [...jul.anomalies, ...aug.anomalies];
  console.log("\n" + "=".repeat(60));
  if (allAnoms.length === 0) {
    console.log("RESULT: PASS — 62 active listings, 62 live products, 0 removed by joins (both months).");
    process.exitCode = 0;
  } else {
    console.log(`RESULT: FAIL — ${allAnoms.length} anomaly(ies) found.`);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error("VALIDATION ERROR:", e);
  process.exit(1);
});
