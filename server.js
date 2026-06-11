require('dotenv').config();
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';
const HISTORICAL_DIR = path.join(__dirname, 'historical_data');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TOKEN_WARN = parseInt(process.env.ANTHROPIC_TOKEN_WARN_THRESHOLD || '500000');
let totalTokensUsed = 0;
let totalQueries = 0;
let _cachedSummaryJson = null;
let _oddsApiCreditsUsed = null;
let _oddsApiCreditsRemaining = null;

app.use(express.static('public'));
app.use(express.json());

// ── Helpers ────────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(d), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function toDecimal(o) {
  return o > 0 ? (o / 100) + 1 : (100 / Math.abs(o)) + 1;
}

function analyzeFightFile(filePath) {
  const d = JSON.parse(fs.readFileSync(filePath));
  const h = d.oddsHistory || [];
  if (!h.length) return null;

  const crossovers = [];
  for (let i = 1; i < h.length; i++) {
    const pf1 = h[i-1].fighter1.numericOdds, cf1 = h[i].fighter1.numericOdds;
    const pf2 = h[i-1].fighter2.numericOdds, cf2 = h[i].fighter2.numericOdds;
    const f1Cross = pf1 > 0 && cf1 < 0;
    const f2Cross = pf2 > 0 && cf2 < 0;
    if (f1Cross || f2Cross) {
      const o1 = f1Cross ? pf2 : pf1;
      const o2 = f1Cross ? cf2 : cf1;
      const d1 = toDecimal(o1), d2 = toDecimal(o2);
      const winWin = (d1 - 1) * (d2 - 1) > 1;
      crossovers.push({ o1, o2, winWin,
        fighter: f1Cross ? h[i-1].fighter2.name : h[i-1].fighter1.name,
        at: h[i].timestamp });
    }
  }

  const open = h[0], close = h[h.length - 1];
  return {
    fightId: d.fightId,
    date: d.fightId.match(/\d{4}-\d{2}-\d{2}/)?.[0] || path.basename(filePath).match(/\d{4}-\d{2}-\d{2}/)?.[0],
    fighter1: open.fighter1.name,
    fighter2: open.fighter2.name,
    openOdds: { [open.fighter1.name]: open.fighter1.numericOdds, [open.fighter2.name]: open.fighter2.numericOdds },
    closeOdds: { [close.fighter1.name]: close.fighter1.numericOdds, [close.fighter2.name]: close.fighter2.numericOdds },
    dataPoints: h.length,
    crossovers,
    winWinCount: crossovers.filter(c => c.winWin).length,
  };
}

// Build/cache an index of all historical fights
let _index = null;
function getIndex() {
  if (_index) return _index;
  const files = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json'));
  _index = files.map(f => {
    try { return analyzeFightFile(path.join(HISTORICAL_DIR, f)); }
    catch { return null; }
  }).filter(Boolean);
  return _index;
}

function invalidateIndex() { _index = null; _cachedSummaryJson = null; }

function getCachedSummary() {
  if (_cachedSummaryJson) return _cachedSummaryJson;
  const index = getIndex();
  const summary = index.map(f => ({
    fight: `${f.fighter1} vs ${f.fighter2}`,
    date: f.date,
    open: f.openOdds,
    close: f.closeOdds,
    crossovers: f.crossovers.length,
    winWins: f.winWinCount,
    // Per-crossover odds so Claude can answer precise questions about odds magnitude
    crossoverEvents: f.crossovers.map(c => ({ o1: c.o1, o2: c.o2, ww: c.winWin })),
  }));
  _cachedSummaryJson = JSON.stringify(summary, null, 1);
  console.log(`Historical summary cached: ${index.length} fights, ${_cachedSummaryJson.length} chars`);
  return _cachedSummaryJson;
}

// Find fights involving a fighter (fuzzy name match)
function findFighterHistory(name, limit = 3) {
  const q = name.toLowerCase().replace(/\s+/g, '');
  const index = getIndex();
  const matches = index.filter(f =>
    f.fighter1.toLowerCase().replace(/\s+/g, '').includes(q) ||
    f.fighter2.toLowerCase().replace(/\s+/g, '').includes(q)
  );
  // Sort by date descending, return most recent N
  return matches
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, limit);
}

const systemPrompt = `You are an expert MMA live betting research assistant. You work with Ish, a professional live MMA bettor who specializes in crossover opportunities during live UFC fights.

## YOUR DATA SOURCES
1. LOCAL HISTORICAL DATA (Dec 2025–May 2026): Live DraftKings odds captured every ~3 seconds during 262 actual UFC fights. Has opening odds, closing odds, AND full crossover/win-win analysis.
2. LIVE/UPCOMING ODDS: Current DraftKings moneyline odds for upcoming fights.
3. ODDS API HISTORICAL (any date): Can fetch pre-fight DraftKings odds for past events outside the local dataset. Costs 10 API credits per date lookup. Use when Ish asks about a fighter whose fights aren't in the local data.

## CORE CONCEPTS

**Crossover**: During a live fight, a fighter's odds flip from underdog (+) to favorite (-). Momentum shifted — book adjusted.

**Win-Win Crossover**: The core opportunity:
- Bet 1: placed live when Fighter A is at plus money
- Crossover happens — Fighter A becomes favorite
- Bet 2: placed on Fighter B now at plus money
- Guaranteed profit condition: (D1-1)(D2-1) > 1
- Works even with minus-money Bet 1 if the crossover swing is large enough

**Stake math**:
- Optimal Bet 2 per $100 Bet 1: sqrt((D1-1)/(D2-1)) × 100
- Safe range: S1/(D2-1) to S1×(D1-1)

**Dataset stats**: 262 fights. 110/262 (42%) had crossovers. 59 confirmed win-win moments.

## WHEN TO REQUEST HISTORICAL API LOOKUP
If Ish asks about a fighter who has NO fights in the local dataset, respond with:
LOOKUP_NEEDED: [fighter name] [approximate fight dates as YYYY-MM-DD]

List up to 3 dates to check (spaced a few months apart around when you estimate their recent fights occurred based on your knowledge of UFC scheduling). The system will fetch those dates and retry your answer with that data included.

## HOW TO ANSWER
- Be specific with numbers — Ish makes real decisions
- Format tables for multi-fight comparisons
- For upcoming fights, assess crossover potential based on odds gap and fighter styles
- Always note if crossover data is from local dataset (full detail) vs API lookup (pre-fight odds only)`;

// ── Routes ─────────────────────────────────────────────────────────────────

// Live UFC odds
app.get('/api/ufc', async (req, res) => {
  try {
    const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    const { data, headers } = await fetchJson(url);
    updateOddsCredits(headers);
    console.log(`Odds API — used: ${_oddsApiCreditsUsed} | remaining: ${_oddsApiCreditsRemaining}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Credits/usage status
app.get('/api/credits', (req, res) => {
  res.json({
    oddsApi: { used: _oddsApiCreditsUsed, remaining: _oddsApiCreditsRemaining, total: 100000 },
    anthropic: {
      sessionTokens: totalTokensUsed,
      sessionQueries: totalQueries,
      estimatedCostUSD: +(totalTokensUsed / 1_000_000 * 3).toFixed(4),
      warnThreshold: TOKEN_WARN,
    },
  });
});

// Historical fight index
app.get('/api/fights', (req, res) => {
  try { res.json(getIndex()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Fighter history lookup
app.get('/api/fighter/:name', (req, res) => {
  try { res.json(findFighterHistory(req.params.name, 5)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Fetch historical odds from The Odds API for a specific past date (costs 10 credits each)
async function fetchHistoricalOdds(dateISO) {
  const url = `${BASE_URL}/historical/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&date=${dateISO}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
  const { data, headers } = await fetchJson(url);
  updateOddsCredits(headers);
  console.log(`Historical API (10 credits) — used: ${_oddsApiCreditsUsed} | remaining: ${_oddsApiCreditsRemaining}`);
  if (!Array.isArray(data?.data)) return [];
  return data.data.filter(f => f.bookmakers?.length > 0).map(f => {
    const outcomes = f.bookmakers[0].markets[0]?.outcomes || [];
    return {
      fight: `${f.home_team} vs ${f.away_team}`,
      date: f.commence_time.slice(0, 10),
      odds: outcomes.reduce((acc, o) => { acc[o.name] = o.price; return acc; }, {}),
      source: 'historical_api',
    };
  });
}

function updateOddsCredits(headers) {
  if (headers['x-requests-used']) _oddsApiCreditsUsed = parseInt(headers['x-requests-used']);
  if (headers['x-requests-remaining']) _oddsApiCreditsRemaining = parseInt(headers['x-requests-remaining']);
}

// AI research endpoint — Ish can ask anything
app.post('/api/research', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    // Pull live upcoming odds
    let liveOdds = [];
    try {
      const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
      const { data, headers } = await fetchJson(url);
      updateOddsCredits(headers);
      liveOdds = (Array.isArray(data) ? data : []).filter(f => f.bookmakers?.length > 0).map(f => {
        const outcomes = f.bookmakers[0].markets[0]?.outcomes || [];
        return {
          fight: `${f.home_team} vs ${f.away_team}`,
          date: f.commence_time.slice(0, 10),
          odds: outcomes.reduce((acc, o) => { acc[o.name] = o.price; return acc; }, {}),
        };
      });
    } catch {}

    const historicalSummaryJson = getCachedSummary();
    totalQueries++;

    const buildMessages = (extraData) => [{
      role: 'user',
      content: `HISTORICAL FIGHT DATA (local, Dec 2025–May 2026):
${historicalSummaryJson}

CURRENT DRAFTKINGS ODDS (upcoming fights):
${JSON.stringify(liveOdds, null, 1)}
${extraData ? `\nADDITIONAL HISTORICAL API DATA (pre-fight odds from The Odds API):\n${JSON.stringify(extraData, null, 1)}` : ''}

Question: ${question}`,
    }];

    // Pass 1
    const pass1 = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: buildMessages(null),
    });
    const pass1Text = pass1.content[0].text;
    let used = pass1.usage.input_tokens + pass1.usage.output_tokens;

    // Check if Claude wants historical API lookups
    const lookupMatch = pass1Text.match(/LOOKUP_NEEDED:\s*(.+)/i);
    let finalAnswer = pass1Text;

    if (lookupMatch) {
      // Parse dates from the LOOKUP_NEEDED line: "Fighter Name YYYY-MM-DD YYYY-MM-DD ..."
      const parts = lookupMatch[1].trim().split(/\s+/);
      const dates = parts.filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p)).slice(0, 3);
      console.log(`Historical lookup requested for dates: ${dates.join(', ')}`);

      const extraData = [];
      for (const d of dates) {
        try {
          const results = await fetchHistoricalOdds(d);
          extraData.push(...results);
        } catch (e) {
          console.error(`Historical API error for ${d}:`, e.message);
        }
      }

      if (extraData.length > 0) {
        // Pass 2 with enriched data
        const pass2 = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: systemPrompt,
          messages: buildMessages(extraData),
        });
        finalAnswer = pass2.content[0].text;
        used += pass2.usage.input_tokens + pass2.usage.output_tokens;
      } else {
        finalAnswer = pass1Text.replace(/LOOKUP_NEEDED:.*/i, '').trim() +
          '\n\n*Note: Historical API lookup returned no results for those dates.*';
      }
    }

    totalTokensUsed += used;
    console.log(`Research query — tokens: ${used} | session total: ${totalTokensUsed}`);
    if (totalTokensUsed > TOKEN_WARN) {
      console.warn(`WARNING: Anthropic token usage (${totalTokensUsed}) exceeded threshold (${TOKEN_WARN})`);
    }

    res.json({
      answer: finalAnswer,
      usage: {
        thisQuery: used,
        sessionTotal: totalTokensUsed,
        sessionQueries: totalQueries,
        estimatedCostUSD: +(totalTokensUsed / 1_000_000 * 3).toFixed(3),
      },
      oddsApi: {
        creditsUsed: _oddsApiCreditsUsed,
        creditsRemaining: _oddsApiCreditsRemaining,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/usage', (req, res) => {
  res.json({
    sessionTokensUsed: totalTokensUsed,
    sessionQueries: totalQueries,
    estimatedCostUSD: +(totalTokensUsed / 1_000_000 * 3).toFixed(3),
    warnThreshold: TOKEN_WARN,
  });
});

app.listen(PORT, () => {
  console.log(`UFC Research Dashboard running at http://localhost:${PORT}`);
});
