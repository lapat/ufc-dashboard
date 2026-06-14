'use strict';
// record_engine.js — Pure recording logic: no HTTP, no Express, no Claude.
// Handles fight ID generation, odds extraction, file saving, and state persistence.
// server.js wraps this with alerts and scheduling; tests hit this directly.

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HISTORICAL_DIR = path.join(__dirname, 'historical_data');
const STATE_FILE     = path.join(__dirname, 'recording_state.json');

// ── Fight ID ──────────────────────────────────────────────────────────────────
// MMA: `fighter1_vs_fighter2_YYYY-MM-DD`  (matches existing historical_data/*.json)
// Other sports: `sport__fighter1_vs_fighter2_YYYY-MM-DD` in sport subfolder

function recFightId(sportKey, fight) {
  const a    = (fight.home_team || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const b    = (fight.away_team || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
  autoEnrich,
  loadPersistedState,
  persistState,
  clearPersistedState,
  HISTORICAL_DIR,
  STATE_FILE,
};
