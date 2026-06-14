'use strict';
// reasoning.js — Confidence transparency for every brain panel verdict.
// Pure functions only: no HTTP, no filesystem, no Claude calls.
const { oddsToImplied } = require('./crossover_detector');

// ── Helpers ───────────────────────────────────────────────────────────────────

function confidenceLevel(n) {
  if (n >= 8) return 'high';
  if (n >= 4) return 'medium';
  return 'low';
}

function fightTimestamp(fight) {
  return fight.oddsHistory?.[0]?.timestamp || null;
}

function fightAgeMonths(fight) {
  const ts = fightTimestamp(fight);
  if (!ts) return null;
  return (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24 * 30);
}

function formatDate(ts) {
  if (!ts) return 'Unknown';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function fmtOdds(n) {
  if (n == null || isNaN(n)) return null;
  return n > 0 ? '+' + n : String(n);
}

// ── Data quality warnings ─────────────────────────────────────────────────────

function dataQualityWarnings(similarFights) {
  const n = similarFights.length;
  const warnings = [];

  if (n === 0) return ['No comparable fights found — this signal is not reliable'];
  if (n === 1) warnings.push('Only 1 comparable fight — do not act on this alone');
  else if (n < 4) warnings.push(`Small sample (${n} fights) — treat as directional only, not a strong signal`);

  // Age check
  const ages = similarFights.map(fightAgeMonths).filter(a => a !== null);
  if (ages.length > 0) {
    const oldCount = ages.filter(a => a > 36).length;
    if (oldCount === n) {
      warnings.push('All comparable fights are 3+ years old — fighter styles may have changed significantly');
    } else if (oldCount >= Math.ceil(n / 2)) {
      warnings.push(`${oldCount}/${n} comparable fights are 3+ years old`);
    }
  }

  // Temporal diversity check — narrow cluster = might be era-specific
  const timestamps = similarFights.map(f => fightTimestamp(f)).filter(Boolean)
    .map(ts => new Date(ts).getTime());
  if (timestamps.length >= 4) {
    const spreadDays = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60 * 24);
    if (spreadDays < 90) {
      warnings.push('All comparable fights are clustered within 3 months — may reflect a short-term pattern, not a durable signal');
    }
  }

  // Missing opening odds = can't compute line movement
  const noOpening = similarFights.filter(f =>
    f.outcome?.openingF1Odds == null || f.outcome?.openingF2Odds == null
  ).length;
  if (noOpening > 0) {
    warnings.push(`${noOpening} fight${noOpening > 1 ? 's' : ''} missing opening odds — line movement data incomplete`);
  }

  return warnings;
}

// ── Fight trail ───────────────────────────────────────────────────────────────

function buildFightTrail(similarFights) {
  return similarFights.map(fight => {
    const oc = fight.outcome;
    if (!oc) return null;

    const ts      = fightTimestamp(fight);
    const f1Name  = fight.oddsHistory?.[0]?.fighter1?.name || 'Fighter 1';
    const f2Name  = fight.oddsHistory?.[0]?.fighter2?.name || 'Fighter 2';

    const openF1  = oc.openingF1Odds;   // raw number from outcome
    const openF2  = oc.openingF2Odds;
    const closeF1 = oc.closingF1Odds;
    const closeF2 = oc.closingF2Odds;

    const openF1Prob  = openF1  != null ? oddsToImplied(openF1)  : null;
    const openF2Prob  = openF2  != null ? oddsToImplied(openF2)  : null;

    // Dog = lower implied probability at opening
    let dogSide = null;
    if (openF1Prob !== null && openF2Prob !== null) {
      dogSide = openF1Prob < openF2Prob ? 'fighter1' : 'fighter2';
    }

    const openDogOdds  = dogSide === 'fighter1' ? openF1  : openF2;
    const closeDogOdds = dogSide === 'fighter1' ? closeF1 : closeF2;
    const openDogProb  = dogSide === 'fighter1' ? openF1Prob : openF2Prob;
    const closeDogProb = closeDogOdds != null ? oddsToImplied(closeDogOdds) : null;

    const dogMovementPpts = (openDogProb !== null && closeDogProb !== null)
      ? Math.round((closeDogProb - openDogProb) * 100)
      : null;

    const dogName = dogSide === 'fighter1' ? f1Name : f2Name;
    const favName = dogSide === 'fighter1' ? f2Name : f1Name;
    const dogWon  = oc.winner === dogSide;

    return {
      date:           formatDate(ts),
      fighter1Name:   f1Name,
      fighter2Name:   f2Name,
      dogName,
      favName,
      openDogOdds:    fmtOdds(openDogOdds),
      closeDogOdds:   fmtOdds(closeDogOdds),
      openDogPct:     openDogProb  !== null ? Math.round(openDogProb  * 100) : null,
      closeDogPct:    closeDogProb !== null ? Math.round(closeDogProb * 100) : null,
      dogMovementPpts,
      dogWon,
      crossover:      oc.crossoverOccurred || false,
      winnerName:     oc.winnerName || (oc.winner === 'fighter1' ? f1Name : f2Name),
      method:         oc.method || null
    };
  }).filter(Boolean);
}

// ── Early line signal ─────────────────────────────────────────────────────────

function earlyLineSignal(similarFights, params) {
  const trail        = buildFightTrail(similarFights);
  const withMovement = trail.filter(f => f.dogMovementPpts !== null);

  if (withMovement.length < 3) {
    return {
      signal:                   'no_signal',
      action:                   'Not enough comparable fights to recommend an entry timing',
      timing:                   'Watch and react live',
      expectedMovementPpts:     null,
      crossoverRatePct:         null,
      positiveMovementRatePct:  null,
      basedOn:                  withMovement.length,
      confidence:               'low'
    };
  }

  const avgMovement   = withMovement.reduce((s, f) => s + f.dogMovementPpts, 0) / withMovement.length;
  const positiveCount = withMovement.filter(f => f.dogMovementPpts > 5).length;
  const positiveRate  = positiveCount / withMovement.length;
  const crossoverCount = trail.filter(f => f.crossover).length;
  const crossoverRate  = trail.length > 0 ? crossoverCount / trail.length : 0;

  // Timing prefix: heavy favorites have early KO risk — wait before betting them
  const f1Cur   = parseFloat(params && params.f1CurrentOdds);
  const f2Cur   = parseFloat(params && params.f2CurrentOdds);
  const heavyFav = (!isNaN(f1Cur) && f1Cur <= -400) || (!isNaN(f2Cur) && f2Cur <= -400);
  const koNote  = heavyFav
    ? 'Wait 60-90s for early KO risk to pass, then'
    : 'Within the first 60s,';

  // Current dog odds for display
  const f1IsDog   = !isNaN(f1Cur) && f1Cur > 0;
  const dogOddsRaw = f1IsDog
    ? (params && params.f1CurrentOdds)
    : (params && params.f2CurrentOdds);
  const dogOddsStr = dogOddsRaw ? String(dogOddsRaw) : 'current odds';

  let signal, action, timing;

  if (avgMovement >= 10 && positiveRate >= 0.55) {
    // Dog reliably tightens — get in early before the line moves
    signal = 'bet_dog_early';
    action = `Dog line tightens ~${Math.round(avgMovement)}ppts by close in ${positiveCount}/${withMovement.length} similar fights — get on before the line moves`;
    timing = `${koNote} bet the dog if still at or above ${dogOddsStr}`;
  } else if (crossoverRate >= 0.40) {
    // High crossover rate — position for the cross
    signal = 'watch_for_crossover';
    action = `${Math.round(crossoverRate * 100)}% of similar fights saw a line crossover — watch for dog line to start moving fast`;
    timing = `${koNote} monitor the line. If dog tightens 15+ ppts in round 1, take it immediately`;
  } else if (avgMovement <= -10 && positiveRate <= 0.30) {
    // Fav line strengthens — wait, then bet fav after dog spikes
    signal = 'wait_for_fav';
    action = `Favorite line strengthens as fight progresses in similar matchups — wait for dog line to spike (crowd overreaction), then take the fav`;
    timing = `${koNote} let the first exchange happen. When dog goes up, take the fav`;
  } else {
    signal = 'no_signal';
    action = 'No consistent early line pattern — react to what you see in round 1';
    timing = heavyFav
      ? 'Wait 60-90s for early KO risk to pass, then react to what you see'
      : 'Watch round 1 before committing';
  }

  return {
    signal,
    action,
    timing,
    expectedMovementPpts:    Math.round(avgMovement),
    crossoverRatePct:        Math.round(crossoverRate * 100),
    positiveMovementRatePct: Math.round(positiveRate * 100),
    basedOn:                 withMovement.length,
    confidence:              confidenceLevel(withMovement.length)
  };
}

// ── Full reasoning object ─────────────────────────────────────────────────────

function buildReasoning(similarFights, params, stats) {
  const n = similarFights.length;

  // Date range of comparable fights
  const timestamps = similarFights
    .map(f => fightTimestamp(f)).filter(Boolean)
    .map(ts => new Date(ts).getTime()).sort((a, b) => a - b);

  const dateRange = timestamps.length >= 1 ? {
    oldest: formatDate(new Date(timestamps[0]).toISOString()),
    newest: formatDate(new Date(timestamps[timestamps.length - 1]).toISOString())
  } : null;

  // Plain-language basis for the verdict
  let verdictBasis;
  if (n === 0) {
    verdictBasis = 'No comparable fights in the database — verdict cannot be supported';
  } else if (n < 5) {
    verdictBasis = `Only ${n} comparable fight${n === 1 ? '' : 's'} found — 5+ needed for a reliable signal`;
  } else {
    const edge   = stats?.edge;
    const favWR  = stats?.favWinRate;
    const dogWR  = stats?.dogWinRate;
    const impl   = stats?.impliedDogProb;
    if (edge != null && edge < -5) {
      verdictBasis = `Favorite won ${favWR}% of ${n} similar fights (book implies ~${impl != null ? 100 - impl : '?'}% fav win probability)`;
    } else if (edge != null && edge > 5) {
      verdictBasis = `Dog won ${dogWR}% of ${n} similar fights — book only implies ${impl}% dog win probability (+${edge} ppts gap)`;
    } else {
      verdictBasis = `${n} comparable fights — no clear historical edge, line appears fairly priced`;
    }
  }

  return {
    confidence:   confidenceLevel(n),
    sampleSize:   n,
    dateRange,
    warnings:     dataQualityWarnings(similarFights),
    fightTrail:   buildFightTrail(similarFights),
    earlyLine:    earlyLineSignal(similarFights, params),
    verdictBasis
  };
}

module.exports = { confidenceLevel, dataQualityWarnings, buildFightTrail, earlyLineSignal, buildReasoning };
