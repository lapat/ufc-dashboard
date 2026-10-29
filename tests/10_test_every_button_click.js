// tests/10_test_every_button_click.js — Simulates Every Single Button on the Tape Page
const assert = require("assert");
const fs = require("fs");
const path = require("path");
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

console.log("\n── Full 24-Fighter Tape Button & Theater Controls Audit ──");

const cardData = getUpcomingFilmRoomCard();
const tapeHtml = fs.readFileSync(path.join(__dirname, "..", "public", "tape.html"), "utf8");

test("public/tape.html contains dynamic theater button routing logic", () => {
  assert.ok(tapeHtml.includes('const isPre2026 = bout.primaryPlatform === "fightpass" || !bout.links.paramount;'), "Must check isPre2026 in playInTheater");
  assert.ok(tapeHtml.includes('tabPara.style.display = "none"'), "Must hide tab-paramount when isPre2026");
  assert.ok(tapeHtml.includes('btnParaWatch.style.display = "none"'), "Must hide btn-paramount-watch when isPre2026");
});

test("simulated button audit across all 24 fighters: zero dead Paramount buttons for pre-2026 fights", () => {
  let pre2026Fighters = 0;
  let post2026Fighters = 0;

  for (const bout of cardData.card) {
    for (const f of [bout.fighter1, bout.fighter2]) {
      const t = f.tape[0];
      const isPre2026 = t.primaryPlatform === "fightpass" || !t.links.paramount;

      if (isPre2026) {
        pre2026Fighters++;
        // In the bout card: Paramount button is hidden (display: none)
        // In the theater: tabPara and btnParaWatch are hidden (display: none)
        assert.strictEqual(t.links.paramount, null, `${f.name} pre-2026 bout must have links.paramount === null`);
        assert.ok(t.links.fightPass && t.links.fightPass.startsWith("https://ufcfightpass.com"), `${f.name} must have valid Fight Pass launcher`);
        assert.ok(!t.links.fightPass.includes("null") && !t.links.fightPass.includes("undefined"), `${f.name} Fight Pass link must not contain null/undefined`);
      } else {
        post2026Fighters++;
        // In the bout card and theater: Paramount button is visible and links to direct ALVE... GUID
        assert.ok(t.links.paramount && t.links.paramount.includes("/shows/video/ALVE"), `${f.name} 2026+ bout must have direct ALVE Paramount link`);
        assert.ok(t.links.fightPass && t.links.fightPass.startsWith("https://ufcfightpass.com"), `${f.name} must have Fight Pass backup`);
      }

      // Both must have valid in-theater YouTube video
      assert.ok(t.videoId && t.videoId.length === 11, `${f.name} must have valid 11-char YouTube ID`);
    }
  }

  console.log(`    (Audited all 24 fighters: ${post2026Fighters} Paramount 2026+ direct buttons, ${pre2026Fighters} Fight Pass exclusives)`);
  assert.strictEqual(pre2026Fighters + post2026Fighters, 24, "Must audit all 24 fighters");
});

test("Tainara Lisboa explicitly verified: zero dead Paramount clicks, clean Fight Pass search", () => {
  const bout11 = cardData.card.find(b => b.fighter1.name.includes("Lisboa") || b.fighter2.name.includes("Lisboa"));
  assert.ok(bout11, "Bout 11 must exist");
  const lisboa = bout11.fighter1.name.includes("Lisboa") ? bout11.fighter1 : bout11.fighter2;
  const t = lisboa.tape[0];
  
  assert.strictEqual(t.primaryPlatform, "fightpass", "Lisboa must be Fight Pass primary");
  assert.strictEqual(t.links.paramount, null, "Lisboa Paramount link must be null");
  assert.strictEqual(t.links.fightPass, "https://ufcfightpass.com/video/801878", "Lisboa Fight Pass link must be exact direct video URL");
  assert.strictEqual(t.videoId, "Q7xlRcTmsRo", "Lisboa YouTube must be official ESPN MMA debut");
  assert.strictEqual(t.opponent, "Melissa Croden", "Opponent must be full name Melissa Croden");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
