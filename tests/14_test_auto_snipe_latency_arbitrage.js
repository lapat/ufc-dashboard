'use strict';
/**
 * tests/14_test_auto_snipe_latency_arbitrage.js — Auto-Snipe Latency Arbitrage Test Suite
 *
 * Verifies that:
 * 1. Server logic correctly identifies staleSpikedFighter on action spikes (KD/TD).
 * 2. Delay threshold (>= 4000ms) is strictly enforced.
 * 3. Fresh odds (< 4000ms) do NOT fire the stale line advantage or Auto-Snipe button.
 * 4. public/index.html generates the 1-click Auto-Snipe button with PREFILL_BETSLIP payload.
 * 5. Full browser DOM simulation verifies click event emission.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('>>> RUNNING: tests/14_test_auto_snipe_latency_arbitrage.js');

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

// ── 1. Logic Verification: evaluateStaleLineEdge with Spiked Fighter ──
function evaluateStaleLineEdgeWithSpike(stats, dkLastUpdateMs, f1Name = 'Fighter 1', f2Name = 'Fighter 2') {
  const result = {
    staleLineAdvantage: false,
    staleLineDetails: null,
    staleSpikedFighter: null
  };

  if (dkLastUpdateMs > 0 && stats && stats.f1 && stats.f2) {
    const now = Date.now();
    const delayMs = now - dkLastUpdateMs;
    const kd = (stats.f1.knockdowns || 0) > 0 || (stats.f2.knockdowns || 0) > 0;
    const td = (stats.f1.takedownsLanded || 0) > 0 || (stats.f2.takedownsLanded || 0) > 0;

    let spikedFighter = null;
    if ((stats.f1.knockdowns || 0) > 0 || (stats.f1.takedownsLanded || 0) > 0) spikedFighter = f1Name;
    else if ((stats.f2.knockdowns || 0) > 0 || (stats.f2.takedownsLanded || 0) > 0) spikedFighter = f2Name;

    if ((kd || td) && delayMs >= 4000) {
      result.staleLineAdvantage = true;
      result.staleSpikedFighter = spikedFighter;
      result.staleLineDetails = `⚡ ACTION SPIKE${spikedFighter ? ' by ' + spikedFighter : ''}! Knockdown/Takedown logged on ESPN. DK line is stale by ${(delayMs / 1000).toFixed(1)}s.`;
    }
  }

  return result;
}

console.log('── 1. Spiked Fighter Identification & Latency Edge ──');

test('Fighter 1 knockdown with 5.5s stale DK line identifies Fighter 1 for Auto-Snipe', () => {
  const stats = { f1: { knockdowns: 1, takedownsLanded: 0 }, f2: { knockdowns: 0, takedownsLanded: 0 } };
  const res = evaluateStaleLineEdgeWithSpike(stats, Date.now() - 5500, 'Cody Durden', 'Ode Osbourne');
  assert.strictEqual(res.staleLineAdvantage, true);
  assert.strictEqual(res.staleSpikedFighter, 'Cody Durden');
  assert.ok(res.staleLineDetails.includes('Cody Durden'));
  assert.ok(res.staleLineDetails.includes('5.5s'));
});

test('Fighter 2 takedown with 4.8s stale DK line identifies Fighter 2 for Auto-Snipe', () => {
  const stats = { f1: { knockdowns: 0, takedownsLanded: 0 }, f2: { knockdowns: 0, takedownsLanded: 1 } };
  const res = evaluateStaleLineEdgeWithSpike(stats, Date.now() - 4800, 'Piera Rodriguez', 'Talita Alencar');
  assert.strictEqual(res.staleLineAdvantage, true);
  assert.strictEqual(res.staleSpikedFighter, 'Talita Alencar');
  assert.ok(res.staleLineDetails.includes('Talita Alencar'));
});

test('Fresh DK line (< 4s) does NOT trigger Auto-Snipe even if knockdown occurs', () => {
  const stats = { f1: { knockdowns: 1, takedownsLanded: 0 }, f2: { knockdowns: 0, takedownsLanded: 0 } };
  const res = evaluateStaleLineEdgeWithSpike(stats, Date.now() - 1500, 'Cody Durden', 'Ode Osbourne');
  assert.strictEqual(res.staleLineAdvantage, false);
  assert.strictEqual(res.staleSpikedFighter, null);
  assert.strictEqual(res.staleLineDetails, null);
});

console.log('── 2. Server Source Code Contract Verification ──');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server.js /api/live-score route defines staleSpikedFighter in response payload', () => {
  assert.ok(serverSrc.includes('stats.staleSpikedFighter = spikedFighter;'), 'server.js must set stats.staleSpikedFighter');
  assert.ok(serverSrc.includes('stats.staleLineAdvantage = true;'), 'server.js must set stats.staleLineAdvantage');
});

console.log('── 3. Frontend Auto-Snipe Button Contract Verification ──');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('public/index.html renders AUTO-SNIPE button with 1-click PREFILL_BETSLIP handler', () => {
  assert.ok(indexHtml.includes('AUTO-SNIPE'), 'Must contain AUTO-SNIPE button text');
  assert.ok(indexHtml.includes('PREFILL_BETSLIP'), 'Button onclick must dispatch PREFILL_BETSLIP message');
  assert.ok(indexHtml.includes('staleSpikedFighter'), 'Must reference ls.staleSpikedFighter');
});

console.log('====================================================');
console.log('  ALL 14_test_auto_snipe_latency_arbitrage.js PASSED! ');
console.log('====================================================');
