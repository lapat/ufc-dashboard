#!/usr/bin/env node
// test_crossover_predictor.js
'use strict';
const { predictCrossover, assessCrossoverRisk } = require('./crossover_predictor');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── predictCrossover ─────────────────────────────────────────────────────────

console.log('\n── predictCrossover: null / invalid ──');

check('returns null for NaN input', () => {
  assert(predictCrossover({ f1OpeningOdds: 'x', f2OpeningOdds: '+130' }) === null);
});
check('returns null when both missing', () => {
  assert(predictCrossover({ f1OpeningOdds: null, f2OpeningOdds: null }) === null);
});

console.log('\n── predictCrossover: tier mapping ──');

check('pick_em (<130 fav) → strong signal, 61%', () => {
  const r = predictCrossover({ f1OpeningOdds: -116, f2OpeningOdds: -102 });
  assert(r.tier === 'pick_em', 'tier: ' + r.tier);
  assert(r.crossoverProbPct === 61, 'prob: ' + r.crossoverProbPct);
  assert(r.signal === 'strong', 'signal: ' + r.signal);
});

check('slight_fav (-165/+138) → moderate signal, 47%', () => {
  const r = predictCrossover({ f1OpeningOdds: -165, f2OpeningOdds: 138 });
  assert(r.tier === 'slight_fav', r.tier);
  assert(r.crossoverProbPct === 47, r.crossoverProbPct);
  assert(r.signal === 'moderate', r.signal);
});

check('moderate_fav (-250/+200) → low signal, 33%', () => {
  const r = predictCrossover({ f1OpeningOdds: -250, f2OpeningOdds: 200 });
  assert(r.tier === 'moderate_fav', r.tier);
  assert(r.crossoverProbPct === 33, r.crossoverProbPct);
  assert(r.signal === 'low', r.signal);
});

check('heavy_fav (-400) → none signal, 15%', () => {
  const r = predictCrossover({ f1OpeningOdds: -400, f2OpeningOdds: 300 });
  assert(r.tier === 'heavy_fav', r.tier);
  assert(r.crossoverProbPct === 15, r.crossoverProbPct);
  assert(r.signal === 'none', r.signal);
});

check('extreme_fav (-700) → 0% crossover', () => {
  const r = predictCrossover({ f1OpeningOdds: -700, f2OpeningOdds: 480 });
  assert(r.tier === 'extreme_fav', r.tier);
  assert(r.crossoverProbPct === 0, r.crossoverProbPct);
  assert(r.signal === 'none', r.signal);
});

console.log('\n── predictCrossover: odds direction agnostic ──');

check('f1 can be the underdog', () => {
  const r = predictCrossover({ f1OpeningOdds: 200, f2OpeningOdds: -250 });
  assert(r.tier === 'moderate_fav', r.tier);
  assert(r.dogOdds === 200, 'dog: ' + r.dogOdds); // f1 is the dog
});

check('symmetric: swapping f1/f2 gives same crossover prob', () => {
  const a = predictCrossover({ f1OpeningOdds: -200, f2OpeningOdds: 165 });
  const b = predictCrossover({ f1OpeningOdds: 165,  f2OpeningOdds: -200 });
  assert(a.crossoverProbPct === b.crossoverProbPct, a.crossoverProbPct + ' vs ' + b.crossoverProbPct);
  assert(a.tier === b.tier, a.tier + ' vs ' + b.tier);
});

console.log('\n── predictCrossover: edge calculation ──');

check('expected dog win rate is a blend of crossover and non-crossover rates', () => {
  // pick_em: 61% × 50% + 39% × 12% = 30.5% + 4.68% = 35.18% ≈ 35%
  const r = predictCrossover({ f1OpeningOdds: -120, f2OpeningOdds: 100 });
  assert(r.expectedDogWinRate >= 33 && r.expectedDogWinRate <= 38,
    'expected: ' + r.expectedDogWinRate);
});

check('implied dog win rate makes sense for positive odds', () => {
  const r = predictCrossover({ f1OpeningOdds: -250, f2OpeningOdds: 200 });
  // +200 → implied = 100/(200+100) = 33%
  assert(r.impliedDogWinRate === 33, r.impliedDogWinRate);
});

check('crossoverEdge is expectedDogWinRate - impliedDogWinRate (approx)', () => {
  const r = predictCrossover({ f1OpeningOdds: -165, f2OpeningOdds: 138 });
  const manualEdge = r.expectedDogWinRate - r.impliedDogWinRate;
  // crossoverEdge is in ppts, manualEdge is also in ppts (both ×100)
  assert(Math.abs(r.crossoverEdge - manualEdge) <= 2, // allow tiny rounding
    `edge ${r.crossoverEdge} vs manual ${manualEdge}`);
});

console.log('\n── predictCrossover: output shape ──');

check('all required fields present', () => {
  const r = predictCrossover({ f1OpeningOdds: -200, f2OpeningOdds: 165 });
  const required = ['crossoverProb','crossoverProbPct','tier','tightness','dogOdds','dogOddsStr',
                    'impliedDogWinRate','expectedDogWinRate','crossoverEdge','signal','advice',
                    'earlyWindowPct','medWindowPct'];
  for (const k of required) assert(k in r, 'missing: ' + k);
});

check('advice is a non-empty string', () => {
  const r = predictCrossover({ f1OpeningOdds: -165, f2OpeningOdds: 138 });
  assert(typeof r.advice === 'string' && r.advice.length > 10, 'advice: ' + r.advice);
});

check('dogOddsStr has correct sign prefix', () => {
  const pos = predictCrossover({ f1OpeningOdds: -200, f2OpeningOdds: 165 });
  assert(pos.dogOddsStr === '+165', pos.dogOddsStr);
  const neg = predictCrossover({ f1OpeningOdds: -116, f2OpeningOdds: -102 });
  assert(neg.dogOddsStr.startsWith('-'), neg.dogOddsStr);
});

// ── assessCrossoverRisk ──────────────────────────────────────────────────────

console.log('\n── assessCrossoverRisk ──');

function makeFight(winner, crossoverOccurred, openF1, openF2) {
  return {
    outcome: { winner, crossoverOccurred, openingF1Odds: openF1, openingF2Odds: openF2 }
  };
}

check('returns null for empty pool', () => {
  assert(assessCrossoverRisk([], {}) === null);
});

check('100% crossover rate when all fights cross', () => {
  const pool = [
    makeFight('fighter1', true, 150, -180),
    makeFight('fighter2', true, 150, -180),
    makeFight('fighter1', true, 150, -180),
  ];
  const r = assessCrossoverRisk(pool, {});
  assert(r.empiricalCrossoverRate === 100, r.empiricalCrossoverRate);
  assert(r.crossoverFightCount === 3, r.crossoverFightCount);
  assert(r.noCrossoverFightCount === 0, r.noCrossoverFightCount);
});

check('0% crossover rate when no fights cross', () => {
  const pool = [
    makeFight('fighter1', false, -200, 165),
    makeFight('fighter1', false, -200, 165),
  ];
  const r = assessCrossoverRisk(pool, {});
  assert(r.empiricalCrossoverRate === 0, r.empiricalCrossoverRate);
});

check('dog win rates computed correctly for crossover fights', () => {
  const pool = [
    // Dog = f1 (f1 is positive odds), crossover: dog wins
    makeFight('fighter1', true,  150, -180),
    // crossover: fav wins (dog loses)
    makeFight('fighter2', true,  150, -180),
    // no crossover: fav wins
    makeFight('fighter2', false, 150, -180),
  ];
  const r = assessCrossoverRisk(pool, {});
  assert(r.crossoverFightCount === 2, r.crossoverFightCount);
  assert(r.dogWinRateOnCross === 50, r.dogWinRateOnCross); // 1/2
  assert(r.dogWinRateNoCross === 0, r.dogWinRateNoCross);  // 0/1
});

check('all required output fields present', () => {
  const pool = [makeFight('fighter1', true, 150, -180), makeFight('fighter2', false, 150, -180)];
  const r = assessCrossoverRisk(pool, {});
  const required = ['empiricalCrossoverRate','crossoverFightCount','noCrossoverFightCount',
                    'dogWinRateOnCross','dogWinRateNoCross'];
  for (const k of required) assert(k in r, 'missing: ' + k);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
