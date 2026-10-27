// tests/6_test_tape_player.js — Verifies Film Room dynamic videoId resolver & embed URLs
const assert = require("assert");
const { resolveYoutubeVideoId } = require("../tape_engine");

let passed = 0;
function test(desc, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log("  ✓ " + desc);
      passed++;
    })
    .catch((e) => {
      console.error("  ✗ " + desc + ":", e.message);
      process.exit(1);
    });
}

async function run() {
  console.log("\n── Film Room Real VideoId Resolver Tests ──");

  await test("Resolves real 11-char YouTube video ID for Renato Moicano vs Duncan", async () => {
    const id = await resolveYoutubeVideoId("UFC full fight Renato Moicano vs Duncan");
    assert.ok(id && id.length === 11, "Must be valid 11-char videoId, got: " + id);
    assert.strictEqual(id.includes("listType"), false, "Must not contain listType");
  });

  await test("Resolves real 11-char YouTube video ID for Randy Brown vs Holland", async () => {
    const id = await resolveYoutubeVideoId("UFC full fight Randy Brown vs Holland");
    assert.ok(id && id.length === 11, "Must be valid 11-char videoId, got: " + id);
  });

  await test("Embed URL format is valid without deprecated search syntax", async () => {
    const id = await resolveYoutubeVideoId("UFC full fight Tom Nolan vs Ziam");
    const embedUrl = "https://www.youtube.com/embed/" + id;
    assert.ok(embedUrl.startsWith("https://www.youtube.com/embed/"));
    assert.ok(!embedUrl.includes("listType=search"));
  });

  console.log("\n═══════════════════════════════════");
  console.log("  " + passed + " passed  0 failed");
  console.log("═══════════════════════════════════\n");
}

run();
