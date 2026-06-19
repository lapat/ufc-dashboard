#!/usr/bin/env node
'use strict';
/**
 * test_bet_placement.js
 *
 * Tests the EXACT chrome.scripting.executeScript injected function from background.js
 * against a mock DraftKings sportsbook page running in a local Puppeteer browser.
 *
 * No live DK session needed. No Chrome extension needed.
 * This tests every DOM step the bet placer performs:
 *   Step 1 — find outcome button by text label
 *   Step 2 — find wager input by aria-label / class
 *   Step 3 — React-set input value, fire input+change events
 *   Step 4 — click Place Bet, detect confirmation / oddsChanged / suspended
 *
 * Run: node test_bet_placement.js
 * Cost: $0.00 — 100% local, no API calls, no real bets placed
 */

const puppeteer = require('puppeteer');

let passed = 0, failed = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function check(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name + ':', e.message);
    failed++;
  }
}

// ── Mock DK HTML ──────────────────────────────────────────────────────────
// Mimics the DK sportsbook DOM structure that the injected script searches.
// Outcome buttons: <button><span>TeamName</span><span>-350</span></button>
// Wager input: aria-label="Wager" (appears after outcome click)
// Place Bet: text "Place Bet" (enabled by default, can be disabled for tests)
// Confirmation: body text updated after Place Bet click
const MOCK_DK_HTML = `<!DOCTYPE html>
<html>
<head><title>Mock DK Sportsbook</title></head>
<body>
  <div id="game">
    <button id="btn-canada">
      <span>Canada</span>
      <span>-350</span>
    </button>
    <button id="btn-draw">
      <span>Draw</span>
      <span>+280</span>
    </button>
    <button id="btn-qatar">
      <span>Qatar</span>
      <span>+800</span>
    </button>
  </div>

  <div id="betslip" class="sportsbook-betslip" style="display:none; padding:10px">
    <p>Selected: <span id="selected-side"></span></p>
    <input
      id="wager-input"
      aria-label="Wager"
      type="number"
      placeholder="Enter Wager"
      style="width:100px"
    />
    <button id="place-bet-btn">Place Bet</button>
  </div>

  <div id="confirm-area"></div>

  <script>
    // Track what the test clicked
    window.__mockState = { clicked: null, amount: null, inputEvents: [], betPlaced: false };

    // Outcome buttons open the bet slip
    ['btn-canada','btn-draw','btn-qatar'].forEach(id => {
      document.getElementById(id).addEventListener('click', () => {
        const btn = document.getElementById(id);
        const side = [...btn.querySelectorAll('span')].find(s =>
          s.childElementCount === 0 && !/^[+-]\\d+$/.test(s.textContent.trim())
        )?.textContent.trim() || '';
        window.__mockState.clicked = side;
        document.getElementById('selected-side').textContent = side;
        document.getElementById('betslip').style.display = 'block';
        btn.setAttribute('aria-pressed', 'true');
      });
    });

    // Input event tracking — confirms React setter fires events
    document.addEventListener('input', e => {
      if (e.target.id === 'wager-input') window.__mockState.inputEvents.push('input');
    });
    document.addEventListener('change', e => {
      if (e.target.id === 'wager-input') window.__mockState.inputEvents.push('change');
    });

    // Place Bet click — shows confirmation
    document.getElementById('place-bet-btn').addEventListener('click', () => {
      window.__mockState.amount = parseFloat(document.getElementById('wager-input').value);
      window.__mockState.betPlaced = true;
      document.getElementById('confirm-area').textContent = 'Bet Placed! Your wager is confirmed.';
      document.getElementById('betslip').style.display = 'none';
    });
  </script>
</body>
</html>`;

// ── The exact injected function from background.js ────────────────────────
// Copy-pasted verbatim — any diff between this and background.js is a test gap.
const INJECTED_BET_PLACER = async (side, amount) => {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function setReactInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const sideL = side.toLowerCase().trim();

  const allClickable = [...document.querySelectorAll('button, [role="button"]')];
  let outcomeBtn = null;

  for (const el of allClickable) {
    const spans = el.querySelectorAll('span, div, p');
    const labelSpan = [...spans].find(s =>
      s.childElementCount === 0 && s.textContent.trim().toLowerCase() === sideL
    );
    if (labelSpan) { outcomeBtn = el; break; }
  }

  // Fallback: looser match
  if (!outcomeBtn) {
    outcomeBtn = allClickable.find(el => {
      const t = el.textContent.trim().toLowerCase();
      return (t === sideL || t.startsWith(sideL + '\n') || t.startsWith(sideL + ' '));
    });
  }

  if (!outcomeBtn) {
    return { ok: false, step: 'find_button', error: `No button found for "${side}" — make sure the game is visible on screen` };
  }

  const oddsEl = [...outcomeBtn.querySelectorAll('span, div')].find(s =>
    s.childElementCount === 0 && /^[+-]\d+$/.test(s.textContent.trim())
  );
  const oddsText = oddsEl ? oddsEl.textContent.trim() : '?';

  outcomeBtn.click();
  await sleep(1200);

  let amtInput = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    amtInput = [...document.querySelectorAll('input')]
      .find(el =>
        /wager|amount|stake|bet amount/i.test(el.getAttribute('aria-label') || el.placeholder || '') ||
        (el.type === 'number' && el.closest('[class*="betslip"], [class*="bet-slip"], [class*="BetSlip"], [class*="sportsbook-betslip"]'))
      );
    if (amtInput) break;
    await sleep(400);
  }

  if (!amtInput) {
    return { ok: false, step: 'find_input', oddsText, error: 'Bet slip did not open or amount input not found — try opening the bet slip manually first' };
  }

  amtInput.focus();
  setReactInput(amtInput, String(amount));
  await sleep(600);

  let placeBtn = [...document.querySelectorAll('button')]
    .find(btn => /place\s*bet|bet\s*now|submit/i.test(btn.textContent.trim()) && !btn.disabled);

  if (!placeBtn) {
    const disabledBtn = [...document.querySelectorAll('button')]
      .find(btn => /place\s*bet|bet\s*now/i.test(btn.textContent.trim()));
    if (disabledBtn) {
      return { ok: false, step: 'btn_disabled', oddsText, amount, error: 'Place Bet button is disabled — check balance or if odds changed' };
    }
    return { ok: false, step: 'find_placebtn', oddsText, amount, error: 'Place Bet button not found' };
  }

  placeBtn.click();
  await sleep(1500);

  const bodyText = document.body.innerText;
  const confirmed  = /bet\s+placed|congrats|success|confirmed/i.test(bodyText);
  const oddsChanged = /odds\s+(have\s+)?changed|accept\s+new\s+odds/i.test(bodyText);
  const suspended  = /market\s+suspended|betting\s+suspended/i.test(bodyText);

  if (oddsChanged) {
    return { ok: false, step: 'odds_changed', oddsText, amount, error: 'DK says odds changed — click "Accept New Odds" in the slip and retry' };
  }
  if (suspended) {
    return { ok: false, step: 'suspended', oddsText, error: 'Market suspended (goal? halftime?) — retry in 30s' };
  }

  return { ok: true, side, oddsText, amount, confirmed, step: 'done' };
};

// ── Helpers ───────────────────────────────────────────────────────────────
async function freshPage(browser) {
  const page = await browser.newPage();
  await page.setContent(MOCK_DK_HTML, { waitUntil: 'domcontentloaded' });
  return page;
}

async function runBet(page, side, amount) {
  return page.evaluate(INJECTED_BET_PLACER, side, amount);
}

// ── MAIN ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n═══════════════════════════════════');
  console.log('  BET PLACEMENT — LOCAL DOM TESTS');
  console.log('  Mock DK page, no live session');
  console.log('═══════════════════════════════════\n');

  const browser = await puppeteer.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // ── Section 1: Step-by-step unit tests (no injected script, test each DOM op) ──
  console.log('── Step 1: Find outcome button by text ──');
  {
    const page = await freshPage(browser);

    await check('Canada button found by exact label span text', async () => {
      const found = await page.evaluate(() => {
        const all = [...document.querySelectorAll('button, [role="button"]')];
        for (const el of all) {
          const spans = el.querySelectorAll('span, div, p');
          const lbl = [...spans].find(s => s.childElementCount === 0 && s.textContent.trim().toLowerCase() === 'canada');
          if (lbl) return { found: true, id: el.id };
        }
        return { found: false };
      });
      assert(found.found, `Canada button not found`);
      assert(found.id === 'btn-canada', `wrong button: ${found.id}`);
    });

    await check('Draw button found by exact label span text', async () => {
      const found = await page.evaluate(() => {
        const all = [...document.querySelectorAll('button')];
        for (const el of all) {
          const spans = [...el.querySelectorAll('span')];
          const lbl = spans.find(s => s.childElementCount === 0 && s.textContent.trim().toLowerCase() === 'draw');
          if (lbl) return { found: true, id: el.id };
        }
        return { found: false };
      });
      assert(found.found, 'Draw button not found');
      assert(found.id === 'btn-draw', `wrong button: ${found.id}`);
    });

    await check('Unknown side → find_button error (no button found)', async () => {
      const found = await page.evaluate((side) => {
        const sideL = side.toLowerCase().trim();
        const all = [...document.querySelectorAll('button, [role="button"]')];
        let btn = null;
        for (const el of all) {
          const lbl = [...el.querySelectorAll('span, div, p')].find(s => s.childElementCount === 0 && s.textContent.trim().toLowerCase() === sideL);
          if (lbl) { btn = el; break; }
        }
        if (!btn) btn = all.find(el => { const t = el.textContent.trim().toLowerCase(); return t === sideL; });
        return btn ? { found: true } : { found: false, step: 'find_button' };
      }, 'Uzbekistan');
      assert(!found.found, 'Uzbekistan should not be found');
      assert(found.step === 'find_button', `step should be find_button, got ${found.step}`);
    });

    await check('Odds text extracted from button span (+280 format)', async () => {
      const oddsText = await page.evaluate(() => {
        const btn = document.getElementById('btn-draw');
        const el = [...btn.querySelectorAll('span, div')].find(s =>
          s.childElementCount === 0 && /^[+-]\d+$/.test(s.textContent.trim())
        );
        return el ? el.textContent.trim() : null;
      });
      assert(oddsText === '+280', `expected +280, got ${oddsText}`);
    });

    await check('Odds text extracted from button span (-350 format)', async () => {
      const oddsText = await page.evaluate(() => {
        const btn = document.getElementById('btn-canada');
        const el = [...btn.querySelectorAll('span, div')].find(s =>
          s.childElementCount === 0 && /^[+-]\d+$/.test(s.textContent.trim())
        );
        return el ? el.textContent.trim() : null;
      });
      assert(oddsText === '-350', `expected -350, got ${oddsText}`);
    });

    await page.close();
  }

  // ── Section 2: Bet slip opens and wager input found ─────────────────────
  console.log('\n── Step 2: Bet slip + wager input ──');
  {
    const page = await freshPage(browser);

    await check('Bet slip hidden before any click', async () => {
      const display = await page.$eval('#betslip', el => el.style.display);
      assert(display === 'none', `expected none, got ${display}`);
    });

    await check('Clicking Canada opens bet slip', async () => {
      await page.click('#btn-canada');
      await new Promise(r => setTimeout(r, 100));
      const display = await page.$eval('#betslip', el => el.style.display);
      assert(display === 'block', `expected block, got ${display}`);
    });

    await check('Wager input found by aria-label="Wager"', async () => {
      const found = await page.evaluate(() => {
        const inp = [...document.querySelectorAll('input')].find(el =>
          /wager|amount|stake|bet amount/i.test(el.getAttribute('aria-label') || el.placeholder || '')
        );
        return inp ? { found: true, ariaLabel: inp.getAttribute('aria-label') } : { found: false };
      });
      assert(found.found, 'wager input not found');
      assert(found.ariaLabel === 'Wager', `aria-label wrong: ${found.ariaLabel}`);
    });

    await check('Wager input also found by class-based betslip selector', async () => {
      const found = await page.evaluate(() => {
        const inp = [...document.querySelectorAll('input')].find(el =>
          el.type === 'number' && el.closest('[class*="betslip"], [class*="bet-slip"], [class*="BetSlip"], [class*="sportsbook-betslip"]')
        );
        return inp ? { found: true } : { found: false };
      });
      assert(found.found, 'class-based betslip selector failed to find input');
    });

    await check('Selected side shown in bet slip after click', async () => {
      const side = await page.$eval('#selected-side', el => el.textContent.trim());
      assert(side === 'Canada', `expected Canada in slip, got "${side}"`);
    });

    await page.close();
  }

  // ── Section 3: React setter ─────────────────────────────────────────────
  console.log('\n── Step 3: React value setter ──');
  {
    const page = await freshPage(browser);
    await page.click('#btn-canada');
    await new Promise(r => setTimeout(r, 100));

    await check('React setter updates input.value to 0.01', async () => {
      const val = await page.evaluate(() => {
        const inp = document.getElementById('wager-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '0.01');
        return inp.value;
      });
      assert(val === '0.01', `expected "0.01", got "${val}"`);
    });

    await check('React setter fires input event (bubbles)', async () => {
      const events = await page.evaluate(() => {
        const inp = document.getElementById('wager-input');
        const fired = [];
        inp.addEventListener('input', () => fired.push('input'));
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '5.00');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return fired;
      });
      assert(events.includes('input'), `input event not fired: ${JSON.stringify(events)}`);
    });

    await check('React setter fires change event (bubbles)', async () => {
      const events = await page.evaluate(() => {
        const inp = document.getElementById('wager-input');
        const fired = [];
        inp.addEventListener('change', () => fired.push('change'));
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '10.00');
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return fired;
      });
      assert(events.includes('change'), `change event not fired: ${JSON.stringify(events)}`);
    });

    await check('setReactInput via page __mockState captures input+change events', async () => {
      const state = await page.evaluate(() => {
        const inp = document.getElementById('wager-input');
        window.__mockState.inputEvents = [];
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '25.00');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return window.__mockState.inputEvents;
      });
      assert(state.includes('input'), `input event not captured in mockState: ${JSON.stringify(state)}`);
      assert(state.includes('change'), `change event not captured in mockState: ${JSON.stringify(state)}`);
    });

    await check('Place Bet button found when enabled', async () => {
      const found = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => /place\s*bet|bet\s*now|submit/i.test(b.textContent.trim()) && !b.disabled);
        return btn ? { found: true, text: btn.textContent.trim() } : { found: false };
      });
      assert(found.found, 'Place Bet button not found');
      assert(found.text === 'Place Bet', `button text wrong: "${found.text}"`);
    });

    await check('Disabled Place Bet returns btn_disabled (not find_placebtn)', async () => {
      const result = await page.evaluate(() => {
        const btn = document.getElementById('place-bet-btn');
        btn.disabled = true;
        // Run the same detection logic as the injected script
        const placeBtn = [...document.querySelectorAll('button')]
          .find(b => /place\s*bet|bet\s*now|submit/i.test(b.textContent.trim()) && !b.disabled);
        if (!placeBtn) {
          const disabled = [...document.querySelectorAll('button')]
            .find(b => /place\s*bet|bet\s*now/i.test(b.textContent.trim()));
          return disabled ? 'btn_disabled' : 'find_placebtn';
        }
        return 'found';
      });
      assert(result === 'btn_disabled', `expected btn_disabled, got ${result}`);
    });

    await page.close();
  }

  // ── Section 4: Confirmation / error string detection ─────────────────────
  console.log('\n── Step 4: Confirmation + error detection ──');
  {
    await check('confirmedRegex matches "Bet Placed!" in body text', async () => {
      const page = await freshPage(browser);
      await page.evaluate(() => { document.getElementById('confirm-area').textContent = 'Bet Placed! Your wager is confirmed.'; });
      const matched = await page.evaluate(() => /bet\s+placed|congrats|success|confirmed/i.test(document.body.innerText));
      assert(matched, 'confirmedRegex did not match "Bet Placed!"');
      await page.close();
    });

    await check('oddsChangedRegex matches "Odds have changed" in body text', async () => {
      const page = await freshPage(browser);
      await page.evaluate(() => { document.getElementById('confirm-area').textContent = 'Odds have changed since you added this to your slip.'; });
      const matched = await page.evaluate(() => /odds\s+(have\s+)?changed|accept\s+new\s+odds/i.test(document.body.innerText));
      assert(matched, 'oddsChangedRegex did not match');
      await page.close();
    });

    await check('suspendedRegex matches "Market Suspended" in body text', async () => {
      const page = await freshPage(browser);
      await page.evaluate(() => { document.getElementById('confirm-area').textContent = 'Market Suspended'; });
      const matched = await page.evaluate(() => /market\s+suspended|betting\s+suspended/i.test(document.body.innerText));
      assert(matched, 'suspendedRegex did not match "Market Suspended"');
      await page.close();
    });

    await check('Clean page body has no confirmation/error strings on load', async () => {
      const page = await freshPage(browser);
      const state = await page.evaluate(() => {
        const body = document.body.innerText;
        return {
          confirmed:    /bet\s+placed|congrats|success|confirmed/i.test(body),
          oddsChanged:  /odds\s+(have\s+)?changed|accept\s+new\s+odds/i.test(body),
          suspended:    /market\s+suspended|betting\s+suspended/i.test(body)
        };
      });
      assert(!state.confirmed, 'clean page should not match confirmed');
      assert(!state.oddsChanged, 'clean page should not match oddsChanged');
      assert(!state.suspended, 'clean page should not match suspended');
      await page.close();
    });
  }

  // ── Section 5: Full end-to-end happy path ($0.01 per bet) ────────────────
  console.log('\n── Full end-to-end: $0.01 bets ──');

  await check('Canada $0.01 — full happy path', async () => {
    const page = await freshPage(browser);
    const result = await runBet(page, 'Canada', 0.01);
    assert(result.ok, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert(result.side === 'Canada', `side wrong: ${result.side}`);
    assert(result.oddsText === '-350', `oddsText wrong: ${result.oddsText}`);
    assert(result.amount === 0.01, `amount wrong: ${result.amount}`);
    assert(result.confirmed, `confirmed should be true, got: ${result.confirmed}`);
    assert(result.step === 'done', `step should be done, got: ${result.step}`);
    // Verify mock state captured the click
    const state = await page.evaluate(() => window.__mockState);
    assert(state.clicked === 'Canada', `mock clicked wrong side: ${state.clicked}`);
    assert(state.amount === 0.01, `mock amount wrong: ${state.amount}`);
    assert(state.betPlaced, 'mock betPlaced flag not set');
    await page.close();
  });

  await check('Draw $0.01 — full happy path (soccer draw outcome)', async () => {
    const page = await freshPage(browser);
    const result = await runBet(page, 'Draw', 0.01);
    assert(result.ok, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert(result.side === 'Draw', `side wrong: ${result.side}`);
    assert(result.oddsText === '+280', `oddsText wrong: ${result.oddsText}`);
    assert(result.confirmed, 'confirmed should be true');
    const state = await page.evaluate(() => window.__mockState);
    assert(state.clicked === 'Draw', `mock side wrong: ${state.clicked}`);
    await page.close();
  });

  await check('Qatar $0.01 — full happy path (underdog)', async () => {
    const page = await freshPage(browser);
    const result = await runBet(page, 'Qatar', 0.01);
    assert(result.ok, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert(result.oddsText === '+800', `oddsText wrong: ${result.oddsText}`);
    assert(result.amount === 0.01, `amount wrong: ${result.amount}`);
    assert(result.confirmed, 'confirmed should be true');
    await page.close();
  });

  await check('Case-insensitive side match — "canada" finds "Canada" button', async () => {
    const page = await freshPage(browser);
    const result = await runBet(page, 'canada', 0.01);
    assert(result.ok, `lowercase should work, got: ${JSON.stringify(result)}`);
    assert(result.step === 'done', `step wrong: ${result.step}`);
    await page.close();
  });

  await check('CANADA (uppercase) — case-insensitive match works', async () => {
    const page = await freshPage(browser);
    const result = await runBet(page, 'CANADA', 5.00);
    assert(result.ok, `uppercase should work, got: ${JSON.stringify(result)}`);
    assert(result.amount === 5.00, `amount wrong: ${result.amount}`);
    await page.close();
  });

  // ── Section 6: Error path end-to-end ────────────────────────────────────
  console.log('\n── Error paths ──');

  await check('Unknown side → ok:false, step:find_button', async () => {
    const page = await freshPage(browser);
    const result = await runBet(page, 'Uzbekistan', 0.01);
    assert(!result.ok, `expected ok:false, got: ${JSON.stringify(result)}`);
    assert(result.step === 'find_button', `step wrong: ${result.step}`);
    assert(result.error.includes('Uzbekistan'), `error should mention the side: ${result.error}`);
    await page.close();
  });

  await check('Disabled Place Bet → ok:false, step:btn_disabled', async () => {
    const page = await freshPage(browser);
    // Disable the Place Bet button before the test runs
    await page.evaluate(() => { document.getElementById('place-bet-btn').disabled = true; });
    const result = await runBet(page, 'Canada', 0.01);
    assert(!result.ok, `expected ok:false, got: ${JSON.stringify(result)}`);
    assert(result.step === 'btn_disabled', `step wrong: ${result.step}`);
    await page.close();
  });

  await check('Odds changed after Place Bet → ok:false, step:odds_changed', async () => {
    const page = await freshPage(browser);
    // Override Place Bet click to show "Odds have changed" instead of confirmation
    await page.evaluate(() => {
      document.getElementById('place-bet-btn').addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        document.getElementById('confirm-area').textContent = 'Odds have changed — please accept new odds to continue.';
      }, true); // capture phase — fires before the normal handler
    });
    const result = await runBet(page, 'Canada', 0.01);
    assert(!result.ok, `expected ok:false, got: ${JSON.stringify(result)}`);
    assert(result.step === 'odds_changed', `step wrong: ${result.step}`);
    await page.close();
  });

  await check('Market suspended after Place Bet → ok:false, step:suspended', async () => {
    const page = await freshPage(browser);
    await page.evaluate(() => {
      document.getElementById('place-bet-btn').addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        document.getElementById('confirm-area').textContent = 'Market Suspended — betting temporarily unavailable.';
      }, true);
    });
    const result = await runBet(page, 'Draw', 0.01);
    assert(!result.ok, `expected ok:false, got: ${JSON.stringify(result)}`);
    assert(result.step === 'suspended', `step wrong: ${result.step}`);
    await page.close();
  });

  await check('No bet slip opens (slip stays hidden) → ok:false, step:find_input', async () => {
    const page = await freshPage(browser);
    // Disconnect click handlers AND remove the wager input from DOM.
    // On real DK, the input only exists after the slip dynamically renders.
    // Our mock has it pre-rendered; removing it simulates DK's dynamic behavior.
    await page.evaluate(() => {
      ['btn-canada','btn-draw','btn-qatar'].forEach(id => {
        const btn = document.getElementById(id);
        const clone = btn.cloneNode(true);
        btn.parentNode.replaceChild(clone, btn);
      });
      // Remove the wager input so the 8-retry loop can't find it
      const inp = document.getElementById('wager-input');
      if (inp) inp.remove();
    });
    const result = await runBet(page, 'Canada', 0.01);
    assert(!result.ok, `expected ok:false, got: ${JSON.stringify(result)}`);
    assert(result.step === 'find_input', `step wrong: ${result.step}`);
    await page.close();
  });

  // ── Section 7: Amount integrity ─────────────────────────────────────────
  console.log('\n── Amount integrity ──');

  await check('$0.01 bet — amount reaches Place Bet click exactly', async () => {
    const page = await freshPage(browser);
    await runBet(page, 'Canada', 0.01);
    const state = await page.evaluate(() => window.__mockState);
    assert(state.amount === 0.01, `amount was ${state.amount}, expected 0.01`);
    await page.close();
  });

  await check('$25.00 bet — amount reaches Place Bet click exactly', async () => {
    const page = await freshPage(browser);
    await runBet(page, 'Canada', 25.00);
    const state = await page.evaluate(() => window.__mockState);
    assert(state.amount === 25, `amount was ${state.amount}, expected 25`);
    await page.close();
  });

  await check('$10000 bet — large amount passes through correctly', async () => {
    const page = await freshPage(browser);
    await runBet(page, 'Qatar', 10000);
    const state = await page.evaluate(() => window.__mockState);
    assert(state.amount === 10000, `amount was ${state.amount}, expected 10000`);
    await page.close();
  });

  await check('Amount set via React setter persists to Place Bet click', async () => {
    const page = await freshPage(browser);
    const result = await runBet(page, 'Draw', 7.77);
    const state = await page.evaluate(() => window.__mockState);
    assert(result.ok, `bet should succeed, got: ${JSON.stringify(result)}`);
    // Check the mock captured the exact amount
    assert(Math.abs(state.amount - 7.77) < 0.001, `amount was ${state.amount}, expected 7.77`);
    await page.close();
  });

  // ── Section 8: Concurrent / sequential bets ──────────────────────────────
  console.log('\n── Sequential bets (fresh page per bet) ──');

  await check('Three sequential bets on same session — each gets own confirmation', async () => {
    // Simulate placing 3 bets in sequence (each time the slip resets)
    // This mirrors the chat UI flow: bet canada → bet draw → bet qatar
    const results = [];
    for (const [side, amount, odds] of [['Canada', 0.01, '-350'], ['Draw', 0.01, '+280'], ['Qatar', 0.01, '+800']]) {
      const page = await freshPage(browser);
      const r = await runBet(page, side, amount);
      results.push({ side, ok: r.ok, oddsText: r.oddsText, confirmed: r.confirmed });
      await page.close();
    }
    assert(results.every(r => r.ok), `not all bets succeeded: ${JSON.stringify(results)}`);
    assert(results.every(r => r.confirmed), `not all confirmed: ${JSON.stringify(results)}`);
    assert(results[0].oddsText === '-350', `Canada odds: ${results[0].oddsText}`);
    assert(results[1].oddsText === '+280', `Draw odds: ${results[1].oddsText}`);
    assert(results[2].oddsText === '+800', `Qatar odds: ${results[2].oddsText}`);
  });

  // ── DONE ──────────────────────────────────────────────────────────────────
  await browser.close();

  const total = passed + failed;
  console.log('\n═══════════════════════════════════');
  console.log(`  ${passed}/${total} passed  ${failed} failed`);
  console.log('═══════════════════════════════════\n');

  if (failed > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
