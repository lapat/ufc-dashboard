#!/usr/bin/env node
// test_fighter_stats.js
'use strict';
const { computeVolatility, fightVolatilityScore, getFighterVolatility, extractAllFighters } = require('./fighter_stats');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ── computeVolatility ─────────────────────────────────────────────────────────

console.log('\n── computeVolatility: null / missing ──');

check('returns null for null profile', () => {
  assert(computeVolatility(null) === null);
});

check('returns null for undefined', () => {
  assert(computeVolatility(undefined) === null);
});

check('baseline 50 when all stats are exactly average', () => {
  // sapm=3.5 → delta=0, no subAvg, strDef=0.70 → delta=0, no tdDef
  const v = computeVolatility({ sapm: 3.5, strDef: 0.70 });
  assert(v === 50, 'got: ' + v);
});

console.log('\n── computeVolatility: SAPM component ──');

check('high SAPM increases volatility above 50', () => {
  const v = computeVolatility({ sapm: 5.0 }); // +15 pts → 65
  assert(v > 50, 'expected >50, got ' + v);
});

check('low SAPM decreases volatility below 50', () => {
  const v = computeVolatility({ sapm: 1.5 }); // -20 pts → 30
  assert(v < 50, 'expected <50, got ' + v);
});

check('SAPM delta clamped at +20 max', () => {
  const vHigh = computeVolatility({ sapm: 99 });
  assert(vHigh <= 70, 'expected <=70, got ' + vHigh); // baseline + cap
});

check('SAPM delta clamped at -20 min', () => {
  const vLow = computeVolatility({ sapm: 0 });
  assert(vLow >= 30, 'expected >=30, got ' + vLow);
});

console.log('\n── computeVolatility: submission component ──');

check('sub avg >= 1.5 adds 15 pts', () => {
  const base = computeVolatility({});
  const v    = computeVolatility({ subAvg: 2.0 });
  assert(v === base + 15, `expected ${base+15}, got ${v}`);
});

check('sub avg 0.8-1.49 adds 7 pts', () => {
  const base = computeVolatility({});
  const v    = computeVolatility({ subAvg: 1.0 });
  assert(v === base + 7, `expected ${base+7}, got ${v}`);
});

check('sub avg < 0.8 adds 0 pts', () => {
  const base = computeVolatility({});
  const v    = computeVolatility({ subAvg: 0.3 });
  assert(v === base, `expected ${base}, got ${v}`);
});

console.log('\n── computeVolatility: striking defense component ──');

check('low str defense (60%) increases volatility', () => {
  const v = computeVolatility({ strDef: 0.60 });
  assert(v > 50, 'expected >50, got ' + v);
});

check('high str defense (85%) decreases volatility', () => {
  const v = computeVolatility({ strDef: 0.85 });
  assert(v < 50, 'expected <50, got ' + v);
});

check('str defense expressed as percentage (65) is handled', () => {
  // strDef > 1 → divided by 100
  const v1 = computeVolatility({ strDef: 0.65 });
  const v2 = computeVolatility({ strDef: 65 });
  assert(v1 === v2, `0.65 gave ${v1}, 65 gave ${v2}`);
});

console.log('\n── computeVolatility: TD defense component ──');

check('very low TD defense (<50%) adds 8 pts', () => {
  const base = computeVolatility({});
  const v    = computeVolatility({ tdDef: 0.40 });
  assert(v === base + 8, `expected ${base+8}, got ${v}`);
});

check('medium TD defense (55-65%) adds 4 pts', () => {
  const base = computeVolatility({});
  const v    = computeVolatility({ tdDef: 0.60 });
  assert(v === base + 4, `expected ${base+4}, got ${v}`);
});

check('high TD defense (>65%) adds 0 pts', () => {
  const base = computeVolatility({});
  const v    = computeVolatility({ tdDef: 0.80 });
  assert(v === base, `expected ${base}, got ${v}`);
});

console.log('\n── computeVolatility: output range ──');

check('output is always 0-100', () => {
  const extreme = computeVolatility({ sapm: 99, subAvg: 3, strDef: 0.01, tdDef: 0.01 });
  assert(extreme >= 0 && extreme <= 100, 'got: ' + extreme);
});

check('output is an integer', () => {
  const v = computeVolatility({ sapm: 4.1, subAvg: 0.9, strDef: 0.63, tdDef: 0.55 });
  assert(Number.isInteger(v), 'not integer: ' + v);
});

// ── fightVolatilityScore ──────────────────────────────────────────────────────

console.log('\n── fightVolatilityScore ──');

const mockProfiles = {
  'Fighter A': { name: 'Fighter A', stats: { sapm: 5.0 }, volatility: 65 },
  'Fighter B': { name: 'Fighter B', stats: { sapm: 2.0 }, volatility: 36 },
};

check('returns null when both fighters missing from profiles', () => {
  assert(fightVolatilityScore('Unknown X', 'Unknown Y', mockProfiles) === null);
});

check('returns available score when only one fighter is in profiles', () => {
  const v = fightVolatilityScore('Fighter A', 'Unknown', mockProfiles);
  assert(v === 65, 'got: ' + v);
});

check('weighted toward the more volatile fighter', () => {
  const v = fightVolatilityScore('Fighter A', 'Fighter B', mockProfiles);
  // 0.65 × max(65,36) + 0.35 × min(65,36) = 0.65×65 + 0.35×36 = 42.25 + 12.6 = 54.85 → 55
  assert(v === 55, 'expected 55, got ' + v);
});

check('result is above both if weighted toward higher', () => {
  const v  = fightVolatilityScore('Fighter A', 'Fighter B', mockProfiles);
  const lo = Math.min(65, 36);
  const hi = Math.max(65, 36);
  assert(v > lo && v < hi + 1, `${v} should be between ${lo} and ${hi}`);
});

check('returns null for null profiles arg', () => {
  assert(fightVolatilityScore('Fighter A', 'Fighter B', null) === null);
});

// ── getFighterVolatility ──────────────────────────────────────────────────────

console.log('\n── getFighterVolatility ──');

check('returns cached volatility from profile', () => {
  const { getFighterVolatility } = require('./fighter_stats');
  const v = getFighterVolatility('Fighter A', mockProfiles);
  assert(v === 65, 'got: ' + v);
});

check('returns null for unknown name', () => {
  const { getFighterVolatility } = require('./fighter_stats');
  const v = getFighterVolatility('No One', mockProfiles);
  assert(v === null, 'got: ' + v);
});

check('returns null for null profiles', () => {
  const { getFighterVolatility } = require('./fighter_stats');
  assert(getFighterVolatility('Fighter A', null) === null);
});

// ── extractAllFighters ────────────────────────────────────────────────────────

console.log('\n── extractAllFighters ──');

check('returns an array', () => {
  const names = extractAllFighters();
  assert(Array.isArray(names), 'not an array');
});

check('returns sorted strings', () => {
  const names = extractAllFighters();
  for (let i = 1; i < names.length; i++) {
    assert(names[i] >= names[i-1], `out of order: ${names[i-1]} > ${names[i]}`);
  }
});

check('every entry is a non-empty string', () => {
  const names = extractAllFighters();
  for (const n of names) {
    assert(typeof n === 'string' && n.length > 0, 'bad entry: ' + JSON.stringify(n));
  }
});

check('no duplicate names', () => {
  const names = extractAllFighters();
  const unique = new Set(names);
  assert(unique.size === names.length, `${names.length - unique.size} duplicates`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
