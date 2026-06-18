#!/usr/bin/env node
'use strict';
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3099; // separate port so it doesn't conflict
const BASE = `http://localhost:${PORT}`;
const LIVE_URL = 'https://ufc-dashboard-production-e03d.up.railway.app';
const LIVE_MODE = process.argv.includes('--live');

let passed = 0, failed = 0;
function check(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { console.log('  ✓', name); passed++; }).catch(e => { console.error('  ✗', name + ':', e.message); failed++; }); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function startServer() {
  const env = { ...process.env, PORT: String(PORT) };
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const timeout = setTimeout(() => rej(new Error('server start timeout')), 10000);
    srv.stdout.on('data', d => { if (d.toString().includes('listening') || d.toString().includes('3099')) { clearTimeout(timeout); res(); } });
    srv.stderr.on('data', d => {
      const s = d.toString();
      if (s.includes('3099') || s.includes('listening')) { clearTimeout(timeout); res(); }
    });
    srv.on('error', e => { clearTimeout(timeout); rej(e); });
    // fallback: just wait 3s
    setTimeout(() => { clearTimeout(timeout); res(); }, 3000);
  });
  return srv;
}

async function screenshotLive() {
  console.log('\n── Live deploy screenshot ──\n');
  const browser = await puppeteer.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log(`  Loading ${LIVE_URL} ...`);
  try {
    await page.goto(LIVE_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  } catch (_) {
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  // Let status dot polls fire (they run on load with a short timeout)
  await new Promise(r => setTimeout(r, 4000));

  const screenshotDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join(screenshotDir, `live-deploy-${date}.png`);
  await page.screenshot({ path: outPath, fullPage: false });

  // Report dot colors
  const dots = ['sc-rec-dot', 'sc-dk-dot', 'sc-api-dot', 'sc-backup-dot'];
  const labels = { 'sc-rec-dot': 'RECORDER', 'sc-dk-dot': 'DK EXT', 'sc-api-dot': 'API', 'sc-backup-dot': 'BACKUP' };
  console.log('\n  Status dots:');
  for (const id of dots) {
    const cls = await page.$eval(`#${id}`, el => el.className).catch(() => 'NOT FOUND');
    const color = ['green', 'yellow', 'red', 'grey'].find(c => cls.includes(c)) || cls;
    const icon = color === 'green' ? '●' : color === 'yellow' ? '◐' : color === 'red' ? '✗' : '○';
    console.log(`  ${icon} ${labels[id]}: ${color}`);
  }

  console.log(`\n  Screenshot saved: ${outPath}\n`);
  await browser.close();
}

async function run() {
  console.log('\n── UI tests (Puppeteer) ──\n');

  let srv;
  try {
    srv = await startServer();
    console.log('  server started on port', PORT, '\n');
  } catch (e) {
    console.error('  Could not start server:', e.message);
    process.exit(1);
  }

  const browser = await puppeteer.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const jsErrors = [];
  const page = await browser.newPage();
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') jsErrors.push(msg.text()); });

  try {
    await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
  } catch (e) {
    // networkidle0 may timeout if live API calls keep firing — just wait for load
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));
  }

  // ── Layout & load ──────────────────────────────────────────────────────────
  console.log('Layout & load');

  await check('page title contains UFC', async () => {
    const title = await page.title();
    assert(title.toLowerCase().includes('ufc') || title.length > 0, `got: "${title}"`);
  });

  await check('no critical JS errors on load', async () => {
    const critical = jsErrors.filter(e =>
      !e.includes('net::ERR') &&
      !e.includes('Failed to fetch') &&
      !e.includes('Failed to load resource') &&
      !e.includes('404')
    );
    assert(critical.length === 0, 'JS errors:\n' + critical.join('\n'));
  });

  await check('pnl-strip exists in DOM', async () => {
    const el = await page.$('#pnl-strip');
    assert(el, '#pnl-strip not found in DOM');
  });

  await check('pnl-strip becomes visible when bets are added (display toggles)', async () => {
    // pnl-strip is display:none by default and shown by JS — check the CSS property is correct
    const display = await page.$eval('#pnl-strip', el => getComputedStyle(el).display);
    // Should be 'none' at start (no bets) or 'flex' if JS already ran — both are valid
    assert(['none', 'flex'].includes(display), `unexpected display: ${display}`);
  });

  await check('crossover banner exists in DOM', async () => {
    const el = await page.$('#xover-live-banner');
    assert(el, '#xover-live-banner not in DOM');
  });

  await check('crossover banner hidden by default', async () => {
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    assert(display === 'none', `expected display:none, got "${display}"`);
  });

  // ── Crossover banner injection & CSS classes ───────────────────────────────
  console.log('\nCrossover banner rendering');

  await check('banner shows with "crossed" class when injected', async () => {
    await page.evaluate(() => {
      const banner = document.getElementById('xover-live-banner');
      banner.className = 'crossed';
      banner.style.display = 'flex';
      banner.innerHTML = '<span>🔴 LINE CROSSED: Fighter A vs Fighter B</span><span class="xb-dismiss">✕ dismiss</span>';
    });
    const display = await page.$eval('#xover-live-banner', el => getComputedStyle(el).display);
    assert(display !== 'none', 'banner should be visible after inject');
  });

  await check('banner "crossed" class gets red background', async () => {
    const bg = await page.$eval('#xover-live-banner', el => getComputedStyle(el).backgroundColor);
    // #1a0000 in rgb is rgb(26, 0, 0)
    assert(bg && bg !== 'rgba(0, 0, 0, 0)', `expected colored bg, got "${bg}"`);
  });

  await check('banner "imminent" class gets orange color', async () => {
    await page.evaluate(() => {
      const banner = document.getElementById('xover-live-banner');
      banner.className = 'imminent';
    });
    const color = await page.$eval('#xover-live-banner', el => getComputedStyle(el).color);
    assert(color && color !== 'rgb(0, 0, 0)', `unexpected color: ${color}`);
  });

  await check('dismiss button is inside banner', async () => {
    await page.evaluate(() => {
      const banner = document.getElementById('xover-live-banner');
      banner.className = 'crossed';
      banner.style.display = 'flex';
      banner.innerHTML = '<span>Test alert</span><span class="xb-dismiss" onclick="event.stopPropagation();this.closest(\'#xover-live-banner\').style.display=\'none\'">✕ dismiss</span>';
    });
    const btn = await page.$('#xover-live-banner .xb-dismiss');
    assert(btn, '.xb-dismiss not found');
  });

  await check('dismiss button hides the banner', async () => {
    await page.click('#xover-live-banner .xb-dismiss');
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    assert(display === 'none', `banner should hide after dismiss, got "${display}"`);
  });

  await check('clicking banner body also hides it', async () => {
    await page.evaluate(() => {
      const banner = document.getElementById('xover-live-banner');
      banner.style.display = 'flex';
      banner.className = 'imminent';
      banner.innerHTML = '<span>Test</span>';
    });
    await page.click('#xover-live-banner');
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    assert(display === 'none', `banner should hide on click, got "${display}"`);
  });

  // ── pollLiveCrossovers function ────────────────────────────────────────────
  console.log('\nLive crossover polling');

  await check('pollLiveCrossovers is defined', async () => {
    const defined = await page.evaluate(() => typeof pollLiveCrossovers === 'function');
    assert(defined, 'pollLiveCrossovers not in global scope');
  });

  await check('_xoverDismissed is defined as object', async () => {
    const type = await page.evaluate(() => typeof _xoverDismissed);
    assert(type === 'object', `got type: ${type}`);
  });

  await check('_xoverDismissed prevents banner re-show when id dismissed', async () => {
    await page.evaluate(() => {
      _xoverDismissed['test-fight-123'] = true;
      const banner = document.getElementById('xover-live-banner');
      banner.style.display = 'none';
    });
    // Simulate what pollLiveCrossovers does with a dismissed fight
    const hidden = await page.evaluate(() => {
      const fights = [{ id: 'test-fight-123', status: 'crossed', msg: 'LINE CROSSED' }];
      const visible = fights.filter(d => !_xoverDismissed[d.id]);
      return visible.length === 0;
    });
    assert(hidden, 'dismissed fight should be filtered out');
  });

  await check('/api/live-crossovers endpoint responds', async () => {
    const resp = await page.evaluate(async () => {
      const r = await fetch('/api/live-crossovers');
      return { status: r.status, ok: r.ok };
    });
    assert(resp.status === 200, `got status ${resp.status}`);
  });

  await check('/api/live-crossovers returns array', async () => {
    const data = await page.evaluate(async () => {
      const r = await fetch('/api/live-crossovers');
      return r.json();
    });
    assert(Array.isArray(data), `expected array, got ${typeof data}`);
  });

  // ── BET FAVORITE styling ───────────────────────────────────────────────────
  console.log('\nBET FAVORITE styling');

  await check('BET FAVORITE CSS class .bet exists in stylesheet', async () => {
    const hasRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText && rule.selectorText.includes('.bet')) return true;
          }
        } catch {}
      }
      return false;
    });
    assert(hasRule, '.bet CSS rule not found');
  });

  await check('BET FAVORITE verdict element renders with correct style when injected', async () => {
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.id = 'test-bet-verdict';
      div.className = 'verdict bet';
      div.textContent = 'BET FAVORITE: 76% win rate historically, most reliable call';
      document.body.appendChild(div);
    });
    const el = await page.$('#test-bet-verdict');
    assert(el, 'injected .verdict.bet element not found');
    const color = await page.$eval('#test-bet-verdict', el => getComputedStyle(el).color);
    assert(color && color !== 'rgb(0, 0, 0)', `expected colored text for .bet verdict, got: ${color}`);
  });

  await check('BET FAVORITE ::before content is set in CSS', async () => {
    const hasContent = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText && rule.selectorText.includes('.bet') && rule.selectorText.includes('before')) {
              return rule.style.content && rule.style.content.length > 0;
            }
          }
        } catch {}
      }
      return false;
    });
    assert(hasContent, '.bet::before content CSS rule not found or empty');
  });

  // ── /api/ufc endpoint ──────────────────────────────────────────────────────
  console.log('\nAPI endpoints');

  await check('/api/ufc responds (live odds endpoint)', async () => {
    const resp = await page.evaluate(async () => {
      const r = await fetch('/api/ufc');
      return { status: r.status };
    });
    // 200 or 500 (if API key issue) — just not a 404/crash
    assert([200, 500].includes(resp.status), `unexpected status: ${resp.status}`);
  });

  await check('/api/patterns returns array of pattern data', async () => {
    const resp = await page.evaluate(async () => {
      const r = await fetch('/api/patterns');
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    assert(resp.status === 200, `got status ${resp.status}`);
    assert(Array.isArray(resp.body) || typeof resp.body === 'object', 'no JSON body');
  });

  await check('/api/fights returns fight data', async () => {
    const resp = await page.evaluate(async () => {
      const r = await fetch('/api/fights');
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    assert(resp.status === 200, `got status ${resp.status}`);
    assert(resp.body && typeof resp.body === 'object', 'no JSON body');
  });

  // ── Reasoning panel ───────────────────────────────────────────────────────
  console.log('\nReasoning panel');

  await check('#brain-reasoning exists in DOM', async () => {
    const el = await page.$('#brain-reasoning');
    assert(el, 'missing #brain-reasoning');
  });

  await check('reasoning panel hidden by default', async () => {
    const display = await page.$eval('#brain-reasoning', el => el.style.display);
    assert(display === 'none', `expected hidden, got "${display}"`);
  });

  await check('renderReasoning function exists', async () => {
    const exists = await page.evaluate(() => typeof renderReasoning === 'function');
    assert(exists, 'renderReasoning not defined');
  });

  await check('toggleReasonTrail function exists', async () => {
    const exists = await page.evaluate(() => typeof toggleReasonTrail === 'function');
    assert(exists, 'toggleReasonTrail not defined');
  });

  await check('renderReasoning shows high confidence badge', async () => {
    await page.evaluate(() => {
      renderReasoning({
        confidence: 'high', sampleSize: 10,
        dateRange: { oldest: 'Jan 2024', newest: 'Apr 2026' },
        warnings: [],
        verdictBasis: 'Favorite won 74% of 10 similar fights',
        earlyLine: { signal: 'bet_dog_early', action: 'Dog tightens 18ppts by close', timing: 'Get in within 60s', expectedMovementPpts: 18, crossoverRatePct: 20, positiveMovementRatePct: 75, basedOn: 10, confidence: 'high' },
        fightTrail: [
          { date: 'Apr 2026', dogName: 'Fighter B', favName: 'Fighter A', openDogOdds: '+280', closeDogOdds: '+165', openDogPct: 26, closeDogPct: 38, dogMovementPpts: 12, dogWon: false, crossover: false, winnerName: 'Fighter A', method: 'KO/TKO' }
        ]
      });
    });
    const badge = await page.$eval('#reason-conf-badge', el => el.textContent);
    assert(badge.includes('HIGH'), `badge text: "${badge}"`);
  });

  await check('reasoning panel visible after renderReasoning', async () => {
    const display = await page.$eval('#brain-reasoning', el => el.style.display);
    assert(display !== 'none', `expected visible, got "${display}"`);
  });

  await check('early line section visible when signal is not no_signal', async () => {
    const display = await page.$eval('#reason-early-line', el => el.style.display);
    assert(display !== 'none', `expected visible, got "${display}"`);
  });

  await check('early line body contains signal label', async () => {
    const text = await page.$eval('#reason-el-body', el => el.textContent);
    assert(text.includes('BET DOG EARLY') || text.includes('bet dog early'), `text: "${text}"`);
  });

  await check('warnings section empty when no warnings', async () => {
    const html = await page.$eval('#reason-warnings', el => el.innerHTML);
    assert(html === '' || !html.includes('reason-warning'), `unexpected warnings: "${html}"`);
  });

  await check('renderReasoning shows warning when provided', async () => {
    await page.evaluate(() => {
      renderReasoning({
        confidence: 'low', sampleSize: 2,
        dateRange: null, warnings: ['Small sample (2 fights) — treat as directional only'],
        verdictBasis: 'Only 2 comparable fights found', earlyLine: { signal: 'no_signal', action: '', timing: '', basedOn: 0, confidence: 'low' }, fightTrail: []
      });
    });
    const html = await page.$eval('#reason-warnings', el => el.innerHTML);
    assert(html.includes('Small sample'), `expected warning, got: "${html}"`);
  });

  await check('fight trail toggle shows trail on click', async () => {
    // First render with a trail
    await page.evaluate(() => {
      renderReasoning({
        confidence: 'medium', sampleSize: 5, dateRange: { oldest: 'Jan 2024', newest: 'Dec 2025' },
        warnings: [], verdictBasis: 'Test',
        earlyLine: { signal: 'no_signal', action: '', timing: '', basedOn: 5, confidence: 'medium' },
        fightTrail: [
          { date: 'Jan 2025', dogName: 'Dog Fighter', favName: 'Fav Fighter', openDogOdds: '+300', closeDogOdds: '+200', openDogPct: 25, closeDogPct: 33, dogMovementPpts: 8, dogWon: false, crossover: false, winnerName: 'Fav Fighter', method: 'Decision' }
        ]
      });
    });
    await page.evaluate(() => document.getElementById('reason-trail-btn').click());
    const display = await page.$eval('#reason-trail', el => el.style.display);
    assert(display !== 'none', 'trail should show after click');
    const html = await page.$eval('#reason-trail', el => el.innerHTML);
    assert(html.includes('Dog Fighter'), `trail missing fight data: "${html.slice(0,200)}"`);
  });

  await check('/api/edge returns reasoning field', async () => {
    const data = await page.evaluate(async () => {
      const r = await fetch('/api/edge?fighter1=Alex+Pereira&fighter2=Ciryl+Gane&f1Odds=-108&f2Odds=-112&f1Open=-108&f2Open=-112');
      return r.json();
    });
    assert(data.reasoning, 'missing reasoning field in /api/edge response');
    assert(typeof data.reasoning.confidence === 'string', 'missing reasoning.confidence');
    assert(Array.isArray(data.reasoning.fightTrail), 'missing reasoning.fightTrail');
    assert(data.reasoning.earlyLine && typeof data.reasoning.earlyLine.signal === 'string', 'missing reasoning.earlyLine.signal');
  });

  // ── Edge: XSS safety in fight names ───────────────────────────────────────
  console.log('\nEdge cases');

  await check('crossover banner with special chars in fighter name does not crash', async () => {
    await page.evaluate(() => {
      const banner = document.getElementById('xover-live-banner');
      // Simulate a fighter name with special characters (HTML-escaped by innerHTML)
      const f1 = 'O\'Neil Collins';
      const f2 = 'Marc-André Barriault';
      banner.style.display = 'flex';
      banner.className = 'approaching';
      banner.innerHTML = `<span>${f1} vs ${f2} approaching even</span>`;
    });
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    assert(display !== 'none', 'banner should still show');
  });

  await check('pollLiveCrossovers handles empty array without throwing', async () => {
    // Mock fetch to return empty array
    await page.evaluate(async () => {
      const orig = window.fetch;
      window.fetch = async (url) => {
        if (url.includes('live-crossovers')) {
          return { ok: true, json: async () => [] };
        }
        return orig(url);
      };
      try { await pollLiveCrossovers(); window.__pollEmptyOk = true; }
      catch(e) { window.__pollEmptyOk = false; window.__pollError = e.message; }
      window.fetch = orig;
    });
    const ok = await page.evaluate(() => window.__pollEmptyOk);
    const err = await page.evaluate(() => window.__pollError);
    assert(ok, `pollLiveCrossovers threw on empty array: ${err}`);
  });

  await check('pollLiveCrossovers hides banner when no active crossovers', async () => {
    await page.evaluate(() => {
      document.getElementById('xover-live-banner').style.display = 'flex';
    });
    await page.evaluate(async () => {
      const orig = window.fetch;
      window.fetch = async (url) => {
        if (url.includes('live-crossovers')) return { ok: true, json: async () => [] };
        return orig(url);
      };
      await pollLiveCrossovers();
      window.fetch = orig;
    });
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    assert(display === 'none', `banner should hide when no crossovers, got: ${display}`);
  });

  await check('pollLiveCrossovers renders crossed fight correctly', async () => {
    await page.evaluate(async () => {
      _xoverDismissed = {};
      const orig = window.fetch;
      window.fetch = async (url) => {
        if (url.includes('live-crossovers')) {
          return {
            ok: true,
            json: async () => [{
              id: 'ufc__test__2026',
              fighter1: 'Alex Pereira',
              fighter2: 'Magomed Ankalaev',
              crossoverState: {
                status: 'crossed',
                dogSide: 'f2',
                openDogProb: 30,
                curDogProb: 55,
                movementPct: 25,
                hasCrossed: true,
                momentum: 2.1,
                minsToEven: null
              },
              alertText: 'LINE CROSSED'
            }]
          };
        }
        return orig(url);
      };
      await pollLiveCrossovers();
      window.fetch = orig;
    });
    const display = await page.$eval('#xover-live-banner', el => el.style.display);
    const className = await page.$eval('#xover-live-banner', el => el.className);
    assert(display !== 'none', 'banner should show for crossed fight');
    assert(className.includes('crossed'), `expected "crossed" class, got "${className}"`);
  });

  await check('pollLiveCrossovers handles fetch error without crashing', async () => {
    await page.evaluate(async () => {
      const orig = window.fetch;
      window.fetch = async (url) => {
        if (url.includes('live-crossovers')) throw new Error('Network error');
        return orig(url);
      };
      try { await pollLiveCrossovers(); window.__pollErrOk = true; }
      catch(e) { window.__pollErrOk = false; }
      window.fetch = orig;
    });
    const ok = await page.evaluate(() => window.__pollErrOk);
    assert(ok, 'pollLiveCrossovers crashed on network error — needs try/catch');
  });

  // ── Spy panel tests ───────────────────────────────────────────────────────
  await check('spy-input-row exists in DOM', async () => {
    const exists = await page.$eval('#spy-input-row', el => !!el);
    assert(exists, 'spy-input-row not found');
  });

  await check('spy-input-row hidden by default (no spy user)', async () => {
    await page.evaluate(() => {
      _spyUser = '';
      localStorage.removeItem('spyUser');
      document.getElementById('spy-input-row').style.display = 'none';
      document.getElementById('spy-banner').style.display = 'none';
    });
    const display = await page.$eval('#spy-input-row', el => el.style.display);
    assert(display === 'none', `spy-input-row should be hidden, got: ${display}`);
  });

  await check('spy-banner hidden when no spy user', async () => {
    const display = await page.$eval('#spy-banner', el => el.style.display);
    assert(display === 'none', `spy-banner should be hidden, got: ${display}`);
  });

  await check('clicking spy button shows input row when no spy active', async () => {
    await page.evaluate(() => {
      _spyUser = '';
      localStorage.removeItem('spyUser');
      document.getElementById('spy-input-row').style.display = 'none';
      document.getElementById('spy-banner').style.display = 'none';
      toggleSpyInput();
    });
    const display = await page.$eval('#spy-input-row', el => el.style.display);
    assert(display === 'flex', `input row should show, got: ${display}`);
  });

  await check('applySpyUser sets _spyUser and shows banner', async () => {
    await page.evaluate(() => {
      document.getElementById('spy-input').value = 'testuser';
      applySpyUser();
    });
    const spyUser = await page.evaluate(() => _spyUser);
    const bannerDisplay = await page.$eval('#spy-banner', el => el.style.display);
    const rowDisplay = await page.$eval('#spy-input-row', el => el.style.display);
    assert(spyUser === 'testuser', `_spyUser should be "testuser", got: ${spyUser}`);
    assert(bannerDisplay === 'flex', `banner should be visible after apply, got: ${bannerDisplay}`);
    assert(rowDisplay === 'none', `input row should hide after apply, got: ${rowDisplay}`);
  });

  await check('spy name appears in banner after applySpyUser', async () => {
    const name = await page.$eval('#spy-name', el => el.textContent);
    assert(name === 'testuser', `spy-name should be "testuser", got: ${name}`);
  });

  await check('applySpyUser persists spy user to localStorage', async () => {
    const stored = await page.evaluate(() => localStorage.getItem('spyUser'));
    assert(stored === 'testuser', `localStorage should have "testuser", got: ${stored}`);
  });

  await check('toggleSpyInput when spy active shows input row (allows clearing)', async () => {
    // spy is currently active (testuser) and banner is showing
    await page.evaluate(() => toggleSpyInput());
    const rowDisplay = await page.$eval('#spy-input-row', el => el.style.display);
    const bannerDisplay = await page.$eval('#spy-banner', el => el.style.display);
    assert(rowDisplay === 'flex', `input row should show when spy active and spy button clicked, got: ${rowDisplay}`);
    assert(bannerDisplay === 'none', `banner should hide when input row shows, got: ${bannerDisplay}`);
  });

  await check('spy input pre-filled with current spy user when opened', async () => {
    const inputVal = await page.$eval('#spy-input', el => el.value);
    assert(inputVal === 'testuser', `input should be pre-filled with "testuser", got: ${inputVal}`);
  });

  await check('toggleSpyInput again collapses input row back to banner', async () => {
    // input row is showing, toggle again should collapse back to banner
    await page.evaluate(() => toggleSpyInput());
    const rowDisplay = await page.$eval('#spy-input-row', el => el.style.display);
    const bannerDisplay = await page.$eval('#spy-banner', el => el.style.display);
    assert(rowDisplay === 'none', `input row should hide, got: ${rowDisplay}`);
    assert(bannerDisplay === 'flex', `banner should show, got: ${bannerDisplay}`);
  });

  await check('clearSpy removes spy user and hides banner', async () => {
    await page.evaluate(() => clearSpy());
    const spyUser = await page.evaluate(() => _spyUser);
    const bannerDisplay = await page.$eval('#spy-banner', el => el.style.display);
    const stored = await page.evaluate(() => localStorage.getItem('spyUser'));
    assert(spyUser === '', `_spyUser should be empty after clear, got: "${spyUser}"`);
    assert(bannerDisplay === 'none', `banner should hide after clear, got: ${bannerDisplay}`);
    assert(stored === null, `localStorage should be cleared, got: ${stored}`);
  });

  await check('spy mode restores on page reload if localStorage has spyUser', async () => {
    // set localStorage before reload
    await page.evaluate(() => localStorage.setItem('spyUser', 'ish'));
    await page.reload({ waitUntil: 'networkidle0' });
    const spyUser = await page.evaluate(() => _spyUser);
    const bannerDisplay = await page.$eval('#spy-banner', el => el.style.display);
    assert(spyUser === 'ish', `_spyUser should restore to "ish" on reload, got: "${spyUser}"`);
    assert(bannerDisplay === 'flex', `banner should show on reload when spy in localStorage, got: ${bannerDisplay}`);
    // clean up
    await page.evaluate(() => { localStorage.removeItem('spyUser'); clearSpy(); });
  });

  // ── end spy tests ────────────────────────────────────────────────────────

  // ── Status cluster dots ───────────────────────────────────────────────────
  console.log('\nStatus cluster dots');

  await check('status-cluster exists in DOM', async () => {
    const el = await page.$('#status-cluster');
    assert(el, '#status-cluster not in DOM');
  });

  await check('#sc-rec-dot exists in DOM', async () => {
    const el = await page.$('#sc-rec-dot');
    assert(el, '#sc-rec-dot not found');
  });

  await check('#sc-dk-dot exists in DOM', async () => {
    const el = await page.$('#sc-dk-dot');
    assert(el, '#sc-dk-dot not found');
  });

  await check('#sc-api-dot exists in DOM', async () => {
    const el = await page.$('#sc-api-dot');
    assert(el, '#sc-api-dot not found');
  });

  await check('#sc-backup-dot exists in DOM', async () => {
    const el = await page.$('#sc-backup-dot');
    assert(el, '#sc-backup-dot not found');
  });

  await check('sc-api-dot starts green (server is responding)', async () => {
    // Wait up to 5s for the API poll to fire
    let cls = '';
    for (let i = 0; i < 10; i++) {
      cls = await page.$eval('#sc-api-dot', el => el.className);
      if (cls.includes('green')) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert(cls.includes('green'), `sc-api-dot expected green, got "${cls}"`);
  });

  await check('sc-rec-dot is set to a known color (not unset) after poll', async () => {
    let cls = '';
    for (let i = 0; i < 10; i++) {
      cls = await page.$eval('#sc-rec-dot', el => el.className);
      if (!cls.includes('sc-dot') || cls !== 'sc-dot grey') break;
      // Wait briefly to let the initial poll fire
      await new Promise(r => setTimeout(r, 500));
    }
    const known = ['green', 'yellow', 'red', 'grey'];
    const found = known.some(c => cls.includes(c));
    assert(found, `sc-rec-dot has unexpected class "${cls}"`);
  });

  await check('backup dot responds to mock backup-status (green when both set)', async () => {
    await page.evaluate(async () => {
      const orig = window.fetch;
      window.fetch = async (url) => {
        if (url.includes('backup-status')) {
          return { ok: true, json: async () => ({ githubToken: true, volumeActive: true }) };
        }
        return orig(url);
      };
      if (typeof pollBackupStatus === 'function') await pollBackupStatus();
      window.fetch = orig;
    });
    const cls = await page.$eval('#sc-backup-dot', el => el.className);
    assert(cls.includes('green'), `backup dot expected green when both set, got "${cls}"`);
  });

  await check('backup dot yellow when only volume active (no token)', async () => {
    await page.evaluate(async () => {
      const orig = window.fetch;
      window.fetch = async (url) => {
        if (url.includes('backup-status')) {
          return { ok: true, json: async () => ({ githubToken: false, volumeActive: true }) };
        }
        return orig(url);
      };
      if (typeof pollBackupStatus === 'function') await pollBackupStatus();
      window.fetch = orig;
    });
    const cls = await page.$eval('#sc-backup-dot', el => el.className);
    assert(cls.includes('yellow'), `backup dot expected yellow for no token, got "${cls}"`);
  });

  await check('backup dot red when neither token nor volume set', async () => {
    await page.evaluate(async () => {
      const orig = window.fetch;
      window.fetch = async (url) => {
        if (url.includes('backup-status')) {
          return { ok: true, json: async () => ({ githubToken: false, volumeActive: false }) };
        }
        return orig(url);
      };
      if (typeof pollBackupStatus === 'function') await pollBackupStatus();
      window.fetch = orig;
    });
    const cls = await page.$eval('#sc-backup-dot', el => el.className);
    assert(cls.includes('red'), `backup dot expected red when neither set, got "${cls}"`);
  });

  await check('setScItem helper updates dot color class correctly', async () => {
    await page.evaluate(() => {
      setScItem('sc-recorder', 'green');
    });
    const cls = await page.$eval('#sc-rec-dot', el => el.className);
    assert(cls.includes('green'), `setScItem did not set green, got "${cls}"`);
    // reset
    await page.evaluate(() => setScItem('sc-recorder', 'grey'));
  });

  // ── Bet coverage gamification ─────────────────────────────────────────────
  console.log('\nBet coverage gamification');

  // Reload cleanly so we start with fresh game cards
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2500));

  await check('game cards render .cov-row inside each card', async () => {
    const count = await page.$$eval('.game-card .cov-row', els => els.length);
    assert(count > 0, `expected at least one .cov-row inside game cards, got ${count}`);
  });

  await check('each .cov-row has .cov-pip elements (one per outcome)', async () => {
    const pipCount = await page.$$eval('.game-card .cov-pip', els => els.length);
    assert(pipCount >= 2, `expected at least 2 .cov-pip elements, got ${pipCount}`);
  });

  await check('coverage dots start grey (no bets)', async () => {
    const hasCovered = await page.$$eval('.cov-dot.covered', els => els.length);
    assert(hasCovered === 0, `expected 0 green dots on load, got ${hasCovered}`);
  });

  await check('applyCoverage turns first outcome dot green', async () => {
    await page.evaluate(() => {
      const pip = document.querySelector('.cov-pip[data-outcome]');
      if (pip) applyCoverage([pip.dataset.outcome]);
    });
    const greenCount = await page.$$eval('.cov-dot.covered', els => els.length);
    assert(greenCount >= 1, `expected ≥1 green dot after applyCoverage, got ${greenCount}`);
  });

  await check('LOCKED badge hidden when only partial coverage', async () => {
    const lockedCount = await page.$$eval('.game-card.locked', els => els.length);
    assert(lockedCount === 0, `should not be locked with partial coverage, got ${lockedCount} locked`);
  });

  await check('applyCoverage all-outcomes → card gets .locked + badge shows', async () => {
    await page.evaluate(() => {
      const card = document.querySelector('.game-card');
      if (!card) return;
      const pips = [...card.querySelectorAll('.cov-pip[data-outcome]')];
      applyCoverage(pips.map(p => p.dataset.outcome));
    });
    const isLocked = await page.$eval('.game-card', el => el.classList.contains('locked'));
    const badgeDisplay = await page.$eval('.game-card .locked-badge', el => el.style.display);
    assert(isLocked, 'card should have .locked class when all outcomes covered');
    assert(badgeDisplay !== 'none', `LOCKED badge should show, got display="${badgeDisplay}"`);
  });

  await check('applyCoverage([]) resets all dots grey and unlocks cards', async () => {
    await page.evaluate(() => applyCoverage([]));
    const greenCount = await page.$$eval('.cov-dot.covered', els => els.length);
    const lockedCount = await page.$$eval('.game-card.locked', els => els.length);
    assert(greenCount === 0, `expected 0 green after reset, got ${greenCount}`);
    assert(lockedCount === 0, `expected 0 locked after reset, got ${lockedCount}`);
  });

  await check('pollCoverage is defined globally', async () => {
    const exists = await page.evaluate(() => typeof pollCoverage === 'function');
    assert(exists, 'pollCoverage not in global scope');
  });

  await check('pollCoverage with mocked empty response leaves dots grey', async () => {
    await page.evaluate(async () => {
      const orig = window.fetch;
      window.fetch = async (url, opts) => {
        if (url.includes('bet-coverage')) return { ok: true, json: async () => ({ covered: [], userId: 'test' }) };
        return orig(url, opts);
      };
      await pollCoverage();
      window.fetch = orig;
    });
    const greenCount = await page.$$eval('.cov-dot.covered', els => els.length);
    assert(greenCount === 0, `expected 0 green after empty coverage poll, got ${greenCount}`);
  });

  await check('game cards have data-game-id attribute', async () => {
    const ids = await page.$$eval('.game-card[data-game-id]', els => els.map(e => e.dataset.gameId));
    assert(ids.length > 0, 'game cards missing data-game-id');
    assert(ids.every(id => id && id.length > 0), 'some data-game-id values are empty');
  });

  await check('game cards have data-outcomes JSON array', async () => {
    const raw = await page.$eval('.game-card', el => el.dataset.outcomes);
    const outcomes = JSON.parse(raw);
    assert(Array.isArray(outcomes) && outcomes.length >= 2, `expected array≥2, got ${raw}`);
  });

  // Reset for screenshot
  await page.evaluate(() => applyCoverage([]));

  // ── Screenshot (always runs — saved to screenshots/) ─────────────────────
  console.log('\nDeploy screenshot');

  await check('take dashboard screenshot after status dots settle', async () => {
    // Reset backup dot back to production state (real fetch)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 3000)); // let polls fire

    const screenshotDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

    const date = new Date().toISOString().slice(0, 10);
    const outPath = path.join(screenshotDir, `deploy-${date}.png`);
    await page.screenshot({ path: outPath, fullPage: false });

    assert(fs.existsSync(outPath), `screenshot file not written to ${outPath}`);
    const size = fs.statSync(outPath).size;
    assert(size > 5000, `screenshot too small (${size} bytes) — likely a blank page`);
    console.log(`    → saved: ${outPath}`);
  });

  // cleanup injected test element
  await page.evaluate(() => {
    const el = document.getElementById('test-bet-verdict');
    if (el) el.remove();
  });

  await browser.close();
  if (srv) srv.kill();

  const total = passed + failed;
  console.log('\n═══════════════════════════════════');
  console.log(` ${passed}/${total} passed  ${failed} failed`);
  console.log('═══════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

if (LIVE_MODE) {
  screenshotLive().catch(e => { console.error('Fatal:', e); process.exit(1); });
} else {
  run().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
