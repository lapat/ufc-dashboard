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
    let filePath = opts.filePath || recFilePath(record.meta.sport, id);
    const payload  = {
      fightId:    id,
      sport:      record.meta.sport,
      fightTitle: `${record.meta.fighter1} vs ${record.meta.fighter2}`,
      startTime:  record.meta.startTime,
      endTime:    new Date().toISOString(),
      dataPoints: record.oddsHistory.length,
      oddsHistory: record.oddsHistory,
    };
    // Never shrink an existing recording. If a file with this id already has at least as many
    // points, write this one beside it instead of replacing it. Both get backed up.
    if (fs.existsSync(filePath)) {
      let existingPoints = -1;
      try { existingPoints = Number(JSON.parse(fs.readFileSync(filePath, 'utf8')).dataPoints) || 0; } catch (_) {}
      if (existingPoints >= payload.dataPoints) {
        filePath = filePath.replace(/\.json$/, `.partial-${Date.now()}.json`);
        console.warn(`[record] ${id}: existing file has ${existingPoints} pts >= ${payload.dataPoints}; saved alongside as ${path.basename(filePath)}`);
      }
    }
    // Atomic write: a crash mid-write can never leave a truncated fight file behind.
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, filePath);
    return { saved: true, filePath, dataPoints: record.oddsHistory.length };
  } catch (e) {
    return { saved: false, reason: e.message };
  }
}

// ── GitHub backup ─────────────────────────────────────────────────────────────
// Every saved fight is mirrored to GitHub so the data survives a volume loss.
// Rewritten 2026-10-19: the old fire-and-forget push silently dropped 209 recordings
// because ghRequest() never checked HTTP status (a rejected PUT was logged as "Backed up").
//  - Backups go to BACKUP_BRANCH (default 'data-backup'), NOT master. Every push to
//    master redeploys Railway, and a redeploy restarts the recorder mid-card.
//  - Every non-2xx response is treated as a failure, queued, and retried.
//  - reconcileBackups() diffs the volume against the remote tree and pushes what is missing.
//  - Never overwrites a file that already exists on the backup branch.
//  - backupStats is exposed on /api/recorder/backup-status so failures are visible.

const BACKUP_BRANCH = process.env.GITHUB_BACKUP_BRANCH || 'data-backup';
const GITHUB_REPO   = process.env.GITHUB_REPO || 'lapat/ufc-dashboard';
const RETRY_MS      = 5 * 60 * 1000;

const backupStats = {
  pushed: 0, skippedExisting: 0, failed: 0, pending: 0,
  lastOkAt: null, lastError: null, lastReconcile: null,
};
const backupQueue = new Map(); // repoPath -> localPath, awaiting retry
let backupRetryTimer = null;

// Repo-relative path for a file under DATA_ROOT, e.g. "historical_data/x.json".
function toRepoPath(filePath) {
  const rel = path.relative(DATA_ROOT, filePath).split(path.sep).join('/');
  return rel.startsWith('historical_data/') && rel.endsWith('.json') ? rel : null;
}

function ghRequestStatus(method, apiPath, body, token) {
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
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('GitHub request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Uploads one file if the path does not exist on the backup branch. Throws on any failure.
// Returns 'pushed' | 'exists'.
async function backupOne(repoPath, localPath, token) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${repoPath}`;
  const probe = await ghRequestStatus('GET', `${apiPath}?ref=${encodeURIComponent(BACKUP_BRANCH)}`, null, token);
  if (probe.status === 200) { backupStats.skippedExisting++; return 'exists'; }
  if (probe.status !== 404) {
    throw new Error(`GET ${repoPath} -> HTTP ${probe.status} ${probe.json?.message || ''}`.trim());
  }
  const b64 = fs.readFileSync(localPath).toString('base64');
  const put = await ghRequestStatus('PUT', apiPath, {
    message: `[backup] ${path.basename(localPath)}`,
    content: b64,
    branch:  BACKUP_BRANCH,
  }, token);
  if (put.status !== 201 && put.status !== 200) {
    throw new Error(`PUT ${repoPath} -> HTTP ${put.status} ${put.json?.message || ''}`.trim());
  }
  backupStats.pushed++;
  backupStats.lastOkAt = new Date().toISOString();
  return 'pushed';
}

function scheduleRetry() {
  if (backupRetryTimer || backupQueue.size === 0) return;
  backupRetryTimer = setTimeout(async () => {
    backupRetryTimer = null;
    const token = process.env.GITHUB_TOKEN;
    if (!token) return;
    for (const [repoPath, localPath] of [...backupQueue]) {
      try {
        await backupOne(repoPath, localPath, token);
        backupQueue.delete(repoPath);
      } catch (e) {
        backupStats.failed++;
        backupStats.lastError = `${repoPath}: ${e.message}`;
      }
    }
    backupStats.pending = backupQueue.size;
    scheduleRetry();
  }, RETRY_MS);
  backupRetryTimer.unref();
}

// Fire-and-forget from recorder call sites. Failures are queued, never dropped.
async function pushFightToGitHub(filePath) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('[github] GITHUB_TOKEN not set — skipping backup'); return; }
  const repoPath = toRepoPath(filePath);
  if (!repoPath) { console.error(`[github] refusing to back up outside historical_data: ${filePath}`); return; }
  try {
    await backupOne(repoPath, filePath, token);
  } catch (e) {
    backupStats.failed++;
    backupStats.lastError = `${repoPath}: ${e.message}`;
    console.error(`[github] Backup failed for ${path.basename(filePath)}: ${e.message}`);
    backupQueue.set(repoPath, filePath);
    backupStats.pending = backupQueue.size;
    scheduleRetry();
  }
}

// Every fight file on the volume (UFC root + sport subfolders), excluding the DK
// bet/capture state and benchmark files, which are not fight recordings.
function listLocalFightFiles() {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.json') && !/^(dk_|bench|fighter)/.test(ent.name)) {
        const repoPath = toRepoPath(full);
        if (repoPath) out.push({ repoPath, localPath: full });
      }
    }
  };
  walk(HISTORICAL_DIR);
  return out;
}

// Compares the volume with the backup branch and pushes anything missing.
// Safe to run repeatedly: existing remote files are never touched.
async function reconcileBackups() {
  const token = process.env.GITHUB_TOKEN;
  const at = new Date().toISOString();
  if (!token) return backupStats.lastReconcile = { at, error: 'GITHUB_TOKEN not set' };
  const tree = await ghRequestStatus('GET', `/repos/${GITHUB_REPO}/git/trees/${encodeURIComponent(BACKUP_BRANCH)}?recursive=1`, null, token);
  if (tree.status !== 200) {
    return backupStats.lastReconcile = { at, error: `tree HTTP ${tree.status} ${tree.json?.message || ''}`.trim() };
  }
  const remote = new Set((tree.json.tree || []).filter(t => t.type === 'blob').map(t => t.path));
  const local = listLocalFightFiles();
  const missing = local.filter(f => !remote.has(f.repoPath));
  let pushed = 0, failed = 0;
  // Sequential on purpose: parallel Contents-API commits to one branch can collide (409).
  for (const f of missing) {
    try { await backupOne(f.repoPath, f.localPath, token); pushed++; }
    catch (e) { failed++; backupQueue.set(f.repoPath, f.localPath); backupStats.lastError = e.message; }
  }
  backupStats.pending = backupQueue.size;
  if (backupQueue.size) scheduleRetry();
  return backupStats.lastReconcile = {
    at, branch: BACKUP_BRANCH, localFiles: local.length, remoteFiles: remote.size,
    missing: missing.length, pushed, failed, truncated: !!tree.json.truncated,
  };
}

// Checks the token against GitHub for real (not just that the env var exists).
async function checkGitHubAccess() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, reason: 'GITHUB_TOKEN not set' };
  try {
    const r = await ghRequestStatus('GET', `/repos/${GITHUB_REPO}/branches/${encodeURIComponent(BACKUP_BRANCH)}`, null, token);
    if (r.status === 200) return { ok: true, branch: BACKUP_BRANCH };
    return { ok: false, reason: `HTTP ${r.status} ${r.json?.message || ''}`.trim() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
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
  reconcileBackups,
  checkGitHubAccess,
  backupStats,
  listLocalFightFiles,
  toRepoPath,
  autoEnrich,
  loadPersistedState,
  persistState,
  clearPersistedState,
  migrateToVolume,
  HISTORICAL_DIR,
  STATE_FILE,
};
