#!/usr/bin/env node
// enricher.js — One-time script to enrich historical fight files with outcomes
// Sources: ESPN MMA API (JSON) → UFC Stats (HTML fallback)
// Run: node enricher.js            (live)
// Run: node enricher.js --dry-run  (preview only)
// Run: node enricher.js --file     abdulrakhmanyakhyaev_vs_brendsonribeiro_2026-04-05.json

'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'historical_data');
const DRY_RUN  = process.argv.includes('--dry-run');
const SINGLE   = process.argv.find(a => a.endsWith('.json'));

// ── Normalisation helpers ─────────────────────────────────────────────────────

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fuzzy(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function bothMatch(nameA, nameB, f1, f2) {
  return (fuzzy(nameA, f1) && fuzzy(nameB, f2)) ||
         (fuzzy(nameA, f2) && fuzzy(nameB, f1));
}

// Parse filename → { fighter1, fighter2, date, fightId }
function parseFightFile(filename) {
  const base = filename.replace('.json', '');
  const dateMatch = base.match(/(\d{4}-\d{2}-\d{2})$/);
  if (!dateMatch) return null;
  const date   = dateMatch[1];
  const fightId = base.slice(0, base.length - date.length - 1);
  const parts  = fightId.split('_vs_');
  if (parts.length !== 2) return null;
  return {
    fighter1: parts[0].replace(/_/g, ' '),
    fighter2: parts[1].replace(/_/g, ' '),
    date, fightId, filename
  };
}

// ── ESPN ──────────────────────────────────────────────────────────────────────

async function fetchESPNResult(fighter1, fighter2, date) {
  try {
    const espnDate = date.replace(/-/g, '');
    // Try date itself AND day before/after (timezone offset can shift fight date)
    for (const offset of [0, -1, 1]) {
      const d = new Date(date);
      d.setDate(d.getDate() + offset);
      const ds = d.toISOString().slice(0,10).replace(/-/g,'');
      const url = `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${ds}&limit=100`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const evt of (data.events || [])) {
        for (const comp of (evt.competitions || [])) {
          const competitors = comp.competitors || [];
          const names = competitors.map(c => c.athlete?.displayName || c.team?.displayName || '');
          if (names.length >= 2 && bothMatch(names[0], names[1], fighter1, fighter2)) {
            const winner = competitors.find(c => c.winner);
            if (!winner) continue;
            const winnerName = winner.athlete?.displayName || winner.team?.displayName || '';
            return {
              winner:     fuzzy(winnerName, fighter1) ? 'fighter1' : 'fighter2',
              winnerName,
              method:     comp.status?.type?.shortDetail || 'Decision',
              round:      null,
              time:       null,
              source:     'espn'
            };
          }
        }
      }
    }
  } catch (_) {}
  return null;
}

// ── UFC Stats ─────────────────────────────────────────────────────────────────

let _ufcEventsCache = null;

async function fetchUFCStatsEvents() {
  if (_ufcEventsCache) return _ufcEventsCache;
  try {
    const r = await fetch('http://ufcstats.com/statistics/events/completed?page=all', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) return [];
    const html = await r.text();
    const events = [];
    // Rows: <a href="http://www.ufcstats.com/event-details/HASH">Name</a> ... date in next <span>
    const re = /href="https?:\/\/(?:www\.)?ufcstats\.com\/event-details\/([a-f0-9]+)"[^>]*>([^<]+)<\/a>[\s\S]{1,800}?(\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const d = new Date(m[3]);
      if (isNaN(d)) continue;
      events.push({
        id:   m[1],
        name: m[2].trim(),
        date: d.toISOString().slice(0,10),
        url:  `http://www.ufcstats.com/event-details/${m[1]}`
      });
    }
    _ufcEventsCache = events;
    return events;
  } catch (e) {
    console.warn('  [UFC Stats] events list failed:', e.message);
    return [];
  }
}

async function fetchUFCStatsEventFights(eventUrl) {
  try {
    const r = await fetch(eventUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const html = await r.text();
    const fights = [];
    // Each fight row in UFC Stats has two fighter anchor tags followed by method/round/time columns
    // Winner is listed FIRST per UFC Stats convention
    const rowRe = /<tr[^>]*class="b-fight-details__table-row(?:\s+js-fight-clickable)?"[^>]*>([\s\S]*?)<\/tr>/g;
    let rm;
    while ((rm = rowRe.exec(html)) !== null) {
      const row = rm[1];
      const nameRe = /href="https?:\/\/(?:www\.)?ufcstats\.com\/fighter-details\/[^"]+">([^<]+)<\/a>/g;
      const names = [];
      let nm;
      while ((nm = nameRe.exec(row)) !== null) names.push(nm[1].trim());
      if (names.length < 2) continue;

      // Method of victory
      const methodRe = /\b(KO\/TKO|Submission|Decision(?:\s*[-–]\s*\w+)?|DQ|No Contest|Overturned|TKO|KO)\b/i;
      const methodM  = row.match(methodRe);
      const method   = methodM ? methodM[1].trim() : 'Decision';

      // Round — small isolated number
      const roundM  = row.match(/<td[^>]*>\s*(\d)\s*<\/td>/);
      const round   = roundM ? parseInt(roundM[1]) : null;

      // Time
      const timeM   = row.match(/(\d:\d{2})/);
      const time    = timeM ? timeM[1] : null;

      fights.push({ fighter1: names[0], fighter2: names[1], winner: names[0], method, round, time });
    }
    return fights;
  } catch (e) {
    console.warn('  [UFC Stats] event page failed:', e.message);
    return [];
  }
}

async function fetchUFCStatsResult(fighter1, fighter2, date) {
  const events = await fetchUFCStatsEvents();
  const fightDate = new Date(date);
  // Allow 2-day window (timezone, Saturday night vs Sunday morning)
  const candidates = events
    .filter(e => Math.abs(new Date(e.date) - fightDate) < 2.5 * 86400000)
    .sort((a, b) => Math.abs(new Date(a.date) - fightDate) - Math.abs(new Date(b.date) - fightDate));

  for (const event of candidates) {
    await new Promise(r => setTimeout(r, 200)); // polite delay
    const fights = await fetchUFCStatsEventFights(event.url);
    const match  = fights.find(f => bothMatch(f.fighter1, f.fighter2, fighter1, fighter2));
    if (match) {
      const f1Won = fuzzy(match.winner, fighter1);
      return {
        winner:     f1Won ? 'fighter1' : 'fighter2',
        winnerName: match.winner,
        method:     match.method,
        round:      match.round,
        time:       match.time,
        event:      event.name,
        source:     'ufcstats'
      };
    }
  }
  return null;
}

// ── Core enrichment ───────────────────────────────────────────────────────────

async function enrichFight(info) {
  const filePath = path.join(DATA_DIR, info.filename);
  const data     = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Re-enrich if existing outcome has no real method (ESPN gives "Final")
  const existingMethod = (data.outcome && data.outcome.method || '').toLowerCase();
  const needsReenrich  = !data.outcome || existingMethod === 'final' || existingMethod === '';
  if (!needsReenrich) return { status: 'already_enriched', file: info.filename };

  // Try UFC Stats first (has real method/round/time), ESPN as fallback
  let outcome = await fetchUFCStatsResult(info.fighter1, info.fighter2, info.date);
  if (!outcome) outcome = await fetchESPNResult(info.fighter1, info.fighter2, info.date);
  if (!outcome) return { status: 'not_found', file: info.filename };

  // Compute derived fields from the recorded odds history
  const history    = data.oddsHistory || [];
  const firstPoint = history[0];
  const lastPoint  = history[history.length - 1];

  // Crossover: did the underdog become the favourite at any point?
  let crossoverOccurred = false;
  let crossoverMinute   = null;
  if (history.length > 1) {
    const openF1 = history[0].fighter1.numericOdds;
    for (let i = 1; i < history.length; i++) {
      const cur = history[i].fighter1.numericOdds;
      // Sign flip = crossover (one side goes from positive to negative or vice versa)
      if ((openF1 > 0 && cur < 0) || (openF1 < 0 && cur > 0)) {
        crossoverOccurred = true;
        const ms = new Date(history[i].timestamp) - new Date(history[0].timestamp);
        crossoverMinute = Math.round(ms / 60000);
        break;
      }
    }
  }

  data.outcome = {
    ...outcome,
    enrichedAt:        new Date().toISOString(),
    openingF1Odds:     firstPoint?.fighter1?.numericOdds ?? null,
    openingF2Odds:     firstPoint?.fighter2?.numericOdds ?? null,
    closingF1Odds:     lastPoint?.fighter1?.numericOdds  ?? null,
    closingF2Odds:     lastPoint?.fighter2?.numericOdds  ?? null,
    lineMovementF1:    (firstPoint && lastPoint)
                         ? lastPoint.fighter1.numericOdds - firstPoint.fighter1.numericOdds
                         : null,
    crossoverOccurred,
    crossoverMinute
  };

  if (!DRY_RUN) fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { status: 'enriched', file: info.filename, outcome: data.outcome };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🧠 BET BOT ENRICHER${DRY_RUN ? ' (DRY RUN — no writes)' : ''}\n`);

  const allFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('dk_') && !f.startsWith('crossover'));

  const files = SINGLE
    ? allFiles.filter(f => f === SINGLE)
    : allFiles;

  const parsed = files.map(parseFightFile).filter(Boolean);
  const todo   = parsed.filter(p => {
    const data   = JSON.parse(fs.readFileSync(path.join(DATA_DIR, p.filename), 'utf8'));
    const method = (data.outcome && data.outcome.method || '').toLowerCase();
    // Include fights with no outcome OR with useless ESPN "Final" method
    return !data.outcome || method === 'final' || method === '';
  });

  console.log(`Total fight files : ${parsed.length}`);
  console.log(`Already enriched  : ${parsed.length - todo.length}`);
  console.log(`Need enrichment   : ${todo.length}\n`);

  if (!todo.length) { console.log('Nothing to do.\n'); return; }

  const results = { enriched: 0, not_found: 0, error: 0 };

  for (let i = 0; i < todo.length; i++) {
    const info = todo[i];
    const prefix = `[${String(i+1).padStart(3)}/${todo.length}] ${info.fightId.slice(0,55).padEnd(55)}`;
    process.stdout.write(prefix + ' … ');
    try {
      const result = await enrichFight(info);
      if (result.status === 'enriched') {
        const o = result.outcome;
        console.log(`✓ ${o.winnerName} | ${o.method} R${o.round ?? '?'} | ${o.source}`);
        results.enriched++;
      } else {
        console.log('✗ not found');
        results.not_found++;
      }
    } catch (e) {
      console.log(`✗ ERROR: ${e.message}`);
      results.error++;
    }
    await new Promise(r => setTimeout(r, 350)); // polite rate limit
  }

  console.log('\n═══════════════════════════════════');
  console.log(`  Enriched   : ${results.enriched}`);
  console.log(`  Not found  : ${results.not_found}`);
  console.log(`  Errors     : ${results.error}`);
  console.log('═══════════════════════════════════\n');
}

if (require.main === module) main().catch(console.error);

// Export helpers for testing
module.exports = { parseFightFile, fuzzy, bothMatch, norm };
