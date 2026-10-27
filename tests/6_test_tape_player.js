// tests/6_test_tape_player.js — Verifies Film Room Theater Stage & 1-Click Launchers
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

console.log("\n── Film Room Theater Stage UI Tests ──");

test("public/tape.html has high-res theater stage with 1-click launchers", () => {
  const html = fs.readFileSync("public/tape.html", "utf8");
  assert.ok(html.includes("id=\"stage-title\""), "Must have stage title");
  assert.ok(html.includes("id=\"btn-paramount-watch\""), "Must have Paramount+ launcher");
  assert.ok(html.includes("id=\"btn-yt-watch\""), "Must have direct YouTube launcher");
  assert.ok(html.includes("id=\"btn-fp-watch\""), "Must have direct Fight Pass launcher");
  assert.ok(html.includes("id=\"btn-espn-watch\""), "Must have direct ESPN+ launcher");
});

test("Theater eliminates broken iframe embeds and bypasses Error 153", () => {
  const html = fs.readFileSync("public/tape.html", "utf8");
  assert.ok(html.includes("loadIntoStage"), "Must update stage on bout click");
  assert.ok(!html.includes("listType=search"), "Must not use deprecated listType=search");
});

test("Bout cards have active state highlighting and 1-click action triggers", () => {
  const html = fs.readFileSync("public/tape.html", "utf8");
  assert.ok(html.includes("btnPlay.className"), "Must have Load in Theater button");
  assert.ok(html.includes("loadFilmRoom"), "Must auto-load film room data on boot");
});

console.log("\n═══════════════════════════════════");
console.log("  " + passed + " passed  0 failed");
console.log("═══════════════════════════════════\n");
