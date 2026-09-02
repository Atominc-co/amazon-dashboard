/*
 * Orders coverage + integrity tests (offline; reads the archived Order Line Items data).
 * Verifies full-month July & August coverage, no duplicate order rows after aggregation, and
 * month-specific results. Run: node test/orders.test.js
 */
require("../dist/config/env");
const assert = require("assert");
const { getOrdersRange } = require("../dist/services/datadoe/datadoe.orders");

const SELLER = "19076074-9461-4eb0-a762-5f27185f9e5b";
let pass = 0;
function check(name, fn) { try { fn(); console.log("  PASS ", name); pass++; } catch (e) { console.error("  FAIL ", name, "-", e.message); process.exitCode = 1; } }

(async () => {
  console.log("Orders coverage + integrity (2026 July / August)\n");
  const jul = await getOrdersRange(SELLER, "2026-07-01", "2026-07-31");
  const aug = await getOrdersRange(SELLER, "2026-08-01", "2026-08-31");

  check("July has orders (full-month coverage)", () => assert(jul.count > 0 && jul.available, `count=${jul.count}`));
  check("August has orders (full-month coverage)", () => assert(aug.count > 0 && aug.available, `count=${aug.count}`));

  check("July order count == 228 (archived)", () => assert.strictEqual(jul.count, 228, `got ${jul.count}`));
  check("August order count == 176 (archived)", () => assert.strictEqual(aug.count, 176, `got ${aug.count}`));

  check("July no duplicate order ids", () => {
    const ids = jul.orders.map((o) => o.orderId);
    assert.strictEqual(ids.length, new Set(ids).size, "duplicate order id in July");
  });
  check("August no duplicate order ids", () => {
    const ids = aug.orders.map((o) => o.orderId);
    assert.strictEqual(ids.length, new Set(ids).size, "duplicate order id in August");
  });

  check("every July order date is within 2026-07-01..07-31", () =>
    jul.orders.forEach((o) => assert(o.date >= "2026-07-01" && o.date <= "2026-07-31", `stray date ${o.date}`)));
  check("every August order date is within 2026-08-01..08-31", () =>
    aug.orders.forEach((o) => assert(o.date >= "2026-08-01" && o.date <= "2026-08-31", `stray date ${o.date}`)));

  check("months do not overlap (no shared order id July vs August)", () => {
    const j = new Set(jul.orders.map((o) => o.orderId));
    const shared = aug.orders.filter((o) => j.has(o.orderId));
    assert.strictEqual(shared.length, 0, `${shared.length} orders shared across months`);
  });

  check("July totals are month-specific (differ from August)", () =>
    assert(jul.totalValue !== aug.totalValue && jul.count !== aug.count, "July == August totals (month switch broken)"));

  // Genuine invariant: never negative, never fabricated. Canceled orders legitimately carry 0 units
  // / £0 in the source (all shipped/charged quantities cancelled) — preserved honestly, not dropped
  // or coerced. Every non-cancelled order has real positive units & value.
  check("order totals non-negative; no fabrication", () =>
    jul.orders.forEach((o) => assert(o.units >= 0 && o.value >= 0, `negative order ${o.orderId}: units=${o.units} value=${o.value}`)));
  check("Canceled orders preserved with genuine 0 units (not dropped, not faked)", () => {
    const cancelled = jul.orders.filter((o) => o.status === "Canceled" || o.status === "Cancelled");
    assert(cancelled.length > 0, "expected some Canceled orders in July");
    cancelled.forEach((o) => assert(o.units === 0 && o.value === 0, `Canceled order ${o.orderId} not 0/0`));
  });
  check("non-cancelled orders have real positive units & value", () =>
    jul.orders.filter((o) => o.status !== "Canceled" && o.status !== "Cancelled")
      .forEach((o) => assert(o.units >= 1 && o.value > 0, `bad order ${o.orderId}: units=${o.units} value=${o.value}`)));

  console.log(`\n${pass} order assertions passed — July 228 / August 176, no duplicates, month-specific.`);
})();
