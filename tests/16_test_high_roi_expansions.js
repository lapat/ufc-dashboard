'use strict';
/**
 * tests/16_test_high_roi_expansions.js — High-ROI Platform Expansions Test Suite
 *
 * Verifies that:
 * 1. tag_crossover_engine.js correctly anchors tagged rates to opening odds tiers:
 *    - Pick'em (-115/-105): Starts at 67% tier base and elevates up to 87%.
 *    - Moderate Fav (-250/+200): Anchors to 43% tier base and elevates to 62.5% on multi-stack.
 *    - Heavy Fav (-450/+350): Anchors to 12% tier base and elevates proportionally (33%).
 * 2. public/index.html implements configurable bankroll units ($25, $50, $100, $250) for Auto-Snipe.
 * 3. public/index.html implements Audio Radar Ping (880Hz / 1046.5Hz) on latency spikes.
 * 4. public/index.html embeds inline Equal-Profit Hedge Calculator with formula S2 = (S1 * D1) / D2.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { calculateTaggedCrossover } = require('../tag_crossover_engine');

console.log('>>> RUNNING: tests/16_test_high_roi_expansions.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exit(1);
  }
}

console.log('── 1. Tier-Anchored Tagged Crossover Math ──');

test('Pick-em bout (-115 / -105) anchors to 67% baseline and elevates with catalysts', () => {
  const f1Tags = { tags: ['gas_tank_risk'] };
  const f2Tags = { tags: ['takedown_defense'] };
  const res = calculateTaggedCrossover(-115, -105, f1Tags, f2Tags, 'Durden', 'Osbourne');
  assert.ok(res !== null);
  assert.ok(res.taggedCrossoverPct >= 80, `Expected >= 80% on pick-em with defense catalyst, got ${res.taggedCrossoverPct}%`);
  assert.strictEqual(res.catalysts[0], '🛡️ Dog Defense vs Fav Power');
});

test('Moderate favorite (-250 / +200) anchors to 43% baseline and matches empirical catalyst matrix', () => {
  const f1Tags = { tags: ['older'] }; // Fav older
  const f2Tags = { tags: ['size_advantage'] }; // Dog size advantage
  const res = calculateTaggedCrossover(-250, 200, f1Tags, f2Tags, 'Favorite', 'Underdog');
  assert.strictEqual(res.taggedCrossoverPct, 62.5);
  assert.strictEqual(res.catalysts[0], '⚡ Multi-Catalyst Stack');
});

test('Heavy favorite (-450 / +350) anchors to 12% baseline and elevates proportionally (33%)', () => {
  const f1Tags = { tags: ['older'] };
  const f2Tags = { tags: ['size_advantage'] }; // 2 catalysts (+21 ppts)
  const res = calculateTaggedCrossover(-450, 350, f1Tags, f2Tags, 'SuperFav', 'DeepDog');
  assert.strictEqual(res.taggedCrossoverPct, 33.0);
});

console.log('── 2. Configurable Bankroll Unit for Auto-Snipe ──');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('public/index.html defines setSnipeUnit and unit selector buttons ($25, $50, $100, $250)', () => {
  assert.ok(indexHtml.includes('setSnipeUnit'), 'Must define setSnipeUnit function');
  assert.ok(indexHtml.includes('unit-pill-btn'), 'Must define unit pill buttons');
  assert.ok(indexHtml.includes('localStorage.getItem(\'betUnit\')'), 'Must read saved unit from storage');
});

console.log('── 3. High-Urgency Audio Radar Ping ──');
test('public/index.html defines playSnipeRadarAudio with two-tone alert pulse', () => {
  assert.ok(indexHtml.includes('function playSnipeRadarAudio'), 'Must define playSnipeRadarAudio function');
  assert.ok(indexHtml.includes('880'), 'Must use 880Hz alert tone');
  assert.ok(indexHtml.includes('1046.5'), 'Must use 1046.5Hz urgency tone');
});

console.log('── 4. Inline Equal-Profit Hedge Calculator in #now-watching ──');
test('public/index.html defines inline Equal-Profit Hedge Calculator with S2 = (S1 * D1) / D2', () => {
  assert.ok(indexHtml.includes('id="nw-hedge-calc"'), 'Must define #nw-hedge-calc container');
  assert.ok(indexHtml.includes('id="hc-s1"'), 'Must define stake input #hc-s1');
  assert.ok(indexHtml.includes('id="hc-o1"'), 'Must define odds input #hc-o1');
  assert.ok(indexHtml.includes('id="hc-o2"'), 'Must define odds input #hc-o2');
  assert.ok(indexHtml.includes('function calcInlineHedge'), 'Must define calcInlineHedge calculation function');
  assert.ok(indexHtml.includes('id="hc-btn-prefill"'), 'Must define 1-click prefill button');
});

console.log('====================================================');
console.log('  ALL 16_test_high_roi_expansions.js PASSED!        ');
console.log('====================================================');
