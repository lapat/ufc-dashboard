#!/usr/bin/env node
// test_brain.js — Extensive tests for the Bet Bot brain (enricher + analyzer)
// Run: node test_brain.js

'use strict';

const { parseFightFile, fuzzy, bothMatch, norm } = require('./enricher');
const {
  impliedProb, oddsLabel, computeStats, findSimilarFights,
  computeUserStats
} = require('./analyzer');

let passed = 0, failed = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// ── Enricher unit tests ───────────────────────────────────────────────────────

console.log('\n── Enricher: parseFightFile ──');

check('parses standard filename', () => {
  const r = parseFightFile('alexandervolkanovski_vs_diegolopes_2026-02-01.json');
  assert(r.fighter1 === 'alexandervolkanovski', `got "${r.fighter1}"`);
  assert(r.fighter2 === 'diegolopes', `got "${r.fighter2}"`);
  assert(r.date === '2026-02-01', `got "${r.date}"`);
  assert(r.fightId === 'alexandervolkanovski_vs_diegolopes', `got "${r.fightId}"`);
});

check('parses multi-word fighter names', () => {
  const r = parseFightFile('mauricio_ruffy_vs_michael_chandler_2026-06-14.json');
  assert(r !== null, 'should not return null');
  assert(r.date === '2026-06-14');
});

check('returns null for non-fight file', () => {
  assert(parseFightFile('dk_captures.json') === null);
  assert(parseFightFile('crossover_results.json') === null);
});

check('returns null for file without date', () => {
  assert(parseFightFile('fighter1_vs_fighter2.json') === null);
});

check('returns null for file without _vs_', () => {
  assert(parseFightFile('someotherthing_2026-01-01.json') === null);
});

console.log('\n── Enricher: fuzzy name matching ──');

check('exact match', () => {
  assert(fuzzy('Alex Pereira', 'Alex Pereira'));
});

check('case insensitive', () => {
  assert(fuzzy('ALEX PEREIRA', 'alex pereira'));
});

check('substring match (nickname/short name)', () => {
  assert(fuzzy('Ciryl Gane', 'Gane'));
});

check('special chars stripped', () => {
  assert(fuzzy("Jon O'Brien", 'Jon OBrien'));
});

check('no false positive on completely different names', () => {
  assert(!fuzzy('Islam Makhachev', 'Jon Jones'));
});

check('no false positive on empty string', () => {
  assert(!fuzzy('', 'Jon Jones'));
  assert(!fuzzy('Jon Jones', ''));
});

check('bothMatch: normal order', () => {
  assert(bothMatch('Alex Pereira', 'Ciryl Gane', 'Alex Pereira', 'Ciryl Gane'));
});

check('bothMatch: reversed order', () => {
  assert(bothMatch('Ciryl Gane', 'Alex Pereira', 'Alex Pereira', 'Ciryl Gane'));
});

check('bothMatch: no false positive', () => {
  assert(!bothMatch('Islam Makhachev', 'Dustin Poirier', 'Alex Pereira', 'Ciryl Gane'));
});

// ── Analyzer: implied probability ─────────────────────────────────────────────

console.log('\n── Analyzer: impliedProb ──');

check('favourite: -200 → 66.7%', () => {
  const p = impliedProb(-200);
  assert(Math.abs(p - 0.667) < 0.001, `got ${p}`);
});

check('underdog: +200 → 33.3%', () => {
  const p = impliedProb(200);
  assert(Math.abs(p - 0.333) < 0.001, `got ${p}`);
});

check('pick-em: +100 → 50%', () => {
  const p = impliedProb(100);
  assert(Math.abs(p - 0.5) < 0.001, `got ${p}`);
});

check('returns null for NaN', () => {
  assert(impliedProb('bogus') === null);
});

check('both sides of pick-em sum > 1 (vig)', () => {
  // With standard vig: -110/-110 → 52.4% + 52.4% = 104.8%
  assert(impliedProb(-110) + impliedProb(-110) > 1);
});

// ── Analyzer: oddsLabel ───────────────────────────────────────────────────────

console.log('\n── Analyzer: oddsLabel ──');

check('-500 → extreme_fav', () => assert(oddsLabel(-500) === 'extreme_fav'));
check('-300 → heavy_fav',   () => assert(oddsLabel(-300) === 'heavy_fav'));
check('-150 → fav',         () => assert(oddsLabel(-150) === 'fav'));
check('-120 → slight_fav',  () => assert(oddsLabel(-120) === 'slight_fav'));
check('+110 → pick_em (< 130 boundary)', () => assert(oddsLabel(110)  === 'pick_em'));
check('+130 → slight_dog',  () => assert(oddsLabel(130)  === 'slight_dog'));
check('+250 → dog',         () => assert(oddsLabel(250)  === 'dog'));
check('+400 → heavy_dog',   () => assert(oddsLabel(400)  === 'heavy_dog'));
check('+130 (string) works', () => assert(oddsLabel('+130') === 'slight_dog'));

// ── Analyzer: computeStats ────────────────────────────────────────────────────

console.log('\n── Analyzer: computeStats ──');

function makeFight(winner, f1OpenOdds, f1CloseOdds, method = 'KO/TKO', crossover = false) {
  return {
    outcome: {
      winner, // 'fighter1' or 'fighter2'
      winnerName: winner === 'fighter1' ? 'Fighter A' : 'Fighter B',
      method,
      round: 2,
      openingF1Odds: f1OpenOdds,
      openingF2Odds: f1OpenOdds < 0 ? Math.round(-10000 / f1OpenOdds) : Math.round(-10000 / f1OpenOdds),
      closingF1Odds: f1CloseOdds,
      closingF2Odds: f1CloseOdds < 0 ? Math.round(-10000 / f1CloseOdds) : null,
      lineMovementF1: f1CloseOdds - f1OpenOdds,
      crossoverOccurred: crossover
    }
  };
}

check('returns null for empty similar fights', () => {
  const stats = computeStats([], { f1CurrentOdds: '-150', f2CurrentOdds: '+130' });
  assert(stats === null);
});

check('underdog win rate computed correctly', () => {
  // f1 is dog (+200), wins 3 out of 5
  const fights = [
    makeFight('fighter1', -200, -180), // f1 was fav, f1 won — f2 was dog
    makeFight('fighter1', -200, -180),
    makeFight('fighter2', -200, -180), // f2 (dog) won
    makeFight('fighter2', -200, -180),
    makeFight('fighter2', -200, -180),
  ];
  // f1CurrentOdds = -200 → f1 is fav → f2 is dog
  const params = { f1CurrentOdds: '-200', f2CurrentOdds: '+180' };
  const stats  = computeStats(fights, params);
  assert(stats.sampleSize === 5, `sampleSize=${stats.sampleSize}`);
  // f2 (dog) won 3 times → dogWinRate = 60%
  assert(stats.dogWinRate === 60, `dogWinRate=${stats.dogWinRate}`);
  assert(stats.favWinRate === 40, `favWinRate=${stats.favWinRate}`);
});

check('edge (historical vs implied) computed', () => {
  // Create 10 fights where underdog wins 7 times
  const fights = Array.from({ length: 10 }, (_, i) =>
    makeFight(i < 7 ? 'fighter2' : 'fighter1', -200, -180) // f2 wins 7 times
  );
  const params = { f1CurrentOdds: '-200', f2CurrentOdds: '+180' };
  const stats  = computeStats(fights, params);
  // implied f2 prob at +180 = 100/280 ≈ 35.7%
  // historical f2 win rate = 70%
  // edge = 70 - 35.7 = ~34 ppts
  assert(stats.edge > 25, `edge=${stats.edge} should be >25`);
});

check('method breakdown populated', () => {
  const fights = [
    makeFight('fighter1', -150, -130, 'KO/TKO'),
    makeFight('fighter1', -150, -130, 'KO/TKO'),
    makeFight('fighter2', -150, -130, 'Submission'),
    makeFight('fighter1', -150, -130, 'Decision'),
  ];
  const stats = computeStats(fights, { f1CurrentOdds: '-150', f2CurrentOdds: '+130' });
  assert(stats.methods['KO/TKO'] === 2, `KO/TKO=${stats.methods['KO/TKO']}`);
  assert(stats.methods['Submission'] === 1);
  assert(stats.methods['Decision'] === 1);
});

check('positive ROI when dog wins more than implied', () => {
  // Dog is +300 (25% implied), wins 50% historically → massively +EV
  const fights = Array.from({ length: 10 }, (_, i) =>
    makeFight(i < 5 ? 'fighter2' : 'fighter1', -200, -200)
  );
  const stats = computeStats(fights, { f1CurrentOdds: '-300', f2CurrentOdds: '+250' });
  assert(stats.dogROI > 0, `dogROI=${stats.dogROI} should be positive`);
});

// ── Analyzer: findSimilarFights ───────────────────────────────────────────────

console.log('\n── Analyzer: findSimilarFights ──');

check('returns fights with similar odds', () => {
  const fights = [
    makeFight('fighter1', -150, -140), // close to current
    makeFight('fighter1', -150, -145), // close to current
    makeFight('fighter2', -500, -480), // very different odds
  ];
  const params  = { f1CurrentOdds: '-140', f1OpeningOdds: '-150' };
  const similar = findSimilarFights(params, fights);
  assert(similar.length >= 2, `found ${similar.length} similar fights`);
  // The -500 fight should score lower
  const hasExtreme = similar.some(f => f.outcome.openingF1Odds === -500);
  assert(!hasExtreme || similar.indexOf(similar.find(f => f.outcome.openingF1Odds === -500)) > 0, 'extreme fight should rank lower');
});

check('crossover preference works', () => {
  const withCrossover    = Array.from({length: 5}, () => makeFight('fighter1', -150, -140, 'Decision', true));
  const withoutCrossover = Array.from({length: 5}, () => makeFight('fighter1', -150, -140, 'Decision', false));
  const params  = { f1CurrentOdds: '-140', f1OpeningOdds: '-150', crossoverOccurred: true };
  const similar = findSimilarFights(params, [...withCrossover, ...withoutCrossover], 5);
  const crossoverCount = similar.filter(f => f.outcome.crossoverOccurred).length;
  assert(crossoverCount >= 3, `expected mostly crossover fights, got ${crossoverCount}/5`);
});

check('empty array for no matches', () => {
  // Provide fights with no history (score will be 0)
  const fights  = [ makeFight('fighter1', null, null) ];
  const params  = { f1CurrentOdds: '-150', f1OpeningOdds: '-150' };
  const similar = findSimilarFights(params, fights);
  assert(Array.isArray(similar));
  // Should have 0 since nulls score 0 < 10 threshold
  assert(similar.length === 0, `expected 0, got ${similar.length}`);
});

// ── Analyzer: computeUserStats ────────────────────────────────────────────────

console.log('\n── Analyzer: computeUserStats ──');

check('computes win rate correctly', () => {
  const bets = [
    { userId: 'louis', odds: 200, stake: 100, status: 'won',  returns: 300, betId: '1' },
    { userId: 'louis', odds: 220, stake: 100, status: 'won',  returns: 320, betId: '2' },
    { userId: 'louis', odds: 180, stake: 100, status: 'lost', returns: 0,   betId: '3' },
    { userId: 'ish',   odds: 210, stake: 200, status: 'won',  returns: 620, betId: '4' },
  ];
  const stats = computeUserStats(bets, [150, 250]);
  assert(stats.wins   === 3, `wins=${stats.wins}`);
  assert(stats.losses === 1, `losses=${stats.losses}`);
  assert(stats.winRate === 75, `winRate=${stats.winRate}`);
});

check('returns null when no bets in range', () => {
  const bets = [
    { userId: 'louis', odds: 500, stake: 100, status: 'won', returns: 600, betId: '1' },
  ];
  const stats = computeUserStats(bets, [150, 250]); // range doesn't include 500
  assert(stats === null);
});

check('tracks ROI correctly', () => {
  const bets = [
    { userId: 'louis', odds: 200, stake: 100, status: 'won',  returns: 300, betId: '1' }, // profit +200
    { userId: 'louis', odds: 200, stake: 100, status: 'lost', returns: 0,   betId: '2' }, // profit -100
  ];
  const stats = computeUserStats(bets, [150, 250]);
  assert(stats.roi === 100, `roi=${stats.roi} (expected 100)`); // +200 -100 = +100
});

check('groups stats by user', () => {
  const bets = [
    { userId: 'louis', odds: 200, stake: 100, status: 'won',  returns: 300, betId: '1' },
    { userId: 'ish',   odds: 210, stake: 100, status: 'lost', returns: 0,   betId: '2' },
  ];
  const stats = computeUserStats(bets, [150, 250]);
  assert(stats.byUser.louis.wins   === 1);
  assert(stats.byUser.louis.losses === 0);
  assert(stats.byUser.ish.wins     === 0);
  assert(stats.byUser.ish.losses   === 1);
});

check('returns null for empty bets array', () => {
  assert(computeUserStats([], [150, 250]) === null);
});

// ── Integration: enriched data round-trip ────────────────────────────────────

console.log('\n── Integration: enriched data loading ──');

check('loadEnrichedFights returns an array (even if empty)', () => {
  const { loadEnrichedFights } = require('./analyzer');
  const fights = loadEnrichedFights();
  assert(Array.isArray(fights), 'should return array');
  // All returned fights must have outcome.winner
  assert(fights.every(f => f.outcome?.winner), 'all fights must have outcome.winner');
});

check('fights with outcomes have required fields', () => {
  const { loadEnrichedFights } = require('./analyzer');
  const fights = loadEnrichedFights();
  for (const f of fights) {
    assert(['fighter1','fighter2'].includes(f.outcome.winner), `invalid winner: ${f.outcome.winner}`);
    assert(f.outcome.openingF1Odds !== undefined, 'missing openingF1Odds');
  }
});

check('computeStats handles enriched real fights if any exist', () => {
  const { loadEnrichedFights } = require('./analyzer');
  const fights = loadEnrichedFights();
  if (!fights.length) { console.log('    (skipped — no enriched fights yet)'); return; }
  const params = { f1CurrentOdds: '-150', f2CurrentOdds: '+130', f1OpeningOdds: '-150' };
  const stats  = computeStats(fights.slice(0, 20), params);
  // Just verify it doesn't throw and returns a reasonable object
  assert(stats === null || (typeof stats.dogWinRate === 'number' && stats.sampleSize > 0));
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n═══════════════════════════════════`);
console.log(`  ${passed} passed  ${failed} failed`);
console.log(`═══════════════════════════════════\n`);
if (failed > 0) process.exit(1);
