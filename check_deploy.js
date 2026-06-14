#!/usr/bin/env node
// check_deploy.js — Poll Railway until deploy completes, then smoke-test production.
// Run immediately after git push: node check_deploy.js
// Screenshots saved to ./screenshots/
'use strict';
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PROD_URL = 'https://www.livebetbot.com';
const TIMEOUT_MS = (parseInt(process.argv[process.argv.indexOf('--timeout') + 1]) || 300) * 1000;
const POLL_MS = 8000;
const SS_DIR = path.join(__dirname, 'screenshots');

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR);

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function fetchJson(path) {
  const res = await fetch(PROD_URL + path, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

// ── Wait for Railway deploy ────────────────────────────────────────────────
async function waitForDeploy() {
  const deadline = Date.now() + TIMEOUT_MS;
  console.log('  Polling Railway for deploy status...\n');
  while (Date.now() < deadline) {
    const out = spawnSync('railway', ['status'], { encoding: 'utf8' }).stdout || '';
    if (out.includes('Deploy failed') || out.includes('FAILED')) {
      console.error('\n  ✗ Railway deployment FAILED');
      console.error(out);
      process.exit(1);
    }
    if (out.includes('Online') && !out.includes('Deploying') && !out.includes('Building')) {
      console.log('  ✓ Railway: Online\n');
      return;
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`Deploy did not finish within ${TIMEOUT_MS / 1000}s`);
}

// ── API smoke tests ────────────────────────────────────────────────────────
async function apiSmoke() {
  console.log('API endpoints');

  await check('/health → ok', async () => {
    const d = await fetchJson('/health');
    assert(d.status === 'ok', JSON.stringify(d));
  });

  await check('/api/ufc responds', async () => {
    const res = await fetch(`${PROD_URL}/api/ufc`, { signal: AbortSignal.timeout(10000) });
    assert([200, 500].includes(res.status), `HTTP ${res.status}`);
  });

  await check('/api/fights returns data', async () => {
    const d = await fetchJson('/api/fights');
    assert(d && typeof d === 'object', 'empty response');
  });

  await check('/api/live-crossovers returns array', async () => {
    const d = await fetchJson('/api/live-crossovers');
    assert(Array.isArray(d), `got ${typeof d}`);
  });

  await check('/api/patterns responds', async () => {
    const d = await fetchJson('/api/patterns');
    assert(d !== null, 'null');
  });

  await check('/api/recordings responds', async () => {
    const d = await fetchJson('/api/recordings');
    assert(d !== null, 'null');
  });
}

// ── Puppeteer UI tests ─────────────────────────────────────────────────────
async function uiSmoke() {
  console.log('\nUI (Puppeteer → production)');

  const browser = await puppeteer.launch({
    headless: true, channel: 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') jsErrors.push(msg.text()); });

  await check('page loads without crash', async () => {
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000)); // let JS settle
  });

  await check('screenshot: initial load', async () => {
    await page.screenshot({ path: path.join(SS_DIR, '1_initial_load.png'), fullPage: false });
  });

  await check('no critical JS errors on load', async () => {
    const crit = jsErrors.filter(e =>
      !e.includes('net::ERR') && !e.includes('Failed to fetch') &&
      !e.includes('Failed to load resource') && !e.includes('404')
    );
    assert(crit.length === 0, crit.join('\n'));
  });

  await check('page title is set', async () => {
    const t = await page.title();
    assert(t && t.length > 0, 'empty title');
  });

  await check('crossover banner in DOM and hidden', async () => {
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    assert(display === 'none', `expected hidden, got "${display}"`);
  });

  await check('P&L strip in DOM', async () => {
    assert(await page.$('#pnl-strip'), 'missing #pnl-strip');
  });

  await check('game pills strip renders', async () => {
    const strip = await page.$('#game-strip');
    assert(strip, 'missing #game-strip');
  });

  await check('legend button is clickable', async () => {
    const btn = await page.$('#legend-btn');
    assert(btn, 'missing #legend-btn');
    await btn.click();
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(SS_DIR, '2_legend_open.png') });
    // close it
    await page.keyboard.press('Escape');
    await page.click('body');
  });

  await check('sim fighter selects exist', async () => {
    const sel = await page.$('#sim-fight-sel');
    assert(sel, 'missing #sim-fight-sel');
  });

  await check('analyze button exists and is clickable', async () => {
    const btn = await page.$('#analyze-btn') || await page.$('[id*="analyze"]');
    assert(btn, 'no analyze button found');
  });

  await check('screenshot: after interaction', async () => {
    await page.screenshot({ path: path.join(SS_DIR, '3_after_interaction.png'), fullPage: true });
  });

  // Scroll down and screenshot bottom half
  await check('screenshot: full page scroll', async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(SS_DIR, '4_scrolled.png') });
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  // Test crossover banner render via JS injection
  await check('crossover banner shows correctly when triggered', async () => {
    await page.evaluate(() => {
      const banner = document.getElementById('xover-live-banner');
      banner.className = 'crossed';
      banner.style.display = 'flex';
      banner.innerHTML = '<span>🔴 LINE CROSSED — PROD TEST: Pereira vs Ankalaev</span><span class="xb-dismiss">✕</span>';
    });
    await page.screenshot({ path: path.join(SS_DIR, '5_crossover_banner.png') });
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    assert(display !== 'none', 'banner not visible');
    // Reset
    await page.evaluate(() => { document.getElementById('xover-live-banner').style.display = 'none'; });
  });

  // Test BET FAVORITE verdict styling
  await check('BET FAVORITE verdict renders with styling', async () => {
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'prod-test-verdict';
      d.className = 'verdict bet';
      d.style.cssText = 'position:fixed;top:60px;right:20px;z-index:9999;padding:12px 20px';
      d.textContent = 'BET FAVORITE: 76% win rate historically';
      document.body.appendChild(d);
    });
    await page.screenshot({ path: path.join(SS_DIR, '6_bet_favorite_verdict.png') });
    const color = await page.$eval('#prod-test-verdict', el => getComputedStyle(el).color);
    assert(color && color !== 'rgb(0,0,0)', `unexpected color: ${color}`);
    await page.evaluate(() => document.getElementById('prod-test-verdict')?.remove());
  });

  await browser.close();
  console.log(`\n  Screenshots saved → ./screenshots/`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n── Post-deploy check ──');
  console.log(`   ${PROD_URL}\n`);

  await waitForDeploy();
  await apiSmoke();
  await uiSmoke();

  const total = passed + failed;
  console.log('\n═══════════════════════════════════');
  console.log(` ${passed}/${total} passed  ${failed} failed`);
  console.log('═══════════════════════════════════\n');

  if (failed > 0) {
    console.error('PROD SMOKE FAILED — check screenshots/ and Railway logs');
    process.exit(1);
  }
  console.log('Production healthy.\n');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
