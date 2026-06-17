#!/usr/bin/env node
// Trim historical fight files to the active odds-movement window.
//
// Files with commenceTime already have been trimmed at save time (new backfill format).
// Files without commenceTime (old backfill) may contain hours of pre-fight static odds.
//
// Algorithm: find first snapshot where odds changed by >50 from opening, keep from
// 2 snapshots before that through the end of activity. If no movement found, skip.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'historical_data');

function trimToActive(hist) {
  if (hist.length < 4) return null; // too short to trim meaningfully

  const base1 = hist[0].fighter1.numericOdds;
  const base2 = hist[0].fighter2.numericOdds;

  let firstActive = -1, lastActive = -1;
  for (let i = 1; i < hist.length; i++) {
    const d1 = Math.abs(hist[i].fighter1.numericOdds - base1);
    const d2 = Math.abs(hist[i].fighter2.numericOdds - base2);
    if (d1 > 50 || d2 > 50) {
      if (firstActive === -1) firstActive = i;
      lastActive = i;
    }
  }

  if (firstActive === -1) return null; // no significant movement, can't trim

  const start = Math.max(0, firstActive - 2);
  const end = Math.min(hist.length - 1, lastActive + 1);
  return hist.slice(start, end + 1);
}

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.startsWith('dk_'));
let trimmed = 0, skipped = 0, noMovement = 0;

for (const f of files) {
  const fp = path.join(DATA_DIR, f);
  const d = JSON.parse(fs.readFileSync(fp));

  // Already in new format (trimmed at backfill time)
  if (d.commenceTime) { skipped++; continue; }

  const active = trimToActive(d.oddsHistory || []);
  if (!active) { noMovement++; continue; }

  // Only trim if we'd remove at least 10 pre-fight snapshots
  const removed = (d.oddsHistory.length - active.length);
  if (removed < 10) { skipped++; continue; }

  const record = {
    fightId: d.fightId,
    fightTitle: d.fightTitle,
    commenceTime: null,
    startTime: active[0].timestamp,
    endTime: active[active.length - 1].timestamp,
    dataPoints: active.length,
    oddsHistory: active,
  };
  fs.writeFileSync(fp, JSON.stringify(record, null, 2));
  trimmed++;
  if (trimmed <= 20) {
    console.log(`TRIMMED ${f}: ${d.dataPoints} → ${active.length} pts (removed ${removed})`);
  }
}

console.log(`\nDone: ${trimmed} files trimmed, ${skipped} already new format or already short, ${noMovement} flat (no movement detected)`);
