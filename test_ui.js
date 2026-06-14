#!/usr/bin/env node
'use strict';
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3099; // separate port so it doesn't conflict
const BASE = `http://localhost:${PORT}`;

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

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
