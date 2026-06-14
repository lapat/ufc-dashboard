#!/usr/bin/env node
// test_backtest.js — Validates that the brain's predictions have real edge
// on historical data (leave-one-out cross-validation).
//
// These are statistical tests — they pass if the overall signal quality
// meets a minimum bar, not if any individual prediction is correct.
//
// Run: node test_backtest.js

'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'historical_data');

// ── Inline helpers (same as backtest.js, no require cycle) ──────────────────

function impliedProb(o) {
  const n = parseFloat(o);
  if (isNaN(n)) return null;
  return n < 0 ? (-n) / (-n + 100) : 100 / (n + 100);
}
function oddsLabel(o) {
  const n = parseFloat(o);
  if (isNaN(n)) return 'unknown';
  if (n <= -400) return 'extreme_fav'; if (n <= -200) return 'heavy_fav';
  if (n <= -130) return 'fav';         if (n < 0)     return 'slight_fav';
  if (n < 130)   return 'pick_em';     if (n < 200)   return 'slight_dog';
  if (n < 350)   return 'dog';         return 'heavy_dog';
}
const TIERS = ['extreme_fav','heavy_fav','fav','slight_fav','pick_em','slight_dog','dog','heavy_dog'];

function simScore(hist, params) {
  const { f1CurrentOdds, f1OpeningOdds, crossoverOccurred } = params;
  let s = 0;
  const hO1 = hist.outcome.openingF1Odds, hO2 = hist.outcome.openingF2Odds, hC1 = hist.outcome.closingF1Odds;
  if (!hO1 || !hO2) return 0;
  if (f1OpeningOdds != null) s += Math.max(0, 50 - Math.abs(hO1 - f1OpeningOdds) / 5);
  const cl = oddsLabel(f1CurrentOdds), hl = oddsLabel(hC1);
  if (cl === hl) s += 30; else if (Math.abs(TIERS.indexOf(cl) - TIERS.indexOf(hl)) <= 1) s += 15;
  if (crossoverOccurred != null && hist.outcome.crossoverOccurred === crossoverOccurred) s += 20;
  const pm = f1OpeningOdds != null ? f1CurrentOdds - f1OpeningOdds : null;
  const hm = hist.outcome.lineMovementF1;
  if (pm != null && hm != null && (pm > 0) === (hm > 0)) s += 15;
  if (hist.derived?.peakOddsSwing > 200) s += 5;
  return s;
}

function runBacktest(minEdge = 5) {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('dk_') && !f.startsWith('crossover'));
  const all = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (!d.outcome?.winner || d.outcome.openingF1Odds == null) continue;
      all.push({ file: f, ...d });
    } catch (_) {}
  }

  const dogBets = [], favBets = [];

  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    const pool = all.filter((_, j) => j !== i);
    const p = {
      f1CurrentOdds:    t.outcome.openingF1Odds,
      f1OpeningOdds:    t.outcome.openingF1Odds,
      f2CurrentOdds:    t.outcome.openingF2Odds,
      crossoverOccurred: t.outcome.crossoverOccurred ?? false
    };

    const sim = pool
      .map(f => ({ f, s: simScore(f, p) }))
      .filter(x => x.s > 10)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map(x => x.f);
    if (sim.length < 5) continue;

    const f1IsDog   = parseFloat(p.f1CurrentOdds) > 0;
    const f1W       = sim.filter(f => f.outcome.winner === 'fighter1').length;
    const dogW      = f1IsDog ? f1W : sim.length - f1W;
    const dogRate   = dogW / sim.length;
    const dogOdds   = parseFloat(f1IsDog ? p.f1CurrentOdds : p.f2CurrentOdds);
    const favOdds   = parseFloat(f1IsDog ? p.f2CurrentOdds : p.f1CurrentOdds);
    const imp       = impliedProb(dogOdds);
    if (!imp) continue;
    const edge = Math.round((dogRate - imp) * 1000) / 10;

    if (edge > minEdge) {
      const won    = f1IsDog ? t.outcome.winner === 'fighter1' : t.outcome.winner === 'fighter2';
      const payout = dogOdds > 0 ? dogOdds / 100 : 100 / Math.abs(dogOdds);
      dogBets.push({ edge, correct: won, payout, odds: dogOdds });
    } else if (edge < -minEdge) {
      const won    = f1IsDog ? t.outcome.winner === 'fighter2' : t.outcome.winner === 'fighter1';
      const payout = favOdds > 0 ? favOdds / 100 : 100 / Math.abs(favOdds);
      favBets.push({ edge, correct: won, payout, odds: favOdds });
    }
  }

  function stats(bets) {
    if (!bets.length) return { count: 0, winRate: 0, roi: 0, avgOdds: 0 };
    const wins    = bets.filter(b => b.correct);
    const losses  = bets.filter(b => !b.correct);
    const winPnl  = wins.reduce((s, b) => s + b.payout, 0);
    const lossPnl = losses.length;
    const net     = winPnl - lossPnl;
    const roi     = net / bets.length * 100;
    const avgOdds = bets.reduce((s, b) => s + b.odds, 0) / bets.length;
    return { count: bets.length, winRate: wins.length / bets.length, roi, avgOdds };
  }

  return { dog: stats(dogBets), fav: stats(favBets), total: all.length };
}

// ── Tests ────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch (e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('\nRunning backtest (this takes ~5s)...');
const results = runBacktest(5);
const { dog, fav, total } = results;

console.log('\n── Data quality ──');
check('have enough historical fights (>= 100)', () => assert(total >= 100, `only ${total}`));
check('BET_DOG has enough signals (>= 20)', () => assert(dog.count >= 20, `only ${dog.count}`));
check('BET_FAV has enough signals (>= 50)', () => assert(fav.count >= 50, `only ${fav.count}`));

console.log('\n── Signal quality ──');
check('BET_DOG win rate beats break-even (avg odds +207, break-even ~33%)', () => {
  const breakEven = 100 / (dog.avgOdds + 100);
  assert(dog.winRate > breakEven, `win ${(dog.winRate*100).toFixed(1)}% <= break-even ${(breakEven*100).toFixed(1)}%`);
});
check('BET_DOG ROI is positive', () => {
  assert(dog.roi > 0, `ROI is ${dog.roi.toFixed(1)}%`);
});
check('BET_FAV ROI is positive', () => {
  assert(fav.roi > 0, `ROI is ${fav.roi.toFixed(1)}%`);
});
check('BET_FAV win rate is above 60%', () => {
  assert(fav.winRate > 0.60, `win ${(fav.winRate*100).toFixed(1)}%`);
});
check('combined signals cover most fights (>= 75% of total)', () => {
  const coverage = (dog.count + fav.count) / total;
  assert(coverage >= 0.75, `only ${(coverage*100).toFixed(1)}% coverage`);
});

console.log('\n── Edge sensitivity ──');

// At higher threshold, quality should hold or improve
const r12 = runBacktest(12);
check('at |edge|>=12, BET_FAV still wins > 60%', () => {
  assert(r12.fav.winRate > 0.60, `${(r12.fav.winRate*100).toFixed(1)}%`);
});
check('at |edge|>=12, BET_FAV has >= 50 signals', () => {
  assert(r12.fav.count >= 50, `only ${r12.fav.count}`);
});

console.log('\n── Sanity checks ──');
check('win rates are real (between 0 and 1)', () => {
  assert(dog.winRate >= 0 && dog.winRate <= 1, 'dog: ' + dog.winRate);
  assert(fav.winRate >= 0 && fav.winRate <= 1, 'fav: ' + fav.winRate);
});
check('signal counts are sane', () => {
  assert(dog.count + fav.count <= total, 'more signals than fights?');
});

// Report actual numbers for reference
console.log('\n── Backtest results (for reference) ──');
console.log(`  Fights in corpus: ${total}`);
console.log(`  BET_DOG: ${dog.count} signals, ${(dog.winRate*100).toFixed(1)}% win, ROI ${dog.roi.toFixed(1)}%`);
console.log(`  BET_FAV: ${fav.count} signals, ${(fav.winRate*100).toFixed(1)}% win, ROI ${fav.roi.toFixed(1)}%`);
console.log(`  (at |edge|>=12): DOG ${r12.dog.count} signals, FAV ${r12.fav.count} signals`);

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
