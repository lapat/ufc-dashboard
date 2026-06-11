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
let _cachedSummaryJson = null; // cached once at startup, cleared when new fights added

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
    bestWinWin: f.crossovers.filter(c => c.winWin).map(c => `${c.fighter} +${c.o1}→+${c.o2}`)[0] || null,
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

// ── Routes ─────────────────────────────────────────────────────────────────

// Live UFC odds
app.get('/api/ufc', async (req, res) => {
  try {
    const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    const { data, headers } = await fetchJson(url);
    console.log(`Odds API — used: ${headers['x-requests-used']} | remaining: ${headers['x-requests-remaining']}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// AI research endpoint — Ish can ask anything
app.post('/api/research', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    // Pull live upcoming odds to give Claude current context
    let liveOdds = [];
    try {
      const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
      const { data } = await fetchJson(url);
      liveOdds = data.filter(f => f.bookmakers?.length > 0).map(f => {
        const outcomes = f.bookmakers[0].markets[0]?.outcomes || [];
        return {
          fight: `${f.home_team} vs ${f.away_team}`,
          date: f.commence_time.slice(0, 10),
          odds: outcomes.reduce((acc, o) => { acc[o.name] = o.price; return acc; }, {}),
        };
      });
    } catch {}

    // Use cached historical summary (built once, reused across all queries)
    const historicalSummaryJson = getCachedSummary();
    totalQueries++;

    const systemPrompt = `You are an expert MMA live betting research assistant. You work with Ish, a professional live MMA bettor who specializes in crossover opportunities during live UFC fights.

## YOUR DATA SOURCES
1. HISTORICAL DATA: Live DraftKings odds captured every ~3 seconds during actual UFC fights (Dec 2025 – May 2026). Contains opening odds, closing odds, and crossover analysis for 262 fights.
2. LIVE/UPCOMING ODDS: Current DraftKings moneyline odds for upcoming fights.

## CORE CONCEPTS YOU KNOW DEEPLY

**Crossover**: During a live fight, a fighter's odds flip from underdog (+ money) to favorite (- money). This happens when momentum shifts — the underdog starts winning and the book adjusts.

**Win-Win Crossover**: The key opportunity Ish looks for. Two bets placed at different times during the live fight:
- Bet 1: placed when Fighter A is at plus money (underdog)
- Crossover happens — Fighter A becomes the new favorite
- Bet 2: placed on Fighter B who is now the new underdog at plus money
- Guaranteed profit condition: (D1-1)(D2-1) > 1 where D = decimal odds
- This works even if Bet 1 was at minus money, IF the crossover swing is large enough
- The bigger the plus money on both legs, the larger the guaranteed profit window

**Stake sizing for win-win**:
- Optimal Bet 2 per $100 Bet 1: sqrt((D1-1)/(D2-1)) × 100
- Profit range: any Bet 2 stake between S1/(D2-1) and S1×(D1-1)
- Example: Bet 1 at +200, Bet 2 at +150 → guaranteed profit on any Bet 2 between $33 and $200 per $100 Bet 1

**Dataset stats**: 262 fights analyzed. 110/262 (42%) had crossovers. 59 confirmed win-win crossover moments across the dataset.

## HOW TO ANSWER
- When asked about a fighter, find their fights in historical data and report: opening odds, closing odds, number of crossovers, any win-win windows
- When asked about upcoming fights, use the live odds data
- Be specific with numbers — Ish makes real decisions based on your answers
- If something isn't in the data, say so clearly
- Format tables when comparing multiple fights
- Suggest what to watch for in upcoming fights based on historical patterns`;


    const userMessage = `HISTORICAL FIGHT DATA:
${historicalSummaryJson}

CURRENT DRAFTKINGS ODDS (upcoming fights):
${JSON.stringify(liveOdds, null, 1)}

Question: ${question}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const used = response.usage.input_tokens + response.usage.output_tokens;
    totalTokensUsed += used;
    console.log(`Research query — tokens: ${used} | session total: ${totalTokensUsed}`);
    if (totalTokensUsed > TOKEN_WARN) {
      console.warn(`WARNING: Anthropic token usage (${totalTokensUsed}) exceeded threshold (${TOKEN_WARN})`);
    }

    res.json({
      answer: response.content[0].text,
      usage: {
        thisQuery: used,
        sessionTotal: totalTokensUsed,
        sessionQueries: totalQueries,
        estimatedCostUSD: +(totalTokensUsed / 1_000_000 * 3).toFixed(3),
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
