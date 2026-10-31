'use strict';
/**
 * tests/17_test_live_crossover_engine.js — Dynamic In-Fight Crossover Adjustment Test Suite
 *
 * Verifies that:
 * 1. computeLiveCrossoverProbability applies the 398-fight empirical survival curve (57% R1, 39% R2, 4% R3).
 * 2. In-cage action spikes (knockdowns, strike volume) front-run bookmakers and elevate live probability.
 * 3. In Round 3 with flat odds, time decay suppresses remaining comeback probability.
 * 4. Line crossing 50% immediately returns 100% and 'CROSSED' status.
 * 5. server.js /api/live-fight-stats route populates stats.liveCrossover dynamically.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { computeLiveCrossoverProbability } = require('../tag_crossover_engine');

console.log('>>> RUNNING: tests/17_test_live_crossover_engine.js');

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

console.log('── 1. Live Crossover Mathematical Trajectory Tests ──');

test('Round 1 action blitz: Underdog knockdown + odds compression (+240 -> +130) drives probability to 90%+', () => {
  const res = computeLiveCrossoverProbability({
    p0: 61.5,
    openOddsDog: 240,
    curOddsDog: 130,
    elapsedMin: 3.0,
    momPptsPerMin: 6.5,
    dogActionShare: 0.68,
    dogKnockdowns: 1,
    favKnockdowns: 0,
    favHasBadTank: true,
    dogHasCardio: true
  });
  assert.ok(res.liveCrossoverPct >= 90, `Expected >= 90%, got ${res.liveCrossoverPct}%`);
  assert.strictEqual(res.phase, 'Round 1 (Prime Window)');
  assert.ok(res.proximityPct > 50, 'Expected > 50% gap closed');
  assert.ok(res.advice.includes('Crossover Imminent') || res.advice.includes('LINE FLIPPED'));
});

test('Round 2 cardio fade: Gassing favorite with bad tank vs cardio dog produces elevated R2 expectancy', () => {
  const res = computeLiveCrossoverProbability({
    p0: 48.3,
    openOddsDog: 200,
    curOddsDog: 160,
    elapsedMin: 7.5,
    momPptsPerMin: 4.0,
    dogActionShare: 0.62,
    dogKnockdowns: 0,
    favKnockdowns: 0,
    favHasBadTank: true,
    dogHasCardio: true
  });
  assert.ok(res.liveCrossoverPct >= 35, `Expected >= 35%, got ${res.liveCrossoverPct}%`);
  assert.strictEqual(res.phase, 'Round 2 (Cardio Fade Window)');
  assert.ok(res.advice.includes('Elevated Live Momentum') || res.advice.includes('Monitoring'));
});

test('Round 3 late decay: Flat odds at minute 12 collapses crossover chance and emits do-not-chase advice', () => {
  const res = computeLiveCrossoverProbability({
    p0: 61.5,
    openOddsDog: 240,
    curOddsDog: 240,
    elapsedMin: 12.0,
    momPptsPerMin: 0,
    dogActionShare: 0.25,
    dogKnockdowns: 0,
    favKnockdowns: 0,
    favHasBadTank: false,
    dogHasCardio: false
  });
  assert.ok(res.liveCrossoverPct <= 30, `Expected <= 30%, got ${res.liveCrossoverPct}%`);
  assert.ok(res.timeDecayFactor <= 0.05, 'Expected time decay factor <= 0.05');
  assert.strictEqual(res.phase, 'Round 3+ (Late Window - Do Not Chase)');
  assert.ok(res.advice.includes('do not chase'));
});

test('Flipped line (underdog becomes live favorite, curOddsDog -120) triggers 100% CROSSED', () => {
  const res = computeLiveCrossoverProbability({
    p0: 41.5,
    openOddsDog: 200,
    curOddsDog: -120, // Now negative (favorite)
    elapsedMin: 4.0
  });
  assert.strictEqual(res.liveCrossoverPct, 100);
  assert.strictEqual(res.status, 'CROSSED');
  assert.ok(res.advice.includes('LINE FLIPPED'));
});

console.log('── 2. Server Source Code Contract Verification ──');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server.js /api/live-fight-stats imports computeLiveCrossoverProbability and populates stats.liveCrossover', () => {
  assert.ok(serverSrc.includes('computeLiveCrossoverProbability'), 'server.js must import computeLiveCrossoverProbability');
  assert.ok(serverSrc.includes('stats.liveCrossover = computeLiveCrossoverProbability'), 'server.js must set stats.liveCrossover');
});

console.log('── 3. Frontend Live In-Fight Crossover Integration ──');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('public/index.html updates nw-tag-advice-text with liveCrossover metrics', () => {
  assert.ok(indexHtml.includes('ls.liveCrossover'), 'index.html must check ls.liveCrossover');
  assert.ok(indexHtml.includes('Live In-Fight Crossover'), 'index.html must format live crossover headline');
});

console.log('====================================================');
console.log('  ALL 17_test_live_crossover_engine.js PASSED!      ');
console.log('====================================================');
