// tests/6_test_tape_player.js — Verifies In-Theater Streaming, Direct Launchers & Extension Header Unblocker
const assert = require("assert");
const fs = require("fs");

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

console.log("\n── Film Room Theater, In-Theater Streaming & Direct Launchers Tests ──");

test("public/tape.html has in-theater iframe player and streaming source tabs", () => {
  const html = fs.readFileSync("public/tape.html", "utf8");
  assert.ok(html.includes("id=\"theater-frame\""), "Must have in-theater iframe frame");
  assert.ok(html.includes("id=\"tab-stage\""), "Must have Stage launcher tab");
  assert.ok(html.includes("id=\"tab-paramount\""), "Must have Paramount+ in-theater tab");
  assert.ok(html.includes("id=\"tab-fightpass\""), "Must have Fight Pass in-theater tab");
  assert.ok(html.includes("id=\"tab-youtube\""), "Must have YouTube in-theater tab");
});

test("public/tape.html has high-definition theater stage with direct 1-click launchers", () => {
  const html = fs.readFileSync("public/tape.html", "utf8");
  assert.ok(html.includes("id=\"stage-title\""), "Must have stage title");
  assert.ok(html.includes("id=\"btn-paramount-watch\""), "Must have Paramount+ launcher");
  assert.ok(html.includes("id=\"btn-fp-watch\""), "Must have direct Fight Pass launcher");
  assert.ok(html.includes("id=\"btn-yt-watch\""), "Must have direct YouTube launcher");
  assert.ok(html.includes("id=\"btn-espn-watch\""), "Must have direct ESPN+ launcher");
});

test("dk-extension has declarativeNetRequest rules stripping x-frame-options for in-theater streaming", () => {
  const manifest = JSON.parse(fs.readFileSync("dk-extension/manifest.json", "utf8"));
  assert.ok(manifest.permissions.includes("declarativeNetRequest"), "Must have declarativeNetRequest permission");
  assert.ok(fs.existsSync("dk-extension/rules.json"), "Must have rules.json");
  const rules = JSON.parse(fs.readFileSync("dk-extension/rules.json", "utf8"));
  assert.ok(rules.length >= 1, "Must have header rules");
  assert.strictEqual(rules[0].action.type, "modifyHeaders");
  const hasXFrame = rules[0].action.responseHeaders.some(h => h.header === "x-frame-options" && h.operation === "remove");
  assert.ok(hasXFrame, "Must strip x-frame-options");
});

test("public/tape.html handles bout card play triggers and updates in-theater frame", () => {
  const html = fs.readFileSync("public/tape.html", "utf8");
  assert.ok(html.includes("playInTheater"), "Must have playInTheater function");
  assert.ok(html.includes("btnPlay.className = \"bc-btn play\""), "Must have Load in Theater button");
  assert.ok(html.includes("updateTheaterStream"), "Must update stream inside theater");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
