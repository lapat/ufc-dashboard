// tests/7_test_provenance_audit.js — Verifies Data Provenance & Empirical Audit Engine
const assert = require("assert");
const fs = require("fs");
const { getAuditData } = require("../provenance_engine");

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

console.log("\n── Data Provenance & Empirical Audit Tests ──");

test("provenance_engine evaluates production sample with zero mathematical discrepancy", () => {
  const audit = getAuditData();
  assert.ok(audit.totalFightsAnalyzed >= 280, "Must analyze at least 280 production fights");
  assert.strictEqual(audit.threshold, "oddsHistory.length >= 20 ticks");
  assert.ok(Array.isArray(audit.catalysts), "Must have catalysts array");
  assert.ok(audit.catalysts.length >= 6, "Must have at least 6 verified catalysts");
});

test("every catalyst has an exact verifiable fight-by-fight audit list", () => {
  const audit = getAuditData();
  for (const c of audit.catalysts) {
    assert.strictEqual(c.fights.length, c.sample, `Catalyst ${c.id} fights count must match sample`);
    const actualCrossovers = c.fights.filter(f => f.crossover).length;
    assert.strictEqual(actualCrossovers, c.crossovers, `Catalyst ${c.id} crossover count must match`);
    const computedRate = c.sample > 0 ? Math.round((c.crossovers / c.sample) * 1000) / 10 : 0;
    assert.strictEqual(computedRate, c.rate, `Catalyst ${c.id} rate must match formula`);
    
    // Check fight attributes
    if (c.fights.length > 0) {
      const f = c.fights[0];
      assert.ok(f.file.endsWith(".json"), "Must cite raw JSON file");
      assert.ok(f.matchup.includes("vs"), "Must cite matchup");
      assert.ok(f.favOdds != null && f.dogOdds != null, "Must have opening odds");
      assert.ok(f.triggerSummary != null, "Must have trigger summary");
    }
  }
});

test("public/audit.html exists with complete transparency components", () => {
  assert.ok(fs.existsSync("public/audit.html"), "public/audit.html must exist");
  const html = fs.readFileSync("public/audit.html", "utf8");
  assert.ok(html.includes("id=\"catalyst-container\""), "Must have catalyst container");
  assert.ok(html.includes("id=\"catalog-table\""), "Must have catalog table");
  assert.ok(html.includes("computeVolatility"), "Must have formula transparency snippet");
  assert.ok(html.includes("DraftKings WebSocket"), "Must cite DraftKings source");
  assert.ok(html.includes("ufcstats.com"), "Must cite UFC Stats source");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
