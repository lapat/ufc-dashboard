#!/usr/bin/env node
// crossover_detector.js — Live crossover detection from in-fight odds movement.
//
// A "crossover" = the opening underdog becomes the favorite during a live fight.
// Key insight (from backtest): dogs win 50% in crossover fights vs 12% without.
// The LIVE signal is when the line crosses even — that's Ish's bet trigger.
//
// Used by server.js to track every active fight's crossover state.

'use strict';

// ── Odds conversion ───────────────────────────────────────────────────────────

// American odds → implied win probability (0-1, raw, no vig removal)
function oddsToImplied(americanOdds) {
  const n = parseFloat(americanOdds);
  if (isNaN(n)) return null;
  return n < 0
    ? Math.abs(n) / (Math.abs(n) + 100)
    : 100 / (n + 100);
}

// Implied probability → American odds (inverse)
function impliedToOdds(p) {
  if (p == null || p <= 0 || p >= 1) return null;
  return p >= 0.5
    ? -Math.round(p / (1 - p) * 100)
    : Math.round((1 - p) / p * 100);
}

// ── Single-snapshot crossover status ─────────────────────────────────────────
//
// STATUS LEVELS:
//   'none'       — no significant movement toward crossover
//   'approaching' — dog's implied prob moved 10+ ppts AND is now > 35%
//   'imminent'   — dog's implied prob > 43% (within 7 ppts of even)
//   'crossed'    — original dog is now the favorite (implied > 50%)
//
// Returns null if opening odds are too close to pick'em (<5 ppts gap) —
// there's no meaningful "dog" to cross in those fights.

function detectLiveCrossover(openF1, openF2, curF1, curF2) {
  const openP1 = oddsToImplied(openF1);
  const openP2 = oddsToImplied(openF2);
  const curP1  = oddsToImplied(curF1);
  const curP2  = oddsToImplied(curF2);

  if (openP1 == null || openP2 == null || curP1 == null || curP2 == null) return null;

  // If the opening line is essentially a pick'em, skip — no meaningful crossover.
  // "Meaningful" = gap of 5+ ppts in implied prob
  const openGap = Math.abs(openP1 - openP2);
  if (openGap < 0.05) return null;

  // Dog at opening = fighter with LOWER implied probability (higher/more positive odds)
  const dogWasF1    = openP1 < openP2;
  const openDogProb = dogWasF1 ? openP1 : openP2;
  const curDogProb  = dogWasF1 ? curP1  : curP2;
  const curFavProb  = dogWasF1 ? curP2  : curP1;

  // ppts the dog's implied prob has shifted from opening
  const movement    = curDogProb - openDogProb; // positive = moving toward fav
  const movementPct = Math.round(movement * 100);

  // ppts remaining until the line crosses even
  const pptsToEven  = Math.round((0.50 - curDogProb) * 100);

  // Status
  let status;
  if (curDogProb > 0.50) {
    status = 'crossed';
  } else if (curDogProb >= 0.43) {
    status = 'imminent';
  } else if (curDogProb >= 0.35 && movement >= 0.10) {
    status = 'approaching';
  } else {
    status = 'none';
  }

  return {
    status,
    dogSide:      dogWasF1 ? 'f1' : 'f2',
    openDogProb:  Math.round(openDogProb * 100),  // % at opening
    curDogProb:   Math.round(curDogProb  * 100),  // % now
    movementPct,                                   // ppts shift (positive = dog strengthening)
    pptsToEven:   Math.max(pptsToEven, 0),         // 0 once crossed
    hasCrossed:   curDogProb > 0.50,
  };
}

// ── Trajectory analysis from full oddsHistory ─────────────────────────────────
// Computes current status plus momentum (rate of movement toward crossover).
// `oddsHistory` = array of { fighter1: { numericOdds }, fighter2: { numericOdds }, timestamp }

function analyzeCrossoverTrajectory(oddsHistory) {
  if (!oddsHistory || oddsHistory.length < 2) return null;

  const first = oddsHistory[0];
  const last  = oddsHistory[oddsHistory.length - 1];

  const openF1 = first.fighter1.numericOdds;
  const openF2 = first.fighter2.numericOdds;
  const curF1  = last.fighter1.numericOdds;
  const curF2  = last.fighter2.numericOdds;

  const detection = detectLiveCrossover(openF1, openF2, curF1, curF2);
  if (!detection) return null;

  // Momentum: rate of dog's implied prob change over the last few data points.
  // Use up to the last 6 points (≈ last 30-60s in live recording).
  const windowSize = Math.min(6, oddsHistory.length);
  const windowStart = oddsHistory[oddsHistory.length - windowSize];
  const windowEnd   = last;
  const dogWasF1    = detection.dogSide === 'f1';

  const windowP_start = oddsToImplied(dogWasF1 ? windowStart.fighter1.numericOdds : windowStart.fighter2.numericOdds);
  const windowP_end   = oddsToImplied(dogWasF1 ? windowEnd.fighter1.numericOdds   : windowEnd.fighter2.numericOdds);

  // Momentum in ppts per minute
  let momentumPptsPerMin = null;
  const tStart = new Date(windowStart.timestamp).getTime();
  const tEnd   = new Date(windowEnd.timestamp).getTime();
  const elapsedMin = (tEnd - tStart) / 60000;
  if (elapsedMin > 0 && windowP_start != null && windowP_end != null) {
    const shift = (windowP_end - windowP_start) * 100; // ppts
    momentumPptsPerMin = Math.round((shift / elapsedMin) * 10) / 10;
  }

  // Time to crossover at current momentum (minutes)
  let minsToEven = null;
  if (momentumPptsPerMin > 0 && detection.pptsToEven > 0) {
    minsToEven = Math.round((detection.pptsToEven / momentumPptsPerMin) * 10) / 10;
  }

  // Total elapsed fight time (first to last point)
  const fightElapsedMin = Math.round((new Date(last.timestamp) - new Date(first.timestamp)) / 60000);

  return {
    ...detection,
    dataPoints:       oddsHistory.length,
    fightElapsedMin,
    momentumPptsPerMin,
    minsToEven,
    openF1Odds:  openF1,
    openF2Odds:  openF2,
    curF1Odds:   curF1,
    curF2Odds:   curF2,
    f1Name:  first.fighter1.name,
    f2Name:  first.fighter2.name,
  };
}

// ── Human-readable alert text ─────────────────────────────────────────────────

function crossoverAlertText(state, f1Name, f2Name) {
  if (!state || state.status === 'none') return null;

  const dogName = state.dogSide === 'f1' ? (f1Name || state.f1Name) : (f2Name || state.f2Name);
  const favName = state.dogSide === 'f1' ? (f2Name || state.f2Name) : (f1Name || state.f1Name);

  if (state.status === 'crossed') {
    return `🔴 LINE CROSSED — ${dogName} was the dog, now the fav (${state.curDogProb}% implied). BET THE DOG NOW.`;
  }
  if (state.status === 'imminent') {
    const momentum = state.momentumPptsPerMin > 0
      ? ` Moving at +${state.momentumPptsPerMin} ppts/min.${state.minsToEven != null ? ` ~${state.minsToEven} min to cross.` : ''}`
      : '';
    return `⚠️ CROSSOVER IMMINENT — ${dogName} at ${state.curDogProb}% (was ${state.openDogProb}% at open).${momentum}`;
  }
  if (state.status === 'approaching') {
    return `👀 LINE MOVING — ${dogName} up +${state.movementPct} ppts to ${state.curDogProb}% implied. Watch for live bet.`;
  }
  return null;
}

module.exports = {
  oddsToImplied,
  impliedToOdds,
  detectLiveCrossover,
  analyzeCrossoverTrajectory,
  crossoverAlertText,
};

// ── CLI demo ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  const examples = [
    { label: 'Heavy fav, line tightening',
      open: [-380, 295], cur: [-145, 118] },
    { label: 'Moderate fav, approaching crossover',
      open: [-250, 200], cur: [-110, -108] },
    { label: 'Line crossed — dog is now fav',
      open: [-300, 240], cur: [+125, -150] },
    { label: 'Pick-em (no meaningful crossover)',
      open: [-110, -108], cur: [-105, -113] },
    { label: 'No movement',
      open: [-200, 165], cur: [-200, 165] },
  ];
  for (const ex of examples) {
    const r = detectLiveCrossover(ex.open[0], ex.open[1], ex.cur[0], ex.cur[1]);
    console.log(`\n${ex.label}:`);
    if (!r) { console.log('  → null (pick-em or bad odds)'); continue; }
    console.log(`  status=${r.status}  dog=${r.dogSide}  ${r.openDogProb}%→${r.curDogProb}%  move=+${r.movementPct}ppts`);
    const txt = crossoverAlertText(r, 'Fighter A', 'Fighter B');
    if (txt) console.log('  →', txt);
  }
}
