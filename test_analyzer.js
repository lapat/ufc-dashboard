#!/usr/bin/env node
// test_analyzer.js — Unit tests for the analyzer brain (no Claude, no HTTP).
// Tests impliedProb, oddsLabel, findSimilarFights, computeStats, computeUserStats.
'use strict';
const {
  impliedProb, oddsLabel, recencyWeight,
  loadEnrichedFights, findSimilarFights, computeStats,
  computeUserStats, loadUserBetHistory,
} = require('./analyzer');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol = 0.005) { return Math.abs(a - b) <= tol; }

// ── recencyWeight ─────────────────────────────────────────────────────────────

console.log('\n── recencyWeight ──');

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

check('fight from yesterday → weight 1.0', () => {
  assert(recencyWeight(daysAgo(1)) === 1.00, recencyWeight(daysAgo(1)));
});
check('fight 90 days ago → weight 1.0 (still in fresh window)', () => {
  assert(recencyWeight(daysAgo(90)) === 1.00, recencyWeight(daysAgo(90)));
});
check('fight 91 days ago → weight 0.85', () => {
  assert(recencyWeight(daysAgo(91)) === 0.85, recencyWeight(daysAgo(91)));
});
check('fight 180 days ago → weight 0.85', () => {
  assert(recencyWeight(daysAgo(180)) === 0.85, recencyWeight(daysAgo(180)));
});
check('fight 181 days ago → weight 0.70', () => {
  assert(recencyWeight(daysAgo(181)) === 0.70, recencyWeight(daysAgo(181)));
});
check('fight 365 days ago → weight 0.70', () => {
  assert(recencyWeight(daysAgo(365)) === 0.70, recencyWeight(daysAgo(365)));
});
check('fight 366 days ago → weight 0.50', () => {
  assert(recencyWeight(daysAgo(366)) === 0.50, recencyWeight(daysAgo(366)));
});
check('fight 730 days ago → weight 0.50', () => {
  assert(recencyWeight(daysAgo(730)) === 0.50, recencyWeight(daysAgo(730)));
});
check('fight 731 days ago → weight 0.30 (stale: 2-3 years)', () => {
  assert(recencyWeight(daysAgo(731)) === 0.30, recencyWeight(daysAgo(731)));
});
check('fight 1095 days ago → weight 0.30', () => {
  assert(recencyWeight(daysAgo(1095)) === 0.30, recencyWeight(daysAgo(1095)));
});
check('fight 1096 days ago → weight 0.15 (Gaethje 2018 territory)', () => {
  assert(recencyWeight(daysAgo(1096)) === 0.15, recencyWeight(daysAgo(1096)));
});
check('fight from 5 years ago → weight 0.15', () => {
  assert(recencyWeight(daysAgo(1825)) === 0.15, recencyWeight(daysAgo(1825)));
});
check('null timestamp → 0.5 (neutral fallback)', () => {
  assert(recencyWeight(null) === 0.5);
});
check('undefined timestamp → 0.5', () => {
  assert(recencyWeight(undefined) === 0.5);
});
check('invalid date string → 0.5', () => {
  assert(recencyWeight('not-a-date') === 0.5);
});
check('weight is monotonically non-increasing over time', () => {
  const checkpoints = [0, 89, 90, 91, 179, 180, 181, 364, 365, 366, 729, 730, 731, 1094, 1095, 1096, 1500];
  const weights = checkpoints.map(d => recencyWeight(daysAgo(d)));
  for (let i = 1; i < weights.length; i++) {
    assert(weights[i] <= weights[i-1], `weight increased at day ${checkpoints[i]}: ${weights[i-1]} → ${weights[i]}`);
  }
});

// ── impliedProb ───────────────────────────────────────────────────────────────

console.log('\n── impliedProb ──');

check('+100 → 0.50', () => assert(near(impliedProb(100), 0.5), impliedProb(100)));
check('-100 → 0.50', () => assert(near(impliedProb(-100), 0.5), impliedProb(-100)));
check('-300 → 0.75', () => assert(near(impliedProb(-300), 0.75), impliedProb(-300)));
check('+200 → 0.333', () => assert(near(impliedProb(200), 1/3), impliedProb(200)));
check('-110 → ~0.524', () => assert(near(impliedProb(-110), 110/210), impliedProb(-110)));
check('+110 → ~0.476', () => assert(near(impliedProb(110), 100/210), impliedProb(110)));
check('NaN string → null', () => assert(impliedProb('x') === null));
check('NaN returns null', () => assert(impliedProb(NaN) === null));
check('result is always in (0,1) for valid odds', () => {
  for (const o of [-500, -200, -110, 100, 200, 500]) {
    const p = impliedProb(o);
    assert(p > 0 && p < 1, `${o} → ${p}`);
  }
});

// ── oddsLabel ─────────────────────────────────────────────────────────────────

console.log('\n── oddsLabel ──');

check('≤-400 → extreme_fav', () => assert(oddsLabel(-400) === 'extreme_fav'));
check('-401 → extreme_fav', () => assert(oddsLabel(-401) === 'extreme_fav'));
check('-399 → heavy_fav', () => assert(oddsLabel(-399) === 'heavy_fav'));
check('-200 → heavy_fav', () => assert(oddsLabel(-200) === 'heavy_fav'));
check('-199 → fav', () => assert(oddsLabel(-199) === 'fav'));
check('-130 → fav', () => assert(oddsLabel(-130) === 'fav'));
check('-129 → slight_fav', () => assert(oddsLabel(-129) === 'slight_fav'));
check('-101 → slight_fav', () => assert(oddsLabel(-101) === 'slight_fav'));
check('+100 → pick_em', () => assert(oddsLabel(100) === 'pick_em'));
check('+129 → pick_em', () => assert(oddsLabel(129) === 'pick_em'));
check('+130 → slight_dog', () => assert(oddsLabel(130) === 'slight_dog'));
check('+199 → slight_dog', () => assert(oddsLabel(199) === 'slight_dog'));
check('+200 → dog', () => assert(oddsLabel(200) === 'dog'));
check('+349 → dog', () => assert(oddsLabel(349) === 'dog'));
check('+350 → heavy_dog', () => assert(oddsLabel(350) === 'heavy_dog'));
check('NaN string → unknown', () => assert(oddsLabel('x') === 'unknown'));
check('NaN → unknown', () => assert(oddsLabel(NaN) === 'unknown'));

// ── loadEnrichedFights ────────────────────────────────────────────────────────

console.log('\n── loadEnrichedFights ──');

let fights;
check('loads without throwing', () => { fights = loadEnrichedFights(); });
check('returns array', () => assert(Array.isArray(fights)));
check('has substantial fights (>100)', () => assert(fights.length > 100, 'got: ' + fights.length));
check('every fight has outcome.winner', () => {
  for (const f of fights) assert(f.outcome?.winner, f.file + ' missing winner');
});
check('every fight has oddsHistory', () => {
  for (const f of fights) assert(Array.isArray(f.oddsHistory), f.file + ' missing oddsHistory');
});
check('fight outcome has opening odds', () => {
  const sample = fights.slice(0, 20);
  const withOdds = sample.filter(f => f.outcome.openingF1Odds != null);
  assert(withOdds.length > 10, 'only ' + withOdds.length + '/20 have opening odds');
});

// ── findSimilarFights ─────────────────────────────────────────────────────────

console.log('\n── findSimilarFights ──');

check('returns array', () => {
  const r = findSimilarFights({ f1CurrentOdds: -200, f2CurrentOdds: 165 }, fights);
  assert(Array.isArray(r));
});

check('returns at most topN results', () => {
  const r = findSimilarFights({ f1CurrentOdds: -200, f2CurrentOdds: 165 }, fights, 10);
  assert(r.length <= 10, 'got: ' + r.length);
});

check('heavy fav query finds fights with similar odds profiles', () => {
  const r = findSimilarFights({
    f1CurrentOdds: -500, f2CurrentOdds: 380,
    f1OpeningOdds: -500,
  }, fights);
  assert(r.length > 0, 'no similar fights found');
  // All returned fights should have opening odds
  for (const f of r) assert(f.outcome?.openingF1Odds != null || f.outcome?.openingF2Odds != null);
});

check('pick-em query returns at least some results', () => {
  const r = findSimilarFights({
    f1CurrentOdds: -115, f2CurrentOdds: -103,
    f1OpeningOdds: -115,
  }, fights);
  // Similarity engine uses tier proximity — should find at least some fights
  assert(r.length > 0, 'no similar fights found for pick-em query');
  // Sanity: all returned fights have a winner
  for (const f of r) assert(f.outcome.winner, 'missing winner in result');
});

check('crossoverOccurred=true biases toward crossover fights', () => {
  const withCross   = findSimilarFights({ f1CurrentOdds: -200, f2CurrentOdds: 165, crossoverOccurred: true }, fights);
  const withoutCross = findSimilarFights({ f1CurrentOdds: -200, f2CurrentOdds: 165, crossoverOccurred: false }, fights);
  const crossInWith    = withCross.filter(f => f.outcome.crossoverOccurred).length;
  const crossInWithout = withoutCross.filter(f => f.outcome.crossoverOccurred).length;
  // crossoverOccurred=true should return more crossover fights
  assert(crossInWith >= crossInWithout, `${crossInWith} vs ${crossInWithout}`);
});

check('returns empty for impossible params (no fights could match)', () => {
  // Use score threshold of 10 — fights with score ≤ 10 are filtered out
  const r = findSimilarFights({ f1CurrentOdds: -200, f2CurrentOdds: 165 }, []);
  assert(r.length === 0);
});

check('result fights all have outcome.winner', () => {
  const r = findSimilarFights({ f1CurrentOdds: -200, f2CurrentOdds: 165 }, fights);
  for (const f of r) assert(f.outcome.winner, 'missing winner');
});

// ── computeStats ──────────────────────────────────────────────────────────────

console.log('\n── computeStats ──');

function makeFight(winner, openF1, openF2, closeF1, method = 'Decision', crossover = false) {
  return {
    outcome: {
      winner,
      openingF1Odds:   openF1,
      openingF2Odds:   openF2,
      closingF1Odds:   closeF1,
      crossoverOccurred: crossover,
      method,
    },
    derived: null,
  };
}

check('returns null for empty pool', () => {
  assert(computeStats([], { f1CurrentOdds: -200 }) === null);
});

check('correct dogWinRate when dog is f1 (positive odds)', () => {
  const pool = [
    makeFight('fighter1', 200, -250, 200),  // dog (f1) wins
    makeFight('fighter1', 200, -250, 200),  // dog wins
    makeFight('fighter2', 200, -250, 200),  // fav wins
    makeFight('fighter2', 200, -250, 200),  // fav wins
  ];
  const r = computeStats(pool, { f1CurrentOdds: 200, f2CurrentOdds: -250 });
  assert(r.dogWinRate === 50, r.dogWinRate);
  assert(r.favWinRate === 50, r.favWinRate);
});

check('correct dogWinRate when dog is f2 (f1 is negative odds)', () => {
  const pool = [
    makeFight('fighter1', -250, 200, -250),  // fav wins
    makeFight('fighter1', -250, 200, -250),  // fav wins
    makeFight('fighter1', -250, 200, -250),  // fav wins
    makeFight('fighter2', -250, 200, -250),  // dog wins (f2)
  ];
  const r = computeStats(pool, { f1CurrentOdds: -250, f2CurrentOdds: 200 });
  assert(r.dogWinRate === 25, r.dogWinRate);
  assert(r.favWinRate === 75, r.favWinRate);
});

check('sampleSize matches pool length', () => {
  const pool = [
    makeFight('fighter1', -200, 165, -200),
    makeFight('fighter2', -200, 165, -200),
    makeFight('fighter2', -200, 165, -200),
  ];
  const r = computeStats(pool, { f1CurrentOdds: -200, f2CurrentOdds: 165 });
  assert(r.sampleSize === 3, r.sampleSize);
});

check('method breakdown is correct', () => {
  const pool = [
    makeFight('fighter1', -200, 165, -200, 'KO/TKO'),
    makeFight('fighter2', -200, 165, -200, 'KO/TKO'),
    makeFight('fighter2', -200, 165, -200, 'Decision'),
  ];
  const r = computeStats(pool, { f1CurrentOdds: -200, f2CurrentOdds: 165 });
  assert(r.methods['KO/TKO'] === 2, JSON.stringify(r.methods));
  assert(r.methods['Decision'] === 1, JSON.stringify(r.methods));
});

check('edge is positive when dog wins more than implied', () => {
  // Dog at +200 → implied 33%. Pool: dog wins 4/5 = 80%. Edge = +47 ppts.
  const pool = Array(4).fill(makeFight('fighter1', 200, -250, 200))
    .concat([makeFight('fighter2', 200, -250, 200)]);
  const r = computeStats(pool, { f1CurrentOdds: 200, f2CurrentOdds: -250 });
  assert(r.edge > 0, 'edge: ' + r.edge);
});

check('edge is negative when dog wins less than implied', () => {
  // Dog at +100 → implied 50%. Pool: dog wins 1/5 = 20%. Edge = -30 ppts.
  const pool = [makeFight('fighter1', 100, -120, 100)]
    .concat(Array(4).fill(makeFight('fighter2', 100, -120, 100)));
  const r = computeStats(pool, { f1CurrentOdds: 100, f2CurrentOdds: -120 });
  assert(r.edge < 0, 'edge: ' + r.edge);
});

check('crossovers count correctly', () => {
  const pool = [
    makeFight('fighter1', -200, 165, -200, 'Decision', true),
    makeFight('fighter2', -200, 165, -200, 'Decision', true),
    makeFight('fighter2', -200, 165, -200, 'Decision', false),
  ];
  const r = computeStats(pool, { f1CurrentOdds: -200, f2CurrentOdds: 165 });
  assert(r.crossovers.total === 2, r.crossovers.total);
});

check('dogROI is positive when dog wins enough to beat break-even', () => {
  // Dog at +200 → needs >33% to be profitable. Pool: dog wins 3/4 = 75%.
  const pool = Array(3).fill(makeFight('fighter1', 200, -250, 200))
    .concat([makeFight('fighter2', 200, -250, 200)]);
  const r = computeStats(pool, { f1CurrentOdds: 200, f2CurrentOdds: -250 });
  assert(r.dogROI > 0, 'dogROI: ' + r.dogROI);
});

check('dogROI is negative when dog loses too much', () => {
  const pool = Array(4).fill(makeFight('fighter2', 200, -250, 200))
    .concat([makeFight('fighter1', 200, -250, 200)]);
  const r = computeStats(pool, { f1CurrentOdds: 200, f2CurrentOdds: -250 });
  assert(r.dogROI < 0, 'dogROI: ' + r.dogROI);
});

check('all required output fields present', () => {
  const pool = [makeFight('fighter1', -200, 165, -200)];
  const r = computeStats(pool, { f1CurrentOdds: -200, f2CurrentOdds: 165 });
  const required = ['sampleSize','dogWinRate','favWinRate','dogROI','edge','methods','crossovers',
                    'impliedDogProb','historicalDogProb','derived'];
  for (const k of required) assert(k in r, 'missing: ' + k);
});

// ── Real data integration ─────────────────────────────────────────────────────

console.log('\n── Integration: findSimilarFights + computeStats ──');

check('full pipeline: moderate fav query returns valid stats', () => {
  const similar = findSimilarFights({
    f1CurrentOdds: -250, f2CurrentOdds: 200,
    f1OpeningOdds: -250,
  }, fights);
  assert(similar.length > 0, 'no similar fights');
  const stats = computeStats(similar, { f1CurrentOdds: -250, f2CurrentOdds: 200 });
  assert(stats !== null);
  assert(stats.sampleSize === similar.length);
  assert(stats.dogWinRate >= 0 && stats.dogWinRate <= 100);
  assert(stats.favWinRate === 100 - stats.dogWinRate);
});

check('full pipeline: heavy fav query — fav wins most', () => {
  const similar = findSimilarFights({
    f1CurrentOdds: -500, f2CurrentOdds: 380,
    f1OpeningOdds: -500,
  }, fights);
  if (similar.length < 5) return; // skip if not enough data
  const stats = computeStats(similar, { f1CurrentOdds: -500, f2CurrentOdds: 380 });
  assert(stats.favWinRate > stats.dogWinRate,
    `favWin=${stats.favWinRate} dogWin=${stats.dogWinRate}`);
});

check('full pipeline: edge is a number or null', () => {
  const similar = findSimilarFights({ f1CurrentOdds: -200, f2CurrentOdds: 165 }, fights);
  const stats = computeStats(similar, { f1CurrentOdds: -200, f2CurrentOdds: 165 });
  if (stats) assert(stats.edge == null || typeof stats.edge === 'number', 'edge: ' + stats.edge);
});

// ── computeUserStats ──────────────────────────────────────────────────────────

console.log('\n── computeUserStats ──');

check('returns null for empty bets', () => {
  assert(computeUserStats([], [100, 200]) === null);
});
check('returns null for null bets', () => {
  assert(computeUserStats(null, [100, 200]) === null);
});

check('computes win rate correctly', () => {
  const bets = [
    { odds: 150, status: 'won',  amount: 100, returns: 250 },
    { odds: 160, status: 'won',  amount: 100, returns: 260 },
    { odds: 140, status: 'lost', amount: 100, returns: 0 },
  ];
  const r = computeUserStats(bets, [100, 200]);
  assert(r !== null);
  assert(r.wins === 2, r.wins);
  assert(r.losses === 1, r.losses);
  assert(r.winRate === 67, r.winRate); // 2/3 = 66.7% → 67
});

check('filters bets outside odds range', () => {
  const bets = [
    { odds: 150, status: 'won',  amount: 100, returns: 250 }, // in range [100,200]
    { odds: 350, status: 'won',  amount: 100, returns: 450 }, // out of range
    { odds: 50,  status: 'lost', amount: 100, returns: 0 },   // out of range
  ];
  const r = computeUserStats(bets, [100, 200]);
  assert(r !== null);
  assert(r.total === 1, 'expected 1 in range, got: ' + r.total);
});

check('returns null when no bets in range', () => {
  const bets = [
    { odds: 350, status: 'won', amount: 100, returns: 450 },
  ];
  assert(computeUserStats(bets, [100, 200]) === null);
});

check('loadUserBetHistory returns array', () => {
  const bets = loadUserBetHistory();
  assert(Array.isArray(bets), 'not an array');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
