'use strict';
// test_extension_scan.js — runs the REAL scanner code from dk-extension/content.js in a real browser
// against a DraftKings-style page. Checks the two silent-drop cases are handled:
//   1. odds on screen, team names found  -> outcomes with side + american
//   2. no odds on screen                 -> empty result
// Run: node test_extension_scan.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/louislapat/.npm/_npx/bc46ece8a1067505/node_modules/playwright');

const src = fs.readFileSync(path.join(__dirname, 'dk-extension', 'content.js'), 'utf8');
// Pull the helper functions out of content.js exactly as shipped.
const start = src.indexOf('  function americanToImplied');
const end = src.indexOf('  // ── Live-fight detection');
if (start < 0 || end < 0) { console.error('could not locate scanner in content.js'); process.exit(1); }
const scannerSource = src.slice(start, end);

const fixture = `<!doctype html><html><body>
  <div class="event-card">
    <div class="row"><span class="team">Kyle Bruce</span>
      <button><span>Kyle Bruce</span><span>+230</span></button>
    </div>
    <div class="row"><span class="team">Dan Wulf</span>
      <button><span>Dan Wulf</span><span>−290</span></button>
    </div>
  </div>
  <div class="event-card"><button>Parlay builder</button></div>
</body></html>`;
const emptyFixture = `<!doctype html><html><body><p>Checking your location...</p></body></html>`;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let passed = 0, failed = 0;
  const check = (name, ok, detail) => { if (ok) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, detail || ''); } };

  await page.setContent(fixture);
  const found = await page.evaluate(code => (0, eval)('(function(){' + code + ' return scanOddsFromPage(); })()'), scannerSource);
  check('finds both prices on the page', found.length === 2, JSON.stringify(found));
  const names = found.map(o => o.side);
  check('names both teams', names.includes('Kyle Bruce') && names.includes('Dan Wulf'), JSON.stringify(names));
  const prices = found.map(o => o.american).sort((a, b) => a - b);
  check('reads the prices, including the unicode minus', JSON.stringify(prices) === JSON.stringify([-290, 230]), JSON.stringify(prices));

  await page.setContent(emptyFixture);
  const none = await page.evaluate(code => (0, eval)('(function(){' + code + ' return scanOddsFromPage(); })()'), scannerSource);
  check('returns nothing when no odds are on screen', none.length === 0, JSON.stringify(none));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness error', e); process.exit(1); });
