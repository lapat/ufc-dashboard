'use strict';
// live_sequence.js — Sequential live bet analyzer
// Answers: "Given where the live odds are NOW vs where they opened, what
// historically happens from this point? Should you make a second bet?"
//
// Completely isolated — no imports from server.js, analyzer.js, or index.html.
// Consumed by server.js via: const { findLiveSequence } = require('./live_sequence');

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'historical_data');

// ── Data loading ──────────────────────────────────────────────────────────────

function loadFightsWithHistory() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('dk_') && !f.startsWith('crossover'));

  const fights = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const h = data.oddsHistory || [];
      // Need at least 20 pts to have meaningful movement data
      if (h.length < 20) continue;
      if (!data.outcome || !data.outcome.winner) continue;
      fights.push({ file: f, oddsHistory: h, outcome: data.outcome });
    } catch (_) {}
  }
  return fights;
}

// ── Core analysis ─────────────────────────────────────────────────────────────

/**
 * For a given historical fight, find the point in its oddsHistory where
 * f1's odds most closely match `targetF1Odds`, returning the index and diff.
 * Only searches the first 85% of the history (don't spoil the ending).
 */
function findMatchPoint(history, targetF1Odds) {
  const searchEnd = Math.floor(history.length * 0.85);
  const searchStart = Math.floor(history.length * 0.05); // skip first 5% (opening noise)
  let bestIdx = -1, bestDiff = Infinity;
  for (let i = searchStart; i < searchEnd; i++) {
    const odds = history[i].fighter1 && history[i].fighter1.numericOdds;
    if (odds == null) continue;
    const diff = Math.abs(odds - targetF1Odds);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  return { idx: bestIdx, diff: bestDiff };
}

/**
 * Main export. Finds historical fights with similar opening odds AND similar
 * current live odds, then computes hold/reversal rates from that point.
 *
 * params: {
 *   f1OpeningOdds: number,  // odds when the fight was first selected
 *   f1CurrentOdds: number,  // live odds right now
 *   f2OpeningOdds: number,
 *   f2CurrentOdds: number,
 *   fighter1: string,
 *   fighter2: string,
 * }
 * fights: array from loadFightsWithHistory() (injectable for testing)
 */
function findLiveSequence(params, fights) {
  const openF1 = parseFloat(params.f1OpeningOdds);
  const curF1  = parseFloat(params.f1CurrentOdds);
  const curF2  = parseFloat(params.f2CurrentOdds);

  if (isNaN(openF1) || isNaN(curF1)) return null;

  const movement = curF1 - openF1;
  // Need at least 50 odds-point movement to have a meaningful mid-fight signal
  if (Math.abs(movement) < 50) return null;

  // Who is currently leading (has better / more negative odds)?
  const f1IsLeading = curF1 < curF2;

  const matches = [];

  for (const fight of fights) {
    const h = fight.oddsHistory;
    const histOpenF1 = h[0].fighter1 && h[0].fighter1.numericOdds;
    if (histOpenF1 == null) continue;

    // Similar opening odds (within 80 points)
    if (Math.abs(histOpenF1 - openF1) > 80) continue;

    // Find the point in this fight's history closest to our current live odds
    const { idx, diff } = findMatchPoint(h, curF1);
    if (idx < 0 || diff > 100) continue;

    // What fraction through the fight is this point?
    const progress = idx / h.length; // 0 = start, 1 = end

    // Who won the fight?
    const f1Won = fight.outcome.winner === 'fighter1';

    // Did the currently-leading fighter hold on and win?
    const leadingFighterWon = f1IsLeading ? f1Won : !f1Won;

    // How much did the line move after the match point to the end?
    const finalF1Odds = h[h.length - 1].fighter1 && h[h.length - 1].fighter1.numericOdds;
    const furtherExtended = finalF1Odds != null &&
      ((f1IsLeading && finalF1Odds < h[idx].fighter1.numericOdds) ||
       (!f1IsLeading && finalF1Odds > h[idx].fighter1.numericOdds));

    matches.push({
      file:              fight.file,
      histOpenF1,
      matchOddsF1:       h[idx].fighter1.numericOdds,
      progress,
      f1Won,
      leadingFighterWon,
      furtherExtended,
    });
  }

  if (matches.length < 3) return null;

  const holdCount     = matches.filter(m => m.leadingFighterWon).length;
  const reversalCount = matches.length - holdCount;
  const holdRate      = Math.round(holdCount / matches.length * 100);

  // ROI if you bet the TRAILING fighter right now (comeback bet)
  const trailerOdds   = f1IsLeading ? curF2 : curF1;
  const trailerPayout = trailerOdds > 0 ? trailerOdds / 100 : 100 / Math.abs(trailerOdds);
  const reversalRate  = reversalCount / matches.length;
  const comebackROI   = Math.round(((reversalRate * trailerPayout) - ((1 - reversalRate) * 1)) * 100) / 100;

  // ROI if you add to the LEADING fighter right now (press bet)
  const leaderOdds    = f1IsLeading ? curF1 : curF2;
  const leaderPayout  = leaderOdds > 0 ? leaderOdds / 100 : 100 / Math.abs(leaderOdds);
  const pressROI      = Math.round((((holdCount / matches.length) * leaderPayout) - ((reversalCount / matches.length) * 1)) * 100) / 100;

  // Verdict
  let verdict, advice;
  if (pressROI > 0.15 && holdRate >= 70) {
    verdict = 'press';
    const leaderName = f1IsLeading ? params.fighter1 : params.fighter2;
    const leaderDisp = leaderOdds > 0 ? '+' + leaderOdds : String(leaderOdds);
    advice  = 'PRESS: ' + leaderName + ' ' + leaderDisp + ' live — holds ' + holdRate + '% from here (+' + pressROI + 'u ROI)';
  } else if (comebackROI > 0.2 && reversalRate >= 0.25) {
    verdict = 'comeback';
    const trailerName = f1IsLeading ? params.fighter2 : params.fighter1;
    const trailerDisp = trailerOdds > 0 ? '+' + trailerOdds : String(trailerOdds);
    advice  = 'LIVE DOG: ' + trailerName + ' ' + trailerDisp + ' — reversal in ' + Math.round(reversalRate * 100) + '% of similar spots (+' + comebackROI + 'u ROI)';
  } else {
    verdict = 'neutral';
    advice  = 'No clean live bet — leader holds ' + holdRate + '% but odds don\'t offer value (' + pressROI + 'u press / ' + comebackROI + 'u comeback)';
  }

  return {
    sampleSize:        matches.length,
    movement:          Math.abs(Math.round(movement)),
    f1IsLeading,
    leaderOdds,
    trailerOdds,
    holdRate,
    reversalRate:      Math.round(reversalRate * 100),
    pressROI,
    comebackROI,
    verdict,
    advice,
  };
}

module.exports = { findLiveSequence, loadFightsWithHistory };
