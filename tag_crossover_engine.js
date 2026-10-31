'use strict';
/**
 * tag_crossover_engine.js — Dynamic Crossover Engine Driven by Ish's Stylistic Tags
 *
 * Maps Ish's subjective tags directly against the empirical 398-fight catalyst matrix:
 * - Base Live Crossover Rate: 41.5%
 * - Underdog High Defense vs Power Fav: 61.5%
 * - Multi-Catalyst Stack (2+ active catalysts): 62.5%
 * - Underdog Size / Frame Advantage: 48.3%
 * - Favorite Age Cliff (35+): 47.6%
 * - Grappler Suppression Trap (Fav Heavy Wrestler vs Dog No TD Def): 34.8%
 */

const BASE_CROSSOVER_RATE = 41.5;

function getTierBaseline(favOdds) {
  const absFav = Math.abs(favOdds);
  if (absFav <= 129) return { tier: 'pick_em', rate: 67.0 };
  if (absFav <= 199) return { tier: 'slight_fav', rate: 52.0 };
  if (absFav <= 299) return { tier: 'moderate_fav', rate: 43.0 };
  if (absFav <= 499) return { tier: 'heavy_fav', rate: 12.0 };
  return { tier: 'extreme_fav', rate: 5.0 };
}

/**
 * calculateTaggedCrossover(f1OpeningOdds, f2OpeningOdds, f1TagsData, f2TagsData, f1Name, f2Name)
 */
function calculateTaggedCrossover(f1OpeningOdds, f2OpeningOdds, f1TagsData, f2TagsData, f1Name = 'Fighter 1', f2Name = 'Fighter 2') {
  const o1 = parseFloat(f1OpeningOdds);
  const o2 = parseFloat(f2OpeningOdds);

  if (isNaN(o1) || isNaN(o2)) return null;

  const f1IsFav = o1 < o2;
  const favName = f1IsFav ? f1Name : f2Name;
  const dogName = f1IsFav ? f2Name : f1Name;
  const favOdds = f1IsFav ? o1 : o2;
  const dogOdds = f1IsFav ? o2 : o1;

  const favTags = f1IsFav ? (f1TagsData?.tags || []) : (f2TagsData?.tags || []);
  const dogTags = f1IsFav ? (f2TagsData?.tags || []) : (f1TagsData?.tags || []);

  const favIsRawDog = f1IsFav ? !!f1TagsData?.isRawDog : !!f2TagsData?.isRawDog;
  const dogIsRawDog = f1IsFav ? !!f2TagsData?.isRawDog : !!f1TagsData?.isRawDog;

  const tierInfo = getTierBaseline(favOdds);
  const isTight = tierInfo.tier === 'pick_em';
  const isExtreme = tierInfo.tier === 'heavy_fav' || tierInfo.tier === 'extreme_fav';

  let activeCatalysts = [];
  let warnings = [];
  let catalystCount = 0;
  let finalRate = isTight ? tierInfo.rate : BASE_CROSSOVER_RATE;
  const hasAnyTags = favTags.length > 0 || dogTags.length > 0 || favIsRawDog || dogIsRawDog;
  if (!hasAnyTags) finalRate = BASE_CROSSOVER_RATE;

  // 1. Dog High Defense vs Fav Power/Damage (Empirical: 61.5% on moderate favs, +20 ppts on pick'em)
  const dogHasDefense = dogTags.includes('takedown_defense') || dogTags.includes('efficient_striker');
  const favHasPower = favTags.includes('striking_power') || favTags.includes('gas_tank_risk');
  if (dogHasDefense && favHasPower) {
    const rate = isTight ? Math.min(92.0, finalRate + 20.0) : isExtreme ? finalRate + 20.0 : 61.5;
    activeCatalysts.push({
      id: 'defense_vs_power',
      badge: '🛡️ Dog Defense vs Fav Power',
      rate,
      detail: `${dogName} defense buffers against ${favName}'s power early`
    });
    catalystCount++;
    finalRate = isTight ? (finalRate + 20.0) : isExtreme ? (finalRate + 20.0) : Math.max(finalRate, 61.5);
  }

  // 2. Favorite Age Cliff (Empirical: 47.6% on moderate favs, +6.1 ppts on pick'em)
  if (favTags.includes('older')) {
    const rate = isTight ? Math.min(90.0, finalRate + 6.1) : isExtreme ? finalRate + 6.1 : 47.6;
    activeCatalysts.push({
      id: 'age_cliff',
      badge: '⏳ Fav Age Cliff',
      rate,
      detail: `${favName} tagged with age cliff/slowdown vulnerability`
    });
    catalystCount++;
    finalRate = isTight ? (finalRate + 6.1) : isExtreme ? (finalRate + 6.1) : Math.max(finalRate, 47.6);
  }

  // 3. Underdog Size Advantage (Empirical: 48.3% on moderate favs, +6.8 ppts on pick'em)
  if (dogTags.includes('size_advantage')) {
    const rate = isTight ? Math.min(90.0, finalRate + 6.8) : isExtreme ? finalRate + 6.8 : 48.3;
    activeCatalysts.push({
      id: 'size_advantage',
      badge: '📏 Dog Size Advantage',
      rate,
      detail: `${dogName} frame/reach creates persistent live range leverage`
    });
    catalystCount++;
    finalRate = isTight ? (finalRate + 6.8) : isExtreme ? (finalRate + 6.8) : Math.max(finalRate, 48.3);
  }

  // 4. Grappler Suppression Trap (Anti-Predictor: 34.8% on moderate favs, -6.7 ppts on pick'em)
  const favIsWrestler = favTags.includes('heavy_wrestler');
  const dogLacksTdDef = !dogTags.includes('takedown_defense');
  if (favIsWrestler && dogLacksTdDef) {
    const rate = isTight ? Math.max(15.0, finalRate - 6.7) : 34.8;
    warnings.push({
      id: 'grappler_suppression',
      badge: '🛑 Grappler Suppression Trap',
      rate,
      detail: `${favName} heavy wrestling smothers live dog rally`
    });
    finalRate = isTight ? (finalRate - 6.7) : Math.min(finalRate, 34.8);
  }

  // 5. Multi-Catalyst Stacking (Empirical: 62.5% on moderate favs, +21 ppts on pick'em)
  if (catalystCount >= 2) {
    const rate = isTight ? Math.min(95.0, tierInfo.rate + 21.0) : isExtreme ? tierInfo.rate + 21.0 : 62.5;
    activeCatalysts.unshift({
      id: 'multi_stack',
      badge: '⚡ Multi-Catalyst Stack',
      rate,
      detail: `${catalystCount} empirical catalysts active on favorite`
    });
    finalRate = isTight ? Math.min(95.0, tierInfo.rate + 21.0) : isExtreme ? tierInfo.rate + 21.0 : Math.max(finalRate, 62.5);
  }

  // 6. Older Underdog Suppression (Ish Canon: -8.0 ppts on pick'em, 33.5% on moderate favs)
  if (dogTags.includes('older')) {
    const rate = isTight ? Math.max(15.0, finalRate - 8.0) : 33.5;
    warnings.push({
      id: 'older_dog',
      badge: '⏳ Older Underdog (Lower Comeback Rate)',
      rate,
      detail: `${dogName} tagged older/veteran; lower likelihood of mounting live line flip`
    });
    finalRate = isTight ? (finalRate - 8.0) : Math.min(finalRate, 33.5);
  }

  // 7. F'ing Loser (High Choke Factor)
  if (favTags.includes('fing_loser')) {
    const rate = isTight ? Math.min(95.0, finalRate + 15.0) : Math.max(finalRate, 60.0);
    activeCatalysts.push({
      id: 'fav_fing_loser',
      badge: "🤦 Fav is an F'ing Loser (Choke Risk)",
      rate,
      detail: `${favName} notoriously blows leads and chokes under pressure`
    });
    catalystCount++;
    finalRate = isTight ? (finalRate + 15.0) : Math.max(finalRate, 60.0);
  } else if (dogTags.includes('fing_loser')) {
    const rate = Math.max(15.0, finalRate - 10.0);
    warnings.push({
      id: 'dog_fing_loser',
      badge: "🤦 Dog is an F'ing Loser (Fold Risk)",
      rate,
      detail: `${dogName} folds when things get difficult; low comeback expectancy`
    });
    finalRate = Math.max(15.0, finalRate - 10.0);
  }

  // 8. First Round Finisher
  if (favTags.includes('first_round_finisher')) {
    activeCatalysts.push({
      id: 'fav_r1_finisher',
      badge: '⚡ Fav R1 Finisher (Cardio Dump Risk if Extended)',
      rate: Math.min(95.0, finalRate + 6.0),
      detail: `${favName} high burn-rate early; vulnerable to Round 2 line flip if dog survives`
    });
    catalystCount++;
    finalRate = Math.min(95.0, finalRate + 6.0);
  } else if (dogTags.includes('first_round_finisher')) {
    activeCatalysts.push({
      id: 'dog_r1_finisher',
      badge: '⚡ Dog R1 Finisher (Early Danger Spike)',
      rate: Math.min(95.0, finalRate + 8.0),
      detail: `${dogName} explosive early puncher; elevated Round 1 crossover hazard`
    });
    catalystCount++;
    finalRate = Math.min(95.0, finalRate + 8.0);
  }

  // 9. Loopy Striker (Chaos / High Volatility)
  if (favTags.includes('loopy') || dogTags.includes('loopy')) {
    const loopyFighter = favTags.includes('loopy') ? favName : dogName;
    activeCatalysts.push({
      id: 'loopy_striker',
      badge: '🌪️ Loopy Striker (Chaos / High Volatility)',
      rate: Math.min(95.0, finalRate + 7.5),
      detail: `${loopyFighter} throws wide, looping punches; creates chaotic high-variance exchanges`
    });
    catalystCount++;
    finalRate = Math.min(95.0, finalRate + 7.5);
  }

  // Raw Dawg Note: Subjective indicator from Ish
  if (dogIsRawDog) {
    activeCatalysts.push({
      id: 'raw_dog',
      badge: '🐕 Ish Raw Dawg Pick',
      rate: finalRate,
      detail: `${dogName} marked as a certified Raw Dawg by Ish`
    });
  }

  // Bound within realistic probability range
  finalRate = Math.round(Math.max(5.0, Math.min(95.0, finalRate)) * 10) / 10;
  const delta = Math.round((finalRate - BASE_CROSSOVER_RATE) * 10) / 10;

  // Expected Dog Win Rate given crossover rate:
  // In our 398 backtests, dog wins 50% in crossover fights vs 12% in non-crossovers
  const pCross = finalRate / 100;
  const expectedDogWinPct = Math.round(((pCross * 0.50) + ((1 - pCross) * 0.12)) * 1000) / 10;

  // Plain-English Betting Advice
  let advice = '';
  if (finalRate >= 60.0) {
    advice = `🔥 High Crossover Potential (${finalRate}%). Watch R1 live line closely — dog wins 50% when the line crosses.`;
  } else if (finalRate <= 35.0) {
    advice = `🛑 Crossover Suppressed (${finalRate}%). ${favName}'s stylistic control makes dog live-entry low expectancy.`;
  } else if (finalRate >= 47.0) {
    advice = `👀 Elevated Volatility (${finalRate}%). Keep on screen; live momentum entry favorable if dog wins R1 exchanges.`;
  } else {
    advice = `⚖️ Baseline Pace (${finalRate}%). Monitor opening round minutes before placing live position.`;
  }

  return {
    taggedCrossoverPct: finalRate,
    baseCrossoverRate: BASE_CROSSOVER_RATE,
    delta,
    catalysts: activeCatalysts.map(c => c.badge),
    catalystDetails: activeCatalysts,
    warnings: warnings.map(w => w.badge),
    warningDetails: warnings,
    expectedDogWinPct,
    advice,
    favName,
    dogName,
    favOdds,
    dogOdds,
    dogIsRawDog,
    favIsRawDog,
    hasTags: (favTags.length > 0 || dogTags.length > 0 || dogIsRawDog || favIsRawDog)
  };
}

/**
 * computeLiveCrossoverProbability(opts)
 * Dynamically adjusts pre-fight crossover probability based on live in-fight conditions
 */
function computeLiveCrossoverProbability(opts = {}) {
  const {
    p0 = BASE_CROSSOVER_RATE,
    openOddsDog = 200,
    curOddsDog = null,
    elapsedMin = 0,
    momPptsPerMin = 0,
    dogActionShare = 0.50,
    dogKnockdowns = 0,
    favKnockdowns = 0,
    favHasBadTank = false,
    dogHasCardio = false
  } = opts;

  function toImplied(o) {
    if (o == null || isNaN(o)) return null;
    const n = parseFloat(o);
    if (n > 0) return 100 / (n + 100);
    return Math.abs(n) / (Math.abs(n) + 100);
  }

  const openDogP = toImplied(openOddsDog) || 0.35;
  const curDogP  = curOddsDog != null ? (toImplied(curOddsDog) || openDogP) : openDogP;

  // 1. Line has already crossed 50%
  if (curDogP >= 0.50) {
    return {
      liveCrossoverPct: 100,
      status: 'CROSSED',
      advice: '🔥 LINE FLIPPED: Underdog is now the live favorite! Hedge or ride position.',
      timeDecayFactor: 1.0,
      proximityPct: 100,
      phase: 'crossed'
    };
  }

  // 2. Pure Time-Decay Survival Curve T(t) based on 398 empirical backtests (57% R1, 39% R2, 4% R3)
  const t = Math.max(0, Math.min(15, parseFloat(elapsedMin) || 0));
  let timeDecay;
  let phase;
  if (t <= 5.0) {
    timeDecay = 1.0 - 0.57 * (t / 5.0);
    phase = 'Round 1 (Prime Window)';
  } else if (t <= 10.0) {
    timeDecay = 0.43 - 0.39 * ((t - 5.0) / 5.0);
    phase = 'Round 2 (Cardio Fade Window)';
  } else {
    timeDecay = 0.04 * Math.max(0, 1.0 - ((t - 10.0) / 5.0));
    phase = 'Round 3+ (Late Window - Do Not Chase)';
  }

  // 3. Proximity Metric: how much of the gap to 50% has the dog closed?
  const gapTotal = 0.50 - openDogP;
  const gapClosed = Math.max(0, curDogP - openDogP);
  const proximity = gapTotal > 0 ? (gapClosed / gapTotal) : 0;

  // 4. Odds Velocity Multiplier
  const velocityBonus = (parseFloat(momPptsPerMin) || 0) * 0.03;

  // 5. Physical In-Cage Modifier (ESPN Stats)
  let cageMod = 0;
  if (dogKnockdowns > 0) cageMod += 0.45;
  if (favKnockdowns > 0) cageMod -= 0.50;
  if (dogActionShare > 0.60) cageMod += (dogActionShare - 0.50) * 0.8;
  if (dogActionShare < 0.40) cageMod -= (0.50 - dogActionShare) * 0.8;

  // 6. Gas Tank Modifier in Round 2 & 3
  let cardioMod = 0;
  if (t >= 4.0) {
    if (favHasBadTank && dogHasCardio) cardioMod += 0.35;
    if (!favHasBadTank && !dogHasCardio) cardioMod -= 0.15;
  }

  // Unified Multiplier over time baseline
  const progressMultiplier = 1.0 + (1.8 * proximity) + velocityBonus + cageMod + cardioMod;
  
  // Blend time-decay baseline with current progress
  let liveProb = (p0 * timeDecay * progressMultiplier);
  
  // Floor & Ceiling: can never be less than current implied dog probability
  const currentImpliedPct = Math.round(curDogP * 100);
  liveProb = Math.max(currentImpliedPct, Math.min(95, liveProb));
  liveProb = Math.round(liveProb * 10) / 10;

  let liveAdvice = '';
  if (t > 10.0 && liveProb < 35.0) {
    liveAdvice = `🛑 Late Stalemate (${liveProb}%). Only 4% of flips happen in R3; do not chase live dog.`;
  } else if (liveProb >= 75.0) {
    liveAdvice = `🔥 Crossover Imminent (${liveProb}%). Dog closing line fast — prepare equal-profit hedge.`;
  } else if (liveProb >= 50.0) {
    liveAdvice = `⚡ Elevated Live Momentum (${liveProb}%). Dog out-working favorite; watch for Round 2 line flip.`;
  } else {
    liveAdvice = `⚖️ In-Play Monitoring (${liveProb}%). Time decay active (${Math.round(timeDecay * 100)}% potential remaining).`;
  }

  return {
    liveCrossoverPct: liveProb,
    preFightBaselinePct: p0,
    timeDecayFactor: Math.round(timeDecay * 100) / 100,
    proximityPct: Math.round(proximity * 100),
    phase,
    advice: liveAdvice,
    currentDogImpliedPct: currentImpliedPct
  };
}

module.exports = {
  BASE_CROSSOVER_RATE,
  calculateTaggedCrossover,
  computeLiveCrossoverProbability
};
