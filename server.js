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
const HISTORICAL_DIR = path.join(__dirname, 'historical_data');
const ODDS_API_BACKFILL_DIR = path.join(__dirname, 'odds_api_backfill'); // browse-only, NOT used by AI brain
const API_CACHE_DIR = path.join(__dirname, 'historical_data', 'api_cache');
if (!fs.existsSync(API_CACHE_DIR)) fs.mkdirSync(API_CACHE_DIR, { recursive: true });

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

// Historical Odds API backfill data — browse only, separate from Ish's live data
app.get('/api/historical-recordings', (req, res) => {
  try {
    if (!fs.existsSync(ODDS_API_BACKFILL_DIR)) return res.json([]);
    const files = fs.readdirSync(ODDS_API_BACKFILL_DIR).filter(f => f.endsWith('.json'));
    const results = [];
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(ODDS_API_BACKFILL_DIR, f)));
        const h = d.oddsHistory || [];
        if (h.length < 5) continue;
        results.push({
          id: 'backfill__' + f.replace('.json',''),
          sport: 'UFC/MMA',
          fighter1: h[0]?.fighter1?.name || d.fightTitle?.split(' vs ')[0] || '?',
          fighter2: h[0]?.fighter2?.name || d.fightTitle?.split(' vs ')[1] || '?',
          date: f.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
          dataPoints: d.dataPoints || h.length,
          startTime: d.startTime || '',
        });
      } catch {}
    }
    results.sort((a,b) => (b.date||'').localeCompare(a.date||''));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full odds history for a specific fight (for graphing)
app.get('/api/fight-history/:fightId', (req, res) => {
  try {
    const id = req.params.fightId;

    // If id starts with backfill__ serve from odds_api_backfill (browse-only)
    if (id.startsWith('backfill__') && fs.existsSync(ODDS_API_BACKFILL_DIR)) {
      const bare = id.replace('backfill__', '');
      const bfiles = fs.readdirSync(ODDS_API_BACKFILL_DIR).filter(f => f.endsWith('.json'));
      const bmatch = bfiles.find(f => f.replace('.json','') === bare);
      if (bmatch) return res.json(JSON.parse(fs.readFileSync(path.join(ODDS_API_BACKFILL_DIR, bmatch))));
    }

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
  const { fighter, odds, stake } = req.body;
  if (!fighter) return res.status(400).json({ error: 'fighter required' });
  const mock = {
    betId: 'mock-' + Date.now(),
    status: 'Open',
    settlementStatus: 'Pending',
    selection: fighter,
    market: 'Live Moneyline',
    odds: odds || '+100',
    stake: stake || 100,
    potentialReturns: null,
    returns: null,
    placementDate: new Date().toISOString(),
  };
  dkBetsByUser.set(DEFAULT_USER, [mock]);
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
app.get('/api/live-score', async (req, res) => {
  const { sport, team1, team2 } = req.query;
  if (!team1 || !team2) return res.json(null);

  const s = (sport || '').toLowerCase();
  const endpoints = [];
  if (s.includes('soccer') || s.includes('football') && !s.includes('nfl')) {
    endpoints.push(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
      'https://site.api.espn.com/apis/site/v2/sports/soccer/concacaf.nations.league/scoreboard',
      'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
      'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.euro/scoreboard',
      'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
      'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
    );
  } else if (s.includes('mma') || s.includes('ufc') || s.includes('fight')) {
    endpoints.push('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard');
  } else if (s.includes('nfl') || (s.includes('football') && s.includes('nfl'))) {
    endpoints.push('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
  } else if (s.includes('nba') || s.includes('basketball')) {
    endpoints.push('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard');
  } else if (s.includes('nhl') || s.includes('hockey')) {
    endpoints.push('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard');
  } else {
    endpoints.push(
      'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
      'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
    );
  }

  const norm = str => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy = (a, b) => { const na = norm(a), nb = norm(b); return na.includes(nb) || nb.includes(na); };

  for (const url of endpoints) {
    try {
      const { data } = await fetchJson(url);
      for (const event of (data.events || [])) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const comps = comp.competitors || [];
        if (comps.length < 2) continue;
        const names = comps.map(c => c.team?.displayName || c.team?.name || '');
        const hasT1 = names.some(n => fuzzy(n, team1));
        const hasT2 = names.some(n => fuzzy(n, team2));
        if (!hasT1 || !hasT2) continue;
        // Align to team1/team2 order
        const c1 = fuzzy(comps[0].team?.displayName || '', team1) ? comps[0] : comps[1];
        const c2 = c1 === comps[0] ? comps[1] : comps[0];
        const st = comp.status;
        return res.json({
          score1: c1.score ?? '0',
          score2: c2.score ?? '0',
          period: st?.type?.shortDetail || st?.type?.description || '',
          clock: st?.displayClock || '',
          completed: st?.type?.completed || false,
        });
      }
    } catch (_) { /* try next */ }
  }
  res.json(null);
});

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

const UFC_POLL_MS   = 3000;
const OTHER_POLL_MS = 5000;  // 5s while browser is open watching
const IDLE_POLL_MS  = 300000;

const SPORT_META = {
  'mma_mixed_martial_arts': { label: 'UFC/MMA', window: 3 * 60 * 60 * 1000 },
  'icehockey_nhl':          { label: 'NHL',     window: 4 * 60 * 60 * 1000 },
  'basketball_nba':         { label: 'NBA',     window: 3 * 60 * 60 * 1000 },
  'americanfootball_nfl':   { label: 'NFL',     window: 4 * 60 * 60 * 1000 },
  'baseball_mlb':           { label: 'MLB',     window: 4 * 60 * 60 * 1000 },
};

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
  recSaveRecord, autoEnrich, loadPersistedState, persistState,
} = require('./record_engine');

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

  // Only invalidate MMA index (other sports don't feed the analyzer)
  if (record.meta.sport === 'mma_mixed_martial_arts') {
    invalidateIndex();
    // Auto-enrich: fetch winner/method from ESPN/UFC Stats immediately after save
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
    return currentIds.size;
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
    return 0;
  }
}

async function recPoll() {
  recorderState.lastPoll = new Date().toISOString();

  // Always poll UFC
  const ufcMeta = SPORT_META['mma_mixed_martial_arts'];
  const ufcLive = await recPollSport('mma_mixed_martial_arts', ufcMeta);

  // Poll the one sport the browser is watching (if heartbeat < 2 min old)
  const now = Date.now();
  const watching = clientWatching && (now - clientWatching.ts < 120000) ? clientWatching : null;
  const otherLive = watching
    ? await recPollSport(watching.sport, SPORT_META[watching.sport] || { label: watching.sport, window: 4*60*60*1000 }, watching)
    : 0;
  const totalLive = ufcLive + otherLive;

  // Next poll: UFC drives the cadence
  const delay = ufcLive > 0 ? UFC_POLL_MS : watching ? OTHER_POLL_MS : IDLE_POLL_MS;
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

app.listen(PORT, () => {
  console.log(`Bet Bot running at http://localhost:${PORT}`);
  recPoll();
  console.log('Recorder started — UFC always-on, other sports when browser is watching');
  scheduleHeartbeat();
  if (HEALTHCHECK_URL) {
    pingHealthcheck();
    setInterval(pingHealthcheck, 5 * 60 * 1000);
  }
});
