#!/usr/bin/env node
// crossover_predictor.js — Pre-fight crossover probability scoring.
//
// A "crossover" = the underdog becomes the favourite during the live fight.
// Key finding from 231-fight backtest:
//   - Dog wins 50% in crossover fights vs 12% in no-crossover fights
//   - 57% of crossovers happen in the first 5 minutes
//   - Crossover rate is almost entirely determined by opening odds tightness
//
// Used by server.js via: const { predictCrossover } = require('./crossover_predictor');
// Used by analyzer.js to enrich similarity scoring and Claude prompt.

'use strict';

// ── Empirical crossover rates from 231-fight leave-one-out backtest ──────────
// Key: rough tightness = min(|f1 opening|, |f2 opening|) in American odds

const CROSSOVER_TABLE = [
  // [maxAbsOdds (of the TIGHTER side), crossoverRate, dogWinIfCross, dogWinIfNoCross]
  { maxTight: 129,  rate: 0.61, dogWinCross: 0.50, dogWinNoCross: 0.12, label: 'pick_em' },
  { maxTight: 199,  rate: 0.47, dogWinCross: 0.50, dogWinNoCross: 0.12, label: 'slight_fav' },
  { maxTight: 299,  rate: 0.33, dogWinCross: 0.50, dogWinNoCross: 0.12, label: 'moderate_fav' },
  { maxTight: 499,  rate: 0.15, dogWinCross: 0.50, dogWinNoCross: 0.12, label: 'heavy_fav' },
  { maxTight: 9999, rate: 0.00, dogWinCross: 0.00, dogWinNoCross: 0.00, label: 'extreme_fav' },
];

// ── Core predictor ────────────────────────────────────────────────────────────

/**
 * predictCrossover({ f1OpeningOdds, f2OpeningOdds })
 *
 * Returns:
 *   crossoverProb     — 0-1 probability of a live crossover
 *   tier              — odds tier label ('pick_em', 'slight_fav', etc.)
 *   expectedDogWinRate — blended dog win rate given crossover probability
 *   impliedDogWinRate  — what the book implies for the dog
 *   signal            — 'strong' | 'moderate' | 'low' | 'none'
 *   advice            — one-sentence plain-English guidance
 *
 * Called with opening odds. Can also be called with live odds during a fight
 * (the prediction weakens if the fight is past the crossover window).
 */
function predictCrossover({ f1OpeningOdds, f2OpeningOdds }) {
  const o1 = parseFloat(f1OpeningOdds);
  const o2 = parseFloat(f2OpeningOdds);
  if (isNaN(o1) || isNaN(o2)) return null;

  // "tightness" = how close to even is the opening line?
  // We use the magnitude of the MORE-NEGATIVE side (the fav)
  const favOdds   = Math.min(o1, o2); // most negative = fav
  const tightness = Math.abs(favOdds); // e.g. -188 → 188

  // Look up crossover rate from empirical table
  const row = CROSSOVER_TABLE.find(r => tightness <= r.maxTight) || CROSSOVER_TABLE[CROSSOVER_TABLE.length - 1];
  const crossoverProb = row.rate;

  // Dog odds and implied probability
  const dogOdds    = Math.max(o1, o2); // least negative or most positive = dog
  const impliedDog = dogOdds > 0
    ? 100 / (dogOdds + 100)
    : Math.abs(dogOdds) / (Math.abs(dogOdds) + 100);

  // Blended expected dog win rate, given crossover probability:
  //   P(dog wins) = P(crossover) × P(dog wins | crossover) + P(no crossover) × P(dog wins | no crossover)
  const expectedDogWinRate =
    crossoverProb * row.dogWinCross + (1 - crossoverProb) * row.dogWinNoCross;

  // Edge vs implied
  const crossoverEdge = Math.round((expectedDogWinRate - impliedDog) * 1000) / 10;

  // Signal strength
  let signal;
  if (crossoverProb >= 0.55) signal = 'strong';
  else if (crossoverProb >= 0.40) signal = 'moderate';
  else if (crossoverProb >= 0.20) signal = 'low';
  else signal = 'none';

  // Plain-English advice
  let advice;
  const dogOddsStr = dogOdds > 0 ? '+' + dogOdds : String(dogOdds);
  if (signal === 'strong') {
    advice = `${Math.round(crossoverProb * 100)}% crossover probability — bet the dog (${dogOddsStr}) NOW before the line moves. Dogs win 50% when this crosses.`;
  } else if (signal === 'moderate') {
    advice = `${Math.round(crossoverProb * 100)}% crossover probability — worth considering the dog (${dogOddsStr}) pre-fight. If it crosses, dog wins coin-flip.`;
  } else if (signal === 'low') {
    advice = `${Math.round(crossoverProb * 100)}% crossover probability — lean on the favourite. Underdogs in these fights rarely win without a line cross.`;
  } else {
    advice = `Near-zero crossover probability — this fight almost never flips. Trust the favourite.`;
  }

  return {
    crossoverProb:        Math.round(crossoverProb * 100) / 100,
    crossoverProbPct:     Math.round(crossoverProb * 100),
    tier:                 row.label,
    tightness,
    dogOdds,
    dogOddsStr,
    impliedDogWinRate:    Math.round(impliedDog * 100),
    expectedDogWinRate:   Math.round(expectedDogWinRate * 100),
    crossoverEdge,
    signal,
    advice,
    // Timing context (57% of crossovers happen in round 1)
    earlyWindowPct:       57,
    medWindowPct:         39,
  };
}

/**
 * assessCrossoverRisk(similar, params)
 *
 * Given a set of similar historical fights, compute empirical crossover rate
 * and compare to the model prediction. Used in analyzer.js for a richer signal.
 */
function assessCrossoverRisk(similar, params) {
  if (!similar.length) return null;
  const crossoverFights = similar.filter(f => f.outcome.crossoverOccurred);
  const empiricalRate   = crossoverFights.length / similar.length;

  // How did dogs perform in crossover vs non-crossover fights in this sample?
  const dogWinsInCross  = crossoverFights.filter(f => {
    const f1IsDog = f.outcome.openingF1Odds > 0;
    return f1IsDog ? f.outcome.winner === 'fighter1' : f.outcome.winner === 'fighter2';
  }).length;
  const noCrossFights   = similar.filter(f => !f.outcome.crossoverOccurred);
  const dogWinsNoCross  = noCrossFights.filter(f => {
    const f1IsDog = f.outcome.openingF1Odds > 0;
    return f1IsDog ? f.outcome.winner === 'fighter1' : f.outcome.winner === 'fighter2';
  }).length;

  return {
    empiricalCrossoverRate:   Math.round(empiricalRate * 100),
    crossoverFightCount:      crossoverFights.length,
    noCrossoverFightCount:    noCrossFights.length,
    dogWinRateOnCross:        crossoverFights.length
      ? Math.round(dogWinsInCross / crossoverFights.length * 100) : null,
    dogWinRateNoCross:        noCrossFights.length
      ? Math.round(dogWinsNoCross / noCrossFights.length * 100) : null,
  };
}

module.exports = { predictCrossover, assessCrossoverRisk };

// ── CLI demo ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  const examples = [
    { label: 'Pick-em',        f1OpeningOdds: -116, f2OpeningOdds: -102 },
    { label: 'Slight fav',     f1OpeningOdds: -165, f2OpeningOdds: +138 },
    { label: 'Moderate fav',   f1OpeningOdds: -240, f2OpeningOdds: +195 },
    { label: 'Heavy fav',      f1OpeningOdds: -380, f2OpeningOdds: +295 },
    { label: 'Extreme fav',    f1OpeningOdds: -700, f2OpeningOdds: +480 },
  ];
  for (const ex of examples) {
    const r = predictCrossover(ex);
    console.log(`\n${ex.label} (${ex.f1OpeningOdds}/${ex.f2OpeningOdds}):`);
    console.log(`  Crossover prob: ${r.crossoverProbPct}%  Signal: ${r.signal}`);
    console.log(`  Expected dog win: ${r.expectedDogWinRate}%  Implied: ${r.impliedDogWinRate}%  Edge: ${r.crossoverEdge > 0 ? '+' : ''}${r.crossoverEdge} ppts`);
    console.log(`  → ${r.advice}`);
  }
}
