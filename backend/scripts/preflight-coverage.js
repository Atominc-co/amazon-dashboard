/*
 * ZERO-TOKEN pre-flight. Computes the datasetKey for each export-only source and reads its
 * existing coverage from disk (no DataDoe calls). Proves the columns/source match the running
 * backend's cache BEFORE any metered export, and shows the exact covered interval so we fetch
 * only the missing gap. Read-only.
 */
require("../dist/config/env");
const { computeDatasetKey, readCoverage } = require("../dist/services/datadoe/datadoe.coverage");

const SELLER_ID = "19076074-9461-4eb0-a762-5f27185f9e5b";

const SETTLEMENT_COLUMNS = [
  "date","total","currency","child_asin","referral_fee","fba_per_unit_fulfillment_fee",
  "fba_storage_fee","long_term_storage_fee","amazon_fees","refunded_amount","promotion_item_price",
  "promotion_fee","promotion_shipping","coupon_redemption_fee","coupon_performance_fee",
  "coupon_participation_fee","deal_performance_fee","deal_participation_fee",
  "fba_customer_return_per_unit_fee","shipping_label_purchase_for_return",
];
const SKU_PROFIT_COLUMNS = ["date","child_asin","total_sales","profit","ad_spend","ad_sales"];
const PPC_COLUMNS = ["date","ad_campaign_type","ad_campaign_id","ad_campaign_name","ad_spend","ad_sales","ad_clicks","ad_impressions","ad_orders"];

const targets = [
  { name: "Settlements & P&L Components", columns: SETTLEMENT_COLUMNS },
  { name: "Profit by SKU & Date", columns: SKU_PROFIT_COLUMNS },
  { name: "Sales & Traffic by ASIN & Date", columns: undefined }, // all:true -> __ALL__
  { name: "Ad Performance by Campaign & Date", columns: PPC_COLUMNS },
];

function lastDate(cov) {
  if (!cov || !cov.rows) return null;
  let mx = null;
  for (const r of cov.rows) { const d = (r.date || "").slice(0,10); if (d && (!mx || d > mx)) mx = d; }
  return mx;
}

(async () => {
  for (const t of targets) {
    const key = computeDatasetKey({ sellerId: SELLER_ID, sourceName: t.name, columns: t.columns });
    const cov = await readCoverage(key);
    console.log("----", t.name);
    console.log("  datasetKey:", key);
    if (!cov) { console.log("  COVERAGE: MISSING (columns/source mismatch or not cached)"); continue; }
    console.log("  intervals:", JSON.stringify(cov.intervals));
    console.log("  rows:", cov.rows.length, "lastDate:", lastDate(cov));
  }
})().catch((e) => { console.error("ERR:", e && e.message ? e.message : e); process.exit(1); });
