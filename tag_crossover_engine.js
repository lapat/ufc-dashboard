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

  let activeCatalysts = [];
  let warnings = [];
  let catalystCount = 0;
  let finalRate = BASE_CROSSOVER_RATE;

  // 1. Dog High Defense vs Fav Power/Damage (Empirical: 61.5%)
  const dogHasDefense = dogTags.includes('takedown_defense') || dogTags.includes('efficient_striker');
  const favHasPower = favTags.includes('striking_power') || favTags.includes('gas_tank_risk');
  if (dogHasDefense && favHasPower) {
    activeCatalysts.push({
      id: 'defense_vs_power',
      badge: '🛡️ Dog Defense vs Fav Power',
      rate: 61.5,
      detail: `${dogName} defense buffers against ${favName}'s power early`
    });
    catalystCount++;
    finalRate = Math.max(finalRate, 61.5);
  }

  // 2. Favorite Age Cliff (Empirical: 47.6%)
  if (favTags.includes('older')) {
    activeCatalysts.push({
      id: 'age_cliff',
      badge: '⏳ Fav Age Cliff',
      rate: 47.6,
      detail: `${favName} tagged with age cliff/slowdown vulnerability`
    });
    catalystCount++;
    finalRate = Math.max(finalRate, 47.6);
  }

  // 3. Underdog Size Advantage (Empirical: 48.3%)
  if (dogTags.includes('size_advantage')) {
    activeCatalysts.push({
      id: 'size_advantage',
      badge: '📏 Dog Size Advantage',
      rate: 48.3,
      detail: `${dogName} frame/reach creates persistent live range leverage`
    });
    catalystCount++;
    finalRate = Math.max(finalRate, 48.3);
  }

  // 4. Grappler Suppression Trap (Anti-Predictor: 34.8%)
  const favIsWrestler = favTags.includes('heavy_wrestler');
  const dogLacksTdDef = !dogTags.includes('takedown_defense');
  if (favIsWrestler && dogLacksTdDef) {
    warnings.push({
      id: 'grappler_suppression',
      badge: '🛑 Grappler Suppression Trap',
      rate: 34.8,
      detail: `${favName} heavy wrestling smothers live dog rally`
    });
    finalRate = Math.min(finalRate, 34.8);
  }

  // 5. Multi-Catalyst Stacking (Empirical: 62.5%)
  if (catalystCount >= 2) {
    activeCatalysts.unshift({
      id: 'multi_stack',
      badge: '⚡ Multi-Catalyst Stack',
      rate: 62.5,
      detail: `${catalystCount} empirical catalysts active on favorite`
    });
    finalRate = Math.max(finalRate, 62.5);
  }

  // 6. Older Underdog Suppression (Ish Canon: "Older underdog has a lower chance of a crossover")
  if (dogTags.includes('older')) {
    warnings.push({
      id: 'older_dog',
      badge: '⏳ Older Underdog (Lower Comeback Rate)',
      rate: 33.5,
      detail: `${dogName} tagged older/veteran; lower likelihood of mounting live line flip`
    });
    finalRate = Math.min(finalRate, 33.5);
  }

  // Raw Dog Note: Subjective indicator from Ish
  if (dogIsRawDog) {
    activeCatalysts.push({
      id: 'raw_dog',
      badge: '🐕 Ish Raw Dog Pick',
      rate: finalRate,
      detail: `${dogName} marked as a certified Raw Dog by Ish`
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

module.exports = {
  BASE_CROSSOVER_RATE,
  calculateTaggedCrossover
};
