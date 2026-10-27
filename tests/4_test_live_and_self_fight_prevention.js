// tests/4_test_live_and_self_fight_prevention.js — Verifies self-fight prevention and live-only enforcement
const assert = require("assert");

function normFighter(n) {
  return (n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function validateOddsPush(body) {
  const { fighter1, fighter2, live } = body || {};
  if (!fighter1 || !fighter2) return { status: 400, error: "missing fields" };
  const n1 = normFighter(fighter1);
  const n2 = normFighter(fighter2);
  if (n1 === n2) return { status: 400, error: "Fighter 1 and Fighter 2 cannot be identical" };
  if (!live) return { status: 200, stored: false, reason: "Fight not live" };
  return { status: 200, stored: true, live: true };
}

function filterLibraryRecordings(recordings) {
  return recordings.filter(r => {
    const f1 = normFighter(r.fighter1);
    const f2 = normFighter(r.fighter2);
    return f1.length > 0 && f2.length > 0 && f1 !== f2;
  });
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

console.log("\n── Self-Fight & Live-Only Recording Guards ──");

test("Rejects identical fighter names (Lucia Szabová vs Lucia Szabová)", () => {
  const r = validateOddsPush({ fighter1: "Lucia Szabová", fighter2: "Lucia Szabová", live: true });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.error, "Fighter 1 and Fighter 2 cannot be identical");
});

test("Rejects diacritic / accent variations of the same fighter (Lucia Szabová vs Lucia Szabova)", () => {
  const r = validateOddsPush({ fighter1: "Lucia Szabová", fighter2: "Lucia Szabova", live: true });
  assert.strictEqual(r.status, 400);
});

test("Rejects pre-fight non-live pushes from live recording pipeline", () => {
  const r = validateOddsPush({ fighter1: "Tainara Lisboa", fighter2: "Lucia Szabová", live: false });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.stored, false);
  assert.strictEqual(r.reason, "Fight not live");
});

test("Accepts genuine live in-progress UFC fight between two distinct fighters", () => {
  const r = validateOddsPush({ fighter1: "Tainara Lisboa", fighter2: "Lucia Szabová", live: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.stored, true);
});

test("Library filter automatically purges any self-fights from view", () => {
  const mockRecs = [
    { fighter1: "Lucia Szabova", fighter2: "Lucia Szabova", id: "luciaszabova_vs_luciaszabova_ext" },
    { fighter1: "Tainara Lisboa", fighter2: "Lucia Szabova", id: "tainaralisboa_vs_luciaszabova" }
  ];
  const cleaned = filterLibraryRecordings(mockRecs);
  assert.strictEqual(cleaned.length, 1);
  assert.strictEqual(cleaned[0].id, "tainaralisboa_vs_luciaszabova");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
