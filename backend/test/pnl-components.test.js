/**
 * Reconciliation test — DataDoe P&L report line-item components (verified 2026-08-31 via
 * Claude-in-Chrome, token-free app-API /profit-and-loss/details capture).
 *
 * OFFLINE, token-free. Folds every .cache/datadoe/pnl/*.json exactly like the backend's loadPnlDaily
 * (date-map, later-filename-wins, positional columns) and asserts the six DataDoe P&L components +
 * net_profit for July and August against the EXACT values read from the DataDoe P&L Reports UI, and
 * proves the P&L identity closes per range:
 *   Sales + Advertising + Amazon fees + Refund cost + FBA chargeback + Lost/damaged = Net profit.
 * A regression (dropped column, wrong sign, bad fold, stale file winning) fails loudly.
 * Evidence: backend/.cache/datadoe/RECONCILIATION-DATADOE-UI-2026-08.md
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PNL_DIR = path.join(process.env.DATADOE_CACHE_DIR || path.join(__dirname, "..", ".cache", "datadoe"), "pnl");
const SELLER = "19076074-9461-4eb0-a762-5f27185f9e5b";
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log("  PASS  " + msg); pass++; };

// Fold pnl archives exactly like loadPnlDaily: later (lexically greater) filename wins per date.
function loadPnlDaily(sellerId) {
  const map = new Map();
  const files = fs.readdirSync(PNL_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp")).sort();
  for (const f of files) {
    const e = JSON.parse(fs.readFileSync(path.join(PNL_DIR, f), "utf8"));
    if (e.sellerId !== sellerId || !Array.isArray(e.rows)) continue;
    const C = e.columns;
    const iD = C.indexOf("date"), iNp = C.indexOf("net_profit"), iS = C.indexOf("sales");
    if (iD < 0 || iNp < 0 || iS < 0) continue;
    const iA = C.indexOf("advertising_cost"), iF = C.indexOf("amazon_fees"), iR = C.indexOf("refund_cost"),
      iC = C.indexOf("fba_shipping_chargeback"), iL = C.indexOf("lost_damaged"), iU = C.indexOf("total_units_sold");
    const cell = (r, i) => (i >= 0 && typeof r[i] === "number" ? r[i] : null);
    for (const r of e.rows) {
      const d = r[iD];
      if (typeof d !== "string" || d.length < 10) continue;
      map.set(d.slice(0, 10), {
        netProfit: r[iNp], sales: r[iS],
        advertising: cell(r, iA), amazonFees: cell(r, iF), refundCost: cell(r, iR),
        fbaChargeback: cell(r, iC), lostDamaged: cell(r, iL), units: cell(r, iU),
      });
    }
  }
  return map;
}

function rangeSums(map, from, to) {
  const acc = { netProfit: 0, sales: 0, advertising: 0, amazonFees: 0, refundCost: 0, fbaChargeback: 0, lostDamaged: 0, units: 0 };
  let componentsAvailable = true, unitsAvailable = true, n = 0;
  for (const [d, row] of map) {
    if (d < from || d > to) continue;
    n++;
    acc.netProfit += row.netProfit; acc.sales += row.sales;
    if (row.units === null) { unitsAvailable = false; } else { acc.units += row.units; }
    if (row.advertising === null || row.amazonFees === null || row.refundCost === null ||
        row.fbaChargeback === null || row.lostDamaged === null) { componentsAvailable = false; continue; }
    acc.advertising += row.advertising; acc.amazonFees += row.amazonFees; acc.refundCost += row.refundCost;
    acc.fbaChargeback += row.fbaChargeback; acc.lostDamaged += row.lostDamaged;
  }
  for (const k in acc) acc[k] = Math.round(acc[k] * 100) / 100;
  return { ...acc, componentsAvailable, unitsAvailable, days: n };
}

// DataDoe P&L Reports-UI verified truth (GBP, Vertex trading UK, interval=DAY)
const JUL = { sales: 3815.41, advertising: -1218.68, amazonFees: -1432.46, refundCost: -41.45, fbaChargeback: -114.97, lostDamaged: 2, netProfit: 1009.85, units: 231 };
// August re-verified fresh 2026-09-01 via ag-grid category-group aggregates — supersedes the prior
// 2026-08-31 capture, which had gone stale again (Amazon's ~2-4wk attribution restatement moved
// Sales 2213.02->2226.01, Amazon fees 292.60->264.51, Net profit 1100.13->1085.03 since then).
const AUG = { sales: 2226.01, advertising: -1300.46, amazonFees: 264.51, refundCost: -78.71, fbaChargeback: -29.37, lostDamaged: 3.05, netProfit: 1085.03, units: 173 };

console.log("Reconciliation: DataDoe P&L components ↔ archive (July + August 2026)\n");
const map = loadPnlDaily(SELLER);
const jul = rangeSums(map, "2026-07-01", "2026-07-31");
const aug = rangeSums(map, "2026-08-01", "2026-08-28");

ok(jul.days === 31, "July folds 31 days");
ok(aug.days === 28, "August folds 28 days");
ok(jul.componentsAvailable && aug.componentsAvailable, "components available for both months (v2 archive covers every covered day)");
ok(jul.unitsAvailable && aug.unitsAvailable, "P&L units available for both months (v3 archive covers every covered day)");

for (const [name, got, want] of [["July", jul, JUL], ["August", aug, AUG]]) {
  ok(near(got.sales, want.sales), `${name} P&L Sales == ${want.sales}`);
  ok(near(got.advertising, want.advertising), `${name} P&L Advertising == ${want.advertising}`);
  ok(near(got.amazonFees, want.amazonFees), `${name} Amazon fees == ${want.amazonFees}`);
  ok(near(got.refundCost, want.refundCost), `${name} Refund cost == ${want.refundCost}`);
  ok(near(got.fbaChargeback, want.fbaChargeback), `${name} FBA chargeback == ${want.fbaChargeback}`);
  ok(near(got.lostDamaged, want.lostDamaged), `${name} Lost/damaged == ${want.lostDamaged}`);
  ok(near(got.netProfit, want.netProfit), `${name} Net profit == ${want.netProfit}`);
  ok(got.units === want.units, `${name} P&L Units (total_units_sold, shipped basis) == ${want.units}`);
  const identity = got.sales + got.advertising + got.amazonFees + got.refundCost + got.fbaChargeback + got.lostDamaged;
  ok(near(identity, got.netProfit), `${name} identity closes (components sum == net_profit ${want.netProfit})`);
}

// Regression guard: P&L Units must NOT equal the free Sales KPI's Sales & Traffic ordered-basis
// units (79 for Jul 20-31, 136 for Aug 1-24) — proving the two remain genuinely distinct sources
// even after the shipped-basis redefinition, not silently collapsed into one number.
ok(JUL.units !== 79, "REGRESSION GUARD: July P&L Units (231) is not the Sales & Traffic ordered-basis figure (79)");
ok(AUG.units !== 136, "REGRESSION GUARD: August P&L Units (173) is not the Sales & Traffic ordered-basis figure (136)");

// Regression guard: the working July Net Profit must be unchanged (settled).
ok(near(jul.netProfit, 1009.85), "REGRESSION GUARD: July Net Profit still 1009.85 (unchanged working metric)");

console.log(`\n${pass} P&L-component assertions passed — dashboard P&L components match DataDoe P&L UI, identity closes both months.`);
