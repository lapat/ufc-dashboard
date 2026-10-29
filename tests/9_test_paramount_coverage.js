// tests/9_test_paramount_coverage.js — Enforces 100% Paramount+ Link Coverage
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getUpcomingFilmRoomCard, toSlug } = require("../tape_engine");

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

console.log("\n── Automated Paramount+ Link Coverage & Weekly Audit Tests ──");

const CACHE_PATH = path.join(__dirname, "..", "analysis", "paramount_tape_cache.json");
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
const cardData = getUpcomingFilmRoomCard();

test("paramount_tape_cache.json exists and contains verified ALVE GUIDs", () => {
  assert.ok(fs.existsSync(CACHE_PATH), "Cache file must exist");
  assert.ok(Object.keys(cache).length >= 15, "Cache must have at least 15 verified links");
  for (const [slug, entry] of Object.entries(cache)) {
    assert.ok(entry.contentId.startsWith("ALVE"), `${slug} contentId must start with ALVE`);
    assert.ok(entry.url.includes("/shows/video/ALVE"), `${slug} URL must be a direct video link`);
  }
});

test("every 2026+ fighter on the card has a direct ALVE video URL (Zero Missing Links)", () => {
  let post2026Count = 0;
  let missing = [];

  for (const bout of cardData.card) {
    for (const f of [bout.fighter1, bout.fighter2]) {
      const t = f.tape[0];
      const yearMatch = (t.date || "").match(/\b(20\d{2})\b/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : 2026;

      if (year >= 2026) {
        post2026Count++;
        const slug = toSlug(f.name);
        const hasCached = cache[slug] && cache[slug].url && cache[slug].url.includes("ALVE");
        const hasDirect = t.links && t.links.paramount && t.links.paramount.includes("ALVE");
        
        // Joseph Kropschot is an unindexed regional fighter making his debut, so we allow fallback
        if (!hasCached && !hasDirect) {
          missing.push(f.name);
        }
      }
    }
  }

  console.log(`    (Audited ${post2026Count} 2026+ fighters on card, missing: ${missing.length})`);
  assert.strictEqual(missing.length, 0, `Missing Paramount+ links for: ${missing.join(", ")}`);
});

test("Talita Alencar is explicitly verified with exact Paramount+ GUID", () => {
  const slug = toSlug("Talita Alencar");
  assert.ok(cache[slug], "Talita Alencar must be in cache");
  assert.strictEqual(cache[slug].contentId, "ALVE01KP66433SE629JDRMTK03A3PE", "Must match exact VOD ID");
  assert.ok(cache[slug].url.includes("ALVE01KP66433SE629JDRMTK03A3PE"), "Must be direct URL");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
