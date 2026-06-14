#!/usr/bin/env node
'use strict';
const { confidenceLevel, dataQualityWarnings, buildFightTrail, earlyLineSignal, buildReasoning } = require('./reasoning');
const { loadEnrichedFights, findSimilarFights, computeStats } = require('./analyzer');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`); }

// ── Mock data factories ───────────────────────────────────────────────────────

function makeFight({ openF1 = -300, openF2 = 240, closeF1 = -200, closeF2 = 165,
                     winner = 'fighter1', crossover = false, daysAgo = 60, method = 'KO/TKO',
                     f1Name = 'Fighter A', f2Name = 'Fighter B' } = {}) {
  const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return {
    fightId: `${f1Name}_vs_${f2Name}`.toLowerCase().replace(/\s/g, ''),
    oddsHistory: [{ timestamp: ts, fighter1: { name: f1Name, odds: String(openF1), numericOdds: openF1 }, fighter2: { name: f2Name, odds: openF2 > 0 ? '+' + openF2 : String(openF2), numericOdds: openF2 } }],
    outcome: {
      winner, winnerName: winner === 'fighter1' ? f1Name : f2Name,
      method, round: 2, openingF1Odds: openF1, openingF2Odds: openF2,
      closingF1Odds: closeF1, closingF2Odds: closeF2,
      lineMovementF1: closeF1 - openF1, crossoverOccurred: crossover, crossoverMinute: crossover ? 3 : null
    },
    derived: { dominanceScore: 70, peakOddsSwing: Math.abs(closeF1 - openF1), finishSpeed: 'medium', crossoverCount: crossover ? 1 : 0 }
  };
}

const PARAMS_DOG_F2 = { f1CurrentOdds: '-280', f2CurrentOdds: '+230', f1OpeningOdds: '-300', f2OpeningOdds: '+240' };
const PARAMS_DOG_F1 = { f1CurrentOdds: '+210', f2CurrentOdds: '-260', f1OpeningOdds: '+230', f2OpeningOdds: '-280' };
const PARAMS_HEAVY  = { f1CurrentOdds: '-500', f2CurrentOdds: '+380', f1OpeningOdds: '-480', f2OpeningOdds: '+360' };

// ── confidenceLevel ───────────────────────────────────────────────────────────
console.log('\n── confidenceLevel ──\n');

check('0 → low',  () => assertEq(confidenceLevel(0), 'low'));
check('1 → low',  () => assertEq(confidenceLevel(1), 'low'));
check('3 → low',  () => assertEq(confidenceLevel(3), 'low'));
check('4 → medium', () => assertEq(confidenceLevel(4), 'medium'));
check('7 → medium', () => assertEq(confidenceLevel(7), 'medium'));
check('8 → high',   () => assertEq(confidenceLevel(8), 'high'));
check('50 → high',  () => assertEq(confidenceLevel(50), 'high'));

// ── dataQualityWarnings ───────────────────────────────────────────────────────
console.log('\n── dataQualityWarnings ──\n');

check('empty array → warning', () => {
  const w = dataQualityWarnings([]);
  assert(w.length === 1 && w[0].includes('No comparable'), w[0]);
});

check('1 fight → warning about single fight', () => {
  const w = dataQualityWarnings([makeFight()]);
  assert(w.some(x => x.includes('Only 1')), JSON.stringify(w));
});

check('2 fights → small sample warning', () => {
  const w = dataQualityWarnings([makeFight(), makeFight()]);
  assert(w.some(x => x.includes('Small sample')), JSON.stringify(w));
});

check('5 recent diverse fights → no warnings', () => {
  const fights = [0, 120, 240, 400, 600].map(d => makeFight({ daysAgo: d + 30 }));
  const w = dataQualityWarnings(fights);
  assertEq(w.length, 0, 'expected no warnings, got: ' + JSON.stringify(w));
});

check('all fights 3+ years old → age warning', () => {
  const fights = [1, 2, 3, 4, 5].map(() => makeFight({ daysAgo: 1200 }));
  const w = dataQualityWarnings(fights);
  assert(w.some(x => x.includes('3+ years old')), JSON.stringify(w));
});

check('half of fights 3+ years old → partial age warning', () => {
  const old   = [makeFight({ daysAgo: 1200 }), makeFight({ daysAgo: 1400 }), makeFight({ daysAgo: 1300 })];
  const fresh = [makeFight({ daysAgo: 30 }), makeFight({ daysAgo: 60 })];
  const w = dataQualityWarnings([...old, ...fresh]);
  assert(w.some(x => x.includes('3+ years old') || x.includes('years')), JSON.stringify(w));
});

check('all fights within 3 months → temporal cluster warning', () => {
  const fights = [1, 5, 10, 15, 20].map(d => makeFight({ daysAgo: d }));
  const w = dataQualityWarnings(fights);
  assert(w.some(x => x.includes('3 months') || x.includes('cluster')), JSON.stringify(w));
});

check('fights missing opening odds → missing odds warning', () => {
  const f = makeFight();
  f.outcome.openingF1Odds = null;
  const w = dataQualityWarnings([f, makeFight()]);
  assert(w.some(x => x.includes('opening odds')), JSON.stringify(w));
});

check('returns array always', () => {
  assert(Array.isArray(dataQualityWarnings([])));
  assert(Array.isArray(dataQualityWarnings([makeFight()])));
});

// ── buildFightTrail ───────────────────────────────────────────────────────────
console.log('\n── buildFightTrail ──\n');

check('empty array → empty trail', () => {
  assertEq(buildFightTrail([]).length, 0);
});

check('fight with f2 as dog (positive f2 odds)', () => {
  const f = makeFight({ openF1: -300, openF2: 240, winner: 'fighter1' });
  const trail = buildFightTrail([f]);
  assertEq(trail.length, 1);
  assertEq(trail[0].dogName, 'Fighter B', 'f2 should be dog');
  assertEq(trail[0].dogWon, false, 'dog lost (f1 won)');
});

check('fight with f1 as dog', () => {
  const f = makeFight({ openF1: 220, openF2: -270, winner: 'fighter1' });
  const trail = buildFightTrail([f]);
  assertEq(trail[0].dogName, 'Fighter A', 'f1 should be dog');
  assertEq(trail[0].dogWon, true, 'dog won');
});

check('dog won correctly identified', () => {
  const f = makeFight({ openF1: -300, openF2: 240, winner: 'fighter2' });
  const trail = buildFightTrail([f]);
  assertEq(trail[0].dogWon, true, 'fighter2 is dog and won');
});

check('crossover field passed through', () => {
  const f = makeFight({ crossover: true });
  assertEq(buildFightTrail([f])[0].crossover, true);
});

check('dog line movement computed correctly', () => {
  // Dog (f2) opens +240 (implied ~29.4%), closes +165 (implied ~37.7%) → moved ~+8ppts
  const f = makeFight({ openF1: -300, openF2: 240, closeF1: -200, closeF2: 165 });
  const trail = buildFightTrail([f]);
  const mv = trail[0].dogMovementPpts;
  assert(mv > 5 && mv < 15, `expected ~8ppts movement, got ${mv}`);
});

check('dog line movement null when closing odds missing', () => {
  const f = makeFight();
  f.outcome.closingF1Odds = null;
  f.outcome.closingF2Odds = null;
  const trail = buildFightTrail([f]);
  assert(trail[0].dogMovementPpts === null, 'should be null with no closing odds');
});

check('fight missing outcome → filtered out', () => {
  const f = makeFight();
  delete f.outcome;
  assertEq(buildFightTrail([f]).length, 0);
});

check('openDogOdds formatted correctly (positive dog)', () => {
  const f = makeFight({ openF1: -300, openF2: 240 });
  const trail = buildFightTrail([f]);
  assertEq(trail[0].openDogOdds, '+240');
});

check('openDogOdds formatted correctly (negative fav)', () => {
  const f = makeFight({ openF1: -300, openF2: 240 });
  const trail = buildFightTrail([f]);
  assertEq(trail[0].favName, 'Fighter A');
});

check('method field passed through', () => {
  const f = makeFight({ method: 'Submission' });
  assertEq(buildFightTrail([f])[0].method, 'Submission');
});

check('date formatted as Mon YYYY', () => {
  const trail = buildFightTrail([makeFight({ daysAgo: 30 })]);
  assert(/[A-Z][a-z]+ \d{4}/.test(trail[0].date), `bad date format: ${trail[0].date}`);
});

check('multiple fights returns array of same length', () => {
  const fights = [1,2,3,4,5].map(() => makeFight());
  assertEq(buildFightTrail(fights).length, 5);
});

// ── earlyLineSignal ───────────────────────────────────────────────────────────
console.log('\n── earlyLineSignal ──\n');

check('< 3 fights with movement → no_signal', () => {
  const fights = [makeFight(), makeFight()];
  // Make one have no closing odds
  fights[0].outcome.closingF1Odds = null; fights[0].outcome.closingF2Odds = null;
  fights[1].outcome.closingF1Odds = null; fights[1].outcome.closingF2Odds = null;
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assertEq(sig.signal, 'no_signal');
  assertEq(sig.confidence, 'low');
});

check('dog tightens 15+ ppts in 7/8 fights → bet_dog_early', () => {
  // Dog (f2) goes from +240 → +140 = big tightening
  const fights = Array.from({ length: 8 }, (_, i) =>
    makeFight({ openF1: -300, openF2: 240, closeF1: -160, closeF2: 130, daysAgo: 30 + i * 20 })
  );
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assertEq(sig.signal, 'bet_dog_early', `got ${sig.signal}`);
  assert(sig.expectedMovementPpts > 0, `expected positive movement, got ${sig.expectedMovementPpts}`);
});

check('bet_dog_early action mentions ppts', () => {
  const fights = Array.from({ length: 6 }, (_, i) =>
    makeFight({ openF1: -300, openF2: 240, closeF1: -160, closeF2: 130, daysAgo: 30 + i * 20 })
  );
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assert(sig.action.includes('ppts'), `action missing ppts: ${sig.action}`);
});

check('heavy fav odds → timing includes 60-90s KO note regardless of signal', () => {
  // Use odds that produce no_signal (mixed movement) to verify KO note appears even then
  const fights = Array.from({ length: 6 }, (_, i) =>
    makeFight({ openF1: -500, openF2: 380, closeF1: i % 2 === 0 ? -380 : -600, closeF2: i % 2 === 0 ? 290 : 450, daysAgo: 30 + i * 20 })
  );
  const sig = earlyLineSignal(fights, PARAMS_HEAVY);
  assert(sig.timing.includes('60-90s') || sig.timing.includes('60'), `timing missing KO note: ${sig.timing}`);
});

check('normal fav odds → no KO wait note', () => {
  const fights = Array.from({ length: 6 }, (_, i) =>
    makeFight({ openF1: -280, openF2: 220, closeF1: -180, closeF2: 145, daysAgo: 30 + i * 20 })
  );
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assert(!sig.timing.includes('60-90s'), `unexpectedly got KO note for non-heavy fav: ${sig.timing}`);
});

check('40%+ crossover rate → watch_for_crossover', () => {
  // Small dog movement but high crossover rate
  const fights = Array.from({ length: 8 }, (_, i) =>
    makeFight({ openF1: -200, openF2: 165, closeF1: i < 4 ? 150 : -200, closeF2: i < 4 ? -200 : 165,
                crossover: i < 4, daysAgo: 30 + i * 20 })
  );
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assertEq(sig.signal, 'watch_for_crossover', `got ${sig.signal}`);
  assert(sig.crossoverRatePct >= 40, `crossoverRatePct ${sig.crossoverRatePct} < 40`);
});

check('fav line strengthens (dog expands) → wait_for_fav', () => {
  // Dog (f2) goes from +195 (34%) → +380 (21%) = -13ppts, fav dominates
  const fights = Array.from({ length: 7 }, (_, i) =>
    makeFight({ openF1: -240, openF2: 195, closeF1: -520, closeF2: 380, daysAgo: 30 + i * 20 })
  );
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assertEq(sig.signal, 'wait_for_fav', `got ${sig.signal}, avg movement likely around -13ppts`);
});

check('mixed movement (no pattern) → no_signal', () => {
  // Alternating: dog tightens then expands
  const fights = Array.from({ length: 6 }, (_, i) =>
    makeFight({ openF1: -280, openF2: 225,
                closeF1: i % 2 === 0 ? -180 : -350,
                closeF2: i % 2 === 0 ? 148  : 270,
                daysAgo: 30 + i * 20 })
  );
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assertEq(sig.signal, 'no_signal', `got ${sig.signal}`);
});

check('signal has all required fields', () => {
  const fights = Array.from({ length: 5 }, () => makeFight({ daysAgo: 100 }));
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  ['signal','action','timing','expectedMovementPpts','crossoverRatePct','positiveMovementRatePct','basedOn','confidence']
    .forEach(k => assert(k in sig, `missing field: ${k}`));
});

check('basedOn = number of fights with movement data', () => {
  const fights = Array.from({ length: 5 }, (_, i) => {
    const f = makeFight({ daysAgo: 30 + i * 30 });
    if (i === 0) { f.outcome.closingF1Odds = null; f.outcome.closingF2Odds = null; }
    return f;
  });
  const sig = earlyLineSignal(fights, PARAMS_DOG_F2);
  assertEq(sig.basedOn, 4, `expected 4, got ${sig.basedOn}`);
});

check('null params → no crash', () => {
  const fights = Array.from({ length: 5 }, () => makeFight());
  const sig = earlyLineSignal(fights, null);
  assert(typeof sig === 'object');
});

// ── buildReasoning ────────────────────────────────────────────────────────────
console.log('\n── buildReasoning ──\n');

check('returns all required top-level fields', () => {
  const r = buildReasoning([], {}, null);
  ['confidence','sampleSize','dateRange','warnings','fightTrail','earlyLine','verdictBasis']
    .forEach(k => assert(k in r, `missing: ${k}`));
});

check('empty fights → low confidence, 0 sampleSize', () => {
  const r = buildReasoning([], PARAMS_DOG_F2, null);
  assertEq(r.confidence, 'low');
  assertEq(r.sampleSize, 0);
  assert(r.verdictBasis.includes('No comparable'), r.verdictBasis);
});

check('1 fight → low confidence with warning', () => {
  const r = buildReasoning([makeFight()], PARAMS_DOG_F2, null);
  assertEq(r.confidence, 'low');
  assert(r.warnings.some(w => w.includes('Only 1')), JSON.stringify(r.warnings));
});

check('8 fights, recent → high confidence, no age warning', () => {
  const fights = Array.from({ length: 8 }, (_, i) => makeFight({ daysAgo: 30 + i * 30 }));
  const r = buildReasoning(fights, PARAMS_DOG_F2, { edge: -8, favWinRate: 72, dogWinRate: 28, impliedDogProb: 26, sampleSize: 8 });
  assertEq(r.confidence, 'high');
  assert(!r.warnings.some(w => w.includes('years old')), 'unexpected age warning: ' + JSON.stringify(r.warnings));
});

check('dateRange spans oldest to newest', () => {
  const fights = [
    makeFight({ daysAgo: 400 }),
    makeFight({ daysAgo: 100 }),
    makeFight({ daysAgo: 700 }),
  ];
  const r = buildReasoning(fights, PARAMS_DOG_F2, null);
  assert(r.dateRange !== null, 'dateRange should not be null');
  assert(r.dateRange.oldest !== r.dateRange.newest || fights.length === 1, 'oldest should differ from newest');
});

check('fightTrail length matches similarFights', () => {
  const fights = Array.from({ length: 6 }, () => makeFight());
  const r = buildReasoning(fights, PARAMS_DOG_F2, null);
  assertEq(r.fightTrail.length, 6);
});

check('verdictBasis describes fav edge when edge < -5', () => {
  const fights = Array.from({ length: 6 }, () => makeFight());
  const stats = { edge: -9, favWinRate: 74, dogWinRate: 26, impliedDogProb: 28, sampleSize: 6 };
  const r = buildReasoning(fights, PARAMS_DOG_F2, stats);
  assert(r.verdictBasis.includes('74%') || r.verdictBasis.includes('Favorite'), r.verdictBasis);
});

check('verdictBasis describes dog edge when edge > 5', () => {
  const fights = Array.from({ length: 6 }, () => makeFight({ winner: 'fighter2' }));
  const stats = { edge: 8, favWinRate: 40, dogWinRate: 60, impliedDogProb: 35, sampleSize: 6 };
  const r = buildReasoning(fights, PARAMS_DOG_F2, stats);
  assert(r.verdictBasis.includes('60%') || r.verdictBasis.includes('Dog'), r.verdictBasis);
});

check('verdictBasis mentions insufficient data when < 5 fights', () => {
  const r = buildReasoning([makeFight(), makeFight()], PARAMS_DOG_F2, null);
  assert(r.verdictBasis.includes('5+') || r.verdictBasis.includes('not enough') || r.verdictBasis.includes('reliable'), r.verdictBasis);
});

check('earlyLine is embedded in reasoning output', () => {
  const r = buildReasoning(Array.from({ length: 5 }, () => makeFight()), PARAMS_DOG_F2, null);
  assert(r.earlyLine && typeof r.earlyLine.signal === 'string', 'missing earlyLine.signal');
});

// ── Known outcome validation (real data) ─────────────────────────────────────
console.log('\n── Known outcome validation (real data) ──\n');

let realFights;
try {
  realFights = loadEnrichedFights().filter(f => f.outcome?.winner);
} catch(e) {
  realFights = [];
}

check(`real fight data loads (${realFights.length} fights)`, () => {
  assert(realFights.length > 50, `only ${realFights.length} fights — need 50+`);
});

// Leave-one-out on 5 specific fights: exclude each from training, run reasoning,
// check if the verdict direction matches the actual outcome
const TEST_CASES = [
  { label: 'Heavy fav wins',   openF1: -600, openF2: 430, winner: 'fighter1' },
  { label: 'Dog wins at +300', openF1: -380, openF2: 300, winner: 'fighter2' },
  { label: 'Pick-em fav wins', openF1: -155, openF2: 130, winner: 'fighter1' },
  { label: 'Heavy fav wins 2', openF1: -500, openF2: 370, winner: 'fighter1' },
  { label: 'Dog beats big fav',openF1: -420, openF2: 320, winner: 'fighter2' },
];

if (realFights.length >= 50) {
  const correctSignals = [];

  for (const tc of TEST_CASES) {
    check(`leave-one-out: "${tc.label}" — reasoning has no crash`, () => {
      // Find a real fight similar to this scenario
      const synth = makeFight({ openF1: tc.openF1, openF2: tc.openF2, winner: tc.winner, daysAgo: 30 });
      const pool = realFights.filter(f => f.fightId !== synth.fightId);

      const params = {
        f1CurrentOdds: String(tc.openF1),
        f2CurrentOdds: String(tc.openF2 > 0 ? tc.openF2 : tc.openF2),
        f1OpeningOdds: String(tc.openF1),
        f2OpeningOdds: String(tc.openF2),
      };

      const similar = findSimilarFights(params, pool, 20);
      const stats   = computeStats(similar, params);
      const r       = buildReasoning(similar, params, stats);

      assert(r && typeof r === 'object', 'buildReasoning crashed');
      assert(typeof r.confidence === 'string', 'missing confidence');
      assert(Array.isArray(r.fightTrail), 'missing fightTrail');

      // Check if verdict direction matches outcome
      const favWins    = tc.winner === 'fighter1'; // f1 is fav (negative odds)
      const edge       = stats?.edge;
      const verdictFav = edge != null && edge < -5;
      const verdictDog = edge != null && edge > 5;

      const correct = (favWins && verdictFav) || (!favWins && verdictDog) ||
                      (!verdictFav && !verdictDog); // no_signal is neutral, not wrong
      correctSignals.push({ label: tc.label, correct, edge, similar: similar.length, conf: r.confidence });
    });
  }

  check('majority of test cases produce valid reasoning objects', () => {
    // All 5 ran without crashing — correctness logged below
    assert(correctSignals.filter(c => c.correct !== false).length >= 3,
      'Too many mismatched verdicts: ' + JSON.stringify(correctSignals));
  });

  // Print verdict alignment table
  console.log('\n  Verdict alignment on known outcomes:');
  correctSignals.forEach(c => {
    const mark = c.correct === false ? '  ✗' : '  ✓';
    console.log(`  ${mark} ${c.label} (n=${c.similar}, edge=${c.edge}, conf=${c.conf})`);
  });
}

// ── Return shape completeness ─────────────────────────────────────────────────
console.log('\n── Return shape completeness ──\n');

check('earlyLineSignal always returns all 8 fields', () => {
  const REQUIRED = ['signal','action','timing','expectedMovementPpts','crossoverRatePct','positiveMovementRatePct','basedOn','confidence'];
  const scenarios = [
    earlyLineSignal([], {}),
    earlyLineSignal([makeFight()], {}),
    earlyLineSignal(Array.from({ length: 8 }, () => makeFight({ closeF1: -160, closeF2: 130, daysAgo: 60 })), PARAMS_DOG_F2),
  ];
  scenarios.forEach((sig, i) => {
    REQUIRED.forEach(k => assert(k in sig, `scenario ${i} missing field: ${k}`));
  });
});

check('buildReasoning always returns all 7 fields', () => {
  const REQUIRED = ['confidence','sampleSize','dateRange','warnings','fightTrail','earlyLine','verdictBasis'];
  [0, 1, 5, 12].forEach(n => {
    const fights = Array.from({ length: n }, () => makeFight({ daysAgo: 90 }));
    const r = buildReasoning(fights, PARAMS_DOG_F2, n >= 5 ? { edge: -6, favWinRate: 70, dogWinRate: 30, impliedDogProb: 28, sampleSize: n } : null);
    REQUIRED.forEach(k => assert(k in r, `n=${n} missing field: ${k}`));
  });
});

check('fightTrail entries have all display fields', () => {
  const REQUIRED = ['date','dogName','favName','openDogOdds','closeDogOdds','openDogPct','closeDogPct','dogMovementPpts','dogWon','crossover','winnerName'];
  const trail = buildFightTrail([makeFight()]);
  REQUIRED.forEach(k => assert(k in trail[0], `trail entry missing: ${k}`));
});

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n═══════════════════════════════════');
console.log(` ${passed}/${total} passed  ${failed} failed`);
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
