'use strict';
// analyzer.js — Bet Bot Brain: pattern engine + Claude edge synthesis
// Completely isolated — no imports from server.js or index.html
// Consumed by server.js via: const { findEdge } = require('./analyzer');

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { predictCrossover, assessCrossoverRisk } = require('./crossover_predictor');
const { loadFighterProfiles } = require('./fighter_stats');

// Load fighter profiles once at startup (empty object if not yet scraped)
let _fighterProfiles = null;
function getFighterProfiles() {
  if (!_fighterProfiles) _fighterProfiles = loadFighterProfiles();
  return _fighterProfiles;
}

const DATA_DIR  = path.join(__dirname, 'historical_data');
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Data loading ──────────────────────────────────────────────────────────────

function loadEnrichedFights() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('dk_') && !f.startsWith('crossover'));

  const fights = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (!data.outcome || !data.outcome.winner) continue;
      fights.push({ file: f, ...data });
    } catch (_) {}
  }
  return fights;
}

// ── Odds utilities ────────────────────────────────────────────────────────────

// Convert American odds to implied probability (0–1)
function impliedProb(americanOdds) {
  const o = parseFloat(americanOdds);
  if (isNaN(o)) return null;
  return o < 0 ? (-o) / (-o + 100) : 100 / (o + 100);
}

// Classify a fighter's odds into a named tier
function oddsLabel(americanOdds) {
  const o = parseFloat(americanOdds);
  if (isNaN(o)) return 'unknown';
  if (o <= -400)       return 'extreme_fav';
  if (o <= -200)       return 'heavy_fav';
  if (o <= -130)       return 'fav';
  if (o < 0)           return 'slight_fav';
  if (o < 130)         return 'pick_em';
  if (o < 200)         return 'slight_dog';
  if (o < 350)         return 'dog';
  return                      'heavy_dog';
}

// How many American-odds points did f1's line move? Positive = toward favourite
function lineMovementMagnitude(openOdds, currentOdds) {
  const open = parseFloat(openOdds), cur = parseFloat(currentOdds);
  if (isNaN(open) || isNaN(cur)) return null;
  return cur - open; // positive = more negative (line moving toward f1 being bigger fav)
}

// ── Similarity matching ───────────────────────────────────────────────────────

// Score how similar a historical fight is to the current situation (higher = more similar)
function similarityScore(hist, params) {
  const { f1CurrentOdds, f2CurrentOdds, f1OpeningOdds, crossoverOccurred, dominanceHint } = params;
  let score = 0;

  const histOpenF1  = hist.outcome.openingF1Odds;
  const histOpenF2  = hist.outcome.openingF2Odds;
  const histCloseF1 = hist.outcome.closingF1Odds;
  const derived     = hist.derived || {};

  if (histOpenF1 == null || histOpenF2 == null) return 0;

  // Odds range similarity (opening odds)
  if (f1OpeningOdds != null) {
    const diff = Math.abs(histOpenF1 - f1OpeningOdds);
    score += Math.max(0, 50 - diff / 5); // up to 50 pts for exact odds match
  }

  // Current odds tier match
  const curLabel  = oddsLabel(f1CurrentOdds);
  const histLabel = oddsLabel(histCloseF1);
  const TIERS = ['extreme_fav','heavy_fav','fav','slight_fav','pick_em','slight_dog','dog','heavy_dog'];
  if (curLabel === histLabel) score += 30;
  else if (Math.abs(TIERS.indexOf(curLabel) - TIERS.indexOf(histLabel)) <= 1) score += 15;

  // Crossover pattern match
  if (crossoverOccurred != null && hist.outcome.crossoverOccurred === crossoverOccurred) score += 20;

  // Line movement direction match
  const paramMovement = f1OpeningOdds != null ? lineMovementMagnitude(f1OpeningOdds, f1CurrentOdds) : null;
  const histMovement  = hist.outcome.lineMovementF1;
  if (paramMovement != null && histMovement != null) {
    if ((paramMovement > 0) === (histMovement > 0)) score += 15;
  }

  // Derived field bonuses — reward fights with similar live action patterns
  if (derived.dominanceScore != null && dominanceHint != null) {
    // dominanceHint: 'dominant' (>60), 'contested' (<40), 'neutral'
    const histDom = derived.dominanceScore;
    const dominant = histDom >= 60, contested = histDom < 40;
    if ((dominanceHint === 'dominant' && dominant) ||
        (dominanceHint === 'contested' && contested) ||
        (dominanceHint === 'neutral'   && !dominant && !contested)) score += 10;
  }

  // Reward high-data fights (more points = more signal)
  if (derived.peakOddsSwing != null && derived.peakOddsSwing > 200) score += 5;

  return score;
}

function findSimilarFights(params, fights, topN = 30) {
  return fights
    .map(f => ({ fight: f, score: similarityScore(f, params) }))
    .filter(x => x.score > 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(x => x.fight);
}

// ── Statistics ────────────────────────────────────────────────────────────────

function computeStats(similar, params) {
  if (!similar.length) return null;

  const total        = similar.length;
  const f1WinCount   = similar.filter(f => f.outcome.winner === 'fighter1').length;
  const f2WinCount   = total - f1WinCount;

  // Determine which side is the underdog right now
  const f1IsDog      = parseFloat(params.f1CurrentOdds) > 0;
  const dogWinCount  = f1IsDog ? f1WinCount : f2WinCount;
  const favWinCount  = f1IsDog ? f2WinCount : f1WinCount;
  const dogWinRate   = dogWinCount / total;
  const favWinRate   = favWinCount / total;

  // Method breakdown
  const methods = {};
  for (const f of similar) {
    const m = (f.outcome.method || 'Decision').replace(/\s*-\s*\w+/, ''); // normalize Decision subtypes
    methods[m] = (methods[m] || 0) + 1;
  }

  // Crossover stats
  const crossovers      = similar.filter(f => f.outcome.crossoverOccurred);
  const crossoverF1Win  = crossovers.filter(f => f.outcome.winner === 'fighter1').length;

  // ROI calculation: if you bet $100 on the dog every time
  const dogOdds = parseFloat(f1IsDog ? params.f1CurrentOdds : params.f2CurrentOdds);
  const dogPayout  = dogOdds > 0 ? dogOdds / 100 : 100 / Math.abs(dogOdds);
  const dogROI     = (dogWinRate * dogPayout) - ((1 - dogWinRate) * 1);

  // Value: is the underdog priced fairly?
  const impliedDogProb = impliedProb(f1IsDog ? params.f1CurrentOdds : params.f2CurrentOdds);
  const historicalDogProb = dogWinRate;
  const edge = impliedDogProb != null ? historicalDogProb - impliedDogProb : null;

  // Derived field aggregates
  const withDerived   = similar.filter(f => f.derived);
  const avgDominance  = withDerived.length
    ? Math.round(withDerived.reduce((s, f) => s + (f.derived.dominanceScore || 0), 0) / withDerived.length)
    : null;
  const avgPeakSwing  = withDerived.length
    ? Math.round(withDerived.reduce((s, f) => s + (f.derived.peakOddsSwing || 0), 0) / withDerived.length)
    : null;
  const finishSpeeds  = {};
  for (const f of withDerived) {
    const sp = f.derived.finishSpeed || 'unknown';
    finishSpeeds[sp] = (finishSpeeds[sp] || 0) + 1;
  }
  const finishSpeedPct = {};
  for (const [sp, cnt] of Object.entries(finishSpeeds)) {
    finishSpeedPct[sp] = Math.round(cnt / (withDerived.length || 1) * 100);
  }
  const avgCrossovers = withDerived.length
    ? Math.round(withDerived.reduce((s, f) => s + (f.derived.crossoverCount || 0), 0) / withDerived.length * 10) / 10
    : null;

  return {
    sampleSize: total,
    dogWinRate:  Math.round(dogWinRate  * 100),
    favWinRate:  Math.round(favWinRate  * 100),
    dogROI:      Math.round(dogROI * 100) / 100,
    edge:        edge != null ? Math.round(edge * 1000) / 10 : null,
    methods,
    crossovers: {
      total:   crossovers.length,
      f1WinPct: crossovers.length ? Math.round(crossoverF1Win / crossovers.length * 100) : null
    },
    impliedDogProb:    impliedDogProb != null ? Math.round(impliedDogProb * 100) : null,
    historicalDogProb: Math.round(historicalDogProb * 100),
    derived: {
      avgDominanceScore: avgDominance,
      avgPeakOddsSwing:  avgPeakSwing,
      finishSpeedPct,
      avgCrossoverCount: avgCrossovers,
      sampleWithDerived: withDerived.length
    }
  };
}

// ── Ish / Louis bet history ───────────────────────────────────────────────────

function loadUserBetHistory() {
  try {
    const raw      = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dk_captures.json'), 'utf8'));
    // dk_captures.json is a flat array of capture objects: [{ userId, data, ts, url }, ...]
    const captures = Array.isArray(raw) ? raw : [];
    const allBets  = [];
    for (const capture of captures) {
      const userId = capture.userId;
      if (!userId || userId.startsWith('test') || userId === 'default') continue;
      const bets = (capture.data && capture.data.result && capture.data.result.initial && capture.data.result.initial.bets) || [];
      for (const b of bets) {
        if (!b.betId || b.isParlay) continue;
        const status = (b.settlementStatus || b.status || '').toLowerCase();
        if (!['won','lost','push'].includes(status)) continue;
        allBets.push({
          userId,
          betId:     b.betId,
          selection: (b.selections && b.selections[0] && b.selections[0].selectionDisplayName) || b.selection || '',
          odds:      parseFloat(b.displayOdds || b.odds || 0),
          stake:     parseFloat(b.stake || 0),
          status,
          returns:   parseFloat(b.returns || 0),
          date:      b.placementDate ? b.placementDate.slice(0, 10) : null
        });
      }
    }
    // Dedup by betId
    const seen = new Set();
    return allBets.filter(b => { if (seen.has(b.betId)) return false; seen.add(b.betId); return true; });
  } catch (_) { return []; }
}

function computeUserStats(bets, currentOddsRange) {
  if (!bets || !bets.length) return null;
  const [low, high] = currentOddsRange;
  const relevant = bets.filter(b => b.odds >= low && b.odds <= high);
  if (!relevant.length) return null;

  const wins   = relevant.filter(b => b.status === 'won').length;
  const losses = relevant.filter(b => b.status === 'lost').length;
  const total  = wins + losses;
  if (!total) return null;

  const roi = relevant.reduce((sum, b) => {
    if (b.status === 'won')  return sum + (b.returns - b.stake);
    if (b.status === 'lost') return sum - b.stake;
    return sum;
  }, 0);

  const byUser = {};
  for (const b of relevant) {
    if (!byUser[b.userId]) byUser[b.userId] = { wins: 0, losses: 0 };
    if (b.status === 'won')  byUser[b.userId].wins++;
    if (b.status === 'lost') byUser[b.userId].losses++;
  }

  return { wins, losses, total, winRate: Math.round(wins/total*100), roi: Math.round(roi*100)/100, byUser };
}

// ── Claude synthesis ──────────────────────────────────────────────────────────

async function synthesizeEdge(params, stats, userBetStats, similar, crossoverPred, crossoverRisk) {
  if (!stats || stats.sampleSize < 5) {
    return {
      confidence: 'low',
      alert: null,
      reason: `Only ${stats?.sampleSize ?? 0} similar historical fights found — not enough data for a reliable signal.`
    };
  }

  const f1IsDog = parseFloat(params.f1CurrentOdds) > 0;
  const dogSide = f1IsDog ? params.fighter1 : params.fighter2;
  const favSide = f1IsDog ? params.fighter2 : params.fighter1;
  const dogOdds = f1IsDog ? params.f1CurrentOdds : params.f2CurrentOdds;

  const systemPrompt = `You are a sharp sports betting analyst for a live MMA/combat sports dashboard.
Your job is to surface high-value insights for live bettors in 2-3 sentences max.
Be direct, specific, and quantitative. No hedging, no disclaimers.
Edge can go EITHER direction: if the underdog is overpriced, say to bet the favorite. If the favorite is overpriced, say to bet the dog. Say which side has value and why.
If crossover probability is high (>45%), lead with that — crossovers make dogs coin-flip winners (50% historically). This is the most actionable pre-fight signal.`;

  const d = stats.derived || {};
  const finishSummary = d.finishSpeedPct
    ? Object.entries(d.finishSpeedPct).sort((a,b) => b[1]-a[1]).map(([sp,pct]) => `${sp} ${pct}%`).join(', ')
    : 'unknown';

  const userPrompt = `Current fight: ${params.fighter1} (${params.f1CurrentOdds}) vs ${params.fighter2} (${params.f2CurrentOdds})
Opening odds: ${params.f1OpeningOdds ?? 'unknown'} / ${params.f2OpeningOdds ?? 'unknown'}
Crossover occurred: ${params.crossoverOccurred ? `Yes (${params.crossoverMinute ?? '?'} min in)` : 'No'}
${crossoverPred ? `
⚡ CROSSOVER PREDICTION (pre-fight):
- Probability: ${crossoverPred.crossoverProbPct}% (${crossoverPred.tier})
- Signal: ${crossoverPred.signal.toUpperCase()}
- If crossover: dog wins ~50% | If no crossover: dog wins ~12%
- Expected dog win blended: ${crossoverPred.expectedDogWinRate}% vs implied ${crossoverPred.impliedDogWinRate}%
- 57% of similar crossovers happen in round 1 — window closes fast` : ''}
${crossoverRisk ? `
Historical crossover data (${stats.sampleSize} similar fights):
- ${crossoverRisk.crossoverFightCount} of ${stats.sampleSize} crossed over (${crossoverRisk.empiricalCrossoverRate}%)
- Dog win rate when crossed: ${crossoverRisk.dogWinRateOnCross ?? 'N/A'}%
- Dog win rate no crossover: ${crossoverRisk.dogWinRateNoCross ?? 'N/A'}%` : ''}

Historical pattern (${stats.sampleSize} similar live fights):
- Underdog (${dogSide} at ${dogOdds}) wins ${stats.dogWinRate}% (book implies ${stats.impliedDogProb}%)
- Edge vs implied probability: ${stats.edge != null ? (stats.edge > 0 ? '+' : '') + stats.edge + ' ppts' : 'unknown'}
- Method breakdown: ${Object.entries(stats.methods).map(([m,c]) => `${m} ${Math.round(c/stats.sampleSize*100)}%`).join(', ')}
${d.sampleWithDerived > 0 ? `- Avg dominance: ${d.avgDominanceScore}/100 | Finish: ${finishSummary}` : ''}

${userBetStats ? `Personal record at similar odds: ${userBetStats.wins}W-${userBetStats.losses}L (${userBetStats.winRate}%)` : ''}

Give me 2-3 sentences: lead with crossover probability if strong, then which side has edge and why, then key risk.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt
    });
    const text = msg.content[0]?.text || '';

    // Determine confidence and signal strength
    const hasEdge    = stats.edge != null && stats.edge > 5;
    const strongEdge = stats.edge != null && stats.edge > 12;
    const confidence = stats.sampleSize >= 20 && strongEdge ? 'high' :
                       stats.sampleSize >= 10 && hasEdge    ? 'medium' : 'low';

    return {
      confidence,
      alert: hasEdge ? {
        side: dogSide,
        odds: dogOdds,
        edge: stats.edge,
        winRate: stats.dogWinRate,
        sampleSize: stats.sampleSize
      } : null,
      summary: text,
      stats
    };
  } catch (e) {
    // If Claude fails, return raw stats without synthesis
    return {
      confidence: stats.edge > 5 ? 'medium' : 'low',
      alert: null,
      summary: `${stats.dogWinRate}% underdog win rate in ${stats.sampleSize} similar fights (book implies ${stats.impliedDogProb}%). Edge: ${stats.edge != null ? (stats.edge > 0 ? '+' : '') + stats.edge + ' ppts' : 'N/A'}.`,
      stats,
      claudeError: e.message
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function findEdge(params) {
  // params: { fighter1, fighter2, f1CurrentOdds, f2CurrentOdds, f1OpeningOdds, f2OpeningOdds, crossoverOccurred, crossoverMinute }
  const fights     = loadEnrichedFights();
  const enriched   = fights.filter(f => f.outcome?.winner);

  if (!enriched.length) {
    return { error: 'No enriched fight data yet — run node enricher.js first', enrichedCount: 0 };
  }

  // Crossover prediction — uses opening odds + fighter profiles for volatility adjustment
  const crossoverPred = predictCrossover({
    f1OpeningOdds: params.f1OpeningOdds ?? params.f1CurrentOdds,
    f2OpeningOdds: params.f2OpeningOdds ?? params.f2CurrentOdds,
    f1Name:   params.fighter1,
    f2Name:   params.fighter2,
    profiles: getFighterProfiles(),
  });

  const similar    = findSimilarFights(params, enriched);
  const stats      = computeStats(similar, params);
  const crossoverRisk = assessCrossoverRisk(similar, params);

  // User bet history at current odds range
  const f1IsDog    = parseFloat(params.f1CurrentOdds) > 0;
  const dogOdds    = parseFloat(f1IsDog ? params.f1CurrentOdds : params.f2CurrentOdds);
  const oddsRange  = [dogOdds - 50, dogOdds + 50];
  const userBets   = loadUserBetHistory();
  const userStats  = computeUserStats(userBets, oddsRange);

  const result     = await synthesizeEdge(params, stats, userStats, similar, crossoverPred, crossoverRisk);

  // Apply backtest finding: strong dog signals (edge > 12) historically underperform.
  // Cap BET_DOG at 12 ppts — beyond that, call it LEAN (the book knows something).
  // BET_FAV remains reliable at any edge level.
  const dogEdge = stats?.edge ?? 0;
  const isBetDog = dogEdge > 12;
  if (isBetDog && result.alert) {
    result._strongDogCapped = true; // flag for UI: show as LEAN not BET
  }

  return {
    ...result,
    crossover: crossoverPred,
    crossoverRisk,
    meta: {
      totalEnrichedFights: enriched.length,
      similarFightsFound:  similar.length,
      fighter1:    params.fighter1,
      fighter2:    params.fighter2,
      f1Odds:      params.f1CurrentOdds,
      f2Odds:      params.f2CurrentOdds,
      crossoverOccurred: params.crossoverOccurred
    }
  };
}

module.exports = { findEdge, loadEnrichedFights, findSimilarFights, computeStats, impliedProb, oddsLabel, computeUserStats, loadUserBetHistory };
