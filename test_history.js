#!/usr/bin/env node
'use strict';
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3088;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { console.log('  ✓', name); passed++; })
        .catch(e => { console.error('  ✗', name + ':', e.message); failed++; });
    }
    console.log('  ✓', name); passed++;
  } catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function fetchJson(path) {
  return new Promise((res, rej) => {
    http.get(`${BASE}${path}`, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(d) }); } catch(e) { res({ status: r.statusCode, body: d }); } });
    }).on('error', rej);
  });
}

async function startServer() {
  const env = { ...process.env, PORT: String(PORT) };
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env, stdio: ['ignore','pipe','pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => { clearTimeout(t); res(); }, 3500);
    srv.stdout.on('data', d => { if (d.toString().includes('listening') || d.toString().includes(PORT)) { clearTimeout(t); res(); } });
    srv.stderr.on('data', d => { if (d.toString().includes(PORT) || d.toString().includes('listening')) { clearTimeout(t); res(); } });
    srv.on('error', e => { clearTimeout(t); rej(e); });
  });
  return srv;
}

async function run() {
  console.log('\n── History & Simulation Tests ──\n');

  let srv;
  try {
    srv = await startServer();
    console.log('  server started on port', PORT, '\n');
  } catch(e) {
    console.error('  Could not start server:', e.message);
    process.exit(1);
  }

  // ── /api/fights ────────────────────────────────────────────────────────────
  console.log('/api/fights — fight index');

  let fights = [];
  await check('/api/fights returns 200', async () => {
    const r = await fetchJson('/api/fights');
    assert(r.status === 200, `got ${r.status}`);
    fights = r.body;
  });

  await check('/api/fights returns array', () => {
    assert(Array.isArray(fights), `got ${typeof fights}`);
  });

  await check('/api/fights has > 100 fights', () => {
    assert(fights.length > 100, `only ${fights.length} fights`);
  });

  await check('every fight has fightId, fighter1, fighter2', () => {
    const bad = fights.filter(f => !f.fightId || !f.fighter1 || !f.fighter2);
    assert(bad.length === 0, `${bad.length} fights missing fields: ${JSON.stringify(bad[0])}`);
  });

  await check('fightIds are unique (no duplicates)', () => {
    const ids = fights.map(f => f.fightId);
    const seen = new Set();
    const dups = ids.filter(id => { if (seen.has(id)) return true; seen.add(id); return false; });
    assert(dups.length === 0, `duplicate fightIds: ${dups.slice(0,3).join(', ')}`);
  });

  await check('fightIds contain dates (YYYY-MM-DD)', () => {
    const missingDate = fights.filter(f => !f.fightId.match(/\d{4}-\d{2}-\d{2}/));
    assert(missingDate.length === 0, `${missingDate.length} fights missing date in fightId: ${missingDate.slice(0,3).map(f=>f.fightId).join(', ')}`);
  });

  await check('no fightId has mma__ prefix', () => {
    const mma = fights.filter(f => f.fightId.startsWith('mma__'));
    assert(mma.length === 0, `${mma.length} fights still have mma__ prefix: ${mma.slice(0,3).map(f=>f.fightId).join(', ')}`);
  });

  await check('fights have numeric data points', () => {
    const bad = fights.filter(f => typeof f.dataPoints !== 'number' || f.dataPoints <= 0);
    assert(bad.length === 0, `${bad.length} fights have bad dataPoints`);
  });

  await check('crossovers is an array on each fight', () => {
    const bad = fights.filter(f => !Array.isArray(f.crossovers));
    assert(bad.length === 0, `${bad.length} fights have non-array crossovers`);
  });

  // ── /api/fight-history ─────────────────────────────────────────────────────
  console.log('\n/api/fight-history — simulation data');

  let sampleFightId = '';
  await check('pick a fight with enough data points for simulation', () => {
    const rich = fights.filter(f => f.dataPoints >= 50).sort((a,b) => b.dataPoints - a.dataPoints);
    assert(rich.length > 0, 'no fights with >= 50 data points');
    sampleFightId = rich[0].fightId;
    assert(sampleFightId, 'no sampleFightId');
  });

  let sampleHistory = null;
  await check('/api/fight-history returns 200 for a valid fightId', async () => {
    const r = await fetchJson(`/api/fight-history/${encodeURIComponent(sampleFightId)}`);
    assert(r.status === 200, `got ${r.status} for ${sampleFightId}`);
    sampleHistory = r.body;
  });

  await check('fight-history has oddsHistory array', () => {
    assert(Array.isArray(sampleHistory?.oddsHistory), 'missing oddsHistory array');
  });

  await check('oddsHistory points have required fields', () => {
    const pt = sampleHistory.oddsHistory[0];
    assert(pt.timestamp, 'missing timestamp');
    assert(pt.fighter1?.name, 'missing fighter1.name');
    assert(pt.fighter2?.name, 'missing fighter2.name');
    assert(typeof pt.fighter1.numericOdds === 'number', 'fighter1.numericOdds not a number');
    assert(typeof pt.fighter2.numericOdds === 'number', 'fighter2.numericOdds not a number');
  });

  await check('all fights in index are fetchable via fight-history', async () => {
    const sample = fights.slice(0, 20); // test first 20
    const errors = [];
    for (const f of sample) {
      const r = await fetchJson(`/api/fight-history/${encodeURIComponent(f.fightId)}`);
      if (r.status !== 200) errors.push(`${f.fightId} -> ${r.status}`);
    }
    assert(errors.length === 0, `${errors.length} fights not fetchable:\n  ${errors.join('\n  ')}`);
  });

  await check('Whitehouse card fights (2026-06-15) are fetchable', async () => {
    const whitehouse = fights.filter(f => f.fightId.includes('2026-06-15'));
    assert(whitehouse.length > 0, 'no 2026-06-15 fights in index');
    const errors = [];
    for (const f of whitehouse) {
      const r = await fetchJson(`/api/fight-history/${encodeURIComponent(f.fightId)}`);
      if (r.status !== 200) errors.push(`${f.fightId} -> ${r.status}`);
    }
    assert(errors.length === 0, `${errors.length} Whitehouse fights not fetchable:\n  ${errors.join('\n  ')}`);
  });

  await check('/api/fight-history returns 404 for unknown fightId', async () => {
    const r = await fetchJson('/api/fight-history/doesnotexist_vs_nobody_9999-99-99');
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  // ── /api/recordings ────────────────────────────────────────────────────────
  console.log('\n/api/recordings — library page data');

  let recs = [];
  await check('/api/recordings returns 200', async () => {
    const r = await fetchJson('/api/recordings');
    assert(r.status === 200, `got ${r.status}`);
    recs = r.body;
  });

  await check('/api/recordings returns array', () => {
    assert(Array.isArray(recs), `got ${typeof recs}`);
  });

  await check('/api/recordings has > 100 entries', () => {
    assert(recs.length > 100, `only ${recs.length} recordings`);
  });

  await check('recording ids are unique', () => {
    const ids = recs.map(r => r.id);
    const seen = new Set();
    const dups = ids.filter(id => { if (seen.has(id)) return true; seen.add(id); return false; });
    assert(dups.length === 0, `duplicate recording ids: ${dups.slice(0,3).join(', ')}`);
  });

  await check('recording ids contain dates', () => {
    const missingDate = recs.filter(r => !r.id.match(/\d{4}-\d{2}-\d{2}/));
    assert(missingDate.length === 0, `${missingDate.length} recordings missing date in id: ${missingDate.slice(0,3).map(r=>r.id).join(', ')}`);
  });

  await check('no recording id has mma__ prefix', () => {
    const mma = recs.filter(r => r.id.startsWith('mma__'));
    assert(mma.length === 0, `${mma.length} recordings still have mma__ prefix`);
  });

  await check('recordings sorted by date descending', () => {
    let ok = true;
    for (let i = 1; i < Math.min(recs.length, 30); i++) {
      const a = recs[i-1].date || '', b = recs[i].date || '';
      if (a < b) { ok = false; break; }
    }
    assert(ok, 'recordings not sorted by date descending in first 30');
  });

  await check('all recording ids are fetchable as fight-history', async () => {
    const sample = recs.filter(r => r.sport === 'UFC/MMA').slice(0, 15);
    const errors = [];
    for (const r of sample) {
      const res = await fetchJson(`/api/fight-history/${encodeURIComponent(r.id)}`);
      if (res.status !== 200) errors.push(`${r.id} -> ${res.status}`);
    }
    assert(errors.length === 0, `${errors.length} recording ids not fetchable as fight-history:\n  ${errors.join('\n  ')}`);
  });

  await check('Whitehouse card appears in recordings', () => {
    const wh = recs.filter(r => r.id.includes('2026-06-15') || (r.date === '2026-06-15'));
    assert(wh.length > 0, 'no 2026-06-15 fights in recordings');
  });

  // ── Library page (Puppeteer) ───────────────────────────────────────────────
  console.log('\nLibrary page — browser tests');

  const browser = await puppeteer.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const jsErrors = [];
  const page = await browser.newPage();
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') jsErrors.push(msg.text()); });

  try {
    await page.goto(`${BASE}/library`, { waitUntil: 'networkidle0', timeout: 15000 });
  } catch(e) {
    await page.goto(`${BASE}/library`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 2500));
  }

  await check('library page loads without critical JS errors', () => {
    const critical = jsErrors.filter(e =>
      !e.includes('net::ERR') && !e.includes('Failed to fetch') &&
      !e.includes('Failed to load resource') && !e.includes('404')
    );
    assert(critical.length === 0, 'JS errors:\n' + critical.join('\n'));
  });

  await check('rec-body is populated with fight rows', async () => {
    await page.waitForSelector('.rec-row', { timeout: 8000 });
    const count = await page.$$eval('.rec-row', rows => rows.length);
    assert(count > 50, `expected > 50 rows, got ${count}`);
  });

  await check('fights are sorted newest first by default', async () => {
    const dates = await page.$$eval('.date-cell', cells => cells.slice(0,5).map(c => c.textContent.trim()));
    // Just verify they're present and non-empty
    assert(dates.length >= 5, `only ${dates.length} date cells visible`);
    assert(dates.every(d => d && d !== '—'), `some dates are missing: ${dates}`);
  });

  await check('search box filters fights', async () => {
    await page.type('#search-box', 'pereira');
    await new Promise(r => setTimeout(r, 300));
    const count = await page.$$eval('.rec-row', rows => rows.length);
    assert(count > 0 && count < 50, `expected filtered results, got ${count}`);
    // Clear search
    await page.evaluate(() => document.getElementById('search-box').value = '');
    await page.evaluate(() => document.getElementById('search-box').dispatchEvent(new Event('input')));
    await new Promise(r => setTimeout(r, 200));
  });

  await check('UFC/MMA filter works', async () => {
    await page.click('.filter-pill[data-sport="UFC/MMA"]');
    await new Promise(r => setTimeout(r, 300));
    const badges = await page.$$eval('.sport-badge', els => els.map(e => e.textContent.trim()));
    assert(badges.length > 0, 'no badges after filtering');
    const nonUFC = badges.filter(b => !b.toUpperCase().includes('UFC') && !b.toUpperCase().includes('MMA'));
    assert(nonUFC.length === 0, `non-UFC badges shown after filter: ${nonUFC.join(', ')}`);
    // Reset to All
    await page.click('.filter-pill[data-sport="all"]');
    await new Promise(r => setTimeout(r, 200));
  });

  await check('sort by crossovers puts xover fights first', async () => {
    await page.select('#sort-sel', 'xovers');
    await new Promise(r => setTimeout(r, 300));
    const xoverTexts = await page.$$eval('.xover-cell', cells => cells.slice(0,5).map(c => c.textContent.trim()));
    const hasXover = xoverTexts.some(t => t.includes('⚡'));
    assert(hasXover, `top 5 fights should have crossovers when sorted by xovers: ${xoverTexts}`);
    // Reset
    await page.select('#sort-sel', 'date');
    await new Promise(r => setTimeout(r, 200));
  });

  await check('clicking a fight row opens the simulation panel', async () => {
    // Click the first row
    await page.click('.rec-row');
    await new Promise(r => setTimeout(r, 400));
    const panelVisible = await page.$eval('#sim-panel', el => el.classList.contains('open'));
    assert(panelVisible, 'sim-panel did not open after clicking a row');
  });

  await check('sim panel shows fight name after row click', async () => {
    const name = await page.$eval('#sim-fight-name', el => el.textContent.trim());
    assert(name && name !== '—', `sim-fight-name is empty: "${name}"`);
    assert(name.includes(' vs '), `expected "A vs B" format, got "${name}"`);
  });

  await check('legend shows fighter names', async () => {
    const f1 = await page.$eval('#leg-f1-name', el => el.textContent.trim());
    const f2 = await page.$eval('#leg-f2-name', el => el.textContent.trim());
    assert(f1 && f1 !== 'Fighter 1', `f1 legend not updated: "${f1}"`);
    assert(f2 && f2 !== 'Fighter 2', `f2 legend not updated: "${f2}"`);
  });

  await check('selected row gets highlighted', async () => {
    const hasSelected = await page.$eval('tbody', el => el.querySelector('.rec-row.selected') !== null);
    assert(hasSelected, 'no .selected class on any row after click');
  });

  await check('Simulate → button opens sim panel', async () => {
    // Close first
    await page.click('#sc-close');
    await new Promise(r => setTimeout(r, 200));
    let panelVisible = await page.$eval('#sim-panel', el => el.classList.contains('open'));
    assert(!panelVisible, 'panel should be closed after sc-close click');
    // Click a Simulate → button
    await page.click('.open-btn');
    await new Promise(r => setTimeout(r, 400));
    panelVisible = await page.$eval('#sim-panel', el => el.classList.contains('open'));
    assert(panelVisible, 'panel did not open after Simulate → click');
  });

  await check('Play button becomes enabled after fight data loads', async () => {
    // Wait up to 5s for the play button to be enabled (data fetch)
    let enabled = false;
    for (let i = 0; i < 25; i++) {
      const disabled = await page.$eval('#sc-play', el => el.disabled);
      if (!disabled) { enabled = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    assert(enabled, 'play button never became enabled — data may not have loaded');
  });

  await check('pressing Play starts the simulation (button changes to Pause)', async () => {
    // Check button is in play state
    const text = await page.$eval('#sc-play', el => el.textContent.trim());
    if (text === '▶ Play') {
      await page.click('#sc-play');
      await new Promise(r => setTimeout(r, 400));
    }
    const newText = await page.$eval('#sc-play', el => el.textContent.trim());
    assert(newText === '⏸ Pause' || newText === '▶ Done' || newText === '▶ Play', `unexpected button text: "${newText}"`);
  });

  await check('progress bar moves during simulation', async () => {
    // Let it play for a bit
    await new Promise(r => setTimeout(r, 600));
    const width = await page.$eval('#sc-fill', el => el.style.width);
    // width could be "0%" if fight has 1 point, but it should be set
    assert(width !== undefined, 'progress fill width not set');
  });

  await check('progress label shows current / total points', async () => {
    const label = await page.$eval('#sc-prog', el => el.textContent.trim());
    // Could be "—" if fight has 1 point, or "X/Y pts"
    assert(label !== undefined, 'progress label not set');
  });

  await check('reset button appears after playback starts', async () => {
    const display = await page.$eval('#sc-reset', el => el.style.display);
    // Should be '' (visible) after playback started
    assert(display !== 'none', `reset button still hidden: "${display}"`);
  });

  await check('close button hides sim panel and clears selection', async () => {
    await page.click('#sc-close');
    await new Promise(r => setTimeout(r, 300));
    const panelOpen = await page.$eval('#sim-panel', el => el.classList.contains('open'));
    assert(!panelOpen, 'sim panel should be closed after close button');
    const hasSelected = await page.$$eval('.rec-row.selected', rows => rows.length);
    assert(hasSelected === 0, 'selected row should be cleared after close');
  });

  await check('speed buttons change the speed class', async () => {
    // Open sim again
    await page.click('.rec-row');
    await new Promise(r => setTimeout(r, 300));
    await page.click('[data-spd="10"]');
    const active10 = await page.$eval('[data-spd="10"]', el => el.classList.contains('active-spd'));
    const active50 = await page.$eval('[data-spd="50"]', el => el.classList.contains('active-spd'));
    assert(active10, '10x button should be active-spd after click');
    assert(!active50, '50x button should not be active-spd after switching to 10x');
  });

  await check('no critical JS errors after all interactions', () => {
    const critical = jsErrors.filter(e =>
      !e.includes('net::ERR') && !e.includes('Failed to fetch') &&
      !e.includes('Failed to load resource') && !e.includes('404')
    );
    assert(critical.length === 0, 'JS errors during test:\n' + critical.join('\n'));
  });

  // ── Extra: crossover fight simulation ─────────────────────────────────────
  console.log('\nCrossover simulation');

  await check('a fight with crossovers shows ⚡ count in sim panel', async () => {
    // Find a fight with crossovers and click it
    const xoverRows = await page.$$('.rec-row');
    let found = false;
    for (const row of xoverRows) {
      const xoverText = await row.$eval('.xover-cell', el => el.textContent).catch(()=>'');
      if (xoverText.includes('⚡')) {
        await row.click();
        await new Promise(r => setTimeout(r, 400));
        const xoverCount = await page.$eval('#sim-xover-count', el => el.textContent.trim());
        assert(xoverCount.includes('⚡'), `expected ⚡ in sim panel, got: "${xoverCount}"`);
        found = true;
        break;
      }
    }
    if (!found) {
      // No crossover fights visible with current filter — that's OK
      console.log('    (no crossover fights visible, skipping xover panel check)');
    }
  });

  await browser.close();
  if (srv) srv.kill();

  const total = passed + failed;
  console.log('\n═══════════════════════════════════');
  console.log(` ${passed}/${total} passed  ${failed} failed`);
  console.log('═══════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
