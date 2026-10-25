require('dotenv').config();
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
// Bump on every deploy so a live check can tell builds apart.
const BUILD_TAG = '2026-10-19-dk-state-volume';
const PORT = process.env.PORT || 3000;

// Admin gate for destructive or costly write routes. Fails CLOSED: if ADMIN_TOKEN is not set,
// these routes refuse everything. Send the token in the X-Admin-Token header.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'ADMIN_TOKEN is not configured on the server; admin routes are disabled' });
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = process.env.ODDS_BASE_URL || 'https://api.the-odds-api.com/v4'; // override only for tests
// HISTORICAL_DIR is set by record_engine (respects DATA_DIR env var for Railway volume).
// Defined here as a placeholder — overwritten after record_engine is imported below.
let HISTORICAL_DIR = path.join(__dirname, 'historical_data');

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    // http:// is only used when ODDS_BASE_URL points at a local test server
    const client = url.startsWith('http://') ? require('http') : https;
    const req = client.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(d), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
    // 10s hard timeout — prevents slow Odds API from stalling the poll loop
    req.setTimeout(10000, () => req.destroy(new Error('fetchJson timeout')));
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
app.get('/hud', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'hud.html')); });
app.get('/guide', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'guide.html')); });
app.get('/library', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'library.html')); });
app.get('/status', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'status.html')); });

// Direct extension download (zero-permission, no Google Drive auth needed)
app.get('/download/bet-bot-dk-sync.zip', (req, res) => {
  const zipPath = path.join(__dirname, 'dk-extension-v3.3.zip');
  if (!fs.existsSync(zipPath)) {
    try {
      require('child_process').execSync('zip -r dk-extension-v3.3.zip dk-extension -x "*.DS_Store"', { cwd: __dirname });
    } catch (_) {}
  }
  res.download(zipPath, 'bet-bot-dk-sync-v3.3.zip');
});
app.get('/extension', (req, res) => {
  res.redirect('/download/bet-bot-dk-sync.zip');
});

// Patterns page
app.get('/patterns', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'patterns.html')); });

// Settled bets (from the P&L ledger) that belong to a fight: the selection is one of the fighters,
// and the bet was placed from an hour before the fight started until 10 min after it ended.
function betsOnFight(fightTitle, startTime, endTime, user) {
  const names = (fightTitle || '').split(/ vs /i).map(n => n.trim().toLowerCase()).filter(Boolean);
  if (!names.length || !startTime) return [];
  const from = new Date(startTime).getTime() - 60 * 60 * 1000;
  const to = (endTime ? new Date(endTime).getTime() : Date.now()) + 10 * 60 * 1000;
  return pnlLedger.filter(e => {
    if (e.userId !== user || !e.selection || !e.placementDate) return false;
    if (!names.includes(e.selection.trim().toLowerCase())) return false;
    const t = Date.parse(e.placementDate);
    return t >= from && t <= to;
  });
}

// Round-by-round pattern analysis across all recorded fights
app.get('/api/patterns', (req, res) => {
  const user = req.query.user || 'ish';
  try {
    const files = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json') && f.includes('_vs_'));
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
          bets: (() => {
            const b = betsOnFight(d.fightTitle, d.startTime, d.endTime, user);
            return {
              count: b.length,
              wagered: b.reduce((t, e) => t + (parseFloat(e.stake) || 0), 0),
              net: b.reduce((t, e) => t + (e.profit || 0), 0),
            };
          })(),
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
        bets: {
          user,
          fightsWithBets: g.filter(r => r.bets.count > 0).length,
          count: g.reduce((t, r) => t + r.bets.count, 0),
          wagered: Math.round(g.reduce((t, r) => t + r.bets.wagered, 0) * 100) / 100,
          net: Math.round(g.reduce((t, r) => t + r.bets.net, 0) * 100) / 100,
        },
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
    // historical_data holds UFC fight recordings only. Fight files are named <fighter>_vs_<fighter>_<date>.json
    const mmaFiles = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json') && f.includes('_vs_'));
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
    // Deduplicate: same fighters (order-independent) + same date → keep highest dataPoints
    const fightKey = r => {
      const [a, b] = [r.fighter1, r.fighter2].map(n => n.toLowerCase().replace(/[^a-z0-9]/g, '')).sort();
      return `${a}|${b}|${r.date}`;
    };
    const byKey = {};
    for (const r of clean) {
      const key = fightKey(r);
      if (!byKey[key] || r.dataPoints > byKey[key].dataPoints) byKey[key] = r;
    }
    const deduped = Object.values(byKey);
    deduped.sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.startTime||'').localeCompare(a.startTime||''));
    res.json(deduped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compares the canonical Odds-API recording against the extension's independent DOM
// capture for the same fight (see CLAUDE.md "PRIORITY #1" — this is the tool that lets
// Ish/us actually answer "which source captures more of the real live odds movement"
// instead of manually diffing <id>.json vs <id>_ext.json by hand after every card.
app.get('/api/ext-capture-comparison', (req, res) => {
  try {
    function scan(dir, sportLabel) {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.json'))
        .map(e => ({ name: e.name, fullPath: path.join(dir, e.name), sport: sportLabel }));
    }
    let files = scan(HISTORICAL_DIR, 'UFC/MMA');
    const subdirs = fs.readdirSync(HISTORICAL_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'api_cache');
    for (const d of subdirs) files = files.concat(scan(path.join(HISTORICAL_DIR, d.name), d.name));

    // Group by base id (strip the _ext suffix so a pair collapses to one key)
    const byBaseId = new Map();
    for (const f of files) {
      const isExt = f.name.endsWith('_ext.json');
      const baseId = f.name.replace(/(_ext)?\.json$/, '');
      if (!byBaseId.has(baseId)) byBaseId.set(baseId, { baseId, sport: f.sport, odds: null, ext: null });
      const entry = byBaseId.get(baseId);
      if (isExt) entry.ext = f.fullPath; else entry.odds = f.fullPath;
    }

    const readSummary = filePath => {
      try {
        const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const h = d.oddsHistory || [];
        return {
          dataPoints: d.dataPoints || h.length,
          startTime: d.startTime || h[0]?.timestamp || null,
          endTime: d.endTime || h[h.length - 1]?.timestamp || null,
        };
      } catch { return null; }
    };

    const comparisons = [];
    for (const { baseId, sport, odds, ext } of byBaseId.values()) {
      if (!odds || !ext) continue; // only interested in pairs — nothing to compare otherwise
      const oddsApi = readSummary(odds);
      const extCap = readSummary(ext);
      if (!oddsApi || !extCap) continue;
      comparisons.push({
        id: baseId,
        sport,
        oddsApi: { dataPoints: oddsApi.dataPoints, startTime: oddsApi.startTime, endTime: oddsApi.endTime },
        ext: { dataPoints: extCap.dataPoints, startTime: extCap.startTime, endTime: extCap.endTime },
        richerSource: extCap.dataPoints > oddsApi.dataPoints ? 'ext'
          : oddsApi.dataPoints > extCap.dataPoints ? 'oddsApi' : 'tie',
        dataPointGapPct: oddsApi.dataPoints
          ? Math.round(((extCap.dataPoints - oddsApi.dataPoints) / oddsApi.dataPoints) * 1000) / 10
          : null,
      });
    }
    comparisons.sort((a, b) => (b.oddsApi.startTime || '').localeCompare(a.oddsApi.startTime || ''));
    res.json({ pairsFound: comparisons.length, comparisons });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full odds history for a specific fight (for graphing)
app.get('/api/fight-history/:fightId', (req, res) => {
  try {
    const id = req.params.fightId;

    // Collect all .json files from flat dir + one level of sport subfolders
    function allJsonFiles(dir) {
      if (!fs.existsSync(dir)) return [];
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          results.push({ name: entry.name, fullPath: path.join(dir, entry.name) });
        } else if (entry.isDirectory()) {
          const sub = path.join(dir, entry.name);
          for (const f of fs.readdirSync(sub)) {
            if (f.endsWith('.json')) results.push({ name: f, fullPath: path.join(sub, f) });
          }
        }
      }
      return results;
    }

    const files = allJsonFiles(HISTORICAL_DIR);
    const stem = f => f.name.replace('.json', '');
    // 1. Exact match
    let match = files.find(f => stem(f) === id);
    // 2. Strip mma__/mma_ prefix
    if (!match) { const s = id.replace(/^mma__?/, ''); match = files.find(f => stem(f) === s); }
    // 3. Prefix match (no date)
    if (!match) {
      const bare = id.replace(/^mma__?/, '');
      match = files.find(f => f.name.startsWith(bare + '_') || f.name.startsWith(id + '_'));
    }
    if (!match) return res.status(404).json({ error: 'Fight not found', id });
    res.json(JSON.parse(fs.readFileSync(match.fullPath)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fighter history lookup
app.get('/api/fighter/:name', (req, res) => {
  try { res.json(findFighterHistory(req.params.name, 5)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Fighter career stats & volatility capsule ──────────────────────────────
const { loadFighterProfiles, fightVolatilityScore, computeGasTankRating, computeFirstRoundFinisher } = require('./fighter_stats');
const { fetchLiveFightStats } = require('./live_fight_stats');
const { getSharpComparison } = require('./sharp_consensus');
const { predictCrossover } = require('./crossover_predictor');

let _fighterProfilesCache = null;
function getFighterProfiles() {
  if (!_fighterProfilesCache) {
    try { _fighterProfilesCache = loadFighterProfiles(); }
    catch (_) { _fighterProfilesCache = {}; }
  }
  return _fighterProfilesCache;
}

function normFighter(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lookupFighter(name, profiles) {
  if (!name || !profiles) return null;
  if (profiles[name]) return profiles[name];
  const q = normFighter(name);
  return Object.values(profiles).find(p => normFighter(p.name) === q) || null;
}

// Live in-fight strikes, takedowns, and control time
// Sharp Book Consensus (Pinnacle vs DraftKings)
app.get('/api/sharp-consensus', async (req, res) => {
  try {
    const { f1, f2, o1, o2 } = req.query;
    if (!f1 || !f2) return res.status(400).json({ error: "Missing f1 or f2 parameters" });
    const num1 = o1 ? parseInt(o1) : null;
    const num2 = o2 ? parseInt(o2) : null;
    const comp = await getSharpComparison(f1, f2, isNaN(num1) ? null : num1, isNaN(num2) ? null : num2);
    res.json(comp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live-fight-stats', async (req, res) => {
  try {
    const { f1, f2 } = req.query;
    if (!f1 || !f2) return res.status(400).json({ error: "Missing f1 or f2 parameters" });
    const stats = await fetchLiveFightStats(f1, f2);
    if (!stats) return res.json({ available: false });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/fighter-stats', (req, res) => {
  try {
    const { f1, f2, name, o1, o2 } = req.query;
    const profiles = getFighterProfiles();

    if (name) {
      const p = lookupFighter(name, profiles);
      return res.json({ profile: p ? { name: p.name, stats: p.stats, volatility: p.volatility } : null });
    }

    if (f1 || f2) {
      const p1 = lookupFighter(f1, profiles);
      const p2 = lookupFighter(f2, profiles);
      const fightVol = fightVolatilityScore(f1, f2, profiles);

      let crossover = null;
      if (o1 != null && o2 != null && o1 !== '' && o2 !== '') {
        try {
          crossover = predictCrossover({
            f1OpeningOdds: o1,
            f2OpeningOdds: o2,
            f1Name: f1,
            f2Name: f2,
            profiles
          });
        } catch (_) {}
      }

      return res.json({
        f1: p1 ? {
          name: p1.name,
          stats: p1.stats,
          volatility: p1.volatility,
          winMethods: p1.winMethods || null,
          sigPositions: p1.sigPositions || null,
          gasTank: computeGasTankRating(p1.stats),
          finisher: computeFirstRoundFinisher(p1.stats)
        } : null,
        f2: p2 ? {
          name: p2.name,
          stats: p2.stats,
          volatility: p2.volatility,
          winMethods: p2.winMethods || null,
          sigPositions: p2.sigPositions || null,
          gasTank: computeGasTankRating(p2.stats),
          finisher: computeFirstRoundFinisher(p2.stats)
        } : null,
        fightVolatility: fightVol,
        crossover
      });
    }

    res.status(400).json({ error: 'Missing f1/f2 or name parameters' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
// DK state lives on the persistent volume (DATA_DIR), NOT in the app folder. Railway wipes the app
// folder on every deploy, which erased Ish's bets and the P&L ledger (2026-10-19).
const DK_STATE_DIR = path.join(process.env.DATA_DIR || __dirname, 'dk_state');
if (!fs.existsSync(DK_STATE_DIR)) fs.mkdirSync(DK_STATE_DIR, { recursive: true });
const DK_CAPTURES_FILE = path.join(DK_STATE_DIR, 'dk_captures.json');
let dkCaptures = [];
try { dkCaptures = JSON.parse(fs.readFileSync(DK_CAPTURES_FILE, 'utf8')); } catch (_) {}

function saveDKCaptures() {
  try { fs.writeFileSync(DK_CAPTURES_FILE, JSON.stringify(dkCaptures.slice(0, 200))); } catch (_) {}
}

// DK's bet-placement flow (wager/v1/getPurchases, placeBets) identifies each selection only by
// id (e.g. "0ML86744453_1"). The outcome name lives in sportscontent payloads as
// { id, label, marketId }. Learn id → label from every payload we see so purchase bets get names.
const dkSelectionLabels = new Map();
function learnSelectionLabels(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) { for (const x of node) learnSelectionLabels(x, depth + 1); return; }
  const id = node.id || node.selectionId;
  const label = node.betSlipLine || node.selectionDisplayName || node.label || (typeof node.name === 'string' && node.id ? node.name : null);
  if (typeof id === 'string' && typeof label === 'string' && label.trim()) {
    dkSelectionLabels.set(id, label.trim());
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') learnSelectionLabels(v, depth + 1);
}

function backfillMissingSelectionLabels() {
  let updated = false;
  for (const [uid, bets] of dkBetsByUser) {
    for (const b of bets) {
      if ((!b.selection || b.selection === '') && b.selectionId && dkSelectionLabels.has(b.selectionId)) {
        b.selection = dkSelectionLabels.get(b.selectionId);
        updated = true;
      }
    }
  }
  if (updated) saveDKBets();
}
for (const c of dkCaptures) learnSelectionLabels(c.data);
setTimeout(backfillMissingSelectionLabels, 1000);

// getPurchases/placeBets shape: purchases[].bets[] with betId/status/stake/potentialReturns.
// Flatten into the same per-bet shape the WS parser produces so these bets are stored
// instead of silently dropped (they were: parseDKBets only knew the WS shapes).
function flattenPurchases(purchases) {
  const out = [];
  for (const p of purchases) {
    for (const b of p.bets || []) {
      const sels = b.selectionsMapped?.length ? b.selectionsMapped : (p.selections || []);
      const primarySelId = sels[0]?.id;
      const full = (p.selections || []).find(ps => ps.id === primarySelId) || sels[0] || {};
      const displayOdds = b.displayOdds || full.displayOdds || '';
      out.push({
        betId: b.receiptId || b.betId || p.id || p.waitingBetId,
        status: b.settlementStatus || b.status || p.status,
        type: b.type,
        stake: b.stake,
        potentialReturns: b.potentialReturns,
        displayOdds: typeof displayOdds === 'object' ? (displayOdds.american || '') : displayOdds,
        placementDate: p.creationDate || b.statusUpdateTime || new Date().toISOString(),
        selectionId: primarySelId,
        selections: sels.map(s => {
          const sFull = (p.selections || []).find(ps => ps.id === s.id) || s;
          const sOdds = sFull.displayOdds || '';
          return {
            id: s.id,
            selectionDisplayName: dkSelectionLabels.get(s.id) || '',
            marketDisplayName: '',
            displayOdds: typeof sOdds === 'object' ? (sOdds.american || '') : sOdds,
          };
        }),
      });
    }
  }
  return out;
}

app.post('/api/dk-sync', (req, res) => {
  try {
    const { url, data, ts, userId } = req.body || {};
    if (!url || !data) return res.status(400).json({ error: 'missing fields' });

    dkCaptures.unshift({ url, data, ts, userId });
    if (dkCaptures.length > 200) dkCaptures.length = 200;
    saveDKCaptures();
    learnSelectionLabels(data);
    backfillMissingSelectionLabels();

    const bets = parseDKBets(url, data, userId);
    dkHeartbeat.lastBetSync = Date.now(); // any WS activity = extension is alive on mybets
    if (bets.length) {
      console.log(`[DK sync] ${bets.length} bets from ${userId || 'unknown'} via ${url}`);
    }

    res.json({ received: true, url, bets });
  } catch (err) {
    console.error('[DK sync] Error processing sync:', err);
    res.status(500).json({ received: false, error: err.message, bets: [] });
  }
});

app.get('/api/dk-captures', (req, res) => {
  res.json(dkCaptures);
});

app.delete('/api/dk-captures', requireAdmin, (req, res) => {
  dkCaptures = [];
  saveDKCaptures();
  res.json({ ok: true });
});

const dkBetsByUser = new Map(); // userId → bets[]
const DEFAULT_USER = 'default';
const DK_BETS_FILE = path.join(DK_STATE_DIR, 'dk_bets_by_user.json');

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

// ── P&L history ledger ────────────────────────────────────────────────────────
// syncPnL() in the dashboard already computes today's P&L live from /api/dk-bets,
// but nothing persists it — once a bet ages out of DK's own feed, that day's
// result is gone. This ledger records each straight bet exactly once, the moment
// it's first observed transitioning from Open to a terminal status, so /api/pnl-history
// can report profit over a week/month/all-time, not just today.
const PNL_LEDGER_FILE = path.join(DK_STATE_DIR, 'pnl_ledger.json');
let pnlLedger = [];
try { pnlLedger = JSON.parse(fs.readFileSync(PNL_LEDGER_FILE, 'utf8')); } catch (_) {}
const loggedPnLBetIds = new Set(pnlLedger.map(e => e.betId));

function savePnLLedger() {
  try { fs.writeFileSync(PNL_LEDGER_FILE, JSON.stringify(pnlLedger)); } catch (_) {}
}

// Mirrors betProfit() in public/index.html's syncPnL() exactly (see test.js
// testPnLNullReturns — the Ish draw-bet-bug fix: DK sometimes sends returns=0/null
// for a won bet, so fall back to potentialReturns rather than reporting a loss).
function betProfit(b) {
  const status = (b.status || '').toLowerCase();
  const stake = parseFloat(b.stake || 0);
  if (status === 'won') {
    const rawRet = parseFloat(b.returns);
    const payout = (rawRet > 0) ? rawRet : parseFloat(b.potentialReturns || 0);
    return payout > stake ? payout - stake : payout;
  }
  if (status === 'lost') return -stake;
  if (status === 'push') return 0;
  return 0;
}

// Only logs a bet when DK's payload gives us an EXPLICIT terminal status
// (Won/Lost/Push) for a bet that was previously Open (or previously unseen —
// covers the case where the very first sync we ever see a bet in already
// shows it settled). If a bet instead just silently disappears from a later
// `initial.bets` snapshot with no status ever observed, it is deliberately
// NOT logged — guessing win/loss without DK ever telling us would risk
// recording a wrong dollar amount, which is worse than a missing data point.
function recordPnLTransitions(uid, existingBets, newBets) {
  const prevStatusById = new Map(existingBets.map(b => [b.betId, (b.status || '').toLowerCase()]));
  let changed = false;
  for (const b of newBets) {
    if (b.isParlay || !b.betId || loggedPnLBetIds.has(b.betId)) continue;
    const status = (b.status || '').toLowerCase();
    if (status !== 'won' && status !== 'lost' && status !== 'push') continue;
    const prevStatus = prevStatusById.get(b.betId);
    if (prevStatus === status) continue; // already settled as this status last sync — not a new transition
    pnlLedger.push({
      betId: b.betId, userId: uid, selection: b.selection, market: b.market,
      stake: b.stake, status: b.status, profit: betProfit(b),
      placementDate: b.placementDate, settledAt: new Date().toISOString(),
    });
    loggedPnLBetIds.add(b.betId);
    changed = true;
  }
  if (changed) savePnLLedger();
}

function parseDKBets(url, data, userId) {
  // DK's WS sends two distinct shapes: `initial.bets` is the FULL current open-bets
  // list (safe to fully replace stored state with — this is how settled/fake bets get
  // cleared). `update.bets` is an INCREMENTAL delta (e.g. just the bet you just placed) —
  // replacing wholesale on an update wipes out every other open bet the user already had
  // (e.g. betting on two different soccer games in a row: the second bet's `update` delta
  // used to erase the first bet entirely). Only merge on update; still full-replace on initial.
  const isFullSnapshot = !!data?.result?.initial?.bets;
  // purchases (getPurchases/placeBets) are per-purchase, not a full snapshot → merge by betId
  const isPurchasePayload = Array.isArray(data?.purchases) ||
    (Array.isArray(data?.bets) && (data?.selections || data?.creationDate || data?.waitingBetId || url?.includes('placeBets') || url?.includes('calculateBets')));
  const purchasesList = Array.isArray(data?.purchases) ? data.purchases : (isPurchasePayload ? [data] : null);

  const rawBets =
    data?.result?.initial?.bets ||
    data?.result?.update?.bets ||
    (purchasesList ? flattenPurchases(purchasesList) : null) ||
    data?.bets || data?.Bets || data?.entries || data?.wagers ||
    (Array.isArray(data?.data) ? data.data : []);

  if (!Array.isArray(rawBets) || !rawBets.length) return [];

  const bets = rawBets.map(b => {
    const sel = b.selections?.[0] || {};
    const primarySelId = b.selectionId || sel.id || sel.selectionId || b.selectionsMapped?.[0]?.id;
    let resolvedSelection = sel.selectionDisplayName || (primarySelId ? dkSelectionLabels.get(primarySelId) : '') || '';

    // Smart Fallback: If label not yet in dkSelectionLabels, check active fights by odds & sport
    if (!resolvedSelection) {
      const rawOdds = (sel.displayOdds || b.displayOdds || '').replace(/[^0-9+-]/g, '');
      const oddsNum = parseInt(rawOdds);
      if (!isNaN(oddsNum) && recorderState && recorderState.extCaptures) {
        for (const [id, rec] of recorderState.extCaptures) {
          if (rec.lastOdds) {
            if (rec.lastOdds.fighter1?.numericOdds === oddsNum) { resolvedSelection = rec.lastOdds.fighter1.name; break; }
            if (rec.lastOdds.fighter2?.numericOdds === oddsNum) { resolvedSelection = rec.lastOdds.fighter2.name; break; }
          }
        }
      }
    }
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
      selection: resolvedSelection,
      selectionId: primarySelId,
      market: sel.marketDisplayName || '',
      odds: (sel.displayOdds || b.displayOdds || '').replace(/−/g, '-'),
      stake: b.stake,
      potentialReturns: b.potentialReturns,
      returns: b.returns,
      placementDate: b.placementDate || new Date().toISOString(),
      isParlay,
      numLegs,
    };
  });

  const uid = userId || DEFAULT_USER;
  const existing = dkBetsByUser.get(uid) || [];
  recordPnLTransitions(uid, existing, bets);
  if (isFullSnapshot) {
    dkBetsByUser.set(uid, bets);
  } else {
    const byId = new Map(existing.map(b => [b.betId, b]));
    for (const b of bets) byId.set(b.betId, b);
    dkBetsByUser.set(uid, Array.from(byId.values()));
  }
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

// Persistent P&L over time — same math as the dashboard's today-only syncPnL(),
// but reading from the ledger so it survives past today. range: 'week' | 'month' | 'all'.
app.get('/api/pnl-history', (req, res) => {
  const userId = req.query.user || DEFAULT_USER;
  const range = req.query.range || 'week';
  const now = Date.now();
  const rangeMs = range === 'month' ? 30 * 24 * 60 * 60 * 1000
    : range === 'all' ? Infinity
    : 7 * 24 * 60 * 60 * 1000;

  const entries = pnlLedger.filter(e =>
    e.userId === userId && (now - new Date(e.settledAt).getTime()) <= rangeMs
  );

  const net = entries.reduce((s, e) => s + e.profit, 0);
  const wagered = entries.reduce((s, e) => s + parseFloat(e.stake || 0), 0);
  const wins = entries.filter(e => (e.status || '').toLowerCase() === 'won').length;
  const losses = entries.filter(e => (e.status || '').toLowerCase() === 'lost').length;
  const pushes = entries.filter(e => (e.status || '').toLowerCase() === 'push').length;
  const decided = wins + losses; // pushes don't count toward win rate
  const winRatePct = decided ? Math.round((wins / decided) * 1000) / 10 : null;

  res.json({ userId, range, net, wagered, wins, losses, pushes, winRatePct, count: entries.length });
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

app.post('/api/dk-mock', requireAdmin, (req, res) => {
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

app.get('/api/sport/:key', async (req, res) => {
  try {
    const url = `${BASE_URL}/sports/${req.params.key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    const { data, headers } = await fetchJson(url);
    updateOddsCredits(headers);
    res.json(Array.isArray(data) ? data : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function updateOddsCredits(headers) {
  if (headers['x-requests-used']) _oddsApiCreditsUsed = parseInt(headers['x-requests-used']);
  if (headers['x-requests-remaining']) _oddsApiCreditsRemaining = parseInt(headers['x-requests-remaining']);
}

app.get('/api/usage', (req, res) => {
  res.json({
    sessionTokensUsed: totalTokensUsed,
    sessionQueries: totalQueries,
    estimatedCostUSD: +(totalTokensUsed / 1_000_000 * 3).toFixed(3),
    warnThreshold: TOKEN_WARN,
  });
});

// Health check — Railway restarts service if this returns non-200
app.get('/health', async (req, res) => {
  const lastPoll = recorderState.lastPoll ? new Date(recorderState.lastPoll) : null;
  const staleSec = lastPoll ? Math.floor((Date.now() - lastPoll) / 1000) : null;
  const stale = staleSec === null || staleSec > 600; // >10 min = unhealthy
  if (stale) return res.status(503).json({ status: 'unhealthy', staleSec, lastPoll: recorderState.lastPoll });
  res.json({ status: 'ok', build: BUILD_TAG, node: process.version, athleteDb: await require('./athlete_db').counts(), dkStateDir: DK_STATE_DIR, staleSec, recording: recorderState.activeFights.size > 0, lastPoll: recorderState.lastPoll });
});

app.get('/api/recorder/status', (req, res) => {
  const includeHistory = req.query.history === '1';
  // Normalize odds slots: extension may push fighters in reversed DOM order.
  // If lastOdds.fighter1.name doesn't match meta.fighter1, swap both lastOdds and oddsHistory slots.
  const active = [...recorderState.activeFights.entries()].map(([id, r]) => {
    const lo = r.lastOdds;
    const reversed = lo && lo.fighter1 && lo.fighter1.name !== r.meta.fighter1;
    const normLast = !lo ? null : reversed
      ? { ...lo, fighter1: lo.fighter2, fighter2: lo.fighter1 }
      : lo;
    const normHistory = includeHistory
      ? (reversed ? r.oddsHistory.map(e => ({ ...e, fighter1: e.fighter2, fighter2: e.fighter1 })) : r.oddsHistory)
      : undefined;
    return {
      id,
      sport: r.meta.label,
      fighter1: r.meta.fighter1,
      fighter2: r.meta.fighter2,
      startTime: r.meta.startTime,
      dataPoints: r.oddsHistory.length,
      lastOdds: normLast,
      ...(includeHistory ? { oddsHistory: normHistory } : {}),
    };
  });
  // Compute actual poll rate from history (median gap between last polls)
  const ph = recorderState.pollHistory;
  let pollRateMs = null;
  if (ph.length >= 2) {
    const gaps = [];
    for (let i = 1; i < ph.length; i++) gaps.push(ph[i] - ph[i-1]);
    gaps.sort((a,b) => a-b);
    pollRateMs = gaps[Math.floor(gaps.length / 2)]; // median gap
  }
  res.json({
    recording: active.length > 0,
    activeFights: active,
    totalSaved: recorderState.totalSaved,
    apiErrors: recorderState.apiErrors,
    extPushes: recorderState.extPushes,
    lastExtPush: recorderState.lastExtPush,
    graceMs: RECORDER_GRACE_MS,
    ...extPushStats(),
    lastDelayMs: recorderState.lastDelayMs,
    lastPoll: recorderState.lastPoll,
    pollRateMs,
    pollHistory: ph.slice(-10),
    watching: ['UFC/MMA (always)', ...(() => { const w=clientWatching; if(!w||Date.now()-w.ts>=120000) return []; return [w.team1?`${w.team1} vs ${w.team2}`:SPORT_META[w.sport]?.label||w.sport]; })()],
  });
});

// Verify backup config — call this to confirm GitHub + volume are wired up
app.get('/api/recorder/backup-status', async (req, res) => {
  // Real checks, not just "env var is set": token is verified against GitHub, and the
  // backup queue must be empty. Previously this reported ok:true while every push failed.
  const github = await checkGitHubAccess();
  const volumeActive = !!(process.env.DATA_DIR && process.env.DATA_DIR !== __dirname);
  res.json({
    github,
    dataDir:       process.env.DATA_DIR || null,
    volumeActive,
    historicalDir: HISTORICAL_DIR,
    stats:         backupStats,
    ok: !!(github.ok && volumeActive && backupStats.pending === 0),
  });
});

// Moves every non-UFC sport folder out of the library into quarantine_non_ufc/ on the volume.
// Nothing is deleted. A folder is skipped if its destination already exists.
const KEEP_HISTORICAL_DIRS = new Set(['api_cache', 'mma_mixed_martial_arts']);
// Moves ONE recording out of the library into quarantine_non_ufc/ (nothing deleted).
app.post('/api/admin/quarantine-recording', requireAdmin, (req, res) => {
  try {
    const id = String(req.body?.id || '');
    if (!id || /[\/\\]/.test(id)) return res.status(400).json({ error: 'bad id' });
    const src = path.join(HISTORICAL_DIR, `${id}.json`);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'not found' });
    const qdir = path.join(path.dirname(HISTORICAL_DIR), 'quarantine_non_ufc');
    if (!fs.existsSync(qdir)) fs.mkdirSync(qdir, { recursive: true });
    const dest = path.join(qdir, `${id}.json`);
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'destination exists' });
    fs.renameSync(src, dest);
    res.json({ ok: true, moved: id, to: dest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/quarantine-non-ufc', requireAdmin, (req, res) => {
  try {
    const qdir = path.join(path.dirname(HISTORICAL_DIR), 'quarantine_non_ufc');
    if (!fs.existsSync(qdir)) fs.mkdirSync(qdir, { recursive: true });
    const moved = [], skipped = [];
    // Root files that are not fight recordings (no "_vs_" in the name) also leave historical_data.
    for (const ent of fs.readdirSync(HISTORICAL_DIR, { withFileTypes: true })) {
      if (ent.isDirectory() || !ent.name.endsWith('.json') || ent.name.includes('_vs_')) continue;
      const dest = path.join(qdir, ent.name);
      if (fs.existsSync(dest)) { skipped.push({ file: ent.name, reason: 'destination exists' }); continue; }
      fs.renameSync(path.join(HISTORICAL_DIR, ent.name), dest);
      moved.push({ file: ent.name });
    }
    for (const ent of fs.readdirSync(HISTORICAL_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory() || KEEP_HISTORICAL_DIRS.has(ent.name)) continue;
      const dest = path.join(qdir, ent.name);
      const files = fs.readdirSync(path.join(HISTORICAL_DIR, ent.name)).length;
      if (fs.existsSync(dest)) { skipped.push({ folder: ent.name, reason: 'destination exists' }); continue; }
      fs.renameSync(path.join(HISTORICAL_DIR, ent.name), dest);
      moved.push({ folder: ent.name, files });
    }
    res.json({ ok: true, quarantineDir: qdir, moved, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serves a cached fighter photo by name (404 when we have none, so the page hides the image).
app.get('/api/fighter-photo', (req, res) => {
  const file = fighterImages.imageFileFor(String(req.query.name || ''));
  if (!file) return res.status(404).end();
  res.sendFile(file);
});

app.get('/api/admin/fighter-images', requireAdmin, (req, res) => res.json(fighterImages.status()));
// Full UFC roster crawl: every event, every fighter, each fighter's page into the database + photo.
// Runs in the background, one request every 15 s. Returns at once; poll roster-status.
const roster = require('./roster');
app.post('/api/admin/roster-start', requireAdmin, (req, res) => {
  if (roster.status().running) return res.json({ ok: true, alreadyRunning: true, ...roster.status() });
  roster.run().catch(e => console.error('[roster]', e.message));
  res.json({ ok: true, started: true, ...roster.status() });
});
app.get('/api/admin/roster-status', requireAdmin, (req, res) => res.json(roster.status()));
// Removes cached photos shared by more than one fighter (generic images) and marks those fighters for refetch.
app.post('/api/admin/fighter-photos-audit', requireAdmin, (req, res) => {
  const groups = fighterImages.auditSharedPhotos();
  const wrongSource = fighterImages.auditWrongSourcePhotos();
  res.json({ ok: true, sharedGroups: groups.length, fightersAffected: groups.reduce((n, g) => n + g.length, 0), wrongSourceRemoved: wrongSource.length, wrongSource });
});

// Queues every UFC fighter found in our fight files (or the names given) for the photo + athlete-page job.
// Runs one request every 15 seconds. Safe to call again: fighters already done are skipped.
app.post('/api/admin/fighter-backfill', requireAdmin, (req, res) => {
  try {
    let names = Array.isArray(req.body?.names) ? req.body.names : null;
    if (!names) {
      names = new Set();
      for (const f of fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json') && f.includes('_vs_'))) {
        const d = JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, f), 'utf8'));
        for (const n of (d.fightTitle || '').split(/ vs /i)) if (n.trim()) names.add(n.trim());
      }
      names = [...names];
    }
    fighterImages.requestFighterImages(names);
    res.json({ ok: true, queued: names.length, status: fighterImages.status() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually triggers a volume-vs-GitHub reconcile (safe: never overwrites a remote file).
app.post('/api/recorder/backup-reconcile', requireAdmin, async (req, res) => {
  try { res.json(await reconcileBackups()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Extension pushes live DK DOM odds directly off the page Ish has open — completely
// independent of the Odds API recorder above. Written to its own "<id>_ext.json" file
// so the two sources never overwrite each other and can be diffed after the fact to see
// which one actually captures more of the fight's live odds movement.
const EXT_CAPTURE_IDLE_MS = 5 * 60 * 1000; // no push for 5 min → assume Ish closed/left the tab, save + close out

function findOrCreateExtCapture(sport, fighter1, fighter2) {
  const pf1 = fighter1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pf2 = fighter2.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [id, record] of recorderState.extCaptures) {
    const rf1 = (record.meta.fighter1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rf2 = (record.meta.fighter2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = (rf1.slice(0,6) === pf1.slice(0,6) && rf2.slice(0,6) === pf2.slice(0,6)) ||
                  (rf1.slice(0,6) === pf2.slice(0,6) && rf2.slice(0,6) === pf1.slice(0,6));
    if (match) return { id, record };
  }
  const [a, b] = [fighter1, fighter2].map(n => n.toLowerCase().replace(/[^a-z0-9]/g, '')).sort();
  const date = new Date().toISOString().slice(0, 10);
  const id = sport === 'mma_mixed_martial_arts' ? `${a}_vs_${b}_${date}` : `${sport.split('_')[0]}__${a}_vs_${b}_${date}`;
  const record = { meta: { sport, label: SPORT_META[sport]?.label || sport, fighter1, fighter2, startTime: new Date().toISOString(), source: 'extension' }, oddsHistory: [], lastOdds: null, lastPushTs: Date.now() };
  recorderState.extCaptures.set(id, record);
  console.log(`[ext-capture] New DOM capture started: ${id}`);
  return { id, record };
}

function extFilePath(sport, id) {
  return recFilePath(sport, id).replace(/\.json$/, '_ext.json');
}

function saveExtCapture(id) {
  const record = recorderState.extCaptures.get(id);
  recorderState.extCaptures.delete(id);
  if (!record) return;
  const result = recSaveRecord(id, record, { filePath: extFilePath(record.meta.sport, id) });
  if (!result.saved) {
    console.error(`[ext-capture] SAVE FAILED for ${id}: ${result.reason}`);
    return;
  }
  console.log(`[ext-capture] Saved: ${id} (${result.dataPoints} pts) → ${result.filePath}`);
  pushFightToGitHub(result.filePath);
}

// Sweep for idle ext captures every minute — independent of the Odds API recorder's
// own live/dead detection, since the whole point is to not depend on that.
setInterval(() => {
  const now = Date.now();
  for (const [id, record] of recorderState.extCaptures) {
    if (now - record.lastPushTs > EXT_CAPTURE_IDLE_MS) saveExtCapture(id);
  }
}, 60000);

// Times of recent extension pushes, for the rate and gap figures on /status.
const extPushTimes = [];
function extPushStats() {
  const now = Date.now();
  const lastMin = extPushTimes.filter(t => now - t <= 60000).length;
  const recent = extPushTimes.filter(t => now - t <= 600000);
  let maxGap = 0;
  for (let i = 1; i < recent.length; i++) maxGap = Math.max(maxGap, recent[i] - recent[i - 1]);
  return { pushesLastMinute: lastMin, maxGapSecondsLast10Min: Math.round(maxGap / 100) / 10 };
}

app.post('/api/dk-odds-push', (req, res) => {
  const {sport='mma_mixed_martial_arts',fighter1,fighter2,numericOdds1,numericOdds2}=req.body||{};
  if(!fighter1||!fighter2||!numericOdds1||!numericOdds2)return res.status(400).json({error:'missing fields'});

  // Reject non-fighter junk labels (e.g. "1.7k people placed this bet")
  const JUNK = /placed this bet|same game parlay|cash out|popular|boost|sgp|live|round|\d+\.?\d*k?\s*people/i;
  if (JUNK.test(fighter1) || JUNK.test(fighter2) || fighter1.trim().length < 3 || fighter2.trim().length < 3) {
    return res.status(400).json({ error: 'invalid fighter name' });
  }

  recorderState.extPushes++;
  recorderState.lastExtPush=Date.now();
  extPushTimes.push(recorderState.lastExtPush); if (extPushTimes.length > 2000) extPushTimes.splice(0, extPushTimes.length - 2000);
  if (sport !== 'mma_mixed_martial_arts') return res.json({ ok: true, received: true, sport, stored: false, reason: 'UFC only' });
  const {id,record}=findOrCreateExtCapture(sport,fighter1,fighter2);

  const live = req.body.live !== false;
  const odds={timestamp:new Date().toISOString(),fighter1:{name:fighter1,numericOdds:+numericOdds1},fighter2:{name:fighter2,numericOdds:+numericOdds2},source:'extension',live};
  const L=record.lastOdds;
  const changed=!L||L.fighter1.numericOdds!==+numericOdds1||L.fighter2.numericOdds!==+numericOdds2;
  (record.samples=record.samples||[]).push({t:odds.timestamp,f1:+numericOdds1,f2:+numericOdds2,c:changed?1:0,live:live?1:0});

  // Dense 1-second recording: capture every single second into oddsHistory
  record.oddsHistory.push(odds);
  record.lastOdds=odds;
  record.lastPushTs=Date.now();
  res.json({ok:true,id,dataPoints:record.oddsHistory.length,samples:record.samples.length,live});
});

// Monitor page — displays pollRate, activeFights, and RECORDING status in real-time
app.get('/monitor', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Recorder Monitor — activeFights / pollRate / RECORDING</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#060606;color:#ccc;font-family:'Helvetica Neue',sans-serif;font-size:14px;padding:16px}
    h1{color:#e8b84b;font-size:1rem;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px}
    .status{font-size:2rem;font-weight:700;margin-bottom:12px}
    .status.ok{color:#69db7c}.status.warn{color:#e8b84b}.status.dead{color:#ff6b6b}
    .fight{background:#111;border:1px solid #1a1a1a;border-radius:8px;padding:12px 16px;margin-bottom:10px}
    .fight-name{font-size:1rem;font-weight:700;color:#fff;margin-bottom:4px}
    .fight-meta{font-size:0.75rem;color:#555;margin-bottom:6px}
    .odds{display:flex;gap:20px;font-size:0.85rem;font-weight:600;margin-bottom:6px}
    .f1{color:#e8b84b}.f2{color:#74c0fc}
    .pts{font-size:0.7rem;color:#444;margin-bottom:10px}
    .chart-wrap{height:160px;position:relative}
    .poll-bar{margin-top:16px;background:#111;border:1px solid #1a1a1a;border-radius:8px;padding:12px 16px}
    .poll-label{font-size:0.65rem;color:#444;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
    .poll-rate{font-size:1.5rem;font-weight:700}
    .poll-rate.good{color:#69db7c}.poll-rate.warn{color:#e8b84b}.poll-rate.bad{color:#ff6b6b}
    .poll-dots{display:flex;gap:4px;margin-top:8px;flex-wrap:wrap}
    .poll-dot{width:8px;height:8px;border-radius:50%}
    .idle{color:#333;font-size:0.85rem;margin-top:8px}
    .ts{font-size:0.65rem;color:#333;margin-top:16px}
    .file-browser{margin-top:16px;background:#111;border:1px solid #1a1a1a;border-radius:8px;padding:12px 16px}
    .file-browser-label{font-size:0.65rem;color:#444;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
    .file-list{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow-y:auto}
    .file-row{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;cursor:pointer;border:1px solid transparent}
    .file-row:hover{background:#1a1a1a;border-color:#2a2a2a}
    .file-row.active{background:#0d1f0d;border-color:#69db7c44}
    .file-name{font-size:0.75rem;color:#ccc;font-family:monospace}
    .file-pts{font-size:0.7rem;color:#444}
    .file-detail{margin-top:10px;background:#080808;border:1px solid #1a1a1a;border-radius:6px;padding:10px;display:none}
    .file-detail.open{display:block}
    .file-detail-head{font-size:0.75rem;color:#e8b84b;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
    .file-json{font-size:0.68rem;color:#888;font-family:monospace;white-space:pre;overflow-x:auto;max-height:320px;overflow-y:auto;line-height:1.5}
    .file-search{background:#0a0a0a;border:1px solid #222;border-radius:4px;color:#ccc;font-size:0.75rem;padding:5px 8px;width:100%;margin-bottom:8px;outline:none}
    .file-search:focus{border-color:#444}
    .compare-row{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;font-size:0.75rem;border:1px solid transparent}
    .compare-row:hover{background:#1a1a1a;border-color:#2a2a2a}
    .compare-id{color:#ccc;font-family:monospace}
    .compare-nums{color:#555}
    .compare-badge{font-size:0.65rem;padding:2px 7px;border-radius:3px;font-weight:700;margin-left:8px}
    .compare-badge.ext{background:#0d2200;color:#7ccd32}
    .compare-badge.oddsApi{background:#1a1500;color:#e8b84b}
    .compare-badge.tie{background:#141414;color:#666}
  </style>
</head>
<body>
  <h1>⚡ Recorder Monitor</h1>
  <div class="status" id="bigStatus">Loading…</div>
  <div id="fights"></div>
  <div class="poll-bar">
    <div class="poll-label">Actual Poll Rate (median last 10 polls)</div>
    <div class="poll-rate" id="pollRate">—</div>
    <div class="poll-dots" id="pollDots"></div>
  </div>
  <div class="ts" id="ts"></div>

  <div class="file-browser">
    <div class="file-browser-label">Stored Fight Files (most recent first)</div>
    <input class="file-search" id="fileSearch" placeholder="Search by fighter name…" oninput="filterFiles()"/>
    <div class="file-list" id="fileList">Loading…</div>
    <div class="file-detail" id="fileDetail">
      <div class="file-detail-head">
        <span id="fileDetailName"></span>
        <span id="fileDetailMeta" style="color:#555"></span>
      </div>
      <pre class="file-json" id="fileDetailJson"></pre>
    </div>
  </div>

  <div class="file-browser">
    <div class="file-browser-label">Ext-Capture vs Odds-API — data-point comparison (PRIORITY #1)</div>
    <div class="file-list" id="compareList">Loading…</div>
  </div>

<script>
const charts = {};

function fmt(o) { return o > 0 ? '+' + o : '' + o; }

function getOrCreateChart(id, canvasId, f1name, f2name) {
  if (charts[id]) return charts[id];
  const ctx = document.getElementById(canvasId).getContext('2d');
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: f1name, data: [], borderColor: '#e8b84b', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3 },
      { label: f2name, data: [], borderColor: '#74c0fc', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3 },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        x: { ticks: { color: '#333', font: { size: 9 }, maxTicksLimit: 6 }, grid: { color: '#1a1a1a' }, border: { color: '#222' } },
        y: { ticks: { color: '#444', font: { size: 9 }, callback: v => v > 0 ? '+' + v : '' + v }, grid: { color: '#1a1a1a' }, border: { color: '#222' } },
      },
      plugins: { legend: { display: true, labels: { color: '#888', font: { size: 10 }, boxWidth: 12 } }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + (c.raw > 0 ? '+' : '') + c.raw } } },
    },
  });
  return charts[id];
}

function updateChart(id, canvasId, f1name, f2name, history) {
  const chart = getOrCreateChart(id, canvasId, f1name, f2name);
  chart.data.labels = history.map(pt => new Date(pt.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  chart.data.datasets[0].label = f1name;
  chart.data.datasets[0].data = history.map(pt => pt.fighter1.numericOdds);
  chart.data.datasets[1].label = f2name;
  chart.data.datasets[1].data = history.map(pt => pt.fighter2.numericOdds);
  chart.update('none');
}

// Destroy charts for fights that are no longer active
function pruneCharts(activeIds) {
  for (const id of Object.keys(charts)) {
    if (!activeIds.has(id)) { charts[id].destroy(); delete charts[id]; }
  }
}

async function refresh() {
  try {
    const d = await fetch('/api/recorder/status?history=1').then(r => r.json());
    const now = Date.now();

    // Big status
    const lastPollAge = d.lastPoll ? (now - new Date(d.lastPoll).getTime()) : Infinity;
    const bigEl = document.getElementById('bigStatus');
    if (!d.lastPoll || lastPollAge > 120000) {
      bigEl.textContent = '🔴 RECORDER STALLED'; bigEl.className = 'status dead';
    } else if (d.recording) {
      bigEl.textContent = '🔴 RECORDING'; bigEl.className = 'status ok';
    } else {
      bigEl.textContent = '⚪ IDLE'; bigEl.className = 'status warn';
    }

    // Fights + graphs
    const fightsEl = document.getElementById('fights');
    const activeIds = new Set(d.activeFights.map(f => f.id));
    pruneCharts(activeIds);

    if (d.activeFights.length === 0) {
      fightsEl.innerHTML = '<div class="idle">No active recordings</div>';
    } else {
      d.activeFights.forEach(f => {
        const canvasId = 'chart-' + f.id.replace(/[^a-z0-9]/g, '-');
        let el = document.getElementById('fight-' + canvasId);
        if (!el) {
          el = document.createElement('div');
          el.id = 'fight-' + canvasId;
          el.className = 'fight';
          const ago = f.lastOdds ? Math.round((now - new Date(f.lastOdds.timestamp).getTime()) / 1000) : null;
          const f1o = f.lastOdds?.fighter1?.numericOdds;
          const f2o = f.lastOdds?.fighter2?.numericOdds;
          el.innerHTML =
            '<div class="fight-name">' + f.fighter1 + ' vs ' + f.fighter2 + '</div>' +
            '<div class="fight-meta">' + f.sport + ' · started ' + new Date(f.startTime).toLocaleTimeString() + '</div>' +
            '<div class="odds"><span class="f1">' + f.fighter1 + ' <span id="o1-' + canvasId + '">' + (f1o != null ? fmt(f1o) : '—') + '</span></span>' +
            '<span class="f2">' + f.fighter2 + ' <span id="o2-' + canvasId + '">' + (f2o != null ? fmt(f2o) : '—') + '</span></span></div>' +
            '<div class="pts" id="pts-' + canvasId + '">' + f.dataPoints + ' pts · ' + (ago == null ? '—' : ago < 30 ? 'moved ' + ago + 's ago' : 'stable ' + ago + 's (line frozen)') + '</div>' +
            '<div class="chart-wrap"><canvas id="' + canvasId + '"></canvas></div>';
          fightsEl.appendChild(el);
        } else {
          // Update live stats without rebuilding DOM
          const ago = f.lastOdds ? Math.round((now - new Date(f.lastOdds.timestamp).getTime()) / 1000) : null;
          const f1o = f.lastOdds?.fighter1?.numericOdds;
          const f2o = f.lastOdds?.fighter2?.numericOdds;
          const o1el = document.getElementById('o1-' + canvasId);
          const o2el = document.getElementById('o2-' + canvasId);
          const ptsEl = document.getElementById('pts-' + canvasId);
          if (o1el) o1el.textContent = f1o != null ? fmt(f1o) : '—';
          if (o2el) o2el.textContent = f2o != null ? fmt(f2o) : '—';
          if (ptsEl) ptsEl.textContent = f.dataPoints + ' pts · ' + (ago == null ? '—' : ago < 30 ? 'moved ' + ago + 's ago' : 'stable ' + ago + 's (line frozen)');
        }
        if (f.oddsHistory && f.oddsHistory.length > 1) {
          try { updateChart(f.id, canvasId, f.fighter1, f.fighter2, f.oddsHistory); }
          catch(ce) { console.warn('Chart error:', ce.message); }
        }
      });
    }

    // Poll rate
    const rateEl = document.getElementById('pollRate');
    const dotsEl = document.getElementById('pollDots');
    if (d.pollRateMs != null) {
      const s = (d.pollRateMs / 1000).toFixed(1);
      rateEl.textContent = s + 's';
      rateEl.className = 'poll-rate ' + (d.pollRateMs < 5000 ? 'good' : d.pollRateMs < 30000 ? 'warn' : 'bad');
    } else {
      rateEl.textContent = '—'; rateEl.className = 'poll-rate warn';
    }
    if (d.pollHistory && d.pollHistory.length > 1) {
      const dots = [];
      for (let i = 1; i < d.pollHistory.length; i++) {
        const gap = d.pollHistory[i] - d.pollHistory[i - 1];
        const color = gap < 5000 ? '#69db7c' : gap < 30000 ? '#e8b84b' : '#ff6b6b';
        dots.push('<div class="poll-dot" style="background:' + color + '" title="' + (gap / 1000).toFixed(1) + 's"></div>');
      }
      dotsEl.innerHTML = dots.join('');
    }

    document.getElementById('ts').textContent = 'Last poll: ' + (d.lastPoll ? new Date(d.lastPoll).toLocaleTimeString() : '—') +
      ' · ' + (lastPollAge < 9999000 ? Math.round(lastPollAge / 1000) + 's ago' : 'unknown');
  } catch (e) {
    document.getElementById('bigStatus').textContent = '🔴 SERVER ERROR';
    document.getElementById('bigStatus').className = 'status dead';
  }
  setTimeout(refresh, 2000);
}
refresh();

// ── File browser ──────────────────────────────────────────────────────────
let allFiles = [], selectedId = null;

async function loadFiles() {
  try {
    const data = await fetch('/api/recordings').then(r => r.json());
    allFiles = (Array.isArray(data) ? data : (data.fights || [])).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.dataPoints || 0) - (a.dataPoints || 0));
    renderFiles();
  } catch(e) {
    document.getElementById('fileList').textContent = 'Error loading files';
  }
}

function filterFiles() {
  const q = document.getElementById('fileSearch').value.toLowerCase();
  const filtered = q ? allFiles.filter(f => f.id.toLowerCase().includes(q) || (f.fighter1||'').toLowerCase().includes(q) || (f.fighter2||'').toLowerCase().includes(q)) : allFiles;
  renderFiles(filtered);
}

function renderFiles(files) {
  const list = files || allFiles;
  const el = document.getElementById('fileList');
  if (!list.length) { el.innerHTML = '<div style="color:#333;font-size:0.8rem">No files found</div>'; return; }
  el.innerHTML = list.map(f =>
    '<div class="file-row' + (f.id === selectedId ? ' active' : '') + '" data-id="' + f.id + '" onclick="selectFile(this.dataset.id)">' +
    '<span class="file-name">' + f.id + '.json</span>' +
    '<span class="file-pts">' + (f.dataPoints || 0) + ' pts</span>' +
    '</div>'
  ).join('');
}

async function selectFile(id) {
  selectedId = id;
  renderFiles();
  const detailEl = document.getElementById('fileDetail');
  const nameEl = document.getElementById('fileDetailName');
  const metaEl = document.getElementById('fileDetailMeta');
  const jsonEl = document.getElementById('fileDetailJson');
  detailEl.className = 'file-detail open';
  nameEl.textContent = id + '.json';
  jsonEl.textContent = 'Loading…';
  metaEl.textContent = '';
  try {
    const resp = await fetch('/api/fight-history/' + encodeURIComponent(id));
    const data = await resp.json();
    if (!resp.ok) { jsonEl.textContent = 'Error ' + resp.status + ': ' + (data.error || 'unknown'); return; }
    const h = data.oddsHistory || [];
    metaEl.textContent = h.length + ' pts · ' + (data.startTime ? new Date(data.startTime).toLocaleString() : '');
    // Show summary + first/last 3 data points so you can verify without scrolling 1000 lines
    const preview = {
      fightId: data.fightId,
      fightTitle: data.fightTitle,
      sport: data.sport,
      startTime: data.startTime,
      endTime: data.endTime,
      dataPoints: data.dataPoints,
      oddsHistory: h.length <= 6
        ? h
        : [ ...h.slice(0, 3), { '...': h.length - 6 + ' more points omitted' }, ...h.slice(-3) ],
    };
    jsonEl.textContent = JSON.stringify(preview, null, 2);
  } catch(e) {
    jsonEl.textContent = 'Error: ' + e.message;
  }
}

async function loadExtCompare() {
  const el = document.getElementById('compareList');
  try {
    const r = await (await fetch('/api/ext-capture-comparison')).json();
    if (!r.comparisons || !r.comparisons.length) {
      el.innerHTML = '<div style="color:#333;font-size:0.8rem">No fight has both an Odds-API recording and an extension capture yet — nothing to compare.</div>';
      return;
    }
    el.innerHTML = r.comparisons.map(function(c) {
      var badgeLabel = c.richerSource === 'ext' ? 'EXT RICHER' : c.richerSource === 'oddsApi' ? 'ODDS API RICHER' : 'TIE';
      var gap = c.dataPointGapPct != null ? (c.dataPointGapPct > 0 ? '+' : '') + c.dataPointGapPct + '%' : '';
      return '<div class="compare-row">' +
        '<span class="compare-id">' + c.id + '</span>' +
        '<span class="compare-nums">odds-api: ' + c.oddsApi.dataPoints + ' pts · ext: ' + c.ext.dataPoints + ' pts ' + gap +
        '<span class="compare-badge ' + c.richerSource + '">' + badgeLabel + '</span></span>' +
        '</div>';
    }).join('');
  } catch (e) {
    el.innerHTML = '<div style="color:#ff6b6b;font-size:0.8rem">Error loading comparison: ' + e.message + '</div>';
  }
}

loadFiles();
loadExtCompare();
</script>
</body>
</html>`);
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

// ── Recorder ────────────────────────────────────────────────────────────────
// UFC: always-on at 3s — events are rare (~20 hrs/mo) so very cheap
// Other sports: client-driven — browser sends heartbeat while watching, stops when tab closes

const UFC_POLL_MS      = 3000;
const OTHER_POLL_MS    = 5000;    // 5s while browser is open watching
const PREWARM_MS       = 15000;   // 15s when a fight starts within 10 min
const PREWARM_SLOW_MS  = 60000;   // 60s when a fight starts within 60 min
const IDLE_POLL_MS     = Number(process.env.IDLE_POLL_MS) || 300000; // 5 min when nothing is coming soon (env override for tests)

const SPORT_META = {
  'mma_mixed_martial_arts': { label: 'UFC/MMA',    window: 3 * 60 * 60 * 1000 },
  'soccer_fifa_world_cup':  { label: 'World Cup',  window: 130 * 60 * 1000 },
  'icehockey_nhl':          { label: 'NHL',        window: 4 * 60 * 60 * 1000 },
  'basketball_nba':         { label: 'NBA',        window: 3 * 60 * 60 * 1000 },
  'americanfootball_nfl':   { label: 'NFL',        window: 4 * 60 * 60 * 1000 },
  'baseball_mlb':           { label: 'MLB',        window: 4 * 60 * 60 * 1000 },
};

// Sports that are always polled (regardless of what the client browser is watching)
// UFC only. historical_data is for UFC fight recordings only; no other sport is recorded or stored.
const ALWAYS_POLL = ['mma_mixed_martial_arts'];

// Client heartbeat — single slot, last watched game wins
// If no ping for 2 min, recording stops
let clientWatching = null; // { ts, sport, team1, team2 }
app.post('/api/recorder/watch', (req, res) => {
  const { sport, team1, team2 } = req.body;
  if (sport && sport !== 'mma_mixed_martial_arts') { clientWatching = null; return res.json({ ok: true, ignored: 'UFC only' }); }
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
  reconcileBackups, checkGitHubAccess, backupStats,
} = require('./record_engine');

// Use the volume-aware path from record_engine everywhere in this file
HISTORICAL_DIR = REC_HISTORICAL_DIR;

// One-time volume migration (no-op if DATA_DIR not set)
migrateToVolume();

const recorderState = {
  activeFights:    loadPersistedState(), // reloads in-flight fights after crash/restart
  extCaptures:     new Map(), // DOM-scraped odds from the extension — separate from activeFights, not persisted
  totalSaved:      0,
  lastPoll:        null,
  pollHistory:     [], // last 20 poll timestamps — used by /monitor to show real poll rate
  failCounts:      {},   // sportKey → consecutive API failure count
  sessionFights:   [],   // fights saved this event night (for summary email)
  summaryTimer:    null, // fires end-of-event summary email after quiet period
  apiErrors:       0,    // total Odds API poll failures since boot
  extPushes:       0,    // extension odds pushes received (ext-capture cross-check)
  lastExtPush:     null,
  lastDelayMs:     null, // delay chosen for the most recent poll (drives the grace period)
};

// A fight must be missing from the feed for this long before its recording is ended.
// Odds API / DraftKings drop a live market for a moment between rounds; ending on the first
// empty poll split recordings into fragments, and each restart overwrote the earlier one.
const RECORDER_GRACE_MS = Number(process.env.RECORDER_GRACE_MS) || 3 * 60 * 1000;

// Continue a recording from its saved file, if one exists, instead of starting empty.
function readPriorRecording(sportKey, id) {
  try {
    const f = JSON.parse(fs.readFileSync(recFilePath(sportKey, id), 'utf8'));
    return { oddsHistory: Array.isArray(f.oddsHistory) ? f.oddsHistory : [], samples: Array.isArray(f.samples) ? f.samples : [], startTime: f.startTime || null };
  } catch (_) {
    return { oddsHistory: [], samples: [], startTime: null };
  }
}

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

// ALWAYS keep the raw Odds API response for every poll, whatever the live status. We pay per
// request, so nothing returned by the API is thrown away. One JSON line per poll per sport.
const POLL_LOG_DIR = path.join(process.env.DATA_DIR || __dirname, 'poll_log');
function appendPollLog(sportKey, fights) {
  try {
    if (!fs.existsSync(POLL_LOG_DIR)) fs.mkdirSync(POLL_LOG_DIR, { recursive: true });
    const now = new Date();
    const line = JSON.stringify({
      t: now.toISOString(),
      sport: sportKey,
      fights: fights.map(f => ({
        id: f.id, home: f.home_team, away: f.away_team, commence: f.commence_time,
        last_update: f.bookmakers?.[0]?.last_update || null,
        h2h: (f.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h')?.outcomes || []).map(o => [o.name, o.price]),
      })),
    });
    fs.appendFileSync(path.join(POLL_LOG_DIR, `${now.toISOString().slice(0, 10)}_${sportKey}.jsonl`), line + '\n');
  } catch (e) {
    console.error('[poll-log] write failed:', e.message);
  }
}

async function recPollSport(sportKey, meta, watchedGame) {
  try {
    const url = `${BASE_URL}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    const { data, headers } = await fetchJson(url);
    updateOddsCredits(headers);
    const fights = Array.isArray(data) ? data : [];
    appendPollLog(sportKey, fights); // every poll, always
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
        const prior = readPriorRecording(sportKey, id);
        const resumed = prior.oddsHistory.length > 0;
        console.log(`REC ${resumed ? 'RESUME' : 'START'} [${meta.label}] ${fight.home_team} vs ${fight.away_team}${resumed ? ` (continuing ${prior.oddsHistory.length} pts)` : ''}`);
        recorderState.activeFights.set(id, {
          meta: { sport: sportKey, label: meta.label, fighter1: fight.home_team, fighter2: fight.away_team, startTime: prior.startTime || new Date().toISOString() },
          oddsHistory: prior.oddsHistory,
          samples: prior.samples,
          lastOdds: prior.oddsHistory[prior.oddsHistory.length - 1] || null,
          stats: { present: 0, absent: 0, changes: 0, resumes: resumed ? 1 : 0 },
        });
        persistState(recorderState.activeFights);
        // Cancel any pending summary — more fights are still happening
        if (recorderState.summaryTimer) { clearTimeout(recorderState.summaryTimer); recorderState.summaryTimer = null; }
        if (!resumed) requireFighterPhotos([fight.home_team, fight.away_team]);
        if (!resumed) sendAlert(
          `🔴 BET BOT: Recording ${fight.home_team} vs ${fight.away_team} [${meta.label}]`,
          `Live game detected.\n\n${fight.home_team} vs ${fight.away_team}\n${meta.label} · Started: ${new Date().toLocaleString()}\n\nhttps://ufc-dashboard-production-e03d.up.railway.app`
        );
      }

      const record = recorderState.activeFights.get(id);
      record.missingSince = null;
      if (record.stats) record.stats.present++;
      const last = record.lastOdds;
      const changed = !last || last.fighter1.numericOdds !== odds.fighter1.numericOdds || last.fighter2.numericOdds !== odds.fighter2.numericOdds;
      // One sample per poll (about 300 per 15 min at 3s). oddsHistory below stays change-only,
      // because crossover and pattern analysis assume consecutive points differ.
      (record.samples = record.samples || []).push({ t: odds.timestamp, f1: odds.fighter1.numericOdds, f2: odds.fighter2.numericOdds, c: changed ? 1 : 0 });
      if (changed) {
        record.oddsHistory.push(odds);
        record.lastOdds = odds;
        if (record.stats) record.stats.changes++;
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

    const nowMs = Date.now();
    for (const [id, record] of recorderState.activeFights) {
      if (record.meta.sport !== sportKey || currentIds.has(id)) continue;
      record.missingSince = record.missingSince || nowMs;
      if (record.stats) record.stats.absent++;
      const grace = Math.max(RECORDER_GRACE_MS, 3 * (recorderState.lastDelayMs || 0));
      if (nowMs - record.missingSince >= grace) {
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
    recorderState.apiErrors++;
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
  recorderState.pollHistory.push(Date.now());
  if (recorderState.pollHistory.length > 20) recorderState.pollHistory.shift();

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
  recorderState.lastDelayMs = delay;
  setTimeout(recPoll, delay);
}

// ── Live crossover detection ──────────────────────────────────────────────────
const { analyzeCrossoverTrajectory, crossoverAlertText } = require('./crossover_detector');
const fighterImages = require('./fighter_images');
const requireFighterPhotos = names => fighterImages.requestFighterImages(names);

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

  // Backup reconcile: once shortly after boot, then every 30 min. Catches anything whose
  // push failed, including fights recorded while GitHub was down.
  const runReconcile = () => reconcileBackups()
    .then(r => console.log('[backup] reconcile:', JSON.stringify(r)))
    .catch(e => console.error('[backup] reconcile failed:', e.message));
  setTimeout(runReconcile, 60 * 1000).unref();
  setInterval(runReconcile, 30 * 60 * 1000).unref();

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
