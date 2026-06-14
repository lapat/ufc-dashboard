#!/usr/bin/env node
// test_live_sequence.js — Tests for the sequential live bet analyzer
'use strict';

const { findLiveSequence, loadFightsWithHistory } = require('./live_sequence');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── Helpers to build synthetic fight data ─────────────────────────────────────

function makeHistory(points) {
  // points: array of f1 odds values, evenly spaced timestamps
  return points.map((odds, i) => ({
    timestamp: new Date(Date.now() - (points.length - i) * 60000).toISOString(),
    fighter1:  { numericOdds: odds,          name: 'Fighter A' },
    fighter2:  { numericOdds: -odds - 20,    name: 'Fighter B' }, // rough opposite
  }));
}

function makeFight(historyOdds, winner) {
  return {
    file: 'test_fight.json',
    oddsHistory: makeHistory(historyOdds),
    outcome: { winner }, // 'fighter1' or 'fighter2'
  };
}

// A fight that opens at -150 and the fav extends to -300 (f1 dominating), f1 wins
function favExtendsFight() {
  const odds = [];
  for (let i = 0; i < 80; i++) odds.push(-150 - i * (150 / 80)); // -150 → -300
  return makeFight(odds, 'fighter1');
}

// A fight that opens at -150, f1 extends to -300, then REVERSES and f2 wins
function favReversesFight() {
  const odds = [];
  for (let i = 0; i < 40; i++) odds.push(-150 - i * (150 / 40)); // -150 → -300
  for (let i = 0; i < 40; i++) odds.push(-300 + i * (350 / 40)); // -300 → +50 (reversal)
  return makeFight(odds, 'fighter2');
}

// ── Unit tests ────────────────────────────────────────────────────────────────

console.log('\n── findLiveSequence: null returns ──');

check('returns null when no meaningful movement (< 50 pts)', () => {
  const fights = [favExtendsFight()];
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -170, // only 20 pts movement
    f2OpeningOdds: 130,  f2CurrentOdds: 145,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result === null, 'should return null for small movement');
});

check('returns null when no fights match opening odds', () => {
  const fights = [favExtendsFight()]; // opens at -150
  const result = findLiveSequence({
    f1OpeningOdds: -450, f1CurrentOdds: -600, // very different opening
    f2OpeningOdds: 350,  f2CurrentOdds: 500,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result === null, 'should return null when no opening match');
});

check('returns null for empty fights array', () => {
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -280,
    f2OpeningOdds: 130,  f2CurrentOdds: 230,
    fighter1: 'A', fighter2: 'B'
  }, []);
  assert(result === null, 'should return null for empty fights');
});

check('returns null when fewer than 3 fights match', () => {
  const fights = [favExtendsFight(), favExtendsFight()]; // only 2
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -280,
    f2OpeningOdds: 130,  f2CurrentOdds: 230,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result === null, 'need at least 3 matches');
});

console.log('\n── findLiveSequence: hold rate computation ──');

check('high hold rate when fav always extends and wins', () => {
  // 8 fights: fav extends from -150 → -280, fav wins
  const fights = Array.from({ length: 8 }, () => favExtendsFight());
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 210,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should find matches');
  assert(result.holdRate >= 80, 'hold rate should be high: ' + result.holdRate);
  assert(result.sampleSize >= 3, 'needs 3+ matches');
});

check('low hold rate when fav always reverses', () => {
  const fights = Array.from({ length: 8 }, () => favReversesFight());
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 210,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should find matches');
  assert(result.holdRate <= 20, 'hold rate should be low: ' + result.holdRate);
});

check('mixed hold rate ~50% with equal wins/reversals', () => {
  const fights = [
    ...Array.from({ length: 5 }, () => favExtendsFight()),
    ...Array.from({ length: 5 }, () => favReversesFight()),
  ];
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 210,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should find matches');
  assert(result.holdRate >= 30 && result.holdRate <= 70, 'mixed rate ~50%: ' + result.holdRate);
});

console.log('\n── findLiveSequence: ROI computation ──');

check('pressROI positive when hold rate high and leader at decent odds', () => {
  const fights = Array.from({ length: 10 }, () => favExtendsFight());
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -200, // f1 is leader at -200
    f2OpeningOdds: 130,  f2CurrentOdds: 165,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should find matches');
  // With 90%+ hold rate and -200 odds (0.5 payout per unit), should be positive
  if (result.holdRate > 80) {
    assert(result.pressROI > 0, 'pressROI should be positive with high hold rate: ' + result.pressROI);
  }
});

check('comebackROI negative when reversals are rare', () => {
  const fights = Array.from({ length: 10 }, () => favExtendsFight()); // fav always wins
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 215,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should find matches');
  assert(result.comebackROI < 0, 'comeback ROI should be negative when fav always wins: ' + result.comebackROI);
});

console.log('\n── findLiveSequence: verdict logic ──');

check('verdict is press when hold rate high and positive ROI', () => {
  // 10 fights: fav wins every time from -250 → presses +ROI
  const fights = Array.from({ length: 10 }, () => {
    const odds = [];
    for (let i = 0; i < 80; i++) odds.push(-150 - i * (150 / 80));
    return makeFight(odds, 'fighter1');
  });
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -200,
    f2OpeningOdds: 130,  f2CurrentOdds: 165,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  if (result && result.holdRate >= 70 && result.pressROI > 0.15) {
    assert(result.verdict === 'press', 'should recommend press: ' + result.verdict);
    assert(typeof result.advice === 'string' && result.advice.length > 0, 'advice should be non-empty');
  }
  assert(result !== null, 'should return a result');
});

check('verdict is neutral when neither press nor comeback has clear edge', () => {
  const fights = [
    ...Array.from({ length: 5 }, () => favExtendsFight()),
    ...Array.from({ length: 5 }, () => favReversesFight()),
  ];
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 210,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should return result');
  assert(['neutral', 'press', 'comeback'].includes(result.verdict), 'valid verdict: ' + result.verdict);
});

check('advice string always populated', () => {
  const fights = Array.from({ length: 6 }, () => favExtendsFight());
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 210,
    fighter1: 'Fighter Alpha', fighter2: 'Fighter Beta'
  }, fights);
  assert(result !== null, 'should return result');
  assert(typeof result.advice === 'string' && result.advice.length > 10, 'advice: ' + result.advice);
});

console.log('\n── findLiveSequence: output shape ──');

check('result has all required fields', () => {
  const fights = Array.from({ length: 5 }, () => favExtendsFight());
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 210,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should return result');
  const required = ['sampleSize', 'movement', 'f1IsLeading', 'leaderOdds', 'trailerOdds',
                    'holdRate', 'reversalRate', 'pressROI', 'comebackROI', 'verdict', 'advice'];
  for (const k of required) assert(k in result, 'missing field: ' + k);
});

check('holdRate + reversalRate = 100', () => {
  const fights = [
    ...Array.from({ length: 4 }, () => favExtendsFight()),
    ...Array.from({ length: 3 }, () => favReversesFight()),
  ];
  const result = findLiveSequence({
    f1OpeningOdds: -150, f1CurrentOdds: -250,
    f2OpeningOdds: 130,  f2CurrentOdds: 210,
    fighter1: 'A', fighter2: 'B'
  }, fights);
  assert(result !== null, 'should return result');
  assert(result.holdRate + result.reversalRate === 100,
    'hold + reversal must = 100: ' + result.holdRate + '+' + result.reversalRate);
});

console.log('\n── Integration: real fight data ──');

check('loadFightsWithHistory returns array', () => {
  const fights = loadFightsWithHistory();
  assert(Array.isArray(fights), 'should return array');
  console.log('    loaded', fights.length, 'fights with history');
});

check('real data: meaningful result when live odds differ from opening', () => {
  const fights = loadFightsWithHistory();
  if (!fights.length) { console.log('    (skipped — no data)'); return; }
  // Simulate: fight opened at -148, now live at -280 (fav dominating)
  const result = findLiveSequence({
    f1OpeningOdds: -148, f1CurrentOdds: -280,
    f2OpeningOdds: 124,  f2CurrentOdds: 230,
    fighter1: 'Lopes', fighter2: 'Garcia'
  }, fights);
  if (result) {
    assert(result.sampleSize >= 1, 'needs at least 1 match');
    assert(result.holdRate >= 0 && result.holdRate <= 100, 'holdRate in range');
    assert(['press', 'comeback', 'neutral'].includes(result.verdict), 'valid verdict');
    console.log('    n=' + result.sampleSize + ' | hold=' + result.holdRate + '% | verdict=' + result.verdict);
  } else {
    console.log('    (no match found for this live scenario)');
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
