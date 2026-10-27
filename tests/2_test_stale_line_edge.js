// tests/2_test_stale_line_edge.js — In-Fight Latency & Stale Line Arbitrage verification
const assert = require("assert");

function evaluateStaleLineEdge(stats, dkLastUpdateMs) {
  const result = {
    staleLineAdvantage: false,
    staleLineDetails: null
  };

  if (dkLastUpdateMs > 0 && stats && stats.f1 && stats.f2) {
    const now = Date.now();
    const delayMs = now - dkLastUpdateMs;
    const kd = (stats.f1.knockdowns || 0) > 0 || (stats.f2.knockdowns || 0) > 0;
    const td = (stats.f1.takedownsLanded || 0) > 0 || (stats.f2.takedownsLanded || 0) > 0;

    if ((kd || td) && delayMs >= 4000) {
      result.staleLineAdvantage = true;
      result.staleLineDetails = "⚡ ACTION SPIKE: Knockdown/Takedown logged on ESPN. DK line is stale by " + (delayMs / 1000).toFixed(1) + "s. Exploit edge before suspension.";
    }
  }

  return result;
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

console.log("\n── In-Fight Latency Arbitrage Tests ──");

test("No action spike (0 KD, 0 TD) → Stale line advantage is false even if delayed", () => {
  const stats = { f1: { knockdowns: 0, takedownsLanded: 0 }, f2: { knockdowns: 0, takedownsLanded: 0 } };
  const dkLastUpdateMs = Date.now() - 10000; // 10s old
  const r = evaluateStaleLineEdge(stats, dkLastUpdateMs);
  assert.strictEqual(r.staleLineAdvantage, false);
  assert.strictEqual(r.staleLineDetails, null);
});

test("Action spike (Knockdown > 0) but DK odds are FRESH (< 4s) → Stale line advantage is false", () => {
  const stats = { f1: { knockdowns: 1, takedownsLanded: 0 }, f2: { knockdowns: 0, takedownsLanded: 0 } };
  const dkLastUpdateMs = Date.now() - 1500; // 1.5s old
  const r = evaluateStaleLineEdge(stats, dkLastUpdateMs);
  assert.strictEqual(r.staleLineAdvantage, false);
});

test("Action spike (Takedown > 0) AND DK odds are STALE (>= 4s) → Stale line advantage is TRUE", () => {
  const stats = { f1: { knockdowns: 0, takedownsLanded: 1 }, f2: { knockdowns: 0, takedownsLanded: 0 } };
  const dkLastUpdateMs = Date.now() - 5200; // 5.2s old
  const r = evaluateStaleLineEdge(stats, dkLastUpdateMs);
  assert.strictEqual(r.staleLineAdvantage, true);
  assert.ok(r.staleLineDetails.includes("ACTION SPIKE"));
  assert.ok(r.staleLineDetails.includes("5.2s"));
});

test("Both fighters have action spikes with stale DK feed → Fires edge", () => {
  const stats = { f1: { knockdowns: 1, takedownsLanded: 0 }, f2: { knockdowns: 1, takedownsLanded: 2 } };
  const dkLastUpdateMs = Date.now() - 6000;
  const r = evaluateStaleLineEdge(stats, dkLastUpdateMs);
  assert.strictEqual(r.staleLineAdvantage, true);
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
