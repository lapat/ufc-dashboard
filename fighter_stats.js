#!/usr/bin/env node
// fighter_stats.js — Scrapes ufc.com athlete pages for fighter career stats.
// Outputs: historical_data/fighter_profiles.json
//
// Run once to populate:  node fighter_stats.js
// Incremental update:    node fighter_stats.js --new-only
// Single fighter:        node fighter_stats.js --fighter "Belal Muhammad"
// Dry run (names only):  node fighter_stats.js --dry-run
//
// Used by crossover_predictor.js at runtime to adjust crossover probability
// based on fighter volatility (SAPM, sub avg, str/TD defense).

'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, 'historical_data');
const CACHE_FILE  = path.join(DATA_DIR, 'fighter_profiles.json');
const DRY_RUN     = process.argv.includes('--dry-run');
const NEW_ONLY    = process.argv.includes('--new-only');
const SINGLE      = process.argv.find(a => a.startsWith('--fighter='))?.split('=').slice(1).join('=')
                 || (process.argv.indexOf('--fighter') !== -1 ? process.argv[process.argv.indexOf('--fighter')+1] : null);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Extract fighter names from fight files ────────────────────────────────────

function extractAllFighters() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('dk_') && !f.startsWith('crossover') && !f.startsWith('fighter'));
  const nameSet = new Set();
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const h = data.oddsHistory || [];
      const f1 = h[0]?.fighter1?.name;
      const f2 = h[0]?.fighter2?.name;
      if (f1) nameSet.add(f1);
      if (f2) nameSet.add(f2);
    } catch (_) {}
  }
  return [...nameSet].sort();
}

// ── UFC.com scraping ──────────────────────────────────────────────────────────

function norm(s) { return (s||'').toLowerCase().replace(/[^a-z]/g,''); }

// Convert a fighter's display name to the ufc.com URL slug.
// e.g. "Sean O'Malley" → "sean-omalley", "Jan Błachowicz" → "jan-blachowicz"
// "Marc-Andre Barriault" → "marc-andre-barriault"
function nameToSlug(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/-/g, ' ')            // hyphens in name (Marc-Andre) → spaces, then re-joined
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')  // remove apostrophes, dots, etc.
    .trim()
    .replace(/\s+/g, '-');
}

// Try several slug variants for names that don't match the primary form.
function slugVariants(name) {
  const base = nameToSlug(name);
  const parts = base.split('-');
  const variants = [base];
  // Without middle name: "Ian Machado Garry" → "ian-garry"
  if (parts.length === 3) variants.push(parts[0] + '-' + parts[2]);
  // Without "Jr" suffix: "Raul Rosas Jr" → "raul-rosas"
  if (parts[parts.length - 1] === 'jr') variants.push(parts.slice(0, -1).join('-'));
  // Last name only variations handled by caller
  return variants;
}

async function scrapeUFCProfile(name) {
  const variants = slugVariants(name);
  for (const slug of variants) {
    const url = `https://www.ufc.com/athlete/${slug}`;
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      });
      if (!r.ok) continue;
      const html = await r.text();
      // ufc.com stat blocks: value comes before its label in the DOM
      // Pattern: c-stat-compare__number">VALUE ... c-stat-compare__label">LABEL
      const pairs = [];
      const re = /c-stat-compare__(?:number|label)"[^>]*>([^<]+)/g;
      let m;
      while ((m = re.exec(html)) !== null) pairs.push(m[1].trim());
      // pairs alternates: value, label, value, label, ...
      const stats = {};
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        stats[pairs[i + 1].toLowerCase()] = pairs[i];
      }
      const sf = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
      const slpm   = sf(stats['sig. str. landed']);
      const sapm   = sf(stats['sig. str. absorbed']);
      const tdAvg  = sf(stats['takedown avg']);
      const subAvg = sf(stats['submission avg']);
      const strDef = sf(stats['sig. str. defense']);
      const tdDef  = sf(stats['takedown defense']);
      const kdAvg  = sf(stats['knockdown avg']);
      if (slpm == null && sapm == null) continue; // page didn't have stats
      // Record W-L from page
      const recordM = html.match(/(\d+)-(\d+)-(\d+)/);
      return {
        slpm, sapm, tdAvg, subAvg,
        strDef, tdDef, kdAvg,
        wins:   recordM ? parseInt(recordM[1]) : null,
        losses: recordM ? parseInt(recordM[2]) : null,
        url,
      };
    } catch (_) {}
  }
  return null;
}

async function scrapeProfile(hash) {
  const url = `http://www.ufcstats.com/fighter-details/${hash}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return null;
    const html = await r.text();

    function stat(label) {
      const re = new RegExp(label + '[\\s\\S]{0,200}?([\\d.]+)\\s*<', 'i');
      const m = html.match(re);
      return m ? parseFloat(m[1]) : null;
    }

    // Extract the stats block (li items)
    const slpm    = stat('SLpM');
    const strAcc  = stat('Str\\. Acc');
    const sapm    = stat('SApM');
    const strDef  = stat('Str\\. Def');
    const tdAvg   = stat('TD Avg');
    const tdAcc   = stat('TD Acc');
    const tdDef   = stat('TD Def');
    const subAvg  = stat('Sub\\. Avg');

    // Record W-L-D from header
    const recordM = html.match(/(\d+)-(\d+)-(\d+)/);
    const wins    = recordM ? parseInt(recordM[1]) : null;
    const losses  = recordM ? parseInt(recordM[2]) : null;

    if (slpm == null && sapm == null) return null; // page didn't parse

    return { slpm, strAcc, sapm, strDef, tdAvg, tdAcc, tdDef, subAvg, wins, losses, url };
  } catch (_) {}
  return null;
}

// ── Volatility score (0-100) ──────────────────────────────────────────────────
// Measures how often this fighter's fights have dramatic momentum shifts.
// Inputs: UFC Stats career stats.
// Higher = more likely to be in a crossover fight.

function computeVolatility(profile) {
  if (!profile) return null;
  let score = 50; // baseline

  // SAPM (strikes absorbed per minute) — high = gets hit a lot = volatile fights
  // UFC avg ~3.5. Range roughly 1-7.
  if (profile.sapm != null) {
    const delta = (profile.sapm - 3.5) * 10; // +5 per 0.5 above avg
    score += Math.max(-20, Math.min(20, delta));
  }

  // Sub avg (submissions per 15 min) — high = can turn a fight with a sub from bad spot
  // UFC avg ~0.5. Range roughly 0-3.
  if (profile.subAvg != null) {
    if (profile.subAvg >= 1.5) score += 15;
    else if (profile.subAvg >= 0.8) score += 7;
  }

  // Str def (striking defense) — low = gets struck = volatile
  // 60% = bad, 80% = good. Invert and scale.
  if (profile.strDef != null) {
    const pct = profile.strDef > 1 ? profile.strDef / 100 : profile.strDef; // handle 0-1 or 0-100
    const delta = (0.70 - pct) * 80; // if strDef is 60%, +8 pts; if 80%, -8 pts
    score += Math.max(-15, Math.min(15, delta));
  }

  // TD def — low = gets taken down = position reversals possible
  if (profile.tdDef != null) {
    const pct = profile.tdDef > 1 ? profile.tdDef / 100 : profile.tdDef;
    if (pct < 0.50) score += 8;
    else if (pct < 0.65) score += 4;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ── Public API ────────────────────────────────────────────────────────────────

function loadFighterProfiles() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) { return {}; }
}

function getFighterVolatility(name, profiles) {
  if (!profiles || !name) return null;
  const key = norm(name);
  // Try exact match first, then partial
  const entry = profiles[name] || Object.values(profiles).find(p => norm(p.name) === key);
  if (!entry?.stats) return null;
  return entry.volatility ?? computeVolatility(entry.stats);
}

// Average volatility of two fighters, weighted toward the more volatile one
// (one volatile fighter is enough to create a crossover opportunity)
function fightVolatilityScore(f1Name, f2Name, profiles) {
  const v1 = getFighterVolatility(f1Name, profiles);
  const v2 = getFighterVolatility(f2Name, profiles);
  if (v1 == null && v2 == null) return null;
  if (v1 == null) return v2;
  if (v2 == null) return v1;
  // Weight toward the higher one — one volatile fighter makes a volatile fight
  return Math.round(0.35 * Math.min(v1, v2) + 0.65 * Math.max(v1, v2));
}

module.exports = { loadFighterProfiles, getFighterVolatility, fightVolatilityScore, computeVolatility, extractAllFighters };

// ── Main (scraper CLI) ────────────────────────────────────────────────────────

async function main() {
  console.log(`\n👊 FIGHTER STATS SCRAPER${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const allNames = SINGLE ? [SINGLE] : extractAllFighters();
  const profiles = loadFighterProfiles();
  const existing = Object.keys(profiles);

  const todo = NEW_ONLY
    ? allNames.filter(n => !profiles[n])
    : allNames;

  console.log(`Total unique fighters : ${allNames.length}`);
  console.log(`Already cached        : ${existing.length}`);
  console.log(`To scrape             : ${todo.length}\n`);

  if (DRY_RUN) {
    todo.forEach(n => console.log(' ', n));
    return;
  }

  let scraped = 0, notFound = 0, errors = 0;

  for (let i = 0; i < todo.length; i++) {
    const name   = todo[i];
    const prefix = `[${String(i+1).padStart(3)}/${todo.length}] ${name.padEnd(32)}`;
    process.stdout.write(prefix + ' … ');

    try {
      const stats = await scrapeUFCProfile(name);
      if (!stats) { console.log('✗ not found'); notFound++; continue; }

      const volatility = computeVolatility(stats);
      profiles[name] = { name, stats, volatility, cachedAt: new Date().toISOString() };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(profiles, null, 2));
      console.log(`✓ vol=${volatility} SAPM=${stats.sapm} sub=${stats.subAvg} strDef=${stats.strDef}`);
      scraped++;
    } catch (e) {
      console.log(`✗ ERROR: ${e.message}`);
      errors++;
    }
    await new Promise(r => setTimeout(r, 250)); // polite rate limit
  }

  console.log('\n═══════════════════════════════════');
  console.log(`  Scraped   : ${scraped}`);
  console.log(`  Not found : ${notFound}`);
  console.log(`  Errors    : ${errors}`);
  console.log('═══════════════════════════════════\n');
}

if (require.main === module) main().catch(console.error);
