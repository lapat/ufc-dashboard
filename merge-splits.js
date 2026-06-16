#!/usr/bin/env node
// Merge fight files that were split across UTC midnight.
// UFC events in the US run Sat night → early prelims land on SatUTC, main card on SunUTC.
// backfill.js filters by commence_time date, so the same fight gets saved twice:
//   - Pre-fight odds → earlier date file
//   - In-fight odds  → later date file
// This script merges them into one complete arc under the later date, deletes the earlier.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'historical_data');

const files = fs.readdirSync(DATA_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('dk_'));

const bySlug = {};
for (const f of files) {
  const m = f.match(/^(.+)_(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) continue;
  const [, slug, date] = m;
  if (!bySlug[slug]) bySlug[slug] = [];
  bySlug[slug].push({ date, f, fp: path.join(DATA_DIR, f) });
}

const dups = Object.entries(bySlug).filter(([, v]) => v.length > 1);
console.log(`Found ${dups.length} matchups with multiple date files.\n`);

let merged = 0, kept = 0, removed = 0;

for (const [slug, versions] of dups) {
  const parsed = versions.map(v => {
    const d = JSON.parse(fs.readFileSync(v.fp, 'utf8'));
    return { ...v, data: d };
  }).sort((a, b) => (a.data.startTime < b.data.startTime ? -1 : 1));

  // Combine all snapshots from all versions
  const allSnaps = parsed.flatMap(v => v.data.oddsHistory || []);
  const tsSeen = new Set();
  const unique = [];
  for (const s of allSnaps) {
    if (!tsSeen.has(s.timestamp)) {
      tsSeen.add(s.timestamp);
      unique.push(s);
    }
  }
  unique.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  // Use the file with the latest date as the canonical file (actual event date)
  const canonical = parsed[parsed.length - 1];
  const stale = parsed.slice(0, -1);

  // Only write if merged file is bigger than the canonical alone
  const canonicalPts = canonical.data.dataPoints || 0;
  const mergedPts = unique.length;

  const record = {
    ...canonical.data,
    startTime: unique[0].timestamp,
    endTime: unique[unique.length - 1].timestamp,
    dataPoints: unique.length,
    oddsHistory: unique,
  };

  fs.writeFileSync(canonical.fp, JSON.stringify(record, null, 2));

  for (const s of stale) {
    fs.unlinkSync(s.fp);
    console.log(`  REMOVED ${s.f} (${s.data.dataPoints}pts)`);
    removed++;
  }

  const gain = mergedPts - canonicalPts;
  const gainStr = gain > 0 ? ` [+${gain} pts from merge]` : ' [no new pts]';
  console.log(`  MERGED → ${canonical.f} (${canonicalPts} → ${mergedPts} pts)${gainStr}`);
  merged++;
}

console.log(`\nDone: ${merged} files merged, ${removed} stale files removed.`);
console.log(`Run: git add historical_data/ && git commit -m "Merge split UTC-midnight fight files"`);
