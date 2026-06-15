#!/usr/bin/env node
// Recover fight recordings from the Odds API historical endpoint.
// Usage:
//   node backfill.js 2026-06-15               # recover all MMA fights on a date
//   node backfill.js 2026-06-15 2026-06-16    # date range
//
// Queries /v4/historical/sports/mma_mixed_martial_arts/odds/?date=... in 5-min steps
// across the full day window, builds oddsHistory for every fight found, and saves
// to historical_data/<filename>.json — overwriting only if the recovered file has
// MORE data points than what's already on disk.

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ODDS_API_KEY;
const DATA_DIR = path.join(__dirname, 'historical_data');

if (!API_KEY) { console.error('ODDS_API_KEY not set'); process.exit(1); }

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('Rate limited'));
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fightFilename(home, away, date) {
  return `${nameToSlug(home)}_vs_${nameToSlug(away)}_${date}`;
}

async function backfillDate(dateStr) {
  console.log(`\nBackfilling ${dateStr}...`);

  // Sweep from noon UTC the day before to noon UTC the day after
  // (covers events in all timezones)
  const prevDay = new Date(dateStr + 'T12:00:00Z');
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);
  let timestamp = prevDay.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cutoff = new Date(dateStr + 'T12:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() + 1);
  const cutoffStr = cutoff.toISOString();

  const allSnapshots = {}; // fightId -> [{ timestamp, fighter1, fighter2 }]
  const fightMeta = {};    // fightId -> { home, away, commenceDate }
  const seen = new Set();
  let calls = 0;

  while (timestamp < cutoffStr) {
    const url = `https://api.the-odds-api.com/v4/historical/sports/mma_mixed_martial_arts/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american&date=${timestamp}`;
    try {
      const d = await get(url);
      calls++;
      const actualTs = d.timestamp || timestamp;
      const nextTs = d.next_timestamp;

      if (seen.has(actualTs)) {
        if (nextTs) { timestamp = nextTs; continue; }
        break;
      }
      seen.add(actualTs);

      for (const fight of (d.data || [])) {
        const ct = fight.commence_time || '';
        if (!ct.startsWith(dateStr)) continue; // only target date
        const fid = fight.id;
        const bk = fight.bookmakers || [];
        if (!bk.length) continue;
        const outcomes = bk[0].markets[0].outcomes;
        if (outcomes.length < 2) continue;
        const [o1, o2] = outcomes;
        if (!allSnapshots[fid]) {
          allSnapshots[fid] = [];
          fightMeta[fid] = { home: fight.home_team, away: fight.away_team, commenceDate: ct.slice(0, 10) };
        }
        allSnapshots[fid].push({
          timestamp: actualTs,
          fighter1: { name: o1.name, numericOdds: o1.price },
          fighter2: { name: o2.name, numericOdds: o2.price },
        });
      }

      process.stdout.write(`\r  ${calls} API calls | ${Object.keys(allSnapshots).length} fights found | ts: ${actualTs.slice(11, 16)} UTC   `);
      if (nextTs) timestamp = nextTs; else break;
      await sleep(250);
    } catch (e) {
      console.error(`\n  Error at ${timestamp}: ${e.message}`);
      await sleep(2000);
      break;
    }
  }

  console.log(`\n  Done sweeping — ${calls} calls, ${Object.keys(allSnapshots).length} fights`);

  let saved = 0, skipped = 0;
  for (const [fid, snaps] of Object.entries(allSnapshots)) {
    if (!snaps.length) continue;
    const meta = fightMeta[fid];
    const filename = fightFilename(meta.home, meta.away, meta.commenceDate);
    const filepath = path.join(DATA_DIR, `${filename}.json`);

    // Deduplicate by timestamp
    const unique = [];
    const tsSeen = new Set();
    for (const s of snaps) {
      if (!tsSeen.has(s.timestamp)) { tsSeen.add(s.timestamp); unique.push(s); }
    }
    unique.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);

    // Only overwrite if we have more data
    if (fs.existsSync(filepath)) {
      const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      if ((existing.dataPoints || 0) >= unique.length) {
        console.log(`  SKIP ${filename}: already has ${existing.dataPoints} pts (recovered ${unique.length})`);
        skipped++;
        continue;
      }
    }

    const record = {
      fightId: filename,
      fightTitle: `${meta.home} vs ${meta.away}`,
      startTime: unique[0].timestamp,
      endTime: unique[unique.length - 1].timestamp,
      dataPoints: unique.length,
      oddsHistory: unique,
    };

    fs.writeFileSync(filepath, JSON.stringify(record, null, 2));
    console.log(`  SAVED ${filename}: ${unique.length} pts | ${unique[0].fighter1.numericOdds} → ${unique[unique.length-1].fighter1.numericOdds}`);
    saved++;
  }

  return { saved, skipped, fights: Object.keys(allSnapshots).length };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('Usage: node backfill.js YYYY-MM-DD [YYYY-MM-DD]');
    process.exit(1);
  }

  const startDate = args[0];
  const endDate = args[1] || startDate;

  const start = new Date(startDate);
  const end = new Date(endDate);
  let total = { saved: 0, skipped: 0 };

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const result = await backfillDate(dateStr);
    total.saved += result.saved;
    total.skipped += result.skipped;
  }

  console.log(`\nDone: ${total.saved} saved, ${total.skipped} skipped`);
}

main().catch(e => { console.error(e); process.exit(1); });
