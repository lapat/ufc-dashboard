#!/usr/bin/env node
// deriver.js — Derives additional fields from existing oddsHistory data.
// Zero HTTP requests. Reads fight files, writes derived fields back.
//
// Run: node deriver.js
//      node deriver.js --dry-run
//      node deriver.js --file somefight_2026-01-01.json
//
// Adds to each fight file:
//   derived.inferredFinishMin    — minutes from fight start when finish likely occurred
//   derived.inferredFinishRound  — estimated round (5-min rounds, ~1-min breaks)
//   derived.peakOddsSwing        — max odds movement from opening (absolute)
//   derived.finishSpeed          — 'fast'|'medium'|'slow'|'decision' based on swing rate
//   derived.preFightSteam        — net line movement in last 20% of pre-fight data
//   derived.dominanceScore       — 0-100: how one-sided the live action was
//   derived.crossoverCount       — how many times the line crossed during live action

'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'historical_data');
const DRY_RUN  = process.argv.includes('--dry-run');
const SINGLE   = process.argv.find(a => a.endsWith('.json'));

// ── UFC timing constants ──────────────────────────────────────────────────────
const ROUND_DURATION_MIN  = 5;
const BREAK_DURATION_MIN  = 1;
const ROUND_TOTAL_MIN     = ROUND_DURATION_MIN + BREAK_DURATION_MIN; // 6 min per round slot

function estimateRound(minutesFromStart) {
  if (minutesFromStart == null) return null;
  // Round 1: 0-5 min, break 5-6, Round 2: 6-11, break 11-12, Round 3: 12-17...
  const round = Math.floor(minutesFromStart / ROUND_TOTAL_MIN) + 1;
  return Math.min(round, 5); // UFC max 5 rounds
}

// ── Core derivation ───────────────────────────────────────────────────────────

function deriveFields(data, filename) {
  const h = data.oddsHistory || [];
  if (h.length < 5) return null;

  const openF1 = h[0].fighter1 && h[0].fighter1.numericOdds;
  if (openF1 == null) return null;

  const firstTs = new Date(h[0].timestamp);
  const lastTs  = new Date(h[h.length - 1].timestamp);
  const totalSpanMin = (lastTs - firstTs) / 60000;

  // ── Peak odds swing from opening ─────────────────────────────────────────
  let peakSwing = 0;
  let peakSwingIdx = 0;
  for (let i = 1; i < h.length; i++) {
    const f1 = h[i].fighter1 && h[i].fighter1.numericOdds;
    if (f1 == null) continue;
    const swing = Math.abs(f1 - openF1);
    if (swing > peakSwing) { peakSwing = swing; peakSwingIdx = i; }
  }

  // ── Inferred finish time (when odds went extreme) ─────────────────────────
  // "Extreme" = one side > 800 (fight is effectively over)
  let inferredFinishMin  = null;
  let inferredFinishRound = null;
  const EXTREME_THRESHOLD = 800;
  for (let i = 1; i < h.length; i++) {
    const f1 = h[i].fighter1 && h[i].fighter1.numericOdds;
    const f2 = h[i].fighter2 && h[i].fighter2.numericOdds;
    if (f1 == null || f2 == null) continue;
    if (Math.abs(f1) > EXTREME_THRESHOLD || Math.abs(f2) > EXTREME_THRESHOLD) {
      const ts = new Date(h[i].timestamp);
      inferredFinishMin   = Math.round((ts - firstTs) / 60000);
      inferredFinishRound = estimateRound(inferredFinishMin);
      break;
    }
  }

  // ── Finish speed (how quickly odds swung to extreme) ─────────────────────
  let finishSpeed = 'decision'; // default: no extreme swing = likely went to judges
  if (inferredFinishMin != null) {
    // Compare against median fight span
    const swingRate = peakSwing / Math.max(inferredFinishMin, 1); // odds pts per minute
    if (swingRate > 300)       finishSpeed = 'fast';   // explosive finish
    else if (swingRate > 100)  finishSpeed = 'medium'; // controlled finish
    else                       finishSpeed = 'slow';   // grinding finish
  }

  // ── Pre-fight steam (line movement trend at end of pre-fight data) ────────
  // Use first 15% of history as "opening", last 15% before fight as "closing"
  // If total span > 30 min, this is live data — ignore for pre-fight steam
  let preFightSteam = null;
  if (totalSpanMin > 30) {
    // Looks like live data captured during fight
    // Pre-fight steam = movement in first 15% (before fight started)
    const preFightEnd = Math.floor(h.length * 0.15);
    const preFightStartF1 = h[0].fighter1 && h[0].fighter1.numericOdds;
    const preFightEndF1   = h[preFightEnd] && h[preFightEnd].fighter1 && h[preFightEnd].fighter1.numericOdds;
    if (preFightStartF1 != null && preFightEndF1 != null) {
      preFightSteam = preFightEndF1 - preFightStartF1;
    }
  } else {
    // Short span = mostly pre-fight data (days of recording compressed)
    // Steam = net movement across the whole history
    const closeF1 = h[h.length - 1].fighter1 && h[h.length - 1].fighter1.numericOdds;
    if (closeF1 != null) preFightSteam = closeF1 - openF1;
  }

  // ── Dominance score (0-100): how one-sided was the live action? ───────────
  // Count data points where the leading fighter had odds < -200 (clear control)
  const dominantPoints = h.filter(pt => {
    const f1 = pt.fighter1 && pt.fighter1.numericOdds;
    const f2 = pt.fighter2 && pt.fighter2.numericOdds;
    return f1 != null && f2 != null && (f1 < -200 || f2 < -200);
  }).length;
  const dominanceScore = Math.round((dominantPoints / h.length) * 100);

  // ── Crossover count (how many times the line crossed) ────────────────────
  let crossoverCount = 0;
  let prevSign = openF1 < 0 ? -1 : 1;
  for (let i = 1; i < h.length; i++) {
    const f1 = h[i].fighter1 && h[i].fighter1.numericOdds;
    if (f1 == null) continue;
    const sign = f1 < 0 ? -1 : 1;
    if (sign !== prevSign) { crossoverCount++; prevSign = sign; }
  }

  return {
    inferredFinishMin,
    inferredFinishRound,
    peakOddsSwing:  Math.round(peakSwing),
    finishSpeed,
    preFightSteam:  preFightSteam != null ? Math.round(preFightSteam) : null,
    dominanceScore,
    crossoverCount,
    derivedAt:      new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📊 DERIVER${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const allFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('dk_') && !f.startsWith('crossover'));

  const files = SINGLE ? allFiles.filter(f => f === SINGLE) : allFiles;

  console.log(`Processing ${files.length} files...\n`);

  let derived = 0, skipped = 0, errors = 0;

  for (const filename of files) {
    const filePath = path.join(DATA_DIR, filename);
    try {
      const data   = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const fields = deriveFields(data, filename);
      if (!fields) { skipped++; continue; }
      data.derived = fields;
      if (!DRY_RUN) fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      derived++;
    } catch (e) {
      console.error(`  ERROR ${filename}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n═══════════════════════════════════`);
  console.log(`  Derived : ${derived}`);
  console.log(`  Skipped : ${skipped}`);
  console.log(`  Errors  : ${errors}`);
  console.log(`═══════════════════════════════════\n`);
}

if (require.main === module) main().catch(console.error);

module.exports = { deriveFields, estimateRound };
