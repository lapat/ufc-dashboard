#!/usr/bin/env node
// test_crossover_detector.js — Tests for live crossover detection module.
'use strict';
const {
  oddsToImplied, impliedToOdds,
  detectLiveCrossover, analyzeCrossoverTrajectory, crossoverAlertText,
} = require('./crossover_detector');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol=0.005) { return Math.abs(a-b) <= tol; }

// ── oddsToImplied ─────────────────────────────────────────────────────────────

console.log('\n── oddsToImplied ──');

check('positive odds +240 → ~29.4%', () => {
  assert(near(oddsToImplied(240), 0.294), oddsToImplied(240));
});
check('negative odds -300 → 75%', () => {
  assert(near(oddsToImplied(-300), 0.75), oddsToImplied(-300));
});
check('+100 (evens) → 50%', () => {
  assert(near(oddsToImplied(100), 0.5), oddsToImplied(100));
});
check('-100 → 50%', () => {
  assert(near(oddsToImplied(-100), 0.5), oddsToImplied(-100));
});
check('-110 → ~52.4%', () => {
  assert(near(oddsToImplied(-110), 0.524), oddsToImplied(-110));
});
check('+110 → ~47.6%', () => {
  assert(near(oddsToImplied(110), 0.476), oddsToImplied(110));
});
check('NaN string → null', () => {
  assert(oddsToImplied('x') === null);
});
check('null → null', () => {
  assert(oddsToImplied(null) === null);
});
check('string odds "-300" parsed correctly', () => {
  assert(near(oddsToImplied('-300'), 0.75));
});

// ── impliedToOdds ─────────────────────────────────────────────────────────────

console.log('\n── impliedToOdds ──');

check('0.75 → -300', () => {
  assert(impliedToOdds(0.75) === -300, impliedToOdds(0.75));
});
check('0.5 → -100', () => {
  assert(impliedToOdds(0.5) === -100, impliedToOdds(0.5));
});
check('0 → null (invalid)', () => {
  assert(impliedToOdds(0) === null);
});
check('1 → null (invalid)', () => {
  assert(impliedToOdds(1) === null);
});

// ── detectLiveCrossover ───────────────────────────────────────────────────────

console.log('\n── detectLiveCrossover: null / pick-em ──');

check('returns null for invalid odds', () => {
  assert(detectLiveCrossover('x', 200, -200, 165) === null);
});
check('returns null for pick-em opening (<5 ppts gap)', () => {
  // -110/-108 is essentially a pick-em, no meaningful crossover to track
  assert(detectLiveCrossover(-110, -108, -105, -113) === null);
});
check('returns result when gap is exactly 5 ppts', () => {
  // A fight that opens just barely past pick-em
  // -120 → 54.5%, +100 → 50%: gap = 4.5% < 5% → null
  assert(detectLiveCrossover(-120, 100, -120, 100) === null);
});
check('returns result for meaningful opening gap', () => {
  assert(detectLiveCrossover(-200, 165, -200, 165) !== null);
});

console.log('\n── detectLiveCrossover: status levels ──');

check('"none" — no significant movement', () => {
  // Opened -200/+165, no change
  const r = detectLiveCrossover(-200, 165, -200, 165);
  assert(r.status === 'none', r.status);
});

check('"none" — small dog improvement but not enough', () => {
  // Dog was at 33%, now 38% (+5 ppts) — need 10+ ppts for "approaching"
  const r = detectLiveCrossover(-200, 165, -175, 142);
  assert(r.status === 'none', r.status + ' move:' + r.movementPct);
});

check('"approaching" — dog moved 10+ ppts AND > 35%', () => {
  // Dog opened at 29% (+240), now at ~38% (+162) — moved 9 ppts, still below 43%
  // detectLiveCrossover(-310, 240, -175, 150)
  // oddsToImplied(150) = 100/250 = 40%, oddsToImplied(-175) = 175/275 = 63.6%
  // dog (f2) at 40%, opened at 29.4% → move = +10.6 ppts → approaching
  const r = detectLiveCrossover(-310, 240, -175, 150);
  assert(r.status === 'approaching', r.status + ' dog%:' + r.curDogProb + ' move:' + r.movementPct);
});

check('"imminent" — dog implied > 43%', () => {
  // Dog at 45% implied (+122 → 100/222 = 45%)
  const r = detectLiveCrossover(-300, 240, -130, 108);
  assert(r.status === 'imminent', r.status + ' dog%:' + r.curDogProb);
});

check('"crossed" — original dog now implied > 50%', () => {
  // Dog opened at +240, now at -150 (60% implied) → crossed
  const r = detectLiveCrossover(-300, 240, 120, -145);
  assert(r.status === 'crossed', r.status);
  assert(r.hasCrossed === true);
});

check('"crossed" when dog barely tips over 50%', () => {
  // Dog opened at +200, now at -102 (50.5% implied)
  const r = detectLiveCrossover(-250, 200, 100, -102);
  assert(r.status === 'crossed', r.status + ' dog%:' + r.curDogProb);
  assert(r.hasCrossed === true);
});

console.log('\n── detectLiveCrossover: dog side identification ──');

check('correctly identifies f2 as opening dog', () => {
  // F1 is fav (-300), F2 is dog (+240)
  const r = detectLiveCrossover(-300, 240, -300, 240);
  assert(r.dogSide === 'f2', r.dogSide);
});
check('correctly identifies f1 as opening dog', () => {
  // F1 is dog (+240), F2 is fav (-300)
  const r = detectLiveCrossover(240, -300, 240, -300);
  assert(r.dogSide === 'f1', r.dogSide);
});
check('symmetric: swapping f1/f2 flips dogSide but same status', () => {
  const r1 = detectLiveCrossover(-300, 240, -150, 120);
  const r2 = detectLiveCrossover(240, -300, 120, -150);
  assert(r1.status === r2.status, r1.status + ' vs ' + r2.status);
  assert(r1.dogSide !== r2.dogSide, 'dogSide should flip');
  assert(r1.curDogProb === r2.curDogProb, r1.curDogProb + ' vs ' + r2.curDogProb);
});

console.log('\n── detectLiveCrossover: output fields ──');

check('openDogProb matches expected opening implied prob', () => {
  // +240 → 100/340 = 29.4% → 29 when rounded
  const r = detectLiveCrossover(-310, 240, -300, 240);
  assert(r.openDogProb === 29, 'got: ' + r.openDogProb);
});
check('pptsToEven is 0 when already crossed', () => {
  const r = detectLiveCrossover(-300, 240, 120, -145);
  assert(r.pptsToEven === 0, r.pptsToEven);
});
check('pptsToEven > 0 when approaching', () => {
  const r = detectLiveCrossover(-300, 240, -142, 115);
  assert(r.pptsToEven > 0, r.pptsToEven);
  assert(r.pptsToEven <= 50 - r.curDogProb + 1); // sanity: can't exceed possible range
});
check('movementPct positive when dog is strengthening', () => {
  const r = detectLiveCrossover(-300, 240, -142, 115);
  assert(r.movementPct > 0, r.movementPct);
});
check('movementPct negative when dog is weakening', () => {
  // Dog opened at +240, now worse at +340
  const r = detectLiveCrossover(-300, 240, -400, 310);
  assert(r.movementPct < 0, r.movementPct);
});

// ── analyzeCrossoverTrajectory ────────────────────────────────────────────────

console.log('\n── analyzeCrossoverTrajectory ──');

function makeHistory(entries) {
  // entries: [{f1, f2, minutesFromStart}]
  const base = new Date('2026-01-01T00:00:00Z');
  return entries.map(({ f1, f2, min }) => ({
    timestamp: new Date(base.getTime() + min * 60000).toISOString(),
    fighter1: { name: 'Fighter A', numericOdds: f1, odds: String(f1) },
    fighter2: { name: 'Fighter B', numericOdds: f2, odds: String(f2) },
    isLocked: false,
  }));
}

check('returns null for empty history', () => {
  assert(analyzeCrossoverTrajectory([]) === null);
});
check('returns null for single-point history', () => {
  const h = makeHistory([{ f1: -300, f2: 240, min: 0 }]);
  assert(analyzeCrossoverTrajectory(h) === null);
});
check('returns null for pick-em history', () => {
  const h = makeHistory([
    { f1: -110, f2: -108, min: 0 },
    { f1: -105, f2: -113, min: 5 },
  ]);
  assert(analyzeCrossoverTrajectory(h) === null);
});

check('detects "crossed" status in trajectory', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -200, f2: 165, min: 3 },
    { f1: -130, f2: 108, min: 6 },
    { f1:  120, f2:-145, min: 9 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  assert(r.status === 'crossed', r.status);
  assert(r.hasCrossed === true);
});

check('detects "approaching" status in trajectory', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -200, f2: 165, min: 3 },
    { f1: -142, f2: 115, min: 6 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  assert(['approaching','imminent','crossed'].includes(r.status), r.status);
});

check('includes f1Name and f2Name from history', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -200, f2: 165, min: 5 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  assert(r.f1Name === 'Fighter A', r.f1Name);
  assert(r.f2Name === 'Fighter B', r.f2Name);
});

check('fightElapsedMin is correct', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -200, f2: 165, min: 7 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  assert(r.fightElapsedMin === 7, r.fightElapsedMin);
});

check('computes positive momentum when dog is strengthening', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -260, f2: 210, min: 2 },
    { f1: -220, f2: 180, min: 4 },
    { f1: -180, f2: 150, min: 6 },
    { f1: -150, f2: 122, min: 8 },
    { f1: -142, f2: 115, min: 10 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  assert(r.momentumPptsPerMin > 0, 'momentum: ' + r.momentumPptsPerMin);
});

check('minsToEven computed when status is approaching/imminent', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -260, f2: 210, min: 2 },
    { f1: -220, f2: 180, min: 4 },
    { f1: -180, f2: 150, min: 6 },
    { f1: -150, f2: 122, min: 8 },
    { f1: -142, f2: 115, min: 10 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  if (r.status !== 'crossed') {
    assert(r.minsToEven != null, 'minsToEven should be set when approaching');
    assert(r.minsToEven > 0, r.minsToEven);
  }
});

check('no movement → momentum is 0 or null', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -300, f2: 240, min: 5 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  assert(r.momentumPptsPerMin === 0 || r.momentumPptsPerMin == null,
    'momentum: ' + r.momentumPptsPerMin);
});

check('includes dataPoints count', () => {
  const h = makeHistory([
    { f1: -300, f2: 240, min: 0 },
    { f1: -200, f2: 165, min: 5 },
    { f1: -150, f2: 122, min: 10 },
  ]);
  const r = analyzeCrossoverTrajectory(h);
  assert(r.dataPoints === 3, r.dataPoints);
});

// ── crossoverAlertText ────────────────────────────────────────────────────────

console.log('\n── crossoverAlertText ──');

check('returns null for "none" status', () => {
  const state = { status: 'none', dogSide: 'f2', curDogProb: 30, openDogProb: 29, movementPct: 1 };
  assert(crossoverAlertText(state, 'A', 'B') === null);
});
check('returns null for null state', () => {
  assert(crossoverAlertText(null, 'A', 'B') === null);
});

check('"approached" text mentions fighter name and ppts', () => {
  const state = { status: 'approaching', dogSide: 'f2', curDogProb: 38, openDogProb: 29,
                  movementPct: 9, pptsToEven: 12, momentumPptsPerMin: null };
  const txt = crossoverAlertText(state, 'Oliveira', 'Makhachev');
  assert(txt !== null);
  assert(txt.includes('Makhachev'), txt); // f2 is dog
  assert(txt.includes('38'), txt);
});

check('"imminent" text mentions approaching crossover', () => {
  const state = { status: 'imminent', dogSide: 'f1', curDogProb: 44, openDogProb: 30,
                  movementPct: 14, pptsToEven: 6, momentumPptsPerMin: 2.1, minsToEven: 2.9 };
  const txt = crossoverAlertText(state, 'Oliveira', 'Makhachev');
  assert(txt !== null);
  assert(txt.toLowerCase().includes('imminent') || txt.includes('⚠️'), txt);
  assert(txt.includes('Oliveira'), txt); // f1 is dog
});

check('"crossed" text says BET NOW', () => {
  const state = { status: 'crossed', dogSide: 'f2', hasCrossed: true,
                  curDogProb: 55, openDogProb: 29, movementPct: 26, pptsToEven: 0,
                  f1Name: 'Fighter A', f2Name: 'Fighter B' };
  const txt = crossoverAlertText(state, null, null); // use names from state
  assert(txt !== null);
  assert(txt.toUpperCase().includes('BET'), txt);
  assert(txt.includes('Fighter B'), txt);
});

check('uses f1Name/f2Name from state when not passed', () => {
  const state = { status: 'crossed', dogSide: 'f1', hasCrossed: true,
                  curDogProb: 55, openDogProb: 29, movementPct: 26, pptsToEven: 0,
                  f1Name: 'Charles Oliveira', f2Name: 'Islam Makhachev' };
  const txt = crossoverAlertText(state);
  assert(txt.includes('Charles Oliveira'), txt);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
