// tests/8_test_every_fight_tape_and_pre2026_rule.js — Verifies Every Fight Tape & Pre-2026 Broadcast Cutoff Rule
const assert = require("assert");
const { getUpcomingFilmRoomCard } = require("../tape_engine");

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

console.log("\n── Every Fight Tape & Pre-2026 Broadcast Cutoff Verification ──");

const cardData = getUpcomingFilmRoomCard();

test("upcoming card has exactly all 12 verified UFC Fight Night bouts", () => {
  assert.strictEqual(cardData.card.length, 12, "Must have exactly 12 bouts on the card");
  assert.strictEqual(cardData.boutCount, 12, "boutCount field must be 12");
  
  // Verify Main Event and Co-Main are correctly placed
  assert.ok(cardData.card[0].fighter1.name.includes("Moicano") || cardData.card[0].fighter2.name.includes("Moicano"), "Moicano must headline");
  assert.ok(cardData.card[11].fighter1.name.includes("Brown") || cardData.card[11].fighter2.name.includes("Brown"), "Randy Brown must be on card");
});

test("every single fighter (24/24) has verified tape for their single most recent fight", () => {
  let fighterCount = 0;
  for (const bout of cardData.card) {
    for (const f of [bout.fighter1, bout.fighter2]) {
      fighterCount++;
      assert.ok(f.name && f.name.length > 2, "Fighter name must be valid");
      assert.ok(Array.isArray(f.tape), "Tape must be an array");
      assert.strictEqual(f.tape.length, 1, `${f.name} must have strictly 1 fight (the single last fight)`);
      
      const t = f.tape[0];
      assert.ok(t.matchup && t.matchup.length > 2, `${f.name} matchup must be present`);
      assert.ok(t.date && t.date.length > 2, `${f.name} date must be present`);
      assert.ok(t.result === "WIN" || t.result === "LOSS" || t.result === "DEC", `${f.name} result must be valid outcome`);
      assert.ok(t.videoId && t.videoId.length === 11, `${f.name} must have valid 11-char YouTube videoId`);
      assert.ok(t.videoType === "FULL FIGHT" || t.videoType === "HIGHLIGHTS", `${f.name} videoType must be FULL FIGHT or HIGHLIGHTS`);
    }
  }
  assert.strictEqual(fighterCount, 24, "Must verify all 24 fighters");
});

test("pre-2026 broadcast cutoff rule is strictly enforced across all 24 fighters", () => {
  let pre2026Count = 0;
  let post2026Count = 0;

  for (const bout of cardData.card) {
    for (const f of [bout.fighter1, bout.fighter2]) {
      const t = f.tape[0];
      const yearMatch = (t.date || "").match(/\b(20\d{2})\b/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : 2026;

      if (year < 2026) {
        pre2026Count++;
        assert.strictEqual(t.primaryPlatform, "fightpass", `${f.name} pre-2026 fight (${t.date}) MUST have primaryPlatform === 'fightpass'`);
        assert.strictEqual(t.links.paramount, null, `${f.name} pre-2026 fight (${t.date}) MUST NOT have a Paramount+ link (rights started 2026)`);
        assert.ok(t.links.fightPass.includes("ufcfightpass.com"), `${f.name} must have UFC Fight Pass link`);
      } else {
        post2026Count++;
        assert.strictEqual(t.primaryPlatform, "paramount", `${f.name} 2026+ fight (${t.date}) MUST have primaryPlatform === 'paramount'`);
        assert.ok(t.links.paramount && t.links.paramount.includes("paramountplus.com"), `${f.name} must have Paramount+ link`);
        assert.ok(t.links.fightPass.includes("ufcfightpass.com"), `${f.name} must also have UFC Fight Pass link`);
      }
    }
  }

  console.log(`    (Verified ${post2026Count} 2026+ Paramount broadcasts, ${pre2026Count} pre-2026 Fight Pass exclusives)`);
  assert.ok(pre2026Count >= 1, "Must catch pre-2026 fights like Lisboa or Szabova");
  assert.ok(post2026Count >= 10, "Must catch 2026+ Paramount broadcasts like Moicano, Nolan, Brown");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
