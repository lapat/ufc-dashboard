#!/usr/bin/env node
const { execSync } = require("child_process");
const path = require("path");

const testFiles = [
  "test_fighter_stats.js",
  "test_crossover_predictor.js",
  "test_crossover_detector.js",
  "test_deriver.js",
  "tests/1_test_hedge_math.js",
  "tests/2_test_stale_line_edge.js",
  "tests/3_test_patterns_endpoint.js",
  "tests/4_test_live_and_self_fight_prevention.js",
  "tests/5_test_tape_engine.js",
  "tests/6_test_tape_player.js",
  "tests/7_test_provenance_audit.js",
  "tests/8_test_every_fight_tape_and_pre2026_rule.js",
  "tests/9_test_paramount_coverage.js",
  "tests/10_test_every_button_click.js",
  "tests/11_test_fighter_tags.js"
];

console.log("====================================================");
console.log("       LIVEBETBOT PRODUCTION TEST SUITE             ");
console.log("====================================================");

let totalPassedSuites = 0;

for (const tf of testFiles) {
  const fullPath = path.join(__dirname, "..", tf);
  console.log("\n>>> RUNNING: " + tf);
  try {
    const out = execSync("node " + fullPath, { encoding: "utf8" });
    console.log(out.trim());
    totalPassedSuites++;
  } catch (err) {
    console.error("FAILED: " + tf);
    console.error(err.stdout || err.message);
    process.exit(1);
  }
}

console.log("\n====================================================");
console.log("  ALL " + totalPassedSuites + "/" + testFiles.length + " TEST SUITES PASSED CLEANLY!");
console.log("  READY FOR LIVE UFC BETTING WITH ZERO REGRESSIONS  ");
console.log("====================================================\n");
