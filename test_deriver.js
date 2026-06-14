#!/usr/bin/env node
// test_deriver.js — Tests for derived fields from oddsHistory
'use strict';

const { deriveFields, estimateRound } = require('./deriver');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function makeHistory(oddsValues) {
  const baseTs = new Date('2026-01-01T20:00:00Z');
  return oddsValues.map((odds, i) => ({
    timestamp: new Date(baseTs.getTime() + i * 60000).toISOString(), // 1 min apart
    fighter1:  { numericOdds: odds,       name: 'A' },
    fighter2:  { numericOdds: -odds - 20, name: 'B' },
  }));
}

// ── estimateRound ─────────────────────────────────────────────────────────────

console.log('\n── estimateRound ──');

check('minute 0 → round 1',   () => assert(estimateRound(0)  === 1, estimateRound(0)));
check('minute 4 → round 1',   () => assert(estimateRound(4)  === 1, estimateRound(4)));
check('minute 6 → round 2',   () => assert(estimateRound(6)  === 2, estimateRound(6)));
check('minute 11 → round 2',  () => assert(estimateRound(11) === 2, estimateRound(11)));
check('minute 12 → round 3',  () => assert(estimateRound(12) === 3, estimateRound(12)));
check('minute 18 → round 4',  () => assert(estimateRound(18) === 4, estimateRound(18)));
check('minute 24 → round 5',  () => assert(estimateRound(24) === 5, estimateRound(24)));
check('minute 30 → capped 5', () => assert(estimateRound(30) === 5, estimateRound(30)));
check('null → null',          () => assert(estimateRound(null) === null));

// ── deriveFields: null returns ────────────────────────────────────────────────

console.log('\n── deriveFields: null returns ──');

check('returns null for empty oddsHistory', () => {
  assert(deriveFields({ oddsHistory: [] }) === null);
});

check('returns null for < 5 data points', () => {
  const data = { oddsHistory: makeHistory([-150, -160, -170, -180]) };
  assert(deriveFields(data) === null);
});

check('returns null when opening odds missing', () => {
  const h = [{ timestamp: '2026-01-01T20:00:00Z', fighter1: {}, fighter2: { numericOdds: 130 } }];
  for (let i = 0; i < 10; i++) h.push(h[0]);
  assert(deriveFields({ oddsHistory: h }) === null);
});

// ── peakOddsSwing ─────────────────────────────────────────────────────────────

console.log('\n── peakOddsSwing ──');

check('swing of 0 when odds flat', () => {
  const data = { oddsHistory: makeHistory(Array(20).fill(-150)) };
  const r = deriveFields(data);
  assert(r !== null, 'should return result');
  assert(r.peakOddsSwing === 0, 'flat odds: ' + r.peakOddsSwing);
});

check('swing matches actual movement', () => {
  // Opens at -150, moves to -350 (200pt swing)
  const odds = Array(10).fill(-150).concat(Array(10).fill(-350));
  const data = { oddsHistory: makeHistory(odds) };
  const r = deriveFields(data);
  assert(r.peakOddsSwing === 200, 'expected 200, got ' + r.peakOddsSwing);
});

check('swing uses absolute value (positive underdog)', () => {
  // Opens at +150, moves to +350 (200pt swing)
  const odds = Array(10).fill(150).concat(Array(10).fill(350));
  const data = { oddsHistory: makeHistory(odds) };
  const r = deriveFields(data);
  assert(r.peakOddsSwing === 200, 'expected 200, got ' + r.peakOddsSwing);
});

// ── inferredFinishRound ───────────────────────────────────────────────────────

console.log('\n── inferredFinishRound ──');

check('no finish round when odds never go extreme', () => {
  const data = { oddsHistory: makeHistory(Array(30).fill(-150)) };
  const r = deriveFields(data);
  assert(r.inferredFinishRound === null, 'should be null: ' + r.inferredFinishRound);
  assert(r.inferredFinishMin   === null, 'should be null: ' + r.inferredFinishMin);
});

check('detects finish when f1 goes extreme (> 800)', () => {
  // 5 min of normal odds, then extreme at minute 6
  const odds = Array(5).fill(-150).concat([-900]);
  const rest = Array(14).fill(-900);
  const data = { oddsHistory: makeHistory([...odds, ...rest]) };
  const r = deriveFields(data);
  assert(r.inferredFinishRound !== null, 'should detect finish');
  assert(r.inferredFinishRound >= 1 && r.inferredFinishRound <= 5, 'round in range: ' + r.inferredFinishRound);
});

check('detects finish when f2 goes extreme', () => {
  // Build history where f2 becomes extreme (f1 goes very positive)
  const baseTs = new Date('2026-01-01T20:00:00Z');
  const h = [];
  for (let i = 0; i < 20; i++) {
    const f1Odds = i < 10 ? -150 : 900; // f1 at +900 means f2 is dominant
    h.push({
      timestamp: new Date(baseTs.getTime() + i * 60000).toISOString(),
      fighter1: { numericOdds: f1Odds, name: 'A' },
      fighter2: { numericOdds: f1Odds < 0 ? 130 : -1100, name: 'B' },
    });
  }
  const r = deriveFields({ oddsHistory: h });
  // f2 is at -1100 in second half → extreme → should detect
  // But our code checks Math.abs(f1) or Math.abs(f2) > 800
  // f1 = 900 → |900| = 900 > 800 → detected
  assert(r !== null && r.inferredFinishRound !== null, 'should detect finish');
});

check('R1 finish (odds go extreme at minute 3)', () => {
  const baseTs = new Date('2026-01-01T20:00:00Z');
  const h = [];
  for (let i = 0; i < 30; i++) {
    h.push({
      timestamp: new Date(baseTs.getTime() + i * 60000).toISOString(),
      fighter1: { numericOdds: i < 3 ? -150 : -1200, name: 'A' },
      fighter2: { numericOdds: i < 3 ? 130  : 850,   name: 'B' },
    });
  }
  const r = deriveFields({ oddsHistory: h });
  assert(r.inferredFinishRound === 1, 'should be R1: got R' + r.inferredFinishRound);
});

check('R3 finish (odds go extreme at minute 14)', () => {
  const baseTs = new Date('2026-01-01T20:00:00Z');
  const h = [];
  for (let i = 0; i < 30; i++) {
    h.push({
      timestamp: new Date(baseTs.getTime() + i * 60000).toISOString(),
      fighter1: { numericOdds: i < 14 ? -148 : -2000, name: 'A' },
      fighter2: { numericOdds: i < 14 ?  124 :  1200, name: 'B' },
    });
  }
  const r = deriveFields({ oddsHistory: h });
  assert(r.inferredFinishRound === 3, 'should be R3: got R' + r.inferredFinishRound);
  assert(r.inferredFinishMin === 14, 'should be 14 min: got ' + r.inferredFinishMin);
});

// ── finishSpeed ───────────────────────────────────────────────────────────────

console.log('\n── finishSpeed ──');

check('decision when no extreme odds', () => {
  const data = { oddsHistory: makeHistory(Array(30).fill(-150)) };
  const r = deriveFields(data);
  assert(r.finishSpeed === 'decision', r.finishSpeed);
});

check('fast when odds spike immediately', () => {
  // Odds go extreme at minute 1 (very fast)
  const baseTs = new Date('2026-01-01T20:00:00Z');
  const h = Array(30).fill(null).map((_, i) => ({
    timestamp: new Date(baseTs.getTime() + i * 60000).toISOString(),
    fighter1: { numericOdds: i === 0 ? -150 : -1500, name: 'A' },
    fighter2: { numericOdds: i === 0 ?  130 :  1000, name: 'B' },
  }));
  // Skip first 5% (search start) — put extreme at index 3
  h[3].fighter1.numericOdds = -1500;
  const r = deriveFields({ oddsHistory: h });
  assert(['fast','medium'].includes(r.finishSpeed), 'fast or medium for quick finish: ' + r.finishSpeed);
});

// ── dominanceScore ────────────────────────────────────────────────────────────

console.log('\n── dominanceScore ──');

check('100% dominance when always at -500', () => {
  const data = { oddsHistory: makeHistory(Array(20).fill(-500)) };
  const r = deriveFields(data);
  assert(r.dominanceScore === 100, r.dominanceScore);
});

check('0% dominance when always near even odds', () => {
  const data = { oddsHistory: makeHistory(Array(20).fill(-110)) };
  const r = deriveFields(data);
  assert(r.dominanceScore === 0, r.dominanceScore);
});

check('partial dominance', () => {
  // Half the fight at -110 (not dominant), half at -400 (dominant)
  const odds = Array(10).fill(-110).concat(Array(10).fill(-400));
  const data = { oddsHistory: makeHistory(odds) };
  const r = deriveFields(data);
  assert(r.dominanceScore > 0 && r.dominanceScore < 100,
    'partial: ' + r.dominanceScore);
});

// ── crossoverCount ────────────────────────────────────────────────────────────

console.log('\n── crossoverCount ──');

check('0 crossovers when no sign change', () => {
  const data = { oddsHistory: makeHistory([-150, -160, -140, -200, -180]) };
  const r = deriveFields(data);
  assert(r.crossoverCount === 0, r.crossoverCount);
  // Need more than 5 pts
  const data2 = { oddsHistory: makeHistory(Array(10).fill(-150)) };
  const r2 = deriveFields(data2);
  assert(r2.crossoverCount === 0, r2.crossoverCount);
});

check('1 crossover when line crosses once', () => {
  // Starts negative (f1 fav), goes positive (f1 becomes dog)
  const odds = Array(10).fill(-150).concat(Array(10).fill(130));
  const data = { oddsHistory: makeHistory(odds) };
  const r = deriveFields(data);
  assert(r.crossoverCount === 1, 'expected 1, got ' + r.crossoverCount);
});

check('2 crossovers when line crosses twice', () => {
  const odds = Array(8).fill(-150).concat(Array(8).fill(130)).concat(Array(8).fill(-120));
  const data = { oddsHistory: makeHistory(odds) };
  const r = deriveFields(data);
  assert(r.crossoverCount === 2, 'expected 2, got ' + r.crossoverCount);
});

// ── Full output shape ─────────────────────────────────────────────────────────

console.log('\n── Output shape ──');

check('all required fields present', () => {
  const data = { oddsHistory: makeHistory(Array(20).fill(-150)) };
  const r = deriveFields(data);
  const required = ['inferredFinishMin','inferredFinishRound','peakOddsSwing',
                    'finishSpeed','preFightSteam','dominanceScore','crossoverCount','derivedAt'];
  for (const k of required) assert(k in r, 'missing: ' + k);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
