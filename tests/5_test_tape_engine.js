// tests/5_test_tape_engine.js — Verifies Film Room fight tape resolver & links
const assert = require("assert");
const { toSlug, getFighterTape, getUpcomingFilmRoomCard } = require("../tape_engine");

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

console.log("\n── Film Room & Fight Tape Resolver Tests ──");

test("toSlug handles accents and punctuation cleanly", () => {
  assert.strictEqual(toSlug("Alexander Volkanovski"), "alexander-volkanovski");
  assert.strictEqual(toSlug("Lucia Szabová"), "lucia-szabova");
  assert.strictEqual(toSlug("Sean O'Malley"), "sean-o-malley");
});

test("getFighterTape returns strictly the single most recent bout with Paramount+ & Fight Pass", () => {
  const tape = getFighterTape("Renato Moicano");
  assert.strictEqual(tape.length, 1, "Must return strictly single most recent fight");
  const b0 = tape[0];
  assert.ok(b0.matchup.includes("Moicano"));
  assert.ok(["WIN", "LOSS", "DEC"].includes(b0.result));
  assert.ok(b0.links.paramount.includes("paramountplus.com"));
  assert.ok(b0.links.fightPass.includes("ufcfightpass.com"));
  assert.ok(b0.links.youtube.includes("youtube.com"));
});

test("getFighterTape provides safe fallback for unindexed/new fighter", () => {
  const tape = getFighterTape("Unindexed Newcomer");
  assert.strictEqual(tape.length, 1);
  assert.ok(tape[0].links.fightPass.includes("Unindexed%20Newcomer"));
  assert.ok(tape[0].links.youtube.includes("Unindexed%20Newcomer"));
});

test("getUpcomingFilmRoomCard returns structured upcoming card with bouts", () => {
  const cardData = getUpcomingFilmRoomCard();
  assert.ok(cardData.card && cardData.card.length > 0, "Must have upcoming bouts");
  const bout = cardData.card[0];
  assert.ok(bout.boutId.includes("_vs_"));
  assert.ok(bout.fighter1.name.length > 0);
  assert.ok(bout.fighter2.name.length > 0);
  assert.ok(Array.isArray(bout.fighter1.tape));
  assert.ok(Array.isArray(bout.fighter2.tape));
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
