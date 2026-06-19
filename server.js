require('dotenv').config();
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';
// HISTORICAL_DIR is set by record_engine (respects DATA_DIR env var for Railway volume).
// Defined here as a placeholder — overwritten after record_engine is imported below.
let HISTORICAL_DIR = path.join(__dirname, 'historical_data');
let API_CACHE_DIR  = path.join(__dirname, 'historical_data', 'api_cache');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TOKEN_WARN = parseInt(process.env.ANTHROPIC_TOKEN_WARN_THRESHOLD || '500000');
const nodemailer = require('nodemailer');

const ALERT_EMAIL = 'louislapat@gmail.com';
const CC_EMAIL    = 'iskanderb@gmail.com';
const mailer = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } })
  : null;

async function sendAlert(subject, text) {
  if (!mailer) return;
  try {
    await mailer.sendMail({ from: process.env.GMAIL_USER, to: ALERT_EMAIL, cc: CC_EMAIL, subject, text });
    console.log(`Alert sent: ${subject}`);
  } catch (e) {
    console.error('Alert email failed:', e.message);
  }
}
let totalTokensUsed = 0;
let totalQueries = 0;
let _cachedSummaryJson = null;
let _oddsApiCreditsUsed = null;
let _oddsApiCreditsRemaining = null;

// ── Dashboard bet command queue ───────────────────────────────────────────────
// Commands typed in the dashboard chat are queued here; the Chrome extension
// polls /api/pending-commands every 5s and executes them on DraftKings.
const DATA_ROOT_DIR = process.env.DATA_DIR || __dirname;
const COMMAND_QUEUE_FILE = path.join(DATA_ROOT_DIR, 'command_queue.json');

function loadCommandQueue() {
  try {
    if (fs.existsSync(COMMAND_QUEUE_FILE)) return JSON.parse(fs.readFileSync(COMMAND_QUEUE_FILE, 'utf8'));
  } catch {}
  return [];
}
function saveCommandQueue() {
  try { fs.writeFileSync(COMMAND_QUEUE_FILE, JSON.stringify(commandQueue, null, 2)); } catch {}
}
function makeCommand(type, intent) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    type,
    side:    intent.side   || null,
    amount:  intent.amount || null,
    trigger: intent.trigger || { type: 'crossover', targetOdds: null },
    status:  'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 120000,
    result: null,
    strategyHistory: [],
  };
}
let commandQueue = loadCommandQueue();

// ── Watch triggers ─────────────────────────────────────────────────────────────
// Conditional bets: "bet $20 on USA as soon as their odds go plus"
// Extension polls /api/watch-triggers every 5s, checks DOM odds against condition,
// fires executePlaceBet when met, then DELETEs the trigger.
let watchTriggers = [];

// ── Auto-bet system ────────────────────────────────────────────────────────────
// Automatically places a first bet when a new live fight matches a configured
// odds bracket. Hedge still fires via the existing crossover trigger.
//
// Failure modes addressed:
//   fight_too_old       — recorder started mid-fight; opening odds no longer valid
//   test_fight          — /api/recorder/test pollutes the session
//   dedup               — firedFights Set prevents double-fire per fight
//   rate_limit          — maxPerSession caps total auto-bets per night
//   no_extension        — block if no DK tab is alive (bet would expire unused)
//   invalid_odds        — NaN or missing odds from Odds API
//   odds_too_close      — implied prob diff < 5% means fav/dog is ambiguous
//   existing_coverage   — user already has an open bet on this side
//   bracket_mismatch    — only fire on user-targeted brackets

const AUTO_BET_CONFIG_FILE = path.join(DATA_ROOT_DIR, 'auto_bet_config.json');
const AUTO_BET_FIRED_FILE  = path.join(DATA_ROOT_DIR, 'auto_bet_fired.json');

const DEFAULT_AUTO_BET_CONFIG = {
  enabled:           false,
  amount:            5,          // dollars per first bet
  brackets:          ['slight'], // 'even' | 'slight' | 'heavy' | 'huge'
  side:              'dog',      // 'dog' (underdog) | 'fav' (favorite)
  maxPerSession:     3,          // hard cap on auto-bets this server session
  requireExtension:  true,       // block if no DK extension heartbeat in last 5 min
  maxFightAgeSecs:   300,        // skip if fight started > N seconds ago (missed opening)
  minOddsGapPct:     5,          // skip if |imp1 - imp2| < N% (odds too close to call)
  autoHedge:         true,       // include crossover trigger on the queued command
};

function loadAutoBetConfig() {
  try {
    if (fs.existsSync(AUTO_BET_CONFIG_FILE))
      return { ...DEFAULT_AUTO_BET_CONFIG, ...JSON.parse(fs.readFileSync(AUTO_BET_CONFIG_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULT_AUTO_BET_CONFIG };
}
function saveAutoBetConfig() {
  try { fs.writeFileSync(AUTO_BET_CONFIG_FILE, JSON.stringify(autoBetConfig, null, 2)); } catch {}
}

let autoBetConfig = loadAutoBetConfig();

// firedFights persisted across restarts so the same fight never gets two auto-bets
// even if server restarts mid-fight. Pruned to last 100 entries.
function loadFiredFights() {
  try {
    if (fs.existsSync(AUTO_BET_FIRED_FILE))
      return new Set(JSON.parse(fs.readFileSync(AUTO_BET_FIRED_FILE, 'utf8')));
  } catch {}
  return new Set();
}
function saveFiredFights() {
  try {
    const arr = [...autoBetFiredFights].slice(-100);
    fs.writeFileSync(AUTO_BET_FIRED_FILE, JSON.stringify(arr));
  } catch {}
}

const autoBetFiredFights = loadFiredFights();
let autoBetSessionCount = 0;
const autoBetLog = []; // last 20 auto-bet events (fired + skipped with reason)

function autoBetLogEvent(event) {
  autoBetLog.unshift({ ...event, ts: Date.now() });
  if (autoBetLog.length > 20) autoBetLog.length = 20;
}

// Returns { fired: true, cmd, side, bracket } | { skipped: true, reason }
function checkAutoBet(fightId, fighter1, fighter2, firstOdds, commenceTimeISO) {
  const cfg = autoBetConfig;

  // Guard: disabled
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' };

  // Guard: test fight
  if (/^test /i.test(fighter1) || /^test /i.test(fighter2))
    return { skipped: true, reason: 'test_fight' };

  // Guard: already fired for this fight (persistent dedup)
  if (autoBetFiredFights.has(fightId))
    return { skipped: true, reason: 'already_fired' };

  // Guard: session rate limit
  if (autoBetSessionCount >= cfg.maxPerSession)
    return { skipped: true, reason: `rate_limit (${autoBetSessionCount}/${cfg.maxPerSession})` };

  // Guard: fight too old (missed the opening)
  if (commenceTimeISO) {
    const liveForSecs = (Date.now() - new Date(commenceTimeISO).getTime()) / 1000;
    if (liveForSecs > cfg.maxFightAgeSecs)
      return { skipped: true, reason: `fight_too_old (${Math.round(liveForSecs)}s)` };
  }

  // Guard: extension connectivity
  if (cfg.requireExtension) {
    const now = Date.now();
    const hasLiveExt = Object.values(dkHeartbeat.users || {}).some(ts => now - ts < 300000);
    if (!hasLiveExt)
      return { skipped: true, reason: 'no_extension_connected' };
  }

  // Guard: invalid odds
  const f1Odds = firstOdds?.fighter1?.numericOdds;
  const f2Odds = firstOdds?.fighter2?.numericOdds;
  if (typeof f1Odds !== 'number' || typeof f2Odds !== 'number' || isNaN(f1Odds) || isNaN(f2Odds))
    return { skipped: true, reason: 'invalid_odds' };

  // Guard: odds too close (fav/dog ambiguous)
  const d1 = toDecimal(f1Odds), d2 = toDecimal(f2Odds);
  const imp1 = 1 / d1, imp2 = 1 / d2;
  const gapPct = Math.abs(imp1 - imp2) * 100;
  if (gapPct < cfg.minOddsGapPct)
    return { skipped: true, reason: `odds_too_close (gap=${gapPct.toFixed(1)}%)` };

  // Guard: bracket not targeted
  const bracket = classifyOddsBracket(f1Odds, f2Odds);
  if (!cfg.brackets.includes(bracket))
    return { skipped: true, reason: `bracket_not_targeted (${bracket})` };

  // Determine side — dog = higher decimal = more positive american
  const favFighter = d1 <= d2 ? fighter1 : fighter2;
  const favOdds    = d1 <= d2 ? f1Odds   : f2Odds;
  const dogFighter = d1 <= d2 ? fighter2 : fighter1;
  const dogOdds    = d1 <= d2 ? f2Odds   : f1Odds;
  const side             = cfg.side === 'dog' ? dogFighter : favFighter;
  const leg2Side         = cfg.side === 'dog' ? favFighter : dogFighter;
  const leg1OddsAmerican = cfg.side === 'dog' ? dogOdds    : favOdds;

  // Guard: already have open bet on this side (prevents double exposure)
  const existingBets = getAllBets(true);
  const alreadyCovered = existingBets.some(b =>
    b.selection && b.selection.toLowerCase().includes(side.toLowerCase().split(' ')[0])
  );
  if (alreadyCovered)
    return { skipped: true, reason: `existing_bet_on_${side}` };

  // All guards passed — queue the command
  const intent = {
    side,
    amount: cfg.amount,
    leg2Side,
    leg1OddsAmerican,
    fighter1,
    fighter2,
    trigger: cfg.autoHedge ? { type: 'crossover', targetOdds: null } : { type: null, targetOdds: null },
  };
  const cmd = makeCommand('place_bet', intent);
  commandQueue.push(cmd);
  saveCommandQueue();
  autoBetFiredFights.add(fightId);
  autoBetSessionCount++;
  saveFiredFights();

  const labels = { even: 'near-even', slight: 'slight fav', heavy: 'heavy fav', huge: 'dominant' };
  const bracketLabel = labels[bracket] || bracket;
  const oddsStr = `${fighter1} ${f1Odds > 0 ? '+' : ''}${f1Odds} / ${fighter2} ${f2Odds > 0 ? '+' : ''}${f2Odds}`;
  console.log(`[auto-bet] FIRED: $${cfg.amount} on ${side} (${bracketLabel}) [${fightId}] session=${autoBetSessionCount}/${cfg.maxPerSession}`);

  autoBetLogEvent({ type: 'fired', fightId, fighter1, fighter2, side, amount: cfg.amount, bracket, odds: oddsStr, cmdId: cmd.id });

  sendAlert(
    `🤖 AUTO-BET: $${cfg.amount} on ${side} — ${fighter1} vs ${fighter2}`,
    `Auto-first-bet triggered.\n\nFight: ${fighter1} vs ${fighter2}\nSide: ${side} (${cfg.side})\nAmount: $${cfg.amount}\nBracket: ${bracketLabel}\nOdds: ${oddsStr}\nAuto-hedge: ${cfg.autoHedge ? 'YES — will hedge at crossover' : 'no'}\n\nExtension will execute on DraftKings within 5 seconds.\n\nhttps://ufc-dashboard-production-e03d.up.railway.app`
  );

  return { fired: true, cmd, side, bracket, bracketLabel };
}

// ── Chat history — per-user rolling context for /api/assistant ─────────────────
const chatHistory = new Map(); // userId → [{role, content}]
const CHAT_HIST_MAX = 10;

function getChatHistory(userId) { return chatHistory.get(userId) || []; }
function addChatTurn(userId, role, content) {
  const hist = chatHistory.get(userId) || [];
  hist.push({ role, content: content.slice(0, 500) });
  if (hist.length > CHAT_HIST_MAX) hist.splice(0, hist.length - CHAT_HIST_MAX);
  chatHistory.set(userId, hist);
}

app.use(express.static('public'));
app.use(express.json());

// CORS — allow extension content scripts (running inside DK pages) to fetch command endpoints.
// Chrome MV3 content scripts are subject to CORS even with host_permissions declared; the server
// must respond with Access-Control-Allow-Origin so the response is readable by content.js.
// This does NOT expose any sensitive data — command endpoints contain only bet instructions
// that the authenticated user typed into the dashboard themselves.
app.use('/api/pending-commands', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/command-result', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/strategy-update', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/resolve-bet-target', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/auto-bet', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/assistant', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/watch-triggers', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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

function classifyOddsBracket(f1Odds, f2Odds) {
  const d1 = toDecimal(f1Odds), d2 = toDecimal(f2Odds);
  const favD = Math.min(d1, d2);
  if (favD <= 1.333) return 'huge';
  if (favD <= 1.5)   return 'heavy';
  if (favD <= 1.833) return 'slight';
  return 'even';
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
  // Use filename stem as canonical ID — it's unique per file and always includes the date.
  // d.fightId can have mma__ prefix or lack the date suffix (old files), so filename wins.
  const fileId = path.basename(filePath, '.json');
  return {
    fightId: fileId,
    date: fileId.match(/\d{4}-\d{2}-\d{2}/)?.[0] || path.basename(filePath).match(/\d{4}-\d{2}-\d{2}/)?.[0],
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

## YOUR TWO DATA SOURCES — understand the difference, it matters

### 1. OUR RECORDED DATA (the good stuff)
Live DraftKings odds captured every 3 seconds during actual UFC fights, Dec 2025 onward.
This is Ish's own recorded dataset — second-by-second odds movement, full crossover detection, win-win windows.
When Ish says "look at our data" or "what do we have" he means THIS.
You can answer precise questions: exact crossover count, what odds were when it crossed, whether win-win was achievable.
The local fight list is passed to you in every message as HISTORICAL FIGHT DATA.

### 2. PRE-FIGHT ODDS (limited, external)
Snapshot odds fetched from external sources for fights we didn't record live.
Only useful for: pre-fight lines, general context, opponent records.
Cannot answer: did a crossover happen, live odds movement, win-win windows.
When Ish asks about a fight not in our recorded data, this is all we have.

## COMMUNICATION RULES
- When answering from recorded data: just answer directly with the numbers
- When answering from pre-fight/external data only: say "we don't have live data from that fight" once, then give what you know
- When Ish says "our data" / "what we have" — he means the recorded fights. Be explicit: "In our data..." or "From the X fights we've recorded..."
- NEVER mention APIs, credits, endpoints, or technical infrastructure
- Be concise — numbers first, explanation after if needed

## CORE CONCEPTS

**Crossover**: During a live fight, a fighter's odds flip from underdog (+) to favorite (-). Momentum shifted — book adjusted.

**Win-Win Crossover**: The core opportunity:
- Bet 1: placed live when Fighter A is at plus money
- Crossover happens — Fighter A becomes favorite
- Bet 2: placed on Fighter B now at plus money
- Guaranteed profit condition: (D1-1)(D2-1) > 1

**Stake math**:
- Optimal Bet 2 per $100 Bet 1: sqrt((D1-1)/(D2-1)) × 100
- Safe range: S1/(D2-1) to S1×(D1-1)

**Dataset stats**: 262 fights. 110/262 (42%) had crossovers. 59 confirmed win-win moments.

## WHEN TO FETCH HISTORICAL DATA
If Ish asks about a fighter with no local data, silently emit (on its own line, nothing else):
LOOKUP_NEEDED: [fighter name] [approximate fight dates as YYYY-MM-DD]

List up to 3 dates. The system fetches and retries automatically. Never tell Ish this is happening.

## HOW TO ANSWER
- Short, direct, specific numbers
- Tables only when comparing multiple fights
- No explanations of your process or data sources`;

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

// Library page
app.get('/library', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'library.html')); });

// Patterns page
app.get('/patterns', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'patterns.html')); });

// Round-by-round pattern analysis across all recorded fights
app.get('/api/patterns', (req, res) => {
  try {
    const files = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json'));
    const rows = [];

    for (const file of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, file)));
        const h = d.oddsHistory || [];
        if (h.length < 20) continue;

        const open = h[0], close = h[h.length - 1], mid = h[Math.floor(h.length / 2)];
        const q1 = h[Math.floor(h.length * 0.25)], q3 = h[Math.floor(h.length * 0.75)];

        const d1o = toDecimal(open.fighter1.numericOdds), d2o = toDecimal(open.fighter2.numericOdds);
        const favIsF1 = d1o <= d2o;

        const getFav = pt => favIsF1 ? pt.fighter1.numericOdds : pt.fighter2.numericOdds;
        const getDog = pt => favIsF1 ? pt.fighter2.numericOdds : pt.fighter1.numericOdds;

        let crossovers = 0;
        for (let i = 1; i < h.length; i++) {
          const p = h[i-1], c = h[i];
          if ((p.fighter1.numericOdds > 0 && c.fighter1.numericOdds < 0) ||
              (p.fighter2.numericOdds > 0 && c.fighter2.numericOdds < 0)) crossovers++;
        }

        const openFavD = d1o <= d2o ? d1o : d2o;
        let bucket;
        if (openFavD <= 1.333)      bucket = 'huge';   // -300+ favorite
        else if (openFavD <= 1.5)   bucket = 'heavy';  // -200 to -300
        else if (openFavD <= 1.833) bucket = 'slight'; // -120 to -200
        else                         bucket = 'even';   // near-even

        rows.push({
          bucket, crossovers,
          openFav: getFav(open), openDog: getDog(open),
          q1Fav: getFav(q1), q1Dog: getDog(q1),
          midFav: getFav(mid), midDog: getDog(mid),
          q3Fav: getFav(q3), q3Dog: getDog(q3),
          closeFav: getFav(close), closeDog: getDog(close),
          duration: h.length,
        });
      } catch {}
    }

    const LABELS = {
      even:   'Near-Even (within -120)',
      slight: 'Slight Fav (-120 to -200)',
      heavy:  'Heavy Fav (-200 to -300)',
      huge:   'Dominant (-300+)',
    };
    const avg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;

    const result = {};
    for (const key of ['even','slight','heavy','huge']) {
      const g = rows.filter(r => r.bucket === key);
      if (!g.length) continue;
      result[key] = {
        label: LABELS[key],
        count: g.length,
        crossoverPct: Math.round(g.filter(r=>r.crossovers>0).length / g.length * 100),
        favDriftedByMid: Math.round(g.filter(r=>toDecimal(r.midFav)>toDecimal(r.openFav)).length/g.length*100),
        dogImprovedByMid: Math.round(g.filter(r=>toDecimal(r.midDog)<toDecimal(r.openDog)).length/g.length*100),
        avgOdds: {
          open:  { fav: avg(g.map(r=>r.openFav)),  dog: avg(g.map(r=>r.openDog))  },
          q1:    { fav: avg(g.map(r=>r.q1Fav)),    dog: avg(g.map(r=>r.q1Dog))    },
          mid:   { fav: avg(g.map(r=>r.midFav)),   dog: avg(g.map(r=>r.midDog))   },
          q3:    { fav: avg(g.map(r=>r.q3Fav)),    dog: avg(g.map(r=>r.q3Dog))    },
          close: { fav: avg(g.map(r=>r.closeFav)), dog: avg(g.map(r=>r.closeDog)) },
        },
      };
    }
    res.json({ totalFights: rows.length, buckets: result });
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

// All recordings across all sports (MMA index + sport subfolders)
app.get('/api/recordings', (req, res) => {
  try {
    const all = [];
    // MMA fights (root of historical_data)
    const mmaFiles = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json'));
    for (const f of mmaFiles) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, f)));
        const h = d.oddsHistory || [];
        all.push({
          id: f.replace('.json',''),  // always use filename stem — unique, includes date
          sport: 'UFC/MMA',
          fighter1: h[0]?.fighter1?.name || d.fightTitle?.split(' vs ')[0] || '?',
          fighter2: h[0]?.fighter2?.name || d.fightTitle?.split(' vs ')[1] || '?',
          date: f.match(/\d{4}-\d{2}-\d{2}/)?.[0] || (d.fightId||'').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
          dataPoints: d.dataPoints || h.length,
          crossovers: (() => { let c=0; for(let i=1;i<h.length;i++){ const p=h[i-1],n=h[i]; if((p.fighter1.numericOdds>0&&n.fighter1.numericOdds<0)||(p.fighter2.numericOdds>0&&n.fighter2.numericOdds<0)) c++; } return c; })(),
          startTime: d.startTime || '',
        });
      } catch {}
    }
    // Other sport subfolders
    const subdirs = fs.readdirSync(HISTORICAL_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'api_cache')
      .map(e => e.name);
    for (const sport of subdirs) {
      const sportDir = path.join(HISTORICAL_DIR, sport);
      const files = fs.readdirSync(sportDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(sportDir, f)));
          const h = d.oddsHistory || [];
          all.push({
            id: f.replace('.json',''),  // always use filename stem
            sport: d.sport || sport,
            fighter1: h[0]?.fighter1?.name || '?',
            fighter2: h[0]?.fighter2?.name || '?',
            date: f.match(/\d{4}-\d{2}-\d{2}/)?.[0] || (d.fightId||'').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
            dataPoints: d.dataPoints || h.length,
            crossovers: (() => { let c=0; for(let i=1;i<h.length;i++){ const p=h[i-1],n=h[i]; if((p.fighter1.numericOdds>0&&n.fighter1.numericOdds<0)||(p.fighter2.numericOdds>0&&n.fighter2.numericOdds<0)) c++; } return c; })(),
            startTime: d.startTime || '',
          });
        } catch {}
      }
    }
    // Normalize sport labels and strip bad entries before returning
    const normSport = s => {
      const u = (s||'').toUpperCase();
      if (u.includes('MMA') || u.includes('MARTIAL')) return 'UFC/MMA';
      if (u.includes('NHL')) return 'NHL';
      if (u.includes('NBA')) return 'NBA';
      if (u.includes('NFL')) return 'NFL';
      if (u.includes('MLB')) return 'MLB';
      return s;
    };
    const normId = id => id.replace(/^mma__?/, '');  // strip mma__ prefix from subdir files
    const clean = all
      .filter(r => r.fighter1 !== '?' && r.fighter2 !== '?')          // drop unknown fighters
      .filter(r => !r.fighter1.startsWith('Test ') && !r.fighter2.startsWith('Test ')) // drop test data
      .filter(r => r.dataPoints >= 5)                                  // drop thin files (no real fight data)
      .map(r => ({ ...r, id: normId(r.id), sport: normSport(r.sport) }));
    // Deduplicate by id (root files take priority over sport-subdir duplicates)
    const seen = new Set();
    const deduped = clean.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
    deduped.sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.startTime||'').localeCompare(a.startTime||''));
    res.json(deduped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full odds history for a specific fight (for graphing)
app.get('/api/fight-history/:fightId', (req, res) => {
  try {
    const id = req.params.fightId;

    const files = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json'));
    // 1. Exact filename match (canonical path — filename stem = fightId)
    let match = files.find(f => f.replace('.json', '') === id);
    // 2. Strip mma__/mma_ prefix (old recorder format) and retry exact match
    if (!match) {
      const stripped = id.replace(/^mma__?/, '');
      match = files.find(f => f.replace('.json', '') === stripped);
    }
    // 3. Prefix match — fightId without date, e.g. "fighter_vs_fighter" → "fighter_vs_fighter_2026-04-05.json"
    if (!match) {
      const bare = id.replace(/^mma__?/, '');
      match = files.find(f => f.startsWith(bare + '_') || f.startsWith(bare + '.') || f.startsWith(id + '_') || f.startsWith(id + '.'));
    }
    if (!match) return res.status(404).json({ error: 'Fight not found', id });
    res.json(JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, match))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fighter history lookup
app.get('/api/fighter/:name', (req, res) => {
  try { res.json(findFighterHistory(req.params.name, 5)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Backfill: load past odds for a game already in progress
app.get('/api/backfill', async (req, res) => {
  const { sport, team1, team2 } = req.query;
  if (!sport || !team1 || !team2) return res.status(400).json({ error: 'missing params' });
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n1 = norm(team1), n2 = norm(team2);

  // MMA: check local recorder files first (free, dense)
  if (sport === 'mma_mixed_martial_arts') {
    try {
      const files = fs.readdirSync(HISTORICAL_DIR);
      const match = files.find(f => {
        const base = f.replace('.json', '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        return base.startsWith(`${n1}_vs_${n2}`) || base.startsWith(`${n2}_vs_${n1}`);
      });
      if (match) {
        const data = JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, match)));
        return res.json({ source: 'local', points: data.oddsHistory || [] });
      }
    } catch {}
  }

  // Any sport: fetch historical API snapshots going back up to 60 min (4 calls = 40 credits)
  const points = [];
  const now = Date.now();
  for (const minsBack of [60, 45, 30, 15]) {
    try {
      const snapISO = new Date(now - minsBack * 60000).toISOString();
      const url = `${BASE_URL}/historical/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&date=${encodeURIComponent(snapISO)}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
      const { data: snap, headers } = await fetchJson(url);
      updateOddsCredits(headers);
      if (!Array.isArray(snap?.data)) continue;
      const match = snap.data.find(f => {
        const hn = norm(f.home_team), an = norm(f.away_team);
        return (hn.includes(n1.slice(0,6)) || n1.includes(hn.slice(0,6))) &&
               (an.includes(n2.slice(0,6)) || n2.includes(an.slice(0,6)));
      });
      if (match?.bookmakers?.length) {
        const outcomes = match.bookmakers[0].markets[0]?.outcomes || [];
        if (outcomes.length >= 2) {
          points.push({
            timestamp: snapISO,
            fighter1: { name: outcomes[0].name, odds: String(outcomes[0].price), numericOdds: outcomes[0].price },
            fighter2: { name: outcomes[1].name, odds: String(outcomes[1].price), numericOdds: outcomes[1].price },
          });
        }
      }
    } catch {}
  }
  res.json({ source: 'historical_api', points, credits: points.length * 10 });
});

// Active sports list
app.get('/api/sports', async (req, res) => {
  try {
    const url = `${BASE_URL}/sports/?apiKey=${ODDS_API_KEY}`;
    const { data, headers } = await fetchJson(url);
    updateOddsCredits(headers);
    const active = data.filter(s => s.active).sort((a, b) => a.group.localeCompare(b.group));
    res.json(active);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DraftKings extension sync ─────────────────────────────────────────────
const DK_CAPTURES_FILE = path.join(__dirname, 'historical_data', 'dk_captures.json');
let dkCaptures = [];
try { dkCaptures = JSON.parse(fs.readFileSync(DK_CAPTURES_FILE, 'utf8')); } catch (_) {}

function saveDKCaptures() {
  try { fs.writeFileSync(DK_CAPTURES_FILE, JSON.stringify(dkCaptures.slice(0, 200))); } catch (_) {}
}

app.post('/api/dk-sync', (req, res) => {
  const { url, data, ts, userId } = req.body;
  if (!url || !data) return res.status(400).json({ error: 'missing fields' });

  dkCaptures.unshift({ url, data, ts, userId });
  if (dkCaptures.length > 200) dkCaptures.length = 200;
  saveDKCaptures();

  const bets = parseDKBets(url, data, userId);
  dkHeartbeat.lastBetSync = Date.now(); // any WS activity = extension is alive on mybets
  if (bets.length) {
    console.log(`[DK sync] ${bets.length} bets from ${userId || 'unknown'} via ${url}`);
  }

  res.json({ received: true, url, bets });
});

app.get('/api/dk-captures', (req, res) => {
  res.json(dkCaptures);
});

app.delete('/api/dk-captures', (req, res) => {
  dkCaptures = [];
  saveDKCaptures();
  res.json({ ok: true });
});

const dkBetsByUser = new Map(); // userId → bets[]
const DEFAULT_USER = 'default';
const DK_BETS_FILE = path.join(__dirname, 'historical_data', 'dk_bets_by_user.json');

// Load persisted bets so server restarts don't lose all state
try {
  const saved = JSON.parse(fs.readFileSync(DK_BETS_FILE, 'utf8'));
  for (const [uid, bets] of Object.entries(saved)) dkBetsByUser.set(uid, bets);
  console.log(`Loaded dk bets for ${dkBetsByUser.size} users from disk`);
} catch (_) {}

function saveDKBets() {
  try {
    const obj = {};
    for (const [uid, bets] of dkBetsByUser) obj[uid] = bets;
    fs.writeFileSync(DK_BETS_FILE, JSON.stringify(obj));
  } catch (_) {}
}

function parseDKBets(url, data, userId) {
  const rawBets =
    data?.result?.initial?.bets ||
    data?.result?.update?.bets ||
    data?.bets || data?.Bets || data?.entries || data?.wagers ||
    (Array.isArray(data?.data) ? data.data : []);

  if (!Array.isArray(rawBets) || !rawBets.length) return [];

  const bets = rawBets.map(b => {
    const sel = b.selections?.[0] || {};
    const numLegs = b.selections?.length || 1;
    // Detect parlays: DK sends type/wagerType fields, or multiple selections, or explicit parlay flags
    const rawType = (b.betType || b.wagerType || b.type || '').toLowerCase();
    const isParlay = numLegs > 1
      || rawType.includes('parlay')
      || rawType.includes('round_robin')
      || rawType.includes('teaser')
      || !!b.parlayId
      || !!b.legId  // individual parlay leg sent separately
      || !!b.parentBetId;
    return {
      betId: b.receiptId || b.betId,
      userId: userId || DEFAULT_USER,
      status: b.settlementStatus || b.status,
      rawStatus: b.status,
      selection: sel.selectionDisplayName || '',
      market: sel.marketDisplayName || '',
      odds: (sel.displayOdds || b.displayOdds || '').replace('−', '-').replace('−', '-'),
      stake: b.stake,
      potentialReturns: b.potentialReturns,
      returns: b.returns,
      placementDate: b.placementDate,
      isParlay,
      numLegs,
    };
  });

  dkBetsByUser.set(userId || DEFAULT_USER, bets);
  saveDKBets();
  return bets;
}

// Merge all real users' bets — default bucket is NEVER served globally
function getAllBets(openOnly = true) {
  const byId = new Map();
  for (const [uid, bets] of dkBetsByUser) {
    if (uid === DEFAULT_USER) continue;
    for (const b of bets) {
      if (!byId.has(b.betId)) byId.set(b.betId, b);
    }
  }
  const all = Array.from(byId.values());
  return openOnly ? all.filter(b => b.status === 'Open') : all;
}

app.get('/api/dk-bets', (req, res) => {
  const all = req.query.all === '1';
  const userId = req.query.user; // optional filter by user
  if (userId) {
    const bets = dkBetsByUser.get(userId) || [];
    res.json(all ? bets : bets.filter(b => b.status === 'Open'));
  } else {
    res.json(getAllBets(!all));
  }
});

app.get('/api/bet-coverage', (req, res) => {
  const userId = req.query.user || DEFAULT_USER;
  const userBets = dkBetsByUser.get(userId) || [];
  const openBets = userBets.filter(b =>
    b.selection && !b.isParlay &&
    (!b.status || /open|unsettled|pending|live/i.test(b.status))
  );
  // Return lowercase selection names so dashboard can fuzzy-match against game outcome names
  const covered = [...new Set(openBets.map(b => b.selection.toLowerCase()))];
  res.json({
    userId,
    covered,
    bets: openBets.map(b => ({ selection: b.selection, stake: b.stake, odds: b.odds, status: b.status }))
  });
});

// Extension health tracking — logout tracked per-user so one user's heartbeat won't mask another's logout
let dkHeartbeat = { ts: null, lastBetSync: null, users: {}, loggedOutUsers: {} };

app.post('/api/dk-heartbeat', (req, res) => {
  const userId = req.body.userId;
  dkHeartbeat.ts = Date.now();
  dkHeartbeat.lastBetSync = dkHeartbeat.lastBetSync || Date.now();
  if (userId) {
    dkHeartbeat.users[userId] = Date.now();
    delete dkHeartbeat.loggedOutUsers[userId]; // this user is alive again
  }
  res.json({ ok: true });
});

app.post('/api/dk-logout', (req, res) => {
  const userId = req.body.userId;
  if (userId) {
    delete dkHeartbeat.users[userId];
    dkHeartbeat.loggedOutUsers[userId] = Date.now();
  }
  res.json({ ok: true });
});

app.get('/api/dk-status', (req, res) => {
  const now = Date.now();
  const activeUsers = Object.entries(dkHeartbeat.users)
    .filter(([, ts]) => now - ts < 300000)
    .map(([u]) => u);
  // Expose per-user logout state — clears after 10 min so stale flags don't linger
  const loggedOutUsers = Object.entries(dkHeartbeat.loggedOutUsers)
    .filter(([, ts]) => now - ts < 600000)
    .map(([u]) => u);
  res.json({
    heartbeat: dkHeartbeat.ts,
    loggedOut: loggedOutUsers.length > 0,
    loggedOutUsers,
    lastBetSync: dkHeartbeat.lastBetSync,
    activeUsers
  });
});

app.post('/api/dk-mock', (req, res) => {
  const { fighter, odds, stake, userId } = req.body;
  if (!fighter) return res.status(400).json({ error: 'fighter required' });
  const targetUser = userId || DEFAULT_USER;
  const mock = {
    betId: 'mock-' + Date.now(),
    userId: targetUser,
    status: 'Open',
    settlementStatus: 'Pending',
    selection: fighter,
    market: 'Live Moneyline',
    odds: odds || '+100',
    stake: stake || 100,
    potentialReturns: null,
    returns: null,
    placementDate: new Date().toISOString(),
    isParlay: false,
  };
  const existing = dkBetsByUser.get(targetUser) || [];
  dkBetsByUser.set(targetUser, [...existing, mock]);
  saveDKBets();
  res.json({ ok: true, bet: mock });
});

// Aggregated soccer — fetches all active soccer leagues and combines
app.get('/api/soccer', async (req, res) => {
  try {
    const { data: sports, headers: sh } = await fetchJson(`${BASE_URL}/sports/?apiKey=${ODDS_API_KEY}`);
    updateOddsCredits(sh);
    const soccerKeys = sports.filter(s => s.active && s.key.startsWith('soccer_')).map(s => s.key);
    const results = await Promise.all(soccerKeys.map(async key => {
      try {
        const url = `${BASE_URL}/sports/${key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
        const { data, headers } = await fetchJson(url);
        updateOddsCredits(headers);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    }));
    res.json(results.flat());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aggregated tennis — same pattern as soccer
app.get('/api/tennis', async (req, res) => {
  try {
    const { data: sports, headers: sh } = await fetchJson(`${BASE_URL}/sports/?apiKey=${ODDS_API_KEY}`);
    updateOddsCredits(sh);
    const keys = sports.filter(s => s.active && s.key.startsWith('tennis_')).map(s => s.key);
    const results = await Promise.all(keys.map(async key => {
      try {
        const url = `${BASE_URL}/sports/${key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
        const { data, headers } = await fetchJson(url);
        updateOddsCredits(headers);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    }));
    res.json(results.flat());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live check — returns which sport keys have at least one live event (commenced but odds still listed)
// Cached 8 min to avoid burning API credits on every poll
const _liveCheckCache = { ts: 0, data: {} };
app.get('/api/live-check', async (req, res) => {
  const age = Date.now() - _liveCheckCache.ts;
  if (age < 480000) return res.json(_liveCheckCache.data);
  const keys = (req.query.keys || '').split(',').filter(Boolean);
  if (!keys.length) return res.json({});
  const now = Date.now();
  const result = {};
  await Promise.all(keys.map(async key => {
    try {
      const endpoint = key === 'tennis' ? `${BASE_URL}/sports/?apiKey=${ODDS_API_KEY}` : null;
      if (key === 'tennis' || key === 'soccer') {
        // aggregated — just check if any game started
        const prefix = key === 'soccer' ? 'soccer_' : 'tennis_';
        const { data: sports } = await fetchJson(`${BASE_URL}/sports/?apiKey=${ODDS_API_KEY}`);
        const subKeys = sports.filter(s => s.active && s.key.startsWith(prefix)).map(s => s.key);
        for (const sk of subKeys) {
          const url = `${BASE_URL}/sports/${sk}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
          const { data } = await fetchJson(url);
          if (Array.isArray(data) && data.some(e => new Date(e.commence_time).getTime() < now && e.bookmakers?.length)) {
            result[key] = true; return;
          }
        }
        result[key] = false;
      } else {
        const url = `${BASE_URL}/sports/${key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
        const { data, headers } = await fetchJson(url);
        updateOddsCredits(headers);
        result[key] = Array.isArray(data) && data.some(e => new Date(e.commence_time).getTime() < now && e.bookmakers?.length);
      }
    } catch { result[key] = false; }
  }));
  _liveCheckCache.ts = Date.now();
  _liveCheckCache.data = result;
  res.json(result);
});

// Live odds for any sport key
// ── Live Score via ESPN public API ────────────────────────────────────────
// ── Live score lookup via ESPN public API ──────────────────────────────────────
// Shared by /api/live-score and the score_tie trigger poll loop.
function espnEndpoints(sport) {
  const s = (sport || '').toLowerCase();
  if (s.includes('soccer') || (s.includes('football') && !s.includes('nfl'))) return [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.nations.league/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.euro/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
  ];
  if (s.includes('mma') || s.includes('ufc') || s.includes('fight'))
    return ['https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard'];
  if (s.includes('nfl') || (s.includes('football') && s.includes('nfl')))
    return ['https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'];
  if (s.includes('nba') || s.includes('basketball'))
    return ['https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'];
  if (s.includes('nhl') || s.includes('hockey'))
    return ['https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'];
  // Default: soccer + UFC
  return [
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
  ];
}

const scoreNorm  = str => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const scoreFuzzy = (a, b) => { const na = scoreNorm(a), nb = scoreNorm(b); return na.includes(nb) || nb.includes(na); };

async function fetchLiveScore(team1, team2, sport) {
  for (const url of espnEndpoints(sport)) {
    try {
      const { data } = await fetchJson(url);
      for (const event of (data.events || [])) {
        const comp  = event.competitions?.[0];
        if (!comp) continue;
        const comps = comp.competitors || [];
        if (comps.length < 2) continue;
        const names = comps.map(c => c.team?.displayName || c.team?.name || '');
        if (!names.some(n => scoreFuzzy(n, team1))) continue;
        if (!names.some(n => scoreFuzzy(n, team2))) continue;
        const c1 = scoreFuzzy(comps[0].team?.displayName || '', team1) ? comps[0] : comps[1];
        const c2 = c1 === comps[0] ? comps[1] : comps[0];
        const st = comp.status;
        return {
          score1:    c1.score ?? '0',
          score2:    c2.score ?? '0',
          period:    st?.type?.shortDetail || st?.type?.description || '',
          clock:     st?.displayClock || '',
          completed: st?.type?.completed || false,
        };
      }
    } catch (_) { /* try next endpoint */ }
  }
  return null;
}

app.get('/api/live-score', async (req, res) => {
  const { sport, team1, team2 } = req.query;
  if (!team1 || !team2) return res.json(null);
  res.json(await fetchLiveScore(team1, team2, sport));
});

// ── Score-tie trigger polling — server-side, every 5s ─────────────────────────
// For each active score_tie trigger, poll ESPN. When scores are equal and both
// teams have scored (avoids 0-0 game-start false fire), queue the bet command.
// The trigger is removed after firing (one-shot).
setInterval(async () => {
  const tieTriggers = watchTriggers.filter(t =>
    t.condition?.type === 'score_tie' && t.expiresAt > Date.now()
  );
  if (!tieTriggers.length) return;

  for (const trigger of tieTriggers) {
    try {
      const { team1, team2, sport } = trigger.condition;
      const score = await fetchLiveScore(team1, team2, sport || 'soccer');
      if (!score) continue;

      const s1 = parseInt(score.score1, 10);
      const s2 = parseInt(score.score2, 10);
      if (isNaN(s1) || isNaN(s2)) continue;
      if (s1 !== s2) continue;         // not tied
      if (s1 + s2 === 0) continue;    // 0-0 at game start — not a real tie yet

      // Score is tied (and at least one team has scored) — fire
      const scoreStr = `${s1}-${s2}`;
      console.log(`[score_tie] FIRED: ${team1} ${scoreStr} ${team2} → $${trigger.amount} on ${trigger.side} [${score.period || '?'}']`);
      const cmd = makeCommand('place_bet', { side: trigger.side, amount: trigger.amount, trigger: null });
      commandQueue.push(cmd);
      saveCommandQueue();
      watchTriggers = watchTriggers.filter(t => t.id !== trigger.id); // one-shot
      sendAlert(
        `⚽ SCORE TIE TRIGGER FIRED: ${team1} ${scoreStr} ${team2}`,
        `Score became tied at ${scoreStr} (${score.period || 'unknown period'}).\nPlacing $${trigger.amount} on ${trigger.side} to win.\n\nExtension will execute within 5 seconds.`
      );
    } catch (_) { /* ignore per-trigger errors */ }
  }
}, 5000);

app.get('/api/sport/:key', async (req, res) => {
  try {
    const url = `${BASE_URL}/sports/${req.params.key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    const { data, headers } = await fetchJson(url);
    updateOddsCredits(headers);
    res.json(Array.isArray(data) ? data : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fetch historical odds from The Odds API for a specific past date (costs 10 credits each)
async function fetchHistoricalOdds(dateISO) {
  // Check disk cache first — free, no API credits
  const cacheFile = path.join(API_CACHE_DIR, `${dateISO}.json`);
  if (fs.existsSync(cacheFile)) {
    console.log(`Historical cache hit: ${dateISO}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  const url = `${BASE_URL}/historical/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&date=${dateISO}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
  const { data, headers } = await fetchJson(url);
  updateOddsCredits(headers);
  console.log(`Historical API (10 credits) — used: ${_oddsApiCreditsUsed} | remaining: ${_oddsApiCreditsRemaining}`);
  if (!Array.isArray(data?.data)) return [];
  const results = data.data.filter(f => f.bookmakers?.length > 0).map(f => {
    const outcomes = f.bookmakers[0].markets[0]?.outcomes || [];
    return {
      fight: `${f.home_team} vs ${f.away_team}`,
      date: f.commence_time.slice(0, 10),
      odds: outcomes.reduce((acc, o) => { acc[o.name] = o.price; return acc; }, {}),
      source: 'historical_api',
    };
  });
  // Save to disk so we never pay for this date again
  if (results.length > 0) fs.writeFileSync(cacheFile, JSON.stringify(results, null, 2));
  return results;
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
    // ── Bet command detection — intercept before research flow ────────────────
    // Keywords that strongly suggest a bet command rather than a research question
    const looksLikeBet = /\b(bet|wager|place|hedge\s+me|hedge\s+out|put\s+\$?\d+|cancel\s+(the\s+)?(bet|hedge|strategy)|stop\s+the\s+(bet|hedge))\b/i.test(question);
    if (looksLikeBet) {
      let intent = { intent: 'unknown' };
      try {
        const r = await anthropic.messages.create({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 256,
          system:     CHAT_SYSTEM(null),
          messages:   [{ role: 'user', content: question.slice(0, 500) }],
        });
        intent = parseChatResponse(r.content[0]?.text?.trim() || '');
      } catch {}

      if (intent.intent === 'place_first_bet' && intent.side && intent.amount) {
        const cmd = makeCommand('place_bet', intent);
        commandQueue.push(cmd);
        saveCommandQueue();
        const triggerStr = intent.trigger?.type === 'crossover'
          ? ' — **auto-hedging at crossover** 🔄'
          : intent.trigger?.type === 'odds_target'
          ? ` — auto-hedge when line hits **${intent.trigger.targetOdds}**`
          : '';
        return res.json({
          answer: `**Bet queued** ✅\n\nPlacing **$${intent.amount}** on **${intent.side}**${triggerStr}.\n\nYour extension will execute this on DraftKings now — I'll update you here when it's confirmed.`,
          betCommand: cmd,
          usage: { thisQuery: 0, sessionTotal: totalTokensUsed, sessionQueries: totalQueries, estimatedCostUSD: 0 },
        });
      }

      if (intent.intent === 'cancel') {
        const cmd = makeCommand('cancel', intent);
        commandQueue.push(cmd);
        saveCommandQueue();
        return res.json({
          answer: `**Cancelling strategy** 🛑\n\nStop signal sent to your extension — the watching will stop and no hedge will fire.`,
          betCommand: cmd,
          usage: { thisQuery: 0, sessionTotal: totalTokensUsed, sessionQueries: totalQueries, estimatedCostUSD: 0 },
        });
      }
      // intent was query/unknown — fall through to normal research
    }

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

      // Always run pass 2 — with enriched data if found, or empty so Claude answers from knowledge
      const pass2 = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: buildMessages(extraData.length > 0 ? extraData : null),
      });
      finalAnswer = pass2.content[0].text;
      used += pass2.usage.input_tokens + pass2.usage.output_tokens;
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

// Health check — Railway restarts service if this returns non-200
app.get('/health', (req, res) => {
  const lastPoll = recorderState.lastPoll ? new Date(recorderState.lastPoll) : null;
  const staleSec = lastPoll ? Math.floor((Date.now() - lastPoll) / 1000) : null;
  const stale = staleSec === null || staleSec > 600; // >10 min = unhealthy
  if (stale) return res.status(503).json({ status: 'unhealthy', staleSec, lastPoll: recorderState.lastPoll });
  res.json({ status: 'ok', staleSec, recording: recorderState.activeFights.size > 0, lastPoll: recorderState.lastPoll });
});

app.get('/api/recorder/status', (req, res) => {
  const active = [...recorderState.activeFights.entries()].map(([id, r]) => ({
    id,
    sport: r.meta.label,
    fighter1: r.meta.fighter1,
    fighter2: r.meta.fighter2,
    startTime: r.meta.startTime,
    dataPoints: r.oddsHistory.length,
    lastOdds: r.lastOdds,
  }));
  res.json({
    recording: active.length > 0,
    activeFights: active,
    totalSaved: recorderState.totalSaved,
    lastPoll: recorderState.lastPoll,
    watching: ['UFC/MMA (always)', ...(() => { const w=clientWatching; if(!w||Date.now()-w.ts>=120000) return []; return [w.team1?`${w.team1} vs ${w.team2}`:SPORT_META[w.sport]?.label||w.sport]; })()],
  });
});

// Verify backup config — call this to confirm GitHub + volume are wired up
app.get('/api/recorder/backup-status', (req, res) => {
  res.json({
    githubToken:  !!process.env.GITHUB_TOKEN,
    dataDir:      process.env.DATA_DIR || null,
    volumeActive: !!(process.env.DATA_DIR && process.env.DATA_DIR !== __dirname),
    historicalDir: HISTORICAL_DIR,
    ok: !!(process.env.GITHUB_TOKEN && process.env.DATA_DIR),
  });
});

// Stop a specific active recording (save what we have and remove it)
app.post('/api/recorder/stop/:id', (req, res) => {
  const id = req.params.id;
  if (!recorderState.activeFights.has(id)) return res.status(404).json({ error: 'not found' });
  recSave(id);
  recorderState.activeFights.delete(id);
  res.json({ ok: true, stopped: id });
});

// Stop ALL active non-UFC recordings
app.post('/api/recorder/stop-all', (req, res) => {
  const stopped = [];
  for (const [id, record] of recorderState.activeFights) {
    if (record.meta.sport !== 'mma_mixed_martial_arts') {
      recSave(id);
      recorderState.activeFights.delete(id);
      stopped.push(id);
    }
  }
  res.json({ ok: true, stopped });
});

// Test endpoint — simulates a full UFC fight recording cycle to verify pipeline
app.post('/api/recorder/test', async (req, res) => {
  const testId = `mma__testfighter_vs_testopponent_${new Date().toISOString().slice(0,10)}`;
  const f1 = 'Test Fighter A', f2 = 'Test Fighter B';

  // 1. Inject a fake fight into the recorder
  recorderState.activeFights.set(testId, {
    meta: { sport: 'mma_mixed_martial_arts', label: 'UFC/MMA (TEST)', fighter1: f1, fighter2: f2, startTime: new Date().toISOString() },
    oddsHistory: [
      { timestamp: new Date().toISOString(), fighter1: { name: f1, numericOdds: 200 }, fighter2: { name: f2, numericOdds: -250 } },
      { timestamp: new Date().toISOString(), fighter1: { name: f1, numericOdds: 150 }, fighter2: { name: f2, numericOdds: -180 } },
      { timestamp: new Date().toISOString(), fighter1: { name: f1, numericOdds: -110 }, fighter2: { name: f2, numericOdds: -110 } },
    ],
    lastOdds: { timestamp: new Date().toISOString(), fighter1: { name: f1, numericOdds: -110 }, fighter2: { name: f2, numericOdds: -110 } },
  });

  // 2. Fire the "fight started" email
  await sendAlert(
    `🔴 BET BOT TEST: Recording ${f1} vs ${f2} [UFC/MMA]`,
    `TEST — this is what a real fight-start alert looks like.\n\n${f1} vs ${f2}\nStarted: ${new Date().toLocaleString()}\n3 data points captured (test)\n\nhttps://ufc-dashboard-production-e03d.up.railway.app\n\nIf you got this email, fight-start alerts are working.`
  );

  // 3. After 10s, "end" the fight — fires the save + completion email, then delete the test file
  setTimeout(() => {
    recSave(testId);
    recorderState.activeFights.delete(testId);
    // Delete the saved file so test data doesn't pollute the recordings library
    const testFile = path.join(HISTORICAL_DIR, `${testId}.json`);
    try { fs.unlinkSync(testFile); } catch (_) {}
  }, 10000);

  res.json({
    ok: true,
    message: 'Test fight injected. Dashboard recording indicator should be active now. Fight will "end" in 10 seconds and save to disk. Check email for alerts.',
    testId,
    emailConfigured: !!mailer,
  });
});

// ── Recorder ────────────────────────────────────────────────────────────────
// UFC: always-on at 3s — events are rare (~20 hrs/mo) so very cheap
// Other sports: client-driven — browser sends heartbeat while watching, stops when tab closes

const UFC_POLL_MS      = 3000;
const OTHER_POLL_MS    = 5000;    // 5s while browser is open watching
const PREWARM_MS       = 15000;   // 15s when a fight starts within 10 min
const PREWARM_SLOW_MS  = 60000;   // 60s when a fight starts within 60 min
const IDLE_POLL_MS     = 300000;  // 5 min when nothing is coming soon

const SPORT_META = {
  'mma_mixed_martial_arts': { label: 'UFC/MMA',    window: 3 * 60 * 60 * 1000 },
  'soccer_fifa_world_cup':  { label: 'World Cup',  window: 130 * 60 * 1000 },
  'icehockey_nhl':          { label: 'NHL',        window: 4 * 60 * 60 * 1000 },
  'basketball_nba':         { label: 'NBA',        window: 3 * 60 * 60 * 1000 },
  'americanfootball_nfl':   { label: 'NFL',        window: 4 * 60 * 60 * 1000 },
  'baseball_mlb':           { label: 'MLB',        window: 4 * 60 * 60 * 1000 },
};

// Sports that are always polled (regardless of what the client browser is watching)
const ALWAYS_POLL = ['mma_mixed_martial_arts', 'soccer_fifa_world_cup'];

// Client heartbeat — single slot, last watched game wins
// If no ping for 2 min, recording stops
let clientWatching = null; // { ts, sport, team1, team2 }
app.post('/api/recorder/watch', (req, res) => {
  const { sport, team1, team2 } = req.body;
  if (sport && sport !== 'mma_mixed_martial_arts' && sport !== 'soccer') {
    const changed = clientWatching && (clientWatching.team1 !== team1 || clientWatching.team2 !== team2);
    clientWatching = { ts: Date.now(), sport, team1, team2 };
    // If user switched to a different game, drop recordings from the old game
    if (changed) {
      for (const [id, record] of recorderState.activeFights) {
        if (record.meta.sport !== 'mma_mixed_martial_arts') {
          recorderState.activeFights.delete(id);
          console.log(`[Recorder] cleared stale recording: ${id} (user switched games)`);
        }
      }
    }
  }
  res.json({ ok: true });
});

const {
  recFightId, recFilePath, recIsLive, recExtractOdds,
  recSaveRecord, pushFightToGitHub, autoEnrich,
  loadPersistedState, persistState,
  migrateToVolume, HISTORICAL_DIR: REC_HISTORICAL_DIR,
} = require('./record_engine');

// Use the volume-aware path from record_engine everywhere in this file
HISTORICAL_DIR = REC_HISTORICAL_DIR;
API_CACHE_DIR  = path.join(REC_HISTORICAL_DIR, 'api_cache');
if (!fs.existsSync(API_CACHE_DIR)) fs.mkdirSync(API_CACHE_DIR, { recursive: true });

// One-time volume migration (no-op if DATA_DIR not set)
migrateToVolume();

const recorderState = {
  activeFights:    loadPersistedState(), // reloads in-flight fights after crash/restart
  totalSaved:      0,
  lastPoll:        null,
  failCounts:      {},   // sportKey → consecutive API failure count
  sessionFights:   [],   // fights saved this event night (for summary email)
  summaryTimer:    null, // fires end-of-event summary email after quiet period
};

// Threshold before emailing about repeated API failures
const FAIL_ALERT_THRESHOLD = 5;
// How long after last fight disappears before we send the summary (15 min)
const SUMMARY_DELAY_MS = 15 * 60 * 1000;

function scheduleSummaryEmail() {
  if (recorderState.summaryTimer) clearTimeout(recorderState.summaryTimer);
  recorderState.summaryTimer = setTimeout(() => {
    const fights = recorderState.sessionFights;
    if (!fights.length) return;
    const mmaFights = fights.filter(f => f.sport === 'mma_mixed_martial_arts');
    const lines = fights.map(f =>
      `  • ${f.fighter1} vs ${f.fighter2} — ${f.dataPoints} data points · ${f.durationMin} min recorded`
    ).join('\n');
    sendAlert(
      `📋 BET BOT: Event complete — ${mmaFights.length} MMA fight${mmaFights.length !== 1 ? 's' : ''} recorded`,
      `Tonight's recording session is complete.\n\n` +
      `${fights.length} fight${fights.length !== 1 ? 's' : ''} captured:\n${lines}\n\n` +
      `MMA fights enriched automatically (winner/method added).\n` +
      `Library now has the new data — brain is updated.\n\n` +
      `https://ufc-dashboard-production-e03d.up.railway.app`
    );
    recorderState.sessionFights = [];
    recorderState.summaryTimer  = null;
  }, SUMMARY_DELAY_MS);
}

function recSave(id) {
  const record = recorderState.activeFights.get(id);
  const result = recSaveRecord(id, record);

  if (!result.saved) {
    const label = record?.meta?.label || id;
    console.error(`[recorder] SAVE FAILED for ${id}: ${result.reason}`);
    sendAlert(
      `🚨 BET BOT: SAVE FAILED — ${record?.meta?.fighter1 || id} vs ${record?.meta?.fighter2 || '?'}`,
      `Recording could NOT be saved to disk.\n\nFight: ${id}\nReason: ${result.reason}\n\nData is still in memory — restart may lose it.\n\nhttps://ufc-dashboard-production-e03d.up.railway.app`
    );
    return;
  }

  recorderState.totalSaved++;
  const startTs  = record.meta.startTime ? new Date(record.meta.startTime).getTime() : null;
  const durationMin = startTs ? Math.round((Date.now() - startTs) / 60000) : null;
  console.log(`[recorder] Saved: ${id} (${result.dataPoints} pts, ${durationMin}min) → ${result.filePath}`);

  // Track for end-of-event summary
  recorderState.sessionFights.push({
    sport:      record.meta.sport,
    fighter1:   record.meta.fighter1,
    fighter2:   record.meta.fighter2,
    dataPoints: result.dataPoints,
    durationMin: durationMin ?? '?',
    filePath:   result.filePath,
  });

  // Back up to GitHub immediately (fire-and-forget)
  pushFightToGitHub(result.filePath);

  // Invalidate index for all sports so the library reflects the new file
  invalidateIndex();

  // MMA only: auto-enrich with winner/method from ESPN/UFC Stats
  if (record.meta.sport === 'mma_mixed_martial_arts') {
    const filename = path.basename(result.filePath);
    autoEnrich(filename, (err, out) => {
      if (err) {
        console.error(`[enricher] Failed for ${filename}:`, err.message);
        sendAlert(
          `🚨 BET BOT: Enrichment failed — ${filename}`,
          `Fight was saved (${result.dataPoints} pts) but auto-enrichment failed.\nRun manually: node enricher.js --file ${filename}\n\nError: ${err.message}\n\nhttps://ufc-dashboard-production-e03d.up.railway.app`
        );
      } else {
        console.log(`[enricher] ${filename}: ${out.stdout || 'done'}`);
        invalidateIndex();
      }
    });
  }

  // Schedule end-of-event summary (resets timer if more fights are still coming)
  scheduleSummaryEmail();
}

async function recPollSport(sportKey, meta, watchedGame) {
  try {
    const url = `${BASE_URL}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    const { data, headers } = await fetchJson(url);
    updateOddsCredits(headers);
    const fights = Array.isArray(data) ? data : [];
    const currentIds = new Set();

    for (const fight of fights) {
      if (!recIsLive(fight, meta.window)) continue;
      // Only record the specific game the user is watching
      if (watchedGame?.team1 && watchedGame?.team2) {
        const { team1, team2 } = watchedGame;
        const teams = [fight.home_team, fight.away_team];
        if (!teams.includes(team1) || !teams.includes(team2)) continue;
      }
      const odds = recExtractOdds(fight);
      if (!odds) continue;
      const id = recFightId(sportKey, fight);
      currentIds.add(id);

      if (!recorderState.activeFights.has(id)) {
        console.log(`REC START [${meta.label}] ${fight.home_team} vs ${fight.away_team}`);
        recorderState.activeFights.set(id, {
          meta: { sport: sportKey, label: meta.label, fighter1: fight.home_team, fighter2: fight.away_team, startTime: new Date().toISOString() },
          oddsHistory: [],
          lastOdds: null,
        });
        persistState(recorderState.activeFights);
        // Cancel any pending summary — more fights are still happening
        if (recorderState.summaryTimer) { clearTimeout(recorderState.summaryTimer); recorderState.summaryTimer = null; }
        sendAlert(
          `🔴 BET BOT: Recording ${fight.home_team} vs ${fight.away_team} [${meta.label}]`,
          `Live game detected.\n\n${fight.home_team} vs ${fight.away_team}\n${meta.label} · Started: ${new Date().toLocaleString()}\n\nhttps://ufc-dashboard-production-e03d.up.railway.app`
        );

        // Auto-bet check — fires when opening odds profile matches config
        const abResult = checkAutoBet(id, fight.home_team, fight.away_team, odds, fight.commence_time);
        if (abResult.fired) {
          console.log(`[auto-bet] Queued cmd ${abResult.cmd.id} — $${autoBetConfig.amount} on ${abResult.side} (${abResult.bracketLabel})`);
          autoBetLogEvent({ type: 'fired', fightId: id, fighter1: fight.home_team, fighter2: fight.away_team, side: abResult.side, bracket: abResult.bracket });
        } else if (abResult.reason !== 'disabled') {
          console.log(`[auto-bet] Skipped ${id}: ${abResult.reason}`);
          autoBetLogEvent({ type: 'skipped', fightId: id, fighter1: fight.home_team, fighter2: fight.away_team, reason: abResult.reason });
        }
      }

      const record = recorderState.activeFights.get(id);
      const last = record.lastOdds;
      if (!last || last.fighter1.numericOdds !== odds.fighter1.numericOdds || last.fighter2.numericOdds !== odds.fighter2.numericOdds) {
        record.oddsHistory.push(odds);
        record.lastOdds = odds;
        persistState(recorderState.activeFights); // persist every new odds point

        // Live crossover detection — update state after every new odds point
        if (record.oddsHistory.length >= 2) {
          const prevState = record.crossoverState;
          record.crossoverState = analyzeCrossoverTrajectory(record.oddsHistory);

          // Track first crossover per fight (used in summary, no email — UI shows it live)
          const state = record.crossoverState;
          if (state && state.status === 'crossed' && !record.crossoverAlerted) {
            record.crossoverAlerted = true;
          }
        }
      }
    }

    for (const [id, record] of recorderState.activeFights) {
      if (record.meta.sport === sportKey && !currentIds.has(id)) {
        recSave(id);
        recorderState.activeFights.delete(id);
        persistState(recorderState.activeFights);
      }
    }

    recorderState.failCounts[sportKey] = 0; // reset on success

    // Find the soonest upcoming (not yet live) fight so recPoll can pre-warm
    const now = Date.now();
    let soonestMs = null;
    for (const fight of fights) {
      const start = new Date(fight.commence_time).getTime();
      if (start > now) {
        const msUntil = start - now;
        if (soonestMs === null || msUntil < soonestMs) soonestMs = msUntil;
      }
    }
    return { live: currentIds.size, soonestMs };
  } catch (e) {
    const fails = (recorderState.failCounts[sportKey] || 0) + 1;
    recorderState.failCounts[sportKey] = fails;
    console.error(`[recorder] [${meta.label}] error #${fails}:`, e.message);
    if (fails === FAIL_ALERT_THRESHOLD) {
      sendAlert(
        `🚨 BET BOT: Recorder failing — ${meta.label}`,
        `Odds API has failed ${fails} times in a row for ${meta.label}.\n\nLast error: ${e.message}\n\nRecording may be missing fight data. Check Railway logs.\n\nhttps://ufc-dashboard-production-e03d.up.railway.app`
      );
    }
    return { live: 0, soonestMs: null };
  }
}

async function recPoll() {
  recorderState.lastPoll = new Date().toISOString();

  // Always poll UFC + World Cup (and any other ALWAYS_POLL sports)
  let alwaysLive = 0;
  let soonestMs = null; // ms until next upcoming fight across all polled sports
  for (const key of ALWAYS_POLL) {
    const r = await recPollSport(key, SPORT_META[key]);
    alwaysLive += r.live;
    if (r.soonestMs !== null && (soonestMs === null || r.soonestMs < soonestMs)) soonestMs = r.soonestMs;
  }

  // Also poll the one sport the browser is watching (if heartbeat < 2 min old)
  const now = Date.now();
  const watching = clientWatching && (now - clientWatching.ts < 120000) ? clientWatching : null;
  let otherLive = 0;
  if (watching && !ALWAYS_POLL.includes(watching.sport)) {
    const r = await recPollSport(watching.sport, SPORT_META[watching.sport] || { label: watching.sport, window: 4*60*60*1000 }, watching);
    otherLive = r.live;
    if (r.soonestMs !== null && (soonestMs === null || r.soonestMs < soonestMs)) soonestMs = r.soonestMs;
  }
  const totalLive = alwaysLive + otherLive;

  // Smart delay: pre-warm before scheduled fights so we never miss the first punch
  const ufcLive = recorderState.activeFights.size > 0 &&
    [...recorderState.activeFights.values()].some(r => r.meta.sport === 'mma_mixed_martial_arts');
  const delay = ufcLive          ? UFC_POLL_MS                                    // live UFC: 3s
    : totalLive > 0              ? OTHER_POLL_MS                                  // other live: 5s
    : soonestMs !== null && soonestMs < 10 * 60 * 1000  ? PREWARM_MS             // < 10 min: 15s
    : soonestMs !== null && soonestMs < 60 * 60 * 1000  ? PREWARM_SLOW_MS        // < 60 min: 60s
    : IDLE_POLL_MS;                                                               // nothing soon: 5 min
  if (soonestMs !== null && soonestMs < 60 * 60 * 1000) {
    console.log(`[recorder] Next fight in ${Math.round(soonestMs / 60000)}min — polling every ${delay / 1000}s`);
  }
  setTimeout(recPoll, delay);
}

// ── Live crossover detection ──────────────────────────────────────────────────
const { analyzeCrossoverTrajectory, crossoverAlertText } = require('./crossover_detector');

app.get('/api/live-crossovers', (req, res) => {
  const results = [];
  for (const [id, record] of recorderState.activeFights) {
    if (!record.crossoverState) continue;
    const { fighter1, fighter2 } = record.meta;
    results.push({
      id,
      fighter1,
      fighter2,
      sport: record.meta.sport,
      crossoverState: record.crossoverState,
      alertText: crossoverAlertText(record.crossoverState, fighter1, fighter2),
    });
  }
  res.json(results);
});

// ── Brain: edge detection endpoint (isolated — see analyzer.js) ──────────────
const { findEdge } = require('./analyzer');
const { findLiveSequence, loadFightsWithHistory } = require('./live_sequence');

app.get('/api/edge', async (req, res) => {
  try {
    const { fighter1, fighter2, f1Odds, f2Odds, f1Open, f2Open, crossover, crossoverMin } = req.query;
    if (!fighter1 || !fighter2) return res.status(400).json({ error: 'fighter1 and fighter2 required' });
    const result = await findEdge({
      fighter1,
      fighter2,
      f1CurrentOdds:   f1Odds  || null,
      f2CurrentOdds:   f2Odds  || null,
      f1OpeningOdds:   f1Open  || null,
      f2OpeningOdds:   f2Open  || null,
      crossoverOccurred: crossover === 'true',
      crossoverMinute: crossoverMin ? parseInt(crossoverMin) : null
    });
    res.json(result);
  } catch (e) {
    console.error('[edge]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live-sequence', (req, res) => {
  try {
    const { fighter1, fighter2, f1Odds, f2Odds, f1Open, f2Open } = req.query;
    if (!f1Open || !f1Odds) return res.json({ verdict: 'no_signal', advice: 'Opening odds not yet established.' });
    const fights = loadFightsWithHistory();
    const result = findLiveSequence({
      fighter1: fighter1 || '',
      fighter2: fighter2 || '',
      f1CurrentOdds: parseFloat(f1Odds),
      f2CurrentOdds: parseFloat(f2Odds),
      f1OpeningOdds: parseFloat(f1Open),
      f2OpeningOdds: parseFloat(f2Open),
    }, fights);
    res.json(result || { verdict: 'no_signal', advice: 'Not enough movement yet for a sequence signal.' });
  } catch (e) {
    console.error('[live-sequence]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Daily heartbeat email ─────────────────────────────────────────────────────
// Sends a "still alive" email every morning at 8am ET.
// If you don't get it, the server is down.
function scheduleHeartbeat() {
  function msUntilNext8amET() {
    const now = new Date();
    // ET = UTC-4 (EDT) or UTC-5 (EST) — use UTC-4 as conservative choice
    const ET_OFFSET_MS = 4 * 60 * 60 * 1000;
    const nowET = new Date(now.getTime() - ET_OFFSET_MS);
    const next8am = new Date(nowET);
    next8am.setHours(8, 0, 0, 0);
    if (next8am <= nowET) next8am.setDate(next8am.getDate() + 1);
    return next8am.getTime() - nowET.getTime();
  }

  function sendHeartbeat() {
    const active  = recorderState.activeFights.size;
    const saved   = recorderState.totalSaved;
    const lastPoll = recorderState.lastPoll
      ? new Date(recorderState.lastPoll).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : 'never';
    sendAlert(
      `✅ BET BOT: Running — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })}`,
      `Daily check-in: server is alive and recording.\n\n` +
      `Active recordings: ${active}\n` +
      `Fights saved this session: ${saved}\n` +
      `Last API poll: ${lastPoll}\n\n` +
      `If you stop receiving these emails, the server is down.\n\n` +
      `https://ufc-dashboard-production-e03d.up.railway.app`
    );
    setTimeout(sendHeartbeat, 24 * 60 * 60 * 1000); // repeat every 24h
  }

  const delay = msUntilNext8amET();
  console.log(`[heartbeat] First email in ${Math.round(delay / 60000)} minutes (8am ET)`);
  setTimeout(sendHeartbeat, delay);
}

// Optional external dead-man's-switch (healthchecks.io) — set HEALTHCHECK_URL in Railway if desired
const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || null;
function pingHealthcheck() {
  if (!HEALTHCHECK_URL) return;
  https.get(HEALTHCHECK_URL, () => {}).on('error', e => console.error('[healthcheck] ping failed:', e.message));
}

// ── POST /api/chat — NL intent parser (Claude Haiku) ─────────────────────────
// Parses natural language betting commands into structured JSON.
// Used by the extension popup chat UI.
//
// Request:  { message: string, gameContext?: { sides: [...], odds: {...} } }
// Response: { intent, side, amount, trigger, confidence, raw, error? }

const CHAT_SYSTEM = (gameContext) => `You are a sports betting assistant. Parse the user's message into structured JSON.

GAME CONTEXT: ${gameContext ? JSON.stringify(gameContext) : 'No active game selected'}

Respond with ONLY a JSON object — no explanation, no markdown:
{
  "intent": "place_first_bet" | "set_hedge_trigger" | "cancel" | "query" | "unknown",
  "side": "<team/player name as shown on DraftKings, or null>",
  "amount": <dollars as number, or null>,
  "trigger": { "type": "crossover" | "odds_target" | null, "targetOdds": <american odds or null> },
  "confidence": <0.0–1.0>
}

EXAMPLES:
"bet $10 on Canada, auto-hedge at crossover"
→ {"intent":"place_first_bet","side":"Canada","amount":10,"trigger":{"type":"crossover","targetOdds":null},"confidence":0.97}

"put $50 on the favorite and hedge automatically"
→ {"intent":"place_first_bet","side":null,"amount":50,"trigger":{"type":"crossover","targetOdds":null},"confidence":0.85}

"bet 25 on Hamad and hedge when Qatar hits +200"
→ {"intent":"place_first_bet","side":"Hamad Medjedovic","amount":25,"trigger":{"type":"odds_target","targetOdds":200},"confidence":0.95}

"cancel" or "stop"
→ {"intent":"cancel","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":0.99}

"what's the line?" or "who's favored?"
→ {"intent":"query","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":0.92}

RULES:
- Amounts: "$1.50" → 1.50, "a penny" → 0.01, "50 cents" → 0.50, "1k" → 1000
- crossover = when underdog implied probability ≥ favorite implied probability
- If user says "favorite" or "dog/underdog" and gameContext has sides+odds, infer the side name
- side must match the name as it appears on DraftKings exactly if possible`;

function parseChatResponse(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const src = jsonMatch ? jsonMatch[0] : raw;
  const parsed = JSON.parse(src);
  // Normalise fields
  return {
    intent:     parsed.intent     || 'unknown',
    side:       parsed.side       || null,
    amount:     typeof parsed.amount === 'number' ? parsed.amount : null,
    trigger:    parsed.trigger    || { type: null, targetOdds: null },
    confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
  };
}

app.post('/api/chat', async (req, res) => {
  const { message, gameContext } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message (string) required' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: CHAT_SYSTEM(gameContext || null),
      messages: [{ role: 'user', content: message.slice(0, 500) }]
    });

    const raw = response.content[0]?.text?.trim() || '';
    let parsed;
    try {
      parsed = parseChatResponse(raw);
    } catch {
      return res.json({ intent: 'unknown', side: null, amount: null, trigger: { type: null, targetOdds: null }, confidence: 0, raw, error: 'parse_failed' });
    }

    res.json({ ...parsed, raw });
  } catch (e) {
    console.error('[api/chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/resolve-bet-target — AI name matching when DOM search fails ─────
// Called by the extension when Strategy A/B/C all fail to find the bet button.
// Sends the visible page options to Haiku; returns the best match + confidence.
// Only fires on failure — zero overhead on the happy path.
//
// Request:  { side: string, nearbyLabels: string[], allButtonTexts: string[] }
// Response: { ok: true,  resolvedSide: string, confidence: number }
//         | { ok: false, ambiguous: true, options: string[], reason: string }
//         | { ok: false, error: string }

const RESOLVE_SYSTEM = `You are a DraftKings sportsbook bet-target resolver. The extension tried to find a bet button for a team/player name and failed. Given the visible page options, identify the correct match.

Respond with ONLY valid JSON — no markdown, no explanation:
{
  "match": "<exact string from visibleOptions, or null if no confident match>",
  "confidence": <0.0–1.0>,
  "reason": "<one short sentence>"
}

RULES:
- match must be the exact string from visibleOptions as provided, or null
- confidence ≥ 0.85 = safe to auto-retry; below that = surface error to user
- If two or more options are plausible, set confidence < 0.60 and match = null
- Common resolutions: US→USA, UK→England, Korea→South Korea, Iran→IR Iran
- Odds values like "-165" or "+330" are NEVER a valid match
- Navigation text (More, Home, Live, SGP) is NEVER a valid match`;

app.post('/api/resolve-bet-target', async (req, res) => {
  const { side, nearbyLabels = [], allButtonTexts = [] } = req.body || {};
  if (!side) return res.status(400).json({ ok: false, error: 'side required' });

  // Deduplicate and clean option candidates; filter out obvious non-names
  const candidates = [...new Set([...nearbyLabels, ...allButtonTexts])]
    .filter(t =>
      t && t.length >= 2 && t.length <= 50 &&
      !/^[+-]\d+$/.test(t) &&        // not odds value
      !/^\$[\d,.]+/.test(t) &&        // not money
      !/^\d+(\.\d+)?%?$/.test(t) &&  // not pure number
      !['More', 'Home', 'Live', 'SGP', 'Opt In', 'Today', 'Tomorrow', 'Show DK Social',
        'MONEYLINE', 'TIE NO BET', 'TOTAL GOALS', 'SPREAD', 'FUTURES', 'Matches',
        'Players', 'Groups', 'Countries', 'Quick Hits', 'Match Props'].includes(t)
    )
    .slice(0, 80);

  if (candidates.length === 0) {
    return res.json({ ok: false, error: 'No candidates extracted from page — make sure the game is visible' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: RESOLVE_SYSTEM,
      messages: [{
        role: 'user',
        content: `User wants to bet on: "${side}"

Visible options on the DraftKings page:
${candidates.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Which option best matches "${side}"?`
      }]
    });

    const raw = response.content[0]?.text?.trim() || '';
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      return res.json({ ok: false, error: `Haiku parse failed: ${raw.slice(0, 100)}` });
    }

    const { match, confidence = 0, reason = '' } = parsed;

    // Safety: match must be in the candidate list
    if (match && !candidates.includes(match)) {
      // Try case-insensitive fallback
      const caseMatch = candidates.find(c => c.toLowerCase() === match.toLowerCase());
      if (!caseMatch) {
        return res.json({ ok: false, error: `AI returned "${match}" which is not in the visible options` });
      }
      return res.json({ ok: true, resolvedSide: caseMatch, confidence, reason });
    }

    if (!match || confidence < 0.85) {
      // Ambiguous or low-confidence — surface best candidates to user
      const topOptions = candidates.slice(0, 10);
      return res.json({ ok: false, ambiguous: true, options: topOptions, confidence, reason });
    }

    console.log(`[resolve-bet-target] "${side}" → "${match}" (${Math.round(confidence * 100)}%): ${reason}`);
    return res.json({ ok: true, resolvedSide: match, confidence, reason });
  } catch (e) {
    console.error('[resolve-bet-target]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Watch trigger CRUD ────────────────────────────────────────────────────────

app.get('/api/watch-triggers', (req, res) => {
  const now = Date.now();
  watchTriggers = watchTriggers.filter(t => t.expiresAt > now);
  res.json({ triggers: watchTriggers });
});

app.post('/api/watch-triggers', (req, res) => {
  const { side, amount, condition, description, userId } = req.body || {};
  if (!side || !amount || !condition) return res.status(400).json({ ok: false, error: 'side, amount, condition required' });
  const trigger = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: userId || 'default',
    side, amount, condition,
    description: description || `Bet $${amount} on ${side}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 4 * 60 * 60 * 1000,
  };
  watchTriggers.push(trigger);
  console.log(`[watch-trigger] Created: ${trigger.description} [${trigger.id}]`);
  res.json({ ok: true, trigger });
});

app.delete('/api/watch-triggers/:id', (req, res) => {
  const before = watchTriggers.length;
  watchTriggers = watchTriggers.filter(t => t.id !== req.params.id);
  console.log(`[watch-trigger] Deleted ${req.params.id} (removed=${before - watchTriggers.length})`);
  res.json({ ok: true, removed: before - watchTriggers.length });
});

// ── Auto-bet API ──────────────────────────────────────────────────────────────

app.get('/api/auto-bet/config', (req, res) => {
  res.json({
    config: autoBetConfig,
    sessionCount: autoBetSessionCount,
    firedFights: [...autoBetFiredFights].slice(-20),
    recentLog: autoBetLog.slice(0, 10),
  });
});

app.post('/api/auto-bet/config', (req, res) => {
  const body = req.body || {};
  const bools   = ['enabled', 'requireExtension', 'autoHedge'];
  const numbers = ['amount', 'maxPerSession', 'maxFightAgeSecs', 'minOddsGapPct'];
  for (const k of bools)   if (typeof body[k] === 'boolean') autoBetConfig[k] = body[k];
  for (const k of numbers) if (typeof body[k] === 'number' && body[k] >= 0) autoBetConfig[k] = body[k];
  if (Array.isArray(body.brackets)) {
    const valid = ['even', 'slight', 'heavy', 'huge'];
    autoBetConfig.brackets = body.brackets.filter(b => valid.includes(b));
  }
  if (['dog', 'fav'].includes(body.side)) autoBetConfig.side = body.side;
  saveAutoBetConfig();
  console.log('[auto-bet] Config updated:', JSON.stringify(autoBetConfig));
  res.json({ ok: true, config: autoBetConfig });
});

app.post('/api/auto-bet/reset-session', (req, res) => {
  autoBetSessionCount = 0;
  autoBetFiredFights.clear();
  saveFiredFights();
  autoBetLog.length = 0;
  console.log('[auto-bet] Session reset');
  res.json({ ok: true });
});

// POST /api/auto-bet/test — dry-run checkAutoBet with custom fight data
// Simulates a new fight detection without needing a real live game.
// Pass dryRun=true (default) to see what would happen without actually queuing a command.
app.post('/api/auto-bet/test', (req, res) => {
  const {
    fighter1    = 'Test Dry Fighter A',
    fighter2    = 'Test Dry Fighter B',
    f1Odds      = -150,
    f2Odds      = 130,
    commenceTime = new Date(Date.now() - 30 * 1000).toISOString(), // 30s ago
    dryRun      = true,
  } = req.body || {};

  const fakeOdds = {
    fighter1: { name: fighter1, numericOdds: f1Odds },
    fighter2: { name: fighter2, numericOdds: f2Odds },
  };
  const fakeId = `dryrun_${Date.now()}`;

  // Temporarily disable test_fight filter for this endpoint
  const origF1 = fighter1, origF2 = fighter2;
  // Use non-"Test " names so guard doesn't block (endpoint is explicitly for testing)
  const safeF1 = fighter1.replace(/^test /i, 'DryRun ');
  const safeF2 = fighter2.replace(/^test /i, 'DryRun ');

  if (dryRun) {
    // Evaluate all guards without mutating state — report what would happen
    const cfg = autoBetConfig;
    const report = [];

    report.push({ guard: 'enabled',          pass: cfg.enabled,            value: cfg.enabled });
    report.push({ guard: 'test_fight',        pass: true,                   value: 'bypassed for /test endpoint' });
    report.push({ guard: 'already_fired',     pass: !autoBetFiredFights.has(fakeId), value: `firedFights.size=${autoBetFiredFights.size}` });
    report.push({ guard: 'rate_limit',        pass: autoBetSessionCount < cfg.maxPerSession, value: `${autoBetSessionCount}/${cfg.maxPerSession}` });

    const liveForSecs = (Date.now() - new Date(commenceTime).getTime()) / 1000;
    report.push({ guard: 'fight_too_old',     pass: liveForSecs <= cfg.maxFightAgeSecs, value: `${Math.round(liveForSecs)}s old, limit=${cfg.maxFightAgeSecs}s` });

    const now = Date.now();
    const hasExt = Object.values(dkHeartbeat.users || {}).some(ts => now - ts < 300000);
    report.push({ guard: 'no_extension',      pass: !cfg.requireExtension || hasExt, value: hasExt ? 'connected' : 'not connected' });

    const oddsOk = typeof f1Odds === 'number' && typeof f2Odds === 'number' && !isNaN(f1Odds) && !isNaN(f2Odds);
    report.push({ guard: 'invalid_odds',      pass: oddsOk, value: `${f1Odds} / ${f2Odds}` });

    const d1 = toDecimal(f1Odds), d2 = toDecimal(f2Odds);
    const gapPct = Math.abs(1/d1 - 1/d2) * 100;
    report.push({ guard: 'odds_too_close',    pass: gapPct >= cfg.minOddsGapPct, value: `gap=${gapPct.toFixed(1)}%, min=${cfg.minOddsGapPct}%` });

    const bracket = classifyOddsBracket(f1Odds, f2Odds);
    report.push({ guard: 'bracket_mismatch',  pass: cfg.brackets.includes(bracket), value: `bracket=${bracket}, targets=${cfg.brackets.join(',')}` });

    const favF = d1 <= d2 ? safeF1 : safeF2;
    const dogF = d1 <= d2 ? safeF2 : safeF1;
    const side = cfg.side === 'dog' ? dogF : favF;
    const openBets = getAllBets(true);
    const alreadyCovered = openBets.some(b => b.selection?.toLowerCase().includes(side.toLowerCase().split(' ')[0]));
    report.push({ guard: 'existing_coverage', pass: !alreadyCovered, value: alreadyCovered ? `already bet on ${side}` : 'clear' });

    const allPass = report.every(g => g.pass);
    return res.json({
      dryRun: true,
      wouldFire: allPass,
      side: allPass ? side : null,
      bracket,
      bracketLabel: { even:'near-even', slight:'slight fav', heavy:'heavy fav', huge:'dominant' }[bracket],
      guards: report,
      config: cfg,
    });
  }

  // Live run — actually fire (use safe names to bypass test_fight guard)
  const result = checkAutoBet(fakeId, safeF1, safeF2, fakeOdds, commenceTime);
  res.json({ dryRun: false, fakeId, result });
});

// ── Unified assistant endpoint ─────────────────────────────────────────────────
// Routes all dashboard chat through a single Haiku classifier, then to the right
// handler: place_bet → command queue, watch_trigger → trigger store,
// cancel → clear both, status → context summary, research → Sonnet pipeline,
// clarify → surface question.

const ASSISTANT_SYSTEM = (ctx) => `You are an intelligent sports betting assistant embedded in a live DraftKings betting app. Parse the user's message into structured JSON.

CURRENT CONTEXT:
${JSON.stringify(ctx, null, 1)}

Respond with ONLY a JSON object — no explanation, no markdown:
{
  "intent": "place_bet" | "watch_trigger" | "cancel" | "status" | "research" | "clarify",
  "side": "<team/player name to bet on, or null>",
  "amount": <dollars as number or null>,
  "trigger": {
    "type": "crossover" | "positive" | "negative" | "odds_threshold" | "score_tie" | null,
    "targetOdds": <american odds number or null>,
    "team1": "<first team name for score_tie, else null>",
    "team2": "<second team name for score_tie, else null>",
    "sport": "<sport name for score_tie e.g. 'soccer', else null>"
  },
  "confidence": <0.0–1.0>,
  "clarifyQuestion": "<question to ask user if intent=clarify, else null>"
}

INTENT RULES:
- place_bet: user wants to bet RIGHT NOW — side + amount, no waiting condition
- watch_trigger: user wants to bet WHEN something happens ("as soon as", "when odds go", "if they hit", "wait until", "when score is tied", "if they equalize", "when the game is level")
- cancel: stop strategy, cancel watching, stop auto-hedge
- status: asking what's currently happening, current odds, open bets — informational
- research: historical data, fight analysis, crossover stats, strategy questions — needs deep research
- clarify: ONLY when truly ambiguous (missing side or amount) — do NOT clarify if intent is clear

TRIGGER CONDITION TYPES (use for watch_trigger):
- "positive": fire when side's american odds > 0 ("goes plus money", "goes into plus territory")
- "negative": fire when side's american odds < 0 ("becomes favorite")
- "odds_threshold": fire when side's odds reach/exceed targetOdds (e.g., ">= +150")
- "crossover": fire at crossover (implied prob swap between two sides)
- "score_tie": fire when the live game score becomes tied/equal
  WHEN TO USE: "if game is tied", "when they tie it", "if score is level", "when [team] equalizes", "if it goes to a tie", "monitor the score, if [team] ties"
  → set trigger.team1 and trigger.team2 to the teams playing (extract from user message or context)
  → set trigger.sport to the sport (usually "soccer" for international team names; "nfl"/"nba"/"nhl" if clear)
  → side = the team the user wants to BET ON when the tie happens

AMOUNT PARSING: "$1.50" → 1.50, "a penny" → 0.01, "50 cents" → 0.50, "1k" → 1000

CONTEXT USAGE:
- "another bet on X" / "also bet X" → use same amount as last bet in recentChat
- "the favorite/underdog" and context has odds → resolve the name
- For watch_trigger: if amount is missing, set intent=clarify and ask for it
- For score_tie: DO NOT clarify just because you're not sure about monitoring — set intent=watch_trigger and fire the trigger. The system handles real-time score monitoring automatically.`;

app.post('/api/assistant', async (req, res) => {
  const { message, userId = 'default', currentOdds } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const openBets = getAllBets(true);
  const activeTriggers = watchTriggers.filter(t => t.expiresAt > Date.now());
  const activeCmds = commandQueue.filter(c =>
    c.status === 'pending' || c.status === 'picked_up' ||
    (c.status === 'done' && c.result?.bothPlaced === false)
  );
  const history = getChatHistory(userId);

  const ctx = {
    openBets: openBets.slice(0, 5).map(b => ({ selection: b.selection, odds: b.odds, stake: b.stake })),
    activeStrategy: activeCmds.length > 0 ? { side: activeCmds[0].side, amount: activeCmds[0].amount, state: activeCmds[0].strategyState || activeCmds[0].status } : null,
    watchTriggers: activeTriggers.slice(0, 5).map(t => ({ id: t.id, description: t.description })),
    currentOdds: currentOdds || null,
    recentChat: history.slice(-4),
  };

  addChatTurn(userId, 'user', message);

  try {
    const classifyR = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: ASSISTANT_SYSTEM(ctx),
      messages: [{ role: 'user', content: message.slice(0, 600) }],
    });

    let parsed;
    try {
      const raw = classifyR.content[0]?.text?.trim() || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      parsed = { intent: 'research', confidence: 0.5 };
    }

    const intent = {
      intent:          parsed.intent || 'research',
      side:            parsed.side   || null,
      amount:          typeof parsed.amount === 'number' ? parsed.amount : null,
      trigger:         parsed.trigger || { type: null, targetOdds: null },
      confidence:      typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      clarifyQuestion: parsed.clarifyQuestion || null,
    };

    // ── place_bet ─────────────────────────────────────────────────────────
    if (intent.intent === 'place_bet') {
      if (!intent.side || !intent.amount) {
        const q = !intent.side ? 'Which side do you want to bet on?' : `How much do you want to bet on ${intent.side}?`;
        addChatTurn(userId, 'assistant', q);
        return res.json({ type: 'clarify', answer: q });
      }
      const cmd = makeCommand('place_bet', intent);
      commandQueue.push(cmd); saveCommandQueue();
      const triggerStr = intent.trigger?.type === 'crossover'
        ? ' — **auto-hedging at crossover** 🔄'
        : intent.trigger?.type === 'odds_target'
        ? ` — auto-hedge when line hits **${intent.trigger.targetOdds}**` : '';
      const answer = `**Bet queued** ✅\n\nPlacing **$${intent.amount}** on **${intent.side}**${triggerStr}.\n\nYour extension will execute this on DraftKings now.`;
      addChatTurn(userId, 'assistant', answer);
      return res.json({ type: 'bet', answer, betCommand: cmd, usage: { thisQuery: 0, sessionTotal: totalTokensUsed, sessionQueries: totalQueries, estimatedCostUSD: 0 } });
    }

    // ── watch_trigger ─────────────────────────────────────────────────────
    if (intent.intent === 'watch_trigger') {
      if (!intent.side || !intent.amount) {
        const q = !intent.side ? 'Which side do you want to watch and bet on?' : `How much do you want to bet on ${intent.side} when the trigger fires?`;
        addChatTurn(userId, 'assistant', q);
        return res.json({ type: 'clarify', answer: q });
      }
      const condType = intent.trigger?.type || 'positive';
      const isScoreTie = condType === 'score_tie';
      const condition = isScoreTie
        ? {
            type: 'score_tie',
            team1: intent.trigger?.team1 || intent.side || '',
            team2: intent.trigger?.team2 || '',
            sport: intent.trigger?.sport || 'soccer',
          }
        : { type: condType, targetOdds: intent.trigger?.targetOdds || null };

      const descSuffix = isScoreTie
        ? `score becomes tied (${condition.team1} vs ${condition.team2})`
        : condType === 'positive' ? 'odds go plus money'
        : condType === 'negative' ? 'odds go negative'
        : `odds reach ${intent.trigger?.targetOdds}`;

      const trigger = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        userId,
        side: intent.side,
        amount: intent.amount,
        condition,
        description: `Bet $${intent.amount} on ${intent.side} when ${descSuffix}`,
        createdAt: Date.now(),
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      };
      watchTriggers.push(trigger);

      let answer;
      if (isScoreTie) {
        const t1 = condition.team1, t2 = condition.team2;
        answer = `**Score trigger set** ⚽\n\nMonitoring the live ${condition.sport} score via ESPN. The moment ${t1 && t2 ? `${t1} vs ${t2}` : 'the game'} becomes tied, I'll place **$${intent.amount}** on **${intent.side}** to win instantly.\n\nServer checks score every 5 seconds — no DK tab required.`;
      } else {
        const condDesc = condType === 'positive' ? 'go into plus money'
          : condType === 'negative' ? 'become a favorite'
          : `hit ${intent.trigger?.targetOdds}`;
        answer = `**Watching** 👁️\n\nI'll bet **$${intent.amount}** on **${intent.side}** as soon as their odds ${condDesc}.\n\nThe extension checks every second — it fires the bet instantly when the condition is met.`;
      }
      addChatTurn(userId, 'assistant', answer);
      return res.json({ type: 'watch_trigger', answer, trigger });
    }

    // ── cancel ────────────────────────────────────────────────────────────
    if (intent.intent === 'cancel') {
      let cancelledCmds = 0;
      commandQueue.forEach(c => {
        if (c.status === 'pending' || c.status === 'picked_up') { c.status = 'cancelled'; cancelledCmds++; }
      });
      saveCommandQueue();
      const before = watchTriggers.length;
      watchTriggers = watchTriggers.filter(t => t.userId !== userId && t.userId !== 'default');
      const cancelledTriggers = before - watchTriggers.length;
      const answer = `**Cancelled** 🛑\n\nStopped ${cancelledCmds} pending bet${cancelledCmds !== 1 ? 's' : ''} and ${cancelledTriggers} watch trigger${cancelledTriggers !== 1 ? 's' : ''}.`;
      addChatTurn(userId, 'assistant', answer);
      return res.json({ type: 'cancel', answer });
    }

    // ── status ────────────────────────────────────────────────────────────
    if (intent.intent === 'status') {
      const lines = [];
      if (openBets.length) lines.push(`**Open bets:** ${openBets.map(b => `${b.selection} ${b.odds} ($${b.stake})`).join(', ')}`);
      if (activeTriggers.length) lines.push(`**Watching:** ${activeTriggers.map(t => t.description).join('; ')}`);
      if (activeCmds.length) lines.push(`**Active strategy:** ${activeCmds[0].side} $${activeCmds[0].amount} (${activeCmds[0].strategyState || activeCmds[0].status})`);
      if (!lines.length) lines.push('No active bets, triggers, or strategies.');
      const answer = lines.join('\n\n');
      addChatTurn(userId, 'assistant', answer);
      return res.json({ type: 'status', answer });
    }

    // ── clarify ───────────────────────────────────────────────────────────
    if (intent.intent === 'clarify') {
      const q = intent.clarifyQuestion || "Could you be more specific? What side and amount did you have in mind?";
      addChatTurn(userId, 'assistant', q);
      return res.json({ type: 'clarify', answer: q });
    }

    // ── research (default) — 2-pass Sonnet pipeline ───────────────────────
    let liveOdds = [];
    try {
      const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
      const { data, headers } = await fetchJson(url);
      updateOddsCredits(headers);
      liveOdds = (Array.isArray(data) ? data : []).filter(f => f.bookmakers?.length > 0).map(f => {
        const outcomes = f.bookmakers[0].markets[0]?.outcomes || [];
        return { fight: `${f.home_team} vs ${f.away_team}`, date: f.commence_time.slice(0, 10), odds: outcomes.reduce((acc, o) => { acc[o.name] = o.price; return acc; }, {}) };
      });
    } catch {}

    const historicalSummaryJson = getCachedSummary();
    totalQueries++;
    const buildResearchMsgs = (extraData) => [{
      role: 'user',
      content: `HISTORICAL FIGHT DATA (local, Dec 2025–May 2026):\n${historicalSummaryJson}\n\nCURRENT DRAFTKINGS ODDS:\n${JSON.stringify(liveOdds, null, 1)}\n${extraData ? `\nADDITIONAL HISTORICAL API DATA:\n${JSON.stringify(extraData, null, 1)}` : ''}\n\nQuestion: ${message}`,
    }];

    const pass1 = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1500, system: systemPrompt, messages: buildResearchMsgs(null) });
    const pass1Text = pass1.content[0].text;
    let usedTokens = pass1.usage.input_tokens + pass1.usage.output_tokens;
    let finalAnswer = pass1Text;

    const lookupMatch = pass1Text.match(/LOOKUP_NEEDED:\s*(.+)/i);
    if (lookupMatch) {
      const dates = lookupMatch[1].trim().split(/\s+/).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p)).slice(0, 3);
      const extraData = [];
      for (const d of dates) { try { extraData.push(...await fetchHistoricalOdds(d)); } catch {} }
      const pass2 = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1500, system: systemPrompt, messages: buildResearchMsgs(extraData.length > 0 ? extraData : null) });
      finalAnswer = pass2.content[0].text;
      usedTokens += pass2.usage.input_tokens + pass2.usage.output_tokens;
    }

    totalTokensUsed += usedTokens;
    if (totalTokensUsed > TOKEN_WARN) console.warn(`WARNING: Anthropic token usage (${totalTokensUsed}) exceeded threshold (${TOKEN_WARN})`);
    addChatTurn(userId, 'assistant', finalAnswer.slice(0, 500));
    return res.json({
      type: 'research',
      answer: finalAnswer,
      usage: { thisQuery: usedTokens, sessionTotal: totalTokensUsed, sessionQueries: totalQueries, estimatedCostUSD: +(totalTokensUsed / 1_000_000 * 3).toFixed(3) },
    });

  } catch (e) {
    console.error('[api/assistant]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Command queue endpoints ───────────────────────────────────────────────────

// Extension polls this every 5s to pick up dashboard bet commands
app.get('/api/pending-commands', (req, res) => {
  const now = Date.now();
  // Purge expired commands
  commandQueue = commandQueue.filter(c => c.status !== 'pending' || c.expiresAt > now);
  // Recycle stuck picked_up commands: if extension fetched the command but CORS blocked
  // the response (or SW died mid-execution), the command stays picked_up forever.
  // Reset to pending after 30s so the next poll retries it.
  commandQueue.forEach(c => {
    if (c.status === 'picked_up' && c.pickedUpAt && (now - c.pickedUpAt) > 30000) {
      c.status = 'pending';
      delete c.pickedUpAt;
    }
  });
  const pending = commandQueue.find(c => c.status === 'pending');
  if (pending) {
    pending.status    = 'picked_up';
    pending.pickedUpAt = now;
    saveCommandQueue();
  }
  res.json({ command: pending || null });
});

// Extension posts bet result back so dashboard can show confirmation
app.post('/api/command-result', (req, res) => {
  const { commandId, result } = req.body || {};
  const cmd = commandQueue.find(c => c.id === commandId);
  if (cmd) {
    cmd.status      = result?.ok ? 'done' : 'failed';
    cmd.result      = result;
    cmd.completedAt = Date.now();
    saveCommandQueue();
  }
  res.json({ ok: true });
});

// Dashboard polls this to get live status of a queued command
app.get('/api/command-status/:id', (req, res) => {
  const cmd = commandQueue.find(c => c.id === req.params.id);
  res.json(cmd || { status: 'not_found' });
});

// Extension posts strategy state-machine updates so dashboard shows live progress
app.post('/api/strategy-update', (req, res) => {
  const { commandId, state, message } = req.body || {};
  const cmd = commandQueue.find(c => c.id === commandId);
  if (cmd) {
    cmd.strategyState   = state;
    cmd.strategyMessage = message;
    cmd.strategyHistory.push({ state, message, ts: Date.now() });
    saveCommandQueue();
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Bet Bot running at http://localhost:${PORT}`);

  // Validate critical env vars at startup — loud errors so Railway logs catch them immediately
  if (!process.env.GITHUB_TOKEN) {
    console.error('🚨 CRITICAL: GITHUB_TOKEN not set — fight files will NOT be backed up to GitHub!');
    sendAlert('🚨 BET BOT: GITHUB_TOKEN missing', 'Fight recordings will save to disk but will NOT be backed up to GitHub. Set GITHUB_TOKEN in Railway Variables immediately.\n\nhttps://ufc-dashboard-production-e03d.up.railway.app');
  } else {
    console.log('[startup] GITHUB_TOKEN ✓');
  }
  if (!process.env.DATA_DIR) {
    console.warn('[startup] DATA_DIR not set — using ephemeral filesystem. Set DATA_DIR=/data for Railway volume.');
  } else {
    console.log(`[startup] DATA_DIR=${process.env.DATA_DIR} ✓`);
  }

  recPoll();
  console.log('Recorder started — UFC always-on, other sports when browser is watching');
  scheduleHeartbeat();
  if (HEALTHCHECK_URL) {
    pingHealthcheck();
    setInterval(pingHealthcheck, 5 * 60 * 1000);
  }
});
