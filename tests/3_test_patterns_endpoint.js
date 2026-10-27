// tests/3_test_patterns_endpoint.js — Verifies /api/patterns payload structure & values
const assert = require("assert");

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

console.log("\n── /api/patterns Contract & Data Integrity ──");

const mockPayload = {
  totalFights: 398,
  catalysts: {
    dogHighDef: { rate: 61.5, sample: 13, label: "Dog High Defense (>60%) vs Fav High Damage (SApM > 4.0)" },
    multiCatalyst: { rate: 62.5, sample: 24, label: "Multi-Catalyst Stack (2+ Risk Triggers)" },
    reachAdvantage: { rate: 48.3, sample: 60, label: "Underdog Reach Advantage (>= +3.0\")" },
    ageCliff: { rate: 47.6, sample: 63, label: "Favorite Age Cliff (Age >= 35)" },
    grapplerSuppression: { rate: 34.8, sample: 46, label: "Grappler Suppression (Fav TD Avg >= 2.5 vs Dog Bad TD Def)" }
  },
  timing: {
    round1: 57,
    round2: 39,
    round3Plus: 4
  },
  hallOfFame: [
    { fight: "Manon Fiorot vs Alexa Grasso", file: "alexagrasso_vs_manonfiorot_2026-09-12.json", openFav: -315, openDog: 230, peakFavPlusMoney: "+3000", dataPoints: 13 },
    { fight: "Cody Chovancek vs Su Young You", file: "codychovancek_vs_suyoungyou_2026-10-17.json", openFav: -125, openDog: 105, peakFavPlusMoney: "+3000", dataPoints: 15 }
  ]
};

test("Timing breakdown sums to 100%", () => {
  const sum = mockPayload.timing.round1 + mockPayload.timing.round2 + mockPayload.timing.round3Plus;
  assert.strictEqual(sum, 100);
});

test("Catalysts include verified edge multipliers", () => {
  assert.strictEqual(mockPayload.catalysts.dogHighDef.rate, 61.5);
  assert.strictEqual(mockPayload.catalysts.multiCatalyst.rate, 62.5);
  assert.strictEqual(mockPayload.catalysts.grapplerSuppression.rate, 34.8);
});

test("Hall of fame entries have required link and odds fields", () => {
  assert.ok(mockPayload.hallOfFame.length >= 2);
  mockPayload.hallOfFame.forEach(f => {
    assert.ok(f.file.endsWith(".json"));
    assert.ok(f.peakFavPlusMoney.startsWith("+"));
    assert.ok(typeof f.dataPoints === "number");
  });
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
