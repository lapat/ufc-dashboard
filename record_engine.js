'use strict';
// record_engine.js — Pure recording logic: no HTTP, no Express, no Claude.
// Handles fight ID generation, odds extraction, file saving, and state persistence.
// server.js wraps this with alerts and scheduling; tests hit this directly.

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

// If DATA_DIR env var is set (Railway volume mounted at /data), use that.
// Otherwise fall back to the local directory (dev / first deploy).
const DATA_ROOT      = process.env.DATA_DIR || __dirname;
const HISTORICAL_DIR = path.join(DATA_ROOT, 'historical_data');
const STATE_FILE     = path.join(DATA_ROOT, 'recording_state.json');

// On first boot with a volume, migrate any fight files already committed to git
// into the volume so they're available on the persistent filesystem.
function migrateToVolume() {
  if (DATA_ROOT === __dirname) return; // not using a volume
  const gitHistDir = path.join(__dirname, 'historical_data');
  if (!fs.existsSync(gitHistDir)) return;
  if (!fs.existsSync(HISTORICAL_DIR)) fs.mkdirSync(HISTORICAL_DIR, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(gitHistDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // sport subfolders (e.g. soccer_fifa_world_cup/)
      const srcDir  = path.join(gitHistDir, entry.name);
      const destDir = path.join(HISTORICAL_DIR, entry.name);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        const dest = path.join(destDir, f);
        if (f.endsWith('.json') && !fs.existsSync(dest)) {
          fs.copyFileSync(path.join(srcDir, f), dest);
          copied++;
        }
      }
    } else if (entry.name.endsWith('.json') && !entry.name.startsWith('dk_')) {
      const dest = path.join(HISTORICAL_DIR, entry.name);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(gitHistDir, entry.name), dest);
        copied++;
      }
    }
  }
  if (copied > 0) console.log(`[recorder] Migrated ${copied} fight file(s) from git to volume.`);
}

// ── Fight ID ──────────────────────────────────────────────────────────────────
// MMA: `fighter1_vs_fighter2_YYYY-MM-DD`  (matches existing historical_data/*.json)
// Other sports: `sport__fighter1_vs_fighter2_YYYY-MM-DD` in sport subfolder

function recFightId(sportKey, fight) {
  // Sort alphabetically so API home/away flips don't create duplicate files
  const [a, b] = [fight.home_team || '', fight.away_team || '']
    .map(n => n.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .sort();
  const date = (fight.commence_time || '').slice(0, 10);
  if (sportKey === 'mma_mixed_martial_arts') {
    return `${a}_vs_${b}_${date}`;
  }
  const prefix = sportKey.split('_')[0];
  return `${prefix}__${a}_vs_${b}_${date}`;
}

// ── File path ─────────────────────────────────────────────────────────────────

function recFilePath(sportKey, fightId) {
  if (sportKey === 'mma_mixed_martial_arts') {
    return path.join(HISTORICAL_DIR, `${fightId}.json`);
  }
  const sportDir = path.join(HISTORICAL_DIR, sportKey);
  if (!fs.existsSync(sportDir)) fs.mkdirSync(sportDir, { recursive: true });
  return path.join(sportDir, `${fightId}.json`);
}

// ── Liveness check ────────────────────────────────────────────────────────────

function recIsLive(fight, windowMs) {
  const now   = Date.now();
  const start = new Date(fight.commence_time).getTime();
  return start <= now && now - start < windowMs;
}

// ── Odds extraction ───────────────────────────────────────────────────────────

function recExtractOdds(fight) {
  const outcomes = fight.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h')?.outcomes ?? [];
  if (outcomes.length < 2) return null;
  return {
    timestamp: new Date().toISOString(),
    fighter1: { name: outcomes[0].name, numericOdds: outcomes[0].price },
    fighter2: { name: outcomes[1].name, numericOdds: outcomes[1].price },
  };
}

// ── Save recording to disk ────────────────────────────────────────────────────
// Returns { saved: true, filePath, dataPoints } on success
// Returns { saved: false, reason } on failure — never throws

function recSaveRecord(id, record, opts = {}) {
  if (!record || !record.oddsHistory || record.oddsHistory.length === 0) {
    return { saved: false, reason: 'empty' };
  }
  try {
    const filePath = opts.filePath || recFilePath(record.meta.sport, id);
    const payload  = {
      fightId:    id,
      sport:      record.meta.sport,
      fightTitle: `${record.meta.fighter1} vs ${record.meta.fighter2}`,
      startTime:  record.meta.startTime,
      endTime:    new Date().toISOString(),
      dataPoints: record.oddsHistory.length,
      oddsHistory: record.oddsHistory,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return { saved: true, filePath, dataPoints: record.oddsHistory.length };
  } catch (e) {
    return { saved: false, reason: e.message };
  }
}

// ── GitHub backup ─────────────────────────────────────────────────────────────
// Pushes a fight file to GitHub via Contents API after every save.
// Fire-and-forget — errors are logged but never throw.
// Requires GITHUB_TOKEN env var and GITHUB_REPO=owner/repo (defaults to lapat/ufc-dashboard).

async function pushFightToGitHub(filePath) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('[github] GITHUB_TOKEN not set — skipping backup'); return; }

  const repo    = process.env.GITHUB_REPO || 'lapat/ufc-dashboard';
  // Compute path relative to repo root (e.g. historical_data/fight.json)
  const repoRelPath = filePath.replace(/^.*?(historical_data\/)/, 'historical_data/');
  const apiPath = `/repos/${repo}/contents/${repoRelPath}`;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const b64     = Buffer.from(content).toString('base64');

    // GET to find existing SHA (needed for update, null for new file)
    const existing = await ghRequest('GET', apiPath, null, token);
    const sha      = existing?.sha || null;

    const body = {
      message: `[auto] record ${path.basename(filePath)}`,
      content: b64,
      ...(sha ? { sha } : {}),
    };
    await ghRequest('PUT', apiPath, body, token);
    console.log(`[github] Backed up ${path.basename(filePath)}`);
  } catch (e) {
    console.error(`[github] Backup failed for ${path.basename(filePath)}: ${e.message}`);
  }
}

function ghRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path:     apiPath,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent':    'ufc-dashboard-recorder',
        'Accept':        'application/vnd.github.v3+json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Auto-enrichment ───────────────────────────────────────────────────────────
// Spawns enricher.js for a single file after save.
// MMA only — other sports don't have UFC Stats / ESPN outcomes.
// Calls onDone(err, result) when finished.

function autoEnrich(filename, onDone) {
  const enricher = path.join(__dirname, 'enricher.js');
  execFile('node', [enricher, '--file', filename], { timeout: 60000 }, (err, stdout, stderr) => {
    if (onDone) onDone(err, { stdout: stdout && stdout.trim(), stderr: stderr && stderr.trim() });
  });
}

// ── State persistence — survives server restarts ──────────────────────────────

function loadPersistedState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const map = new Map(Object.entries(raw));
    if (map.size > 0) {
      console.log(`[recorder] Resumed ${map.size} in-flight fight(s) from disk: ${[...map.keys()].join(', ')}`);
    }
    return map;
  } catch (e) {
    console.error('[recorder] Could not load persisted state:', e.message);
    return new Map();
  }
}

function persistState(activeFights) {
  try {
    if (!fs.existsSync(path.dirname(STATE_FILE))) {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    }
    const obj = {};
    for (const [id, record] of activeFights) obj[id] = record;
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[recorder] Could not persist state:', e.message);
  }
}

function clearPersistedState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (_) {}
}

module.exports = {
  recFightId,
  recFilePath,
  recIsLive,
  recExtractOdds,
  recSaveRecord,
  pushFightToGitHub,
  autoEnrich,
  loadPersistedState,
  persistState,
  clearPersistedState,
  migrateToVolume,
  HISTORICAL_DIR,
  STATE_FILE,
};
