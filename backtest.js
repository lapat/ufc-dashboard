#!/usr/bin/env node
// backtest.js — Leave-one-out cross-validation of the brain's edge predictions.
//
// For each fight we have an outcome for:
//   1. Use its opening odds as "current" params
//   2. Find similar fights from ALL OTHER fights (exclude itself)
//   3. Generate a signal: BET_DOG | BET_FAV | PASS
//   4. Check against actual outcome
//   5. Report accuracy + ROI per signal tier
//
// Run: node backtest.js
//      node backtest.js --verbose   (show each fight's prediction)
//      node backtest.js --min-edge 8  (only count signals >= 8 ppts)

'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'historical_data');
const VERBOSE  = process.argv.includes('--verbose');
const MIN_EDGE = parseFloat(process.argv.find(a => a.startsWith('--min-edge='))?.split('=')[1] || '5');

// ── Inline copies of analyzer helpers (no Claude, no HTTP) ───────────────────

function impliedProb(o) {
  const n = parseFloat(o);
  if (isNaN(n)) return null;
  return n < 0 ? (-n) / (-n + 100) : 100 / (n + 100);
}

function oddsLabel(o) {
  const n = parseFloat(o);
  if (isNaN(n)) return 'unknown';
  if (n <= -400)  return 'extreme_fav';
  if (n <= -200)  return 'heavy_fav';
  if (n <= -130)  return 'fav';
  if (n < 0)      return 'slight_fav';
  if (n < 130)    return 'pick_em';
  if (n < 200)    return 'slight_dog';
  if (n < 350)    return 'dog';
  return                 'heavy_dog';
}

const TIERS = ['extreme_fav','heavy_fav','fav','slight_fav','pick_em','slight_dog','dog','heavy_dog'];

function similarityScore(hist, params) {
  const { f1CurrentOdds, f1OpeningOdds, crossoverOccurred } = params;
  let score = 0;

  const histOpenF1  = hist.outcome.openingF1Odds;
  const histOpenF2  = hist.outcome.openingF2Odds;
  const histCloseF1 = hist.outcome.closingF1Odds;
  if (histOpenF1 == null || histOpenF2 == null) return 0;

  if (f1OpeningOdds != null) {
    const diff = Math.abs(histOpenF1 - f1OpeningOdds);
    score += Math.max(0, 50 - diff / 5);
  }

  const curLabel  = oddsLabel(f1CurrentOdds);
  const histLabel = oddsLabel(histCloseF1);
  if (curLabel === histLabel) score += 30;
  else if (Math.abs(TIERS.indexOf(curLabel) - TIERS.indexOf(histLabel)) <= 1) score += 15;

  if (crossoverOccurred != null && hist.outcome.crossoverOccurred === crossoverOccurred) score += 20;

  const paramMov = f1OpeningOdds != null ? f1CurrentOdds - f1OpeningOdds : null;
  const histMov  = hist.outcome.lineMovementF1;
  if (paramMov != null && histMov != null && (paramMov > 0) === (histMov > 0)) score += 15;

  if (hist.derived && hist.derived.peakOddsSwing > 200) score += 5;

  return score;
}

function computeEdge(similar, f1CurrentOdds) {
  if (similar.length < 5) return null;
  const total     = similar.length;
  const f1IsDog   = parseFloat(f1CurrentOdds) > 0;
  const f1WinCnt  = similar.filter(f => f.outcome.winner === 'fighter1').length;
  const dogWinCnt = f1IsDog ? f1WinCnt : total - f1WinCnt;
  const dogWinRate = dogWinCnt / total;
  const dogOdds   = parseFloat(f1IsDog ? f1CurrentOdds : /* we'd need f2, pass it in */ 200);
  const impliedDog = impliedProb(f1IsDog ? f1CurrentOdds : null) ??
                     // fallback: if f1 is fav, estimate dog odds from f1
                     impliedProb(-f1CurrentOdds * 0.9); // rough
  if (impliedDog == null) return null;
  return {
    edge:        Math.round((dogWinRate - impliedDog) * 1000) / 10,
    dogWinRate:  Math.round(dogWinRate  * 100),
    impliedDogProb: Math.round(impliedDog * 100),
    sampleSize:  total
  };
}

// ── Load all fights ───────────────────────────────────────────────────────────

function loadFights() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('dk_') && !f.startsWith('crossover'));
  const fights = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (!data.outcome?.winner) continue;
      if (data.outcome.openingF1Odds == null) continue;
      fights.push({ file: f, ...data });
    } catch (_) {}
  }
  return fights;
}

// ── Signal tiers ─────────────────────────────────────────────────────────────

function getSignal(edge, sampleSize) {
  if (!edge || sampleSize < 5) return 'PASS';
  if (edge > MIN_EDGE)  return 'BET_DOG';
  if (edge < -MIN_EDGE) return 'BET_FAV';
  return 'PASS';
}

// ── ROI calc ──────────────────────────────────────────────────────────────────

function computePayout(americanOdds) {
  const o = parseFloat(americanOdds);
  if (isNaN(o)) return 0;
  return o > 0 ? o / 100 : 100 / Math.abs(o);
}

// ── Main backtest ─────────────────────────────────────────────────────────────

function main() {
  const allFights = loadFights();
  console.log(`\n📊  BACKTEST — leave-one-out cross-validation`);
  console.log(`    ${allFights.length} fights with outcomes | min edge threshold: ${MIN_EDGE} ppts\n`);

  const results = {
    BET_DOG: { correct: 0, wrong: 0, roi: 0, oddsUsed: [] },
    BET_FAV: { correct: 0, wrong: 0, roi: 0, oddsUsed: [] },
    PASS:    { correct: 0, wrong: 0, roi: 0 }
  };

  // Edge-tier breakdown: count predictions at each tier
  const edgeBuckets = {}; // e.g. '5-10' → { correct, wrong }
  function edgeBucket(e) {
    const abs = Math.abs(e);
    if (abs < 5)  return '<5';
    if (abs < 10) return '5-10';
    if (abs < 20) return '10-20';
    return '20+';
  }

  let skipped = 0;
  const predictions = [];

  for (let i = 0; i < allFights.length; i++) {
    const target = allFights[i];
    const pool   = allFights.filter((_, j) => j !== i); // leave-one-out

    const params = {
      f1CurrentOdds:   target.outcome.openingF1Odds,
      f1OpeningOdds:   target.outcome.openingF1Odds,
      f2CurrentOdds:   target.outcome.openingF2Odds,
      crossoverOccurred: target.outcome.crossoverOccurred ?? false
    };

    // Find similar fights from pool
    const scored = pool
      .map(f => ({ fight: f, score: similarityScore(f, params) }))
      .filter(x => x.score > 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map(x => x.fight);

    if (scored.length < 5) { skipped++; continue; }

    // Compute edge
    const total     = scored.length;
    const f1IsDog   = parseFloat(params.f1CurrentOdds) > 0;
    const f1WinCnt  = scored.filter(f => f.outcome.winner === 'fighter1').length;
    const dogWinCnt = f1IsDog ? f1WinCnt : total - f1WinCnt;
    const favWinCnt = total - dogWinCnt;
    const dogWinRate = dogWinCnt / total;
    const dogOdds   = f1IsDog ? params.f1CurrentOdds : params.f2CurrentOdds;
    const favOdds   = f1IsDog ? params.f2CurrentOdds : params.f1CurrentOdds;
    const impliedDog = impliedProb(dogOdds);
    if (impliedDog == null) { skipped++; continue; }

    const edge     = Math.round((dogWinRate - impliedDog) * 1000) / 10;
    const signal   = getSignal(edge, total);
    const bucket   = edgeBucket(edge);

    // Was the prediction correct?
    const actualWinner = target.outcome.winner; // 'fighter1' or 'fighter2'
    const f1IsFav      = parseFloat(params.f1CurrentOdds) < 0;
    const dogIsF1      = !f1IsFav;
    const favIsF1      = f1IsFav;

    let correct = false;
    let betOdds = null;
    let pnl     = 0;

    if (signal === 'BET_DOG') {
      betOdds = parseFloat(dogOdds);
      const dogWon = dogIsF1 ? actualWinner === 'fighter1' : actualWinner === 'fighter2';
      correct = dogWon;
      pnl     = dogWon ? computePayout(betOdds) : -1;
      results.BET_DOG.roi += pnl;
      results.BET_DOG.oddsUsed.push(betOdds);
      if (correct) results.BET_DOG.correct++; else results.BET_DOG.wrong++;
    } else if (signal === 'BET_FAV') {
      betOdds = parseFloat(favOdds);
      const favWon = favIsF1 ? actualWinner === 'fighter1' : actualWinner === 'fighter2';
      correct = favWon;
      pnl     = favWon ? computePayout(betOdds) : -1;
      results.BET_FAV.roi += pnl;
      results.BET_FAV.oddsUsed.push(betOdds);
      if (correct) results.BET_FAV.correct++; else results.BET_FAV.wrong++;
    } else {
      results.PASS.correct++;
    }

    if (!edgeBuckets[bucket]) edgeBuckets[bucket] = { total: 0, correct: 0, wrong: 0 };
    if (signal !== 'PASS') {
      edgeBuckets[bucket].total++;
      if (correct) edgeBuckets[bucket].correct++; else edgeBuckets[bucket].wrong++;
    }

    const rec = {
      file:    target.file,
      signal,
      edge,
      bucket,
      actualWinner,
      correct,
      pnl:    Math.round(pnl * 100) / 100,
      sampleSize: total,
      dogOdds,
      favOdds,
      dogWinRate: Math.round(dogWinRate * 100),
      impliedDog: Math.round(impliedDog * 100)
    };
    predictions.push(rec);

    if (VERBOSE && signal !== 'PASS') {
      const tag = correct ? '✓' : '✗';
      console.log(`${tag} [${signal.padEnd(7)}] edge:${String(edge).padStart(6)} ppts  ${target.file.slice(0,55).padEnd(55)}  P&L:${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  SIGNAL BREAKDOWN');
  console.log('═══════════════════════════════════════════════════════');

  for (const [sig, r] of Object.entries(results)) {
    if (sig === 'PASS') continue;
    const total     = r.correct + r.wrong;
    if (!total) { console.log(`  ${sig}: no signals`); continue; }
    const winRate   = Math.round(r.correct / total * 100);
    const roi       = Math.round(r.roi / total * 1000) / 10;
    const avgOdds   = r.oddsUsed.length ? Math.round(r.oddsUsed.reduce((s,o)=>s+o,0)/r.oddsUsed.length) : 0;
    console.log(`  ${sig}:`);
    console.log(`    Bets:    ${total} (${r.correct}W / ${r.wrong}L)`);
    console.log(`    Win %:   ${winRate}%`);
    console.log(`    ROI:     ${roi > 0 ? '+' : ''}${roi} units/bet`);
    console.log(`    Avg odds: ${avgOdds > 0 ? '+' : ''}${avgOdds}`);
  }

  const totalSignals = results.BET_DOG.correct + results.BET_DOG.wrong + results.BET_FAV.correct + results.BET_FAV.wrong;
  const totalCorrect = results.BET_DOG.correct + results.BET_FAV.correct;
  const overallWin   = totalSignals ? Math.round(totalCorrect / totalSignals * 100) : 0;
  const combinedROI  = (results.BET_DOG.roi + results.BET_FAV.roi);
  const roiPerBet    = totalSignals ? Math.round(combinedROI / totalSignals * 1000) / 10 : 0;

  console.log('\n  COMBINED:');
  console.log(`    Total signals: ${totalSignals} of ${allFights.length - skipped} fights`);
  console.log(`    Win rate:      ${overallWin}%`);
  console.log(`    ROI:           ${roiPerBet > 0 ? '+' : ''}${roiPerBet} units/bet`);
  console.log(`    Skipped:       ${skipped} (< 5 similar fights)`);

  console.log('\n  EDGE BUCKET ACCURACY (signals only):');
  for (const [b, d] of Object.entries(edgeBuckets).sort((a,b) => a[0].localeCompare(b[0]))) {
    if (!d.total) continue;
    const wr = Math.round(d.correct / d.total * 100);
    console.log(`    edge ${b.padEnd(5)} ppts: ${d.correct}W/${d.wrong}L  (${wr}% win)`);
  }

  // ── Most interesting calls ────────────────────────────────────────────────

  const correctBig  = predictions.filter(p => p.signal !== 'PASS' && p.correct && Math.abs(p.edge) > 15).slice(0,5);
  const wrongBig    = predictions.filter(p => p.signal !== 'PASS' && !p.correct && Math.abs(p.edge) > 15).slice(0,5);

  if (correctBig.length) {
    console.log('\n  BIGGEST CORRECT CALLS (|edge| > 15):');
    for (const p of correctBig) {
      const side = p.signal === 'BET_DOG' ? 'dog' : 'fav';
      console.log(`    ✓ edge:${p.edge > 0 ? '+' : ''}${p.edge} bet ${side} ${p.dogOdds}/${p.favOdds} — ${p.file.replace('.json','')}`);
    }
  }
  if (wrongBig.length) {
    console.log('\n  BIGGEST WRONG CALLS (|edge| > 15):');
    for (const p of wrongBig) {
      const side = p.signal === 'BET_DOG' ? 'dog' : 'fav';
      console.log(`    ✗ edge:${p.edge > 0 ? '+' : ''}${p.edge} bet ${side} — ${p.file.replace('.json','')}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════\n');
}

main();
