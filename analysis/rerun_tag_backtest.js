'use strict';
/**
 * rerun_tag_backtest.js — Evaluates historical fight dataset using Ish's corrected tags
 *
 * Implements Ish's requirement:
 * "And then eventually that bot will have to rerun the analysis with the new corrected
 * points you put on it. Right? Yes."
 */

const fs = require('fs');
const path = require('path');
const { getAllTags, _norm } = require('../fighter_tag_engine');
const { calculateTaggedCrossover, BASE_CROSSOVER_RATE } = require('../tag_crossover_engine');

const HIST_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'historical_data');

function runTagBacktest(tagFilter = null) {
  if (!fs.existsSync(HIST_DIR)) {
    return { error: 'historical_data directory not found', totalFights: 0 };
  }

  const tags = getAllTags();
  const files = fs.readdirSync(HIST_DIR).filter(f => f.endsWith('.json') && f.includes('_vs_'));

  let totalAnalyzed = 0;
  let taggedFightsCount = 0;
  let crossoversInTagged = 0;
  let crossoversOverall = 0;
  const taggedMatches = [];

  for (const file of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(HIST_DIR, file), 'utf8'));
      const h = d.oddsHistory || [];
      if (h.length < 5) continue;

      const open = h[0];
      const f1 = d.meta?.fighter1 || open.fighter1?.name || open.fighter1Name;
      const f2 = d.meta?.fighter2 || open.fighter2?.name || open.fighter2Name;
      if (!f1 || !f2) continue;

      const o1 = open.fighter1?.numericOdds ?? open.fighter1Odds ?? open.f1;
      const o2 = open.fighter2?.numericOdds ?? open.fighter2Odds ?? open.f2;
      if (o1 == null || o2 == null) continue;

      totalAnalyzed++;

      // Detect actual crossover in recording
      let didCross = false;
      for (let i = 1; i < h.length; i++) {
        const p1 = h[i - 1].fighter1?.numericOdds ?? h[i - 1].f1;
        const c1 = h[i].fighter1?.numericOdds ?? h[i].f1;
        const p2 = h[i - 1].fighter2?.numericOdds ?? h[i - 1].f2;
        const c2 = h[i].fighter2?.numericOdds ?? h[i].f2;
        if (p1 != null && c1 != null && p2 != null && c2 != null) {
          if ((p1 > 0 && c1 < 0) || (p2 > 0 && c2 < 0)) {
            didCross = true;
            break;
          }
        }
      }

      if (didCross) crossoversOverall++;

      // Check if either fighter has Ish's tags
      const k1 = _norm(f1);
      const k2 = _norm(f2);
      const t1 = tags[k1];
      const t2 = tags[k2];

      const f1Tags = t1?.tags || [];
      const f2Tags = t2?.tags || [];
      const f1RawDog = !!t1?.isRawDog;
      const f2RawDog = !!t2?.isRawDog;
      
      let hasIshTags = false;
      if (tagFilter) {
        if (tagFilter === 'raw_dog') {
          hasIshTags = f1RawDog || f2RawDog;
        } else {
          hasIshTags = f1Tags.includes(tagFilter) || f2Tags.includes(tagFilter);
        }
      } else {
        hasIshTags = f1Tags.length > 0 || f2Tags.length > 0 || f1RawDog || f2RawDog;
      }

      if (hasIshTags) {
        taggedFightsCount++;
        if (didCross) crossoversInTagged++;

        const taggedPrediction = calculateTaggedCrossover(o1, o2, t1 || { tags: [] }, t2 || { tags: [] }, f1, f2);

        taggedMatches.push({
          file,
          f1,
          f2,
          o1,
          o2,
          didCross,
          predictedRate: taggedPrediction?.taggedCrossoverPct || BASE_CROSSOVER_RATE,
          catalysts: taggedPrediction?.catalysts || [],
          warnings: taggedPrediction?.warnings || []
        });
      }
    } catch (_) {}
  }

  const overallCrossoverRate = totalAnalyzed > 0
    ? Math.round((crossoversOverall / totalAnalyzed) * 1000) / 10
    : BASE_CROSSOVER_RATE;

  const taggedCrossoverRate = taggedFightsCount > 0
    ? Math.round((crossoversInTagged / taggedFightsCount) * 1000) / 10
    : null;

  return {
    timestamp: new Date().toISOString(),
    totalAnalyzed,
    taggedFightsCount,
    crossoversInTagged,
    taggedCrossoverRate,
    overallCrossoverRate,
    taggedMatches
  };
}

if (require.main === module) {
  const result = runTagBacktest();
  console.log('=== ISH TAG BACKTEST & RERUN ANALYSIS ===');
  console.log(`Total Fights Analyzed: ${result.totalAnalyzed}`);
  console.log(`Fights with Ish Tags: ${result.taggedFightsCount}`);
  if (result.taggedCrossoverRate != null) {
    console.log(`Crossover Rate in Ish Tagged Fights: ${result.taggedCrossoverRate}% (vs ${result.overallCrossoverRate}% overall)`);
  }
  console.log(`Sample Matches:`, JSON.stringify(result.taggedMatches.slice(0, 3), null, 2));
}

module.exports = { runTagBacktest };
