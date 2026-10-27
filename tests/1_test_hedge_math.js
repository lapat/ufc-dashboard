// tests/1_test_hedge_math.js — Mathematical proofs for guaranteed-profit locks
const assert = require("assert");

function toDecimal(o) {
  return o > 0 ? (o / 100) + 1 : (100 / Math.abs(o)) + 1;
}

function calcEqualProfitHedge(s1, o1, o2) {
  const d1 = toDecimal(o1);
  const d2 = toDecimal(o2);
  const winWin = (d1 - 1) * (d2 - 1) > 1;
  const s2 = (s1 * d1) / d2;
  const pay1 = s1 * d1 - s1 - s2;
  const pay2 = s2 * d2 - s1 - s2;
  return { d1, d2, winWin, s2, pay1, pay2, net: Math.min(pay1, pay2) };
}

let passed = 0;
function test(desc, fn) {
  try {
    fn();
    console.log("  ✓ " + desc);
    passed++;
  } catch (e) {
    console.error("  ✗ " + desc + ":", e.message);
    process.exit(1);
  }
}

console.log("\n── 1. Decimal Odds Conversion ──");
test("+100 is 2.0", () => assert.strictEqual(toDecimal(100), 2.0));
test("+150 is 2.5", () => assert.strictEqual(toDecimal(150), 2.5));
test("-200 is 1.5", () => assert.strictEqual(toDecimal(-200), 1.5));
test("-300 is 1.3333...", () => assert.ok(Math.abs(toDecimal(-300) - 1.3333) < 0.001));

console.log("\n── 2. Equal-Profit Proofs ──");
test("Slight-edge crossover (+145 dog, +115 fav hedge)", () => {
  const r = calcEqualProfitHedge(10, 145, 115);
  assert.ok(r.winWin, "Must satisfy (D1-1)(D2-1) > 1");
  assert.ok(Math.abs(r.pay1 - r.pay2) < 0.0001, "Both outcomes must yield exact equal profit");
  assert.ok(r.net > 3.05 && r.net < 3.15, "Net profit must be ~$3.10");
  assert.ok(r.s2 > 11.35 && r.s2 < 11.45, "Optimal hedge stake must be ~$11.40");
});

test("Deep underdog swing (+250 dog, +120 fav hedge)", () => {
  const r = calcEqualProfitHedge(25, 250, 120);
  assert.ok(r.winWin);
  assert.ok(Math.abs(r.pay1 - r.pay2) < 0.0001);
  assert.ok(r.net > 10.0, "Substantial guaranteed profit");
});

test("Vig trap detection (+105 dog, -105 fav hedge)", () => {
  const r = calcEqualProfitHedge(10, 105, -105);
  assert.strictEqual(r.winWin, false, "Negative EV hedge must be flagged");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
