const https = require('https');
const fs = require('fs');
const path = require('path');
const { getUpcomingFilmRoomCard, toSlug } = require('../tape_engine');

const CACHE_PATH = path.join(__dirname, '..', 'analysis', 'paramount_tape_cache.json');

function queryParamount(term) {
  return new Promise((resolve) => {
    const url = 'https://www.paramountplus.com/search/vod-lookup/?term=' + encodeURIComponent(term) + '&offset=0&limit=5';
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(j.result?.data || []);
        } catch (_) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function hydrate() {
  console.log('--- Starting Automated Paramount+ Link Hydration ---');
  let cache = {};
  if (fs.existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch (_) {}
  }

  const cardData = getUpcomingFilmRoomCard();
  console.log(`Found ${cardData.card.length} bouts on upcoming card.`);

  let addedCount = 0;

  for (const bout of cardData.card) {
    for (const fighter of [bout.fighter1, bout.fighter2]) {
      const tape = fighter.tape?.[0];
      if (!tape) continue;

      const yearMatch = (tape.date || '').match(/\b(20\d{2})\b/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : 2026;

      // Only 2026+ fights belong on Paramount+
      if (year < 2026) {
        console.log(`[Pre-2026] Skipping ${fighter.name} (${tape.date}) -> Fight Pass exclusive.`);
        continue;
      }

      const slug = toSlug(fighter.name);
      if (cache[slug] && cache[slug].url && cache[slug].url.includes('/shows/video/ALVE')) {
        console.log(`[Cached]   ${fighter.name.padEnd(22)} -> ${cache[slug].contentId}`);
        continue;
      }

      console.log(`[Resolving] ${fighter.name.padEnd(22)} ...`);
      let results = await queryParamount(fighter.name);
      let best = results[0];

      // If no hit on fighter name, try their opponent
      if (!best && tape.opponent) {
        console.log(`  Trying opponent: ${tape.opponent} ...`);
        const oppResults = await queryParamount(tape.opponent);
        best = oppResults[0];
      }

      if (best && best.contentId) {
        cache[slug] = {
          name: fighter.name,
          contentId: best.contentId,
          title: best.title,
          url: 'https://www.paramountplus.com' + best.href,
          duration: best.durationAndSeries || ''
        };
        console.log(`  ✓ RESOLVED: ${best.contentId} | ${best.title}`);
        addedCount++;
      } else {
        console.log(`  ✗ NOT FOUND on Paramount+ for ${fighter.name}`);
      }
    }
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`\nHydration complete! Added ${addedCount} new links. Total cached: ${Object.keys(cache).length}`);
}

hydrate().catch(console.error);
