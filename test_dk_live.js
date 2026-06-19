#!/usr/bin/env node
'use strict';
/**
 * test_dk_live.js — live DK bet placement, $0.01
 *
 * Extracts & decrypts the user's DK session cookies from Chrome's on-disk
 * Cookies DB (no login form, no re-typing password, no account lock risk).
 * Injects them into a fresh Puppeteer browser and places a real $0.01 bet.
 *
 * Crypto path (macOS Chrome v10 cookies):
 *   key = PBKDF2(password=keychain_secret, salt='saltysalt', iter=1003, len=16, sha1)
 *   iv  = 0x20 * 16  (16 spaces)
 *   pt  = AES-128-CBC-decrypt(ciphertext = encrypted_value[3:])  // strip 'v10' prefix
 */

const puppeteer = require('puppeteer');
const crypto    = require('crypto');
const { execSync } = require('child_process');

const AMOUNT = 0.01;

// ── 1. Derive AES key from macOS Keychain ────────────────────────────────
function getDecryptionKey() {
  const keystorePass = execSync(
    'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"'
  ).toString().trim();
  // PBKDF2-SHA1: Chrome uses the raw keychain string as the password
  return crypto.pbkdf2Sync(keystorePass, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookieValue(encHex, key) {
  if (!encHex || encHex.length < 6) return '';
  const buf = Buffer.from(encHex, 'hex');
  const prefix = buf.slice(0, 3).toString('utf8');
  if (prefix !== 'v10') return buf.toString('utf8'); // plaintext cookie
  const ciphertext = buf.slice(3);
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Convert Chrome's Windows FILETIME (microseconds since 1601-01-01) to Unix seconds
function chromeTimeToUnix(chromeTime) {
  if (!chromeTime || chromeTime === '0') return 0;
  return Math.floor((parseInt(chromeTime, 10) / 1_000_000) - 11_644_473_600);
}

// ── 2. Read & decrypt DK cookies from Chrome's cookie DB ─────────────────
function getDkCookies() {
  // Copy the DB first (Chrome may hold a soft lock; copy avoids SQLITE_BUSY)
  execSync('cp "/Users/louislapat/Library/Application Support/Google/Chrome/Default/Cookies" /tmp/dk_cookies_copy.db');
  const key = getDecryptionKey();

  const rows = execSync(
    `sqlite3 /tmp/dk_cookies_copy.db "SELECT name, host_key, path, is_secure, is_httponly, expires_utc, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%draftkings%';"`
  ).toString().trim().split('\n');

  return rows
    .map(row => {
      const parts = row.split('|');
      if (parts.length < 7) return null;
      const [name, host_key, path, is_secure, is_httponly, expires_utc, encHex] = parts;
      const value = decryptCookieValue(encHex, key);
      if (!value) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      const exp = chromeTimeToUnix(expires_utc);
      // Skip session cookies with no expiry (expires_utc=0) and already-expired cookies
      // by simply omitting the expires field — Puppeteer treats those as session cookies.
      const cookie = {
        name: name.trim(),
        value: value.replace(/[\r\n]/g, ''), // strip control chars that Chrome CDP rejects
        domain: host_key.trim(),             // keep leading dot for domain cookies
        path: path.trim() || '/',
        secure: is_secure === '1',
        httpOnly: is_httponly === '1',
      };
      // Only set expires if it's a future timestamp (not session, not expired)
      if (exp > nowSec + 60) cookie.expires = exp;
      return cookie;
    })
    .filter(Boolean);
}

// ── 3. Injected bet placer (exact background.js logic + DK table fallback) ─
const INJECTED_BET_PLACER_DK = async (side, amount) => {
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

  // Strategy A: button contains span whose text === sideL
  for (const el of allClickable) {
    const spans = [...el.querySelectorAll('span, div, p')];
    if (spans.find(s => s.childElementCount === 0 && s.textContent.trim().toLowerCase() === sideL)) {
      outcomeBtn = el; break;
    }
  }

  // Strategy B: DK live table — find name element in row, click the odds button
  if (!outcomeBtn) {
    const nameEls = [...document.querySelectorAll('*')].filter(el =>
      el.childElementCount === 0 &&
      el.textContent.trim().toLowerCase() === sideL &&
      el.closest('button, [role="button"]') === null
    );
    for (const nameEl of nameEls) {
      let ancestor = nameEl.parentElement;
      for (let i = 0; i < 10 && ancestor; i++) {
        const btn = [...ancestor.querySelectorAll('button, [role="button"]')]
          .find(b => /^[+−\-]\d+$/.test(b.textContent.trim()));
        if (btn) { outcomeBtn = btn; break; }
        ancestor = ancestor.parentElement;
      }
      if (outcomeBtn) break;
    }
  }

  // Strategy C: fuzzy
  if (!outcomeBtn) {
    outcomeBtn = allClickable.find(el => el.textContent.trim().toLowerCase().includes(sideL));
  }

  if (!outcomeBtn) return { ok: false, step: 'find_button', error: `No button for "${side}"` };

  const oddsEl = [...outcomeBtn.querySelectorAll('span, div'), outcomeBtn]
    .find(s => s.childElementCount === 0 && /^[+−\-]\d+$/.test(s.textContent.trim()));
  const oddsText = oddsEl ? oddsEl.textContent.trim() : outcomeBtn.textContent.trim().slice(0, 10);

  outcomeBtn.click();
  await sleep(1500);

  let amtInput = null;
  for (let i = 0; i < 12; i++) {
    amtInput = [...document.querySelectorAll('input')].find(el =>
      /wager|amount|stake|bet amount/i.test(el.getAttribute('aria-label') || el.placeholder || '') ||
      (el.type === 'number' && el.closest('[class*="betslip" i],[class*="bet-slip" i],[class*="BetSlip"]'))
    );
    if (amtInput) break;
    await sleep(400);
  }
  if (!amtInput) return { ok: false, step: 'find_input', oddsText, error: 'Bet slip did not open' };

  amtInput.focus();
  setReactInput(amtInput, '');
  await sleep(150);
  setReactInput(amtInput, String(amount));
  await sleep(800);

  let placeBtn = [...document.querySelectorAll('button')]
    .find(btn => /place\s*bet|bet\s*now|submit/i.test(btn.textContent.trim()) && !btn.disabled);
  if (!placeBtn) {
    const disabled = [...document.querySelectorAll('button')].find(btn => /place\s*bet|bet\s*now/i.test(btn.textContent.trim()));
    return disabled
      ? { ok: false, step: 'btn_disabled', oddsText, amount, error: 'Place Bet is disabled — check balance or minimum bet' }
      : { ok: false, step: 'find_placebtn', oddsText, amount, error: 'Place Bet button not found' };
  }

  placeBtn.click();
  await sleep(2500);

  const body = document.body.innerText;
  if (/odds\s+(have\s+)?changed|accept\s+new\s+odds/i.test(body))  return { ok: false, step: 'odds_changed', oddsText, amount };
  if (/market\s+suspended|betting\s+suspended/i.test(body))         return { ok: false, step: 'suspended', oddsText };
  const confirmed = /bet\s+placed|congrats|success|confirmed/i.test(body);
  return { ok: true, side, oddsText, amount, confirmed, step: 'done' };
};

// ── 4. Discover bettable outcome on current page ──────────────────────────
const DISCOVER_OUTCOME = () => {
  const oddsBtns = [...document.querySelectorAll('button, [role="button"]')]
    .filter(b => /^[+−\-]\d+$/.test(b.textContent.trim()));

  for (const btn of oddsBtns) {
    let ancestor = btn.parentElement;
    for (let i = 0; i < 8 && ancestor; i++) {
      const nameEl = [...ancestor.querySelectorAll('*')].find(el =>
        el.childElementCount === 0 &&
        el.textContent.trim().length > 2 &&
        !/^[+−\-]\d+(\.\d+)?$/.test(el.textContent.trim()) &&
        !/^\d+$/.test(el.textContent.trim()) &&
        el.closest('button, [role="button"]') === null
      );
      if (nameEl) return { side: nameEl.textContent.trim(), odds: btn.textContent.trim() };
      ancestor = ancestor.parentElement;
    }
  }
  return null;
};

// ── MAIN ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n════════════════════════════════════');
  console.log('  LIVE DK BET PLACEMENT — $0.01');
  console.log('  (using your Chrome session cookies)');
  console.log('════════════════════════════════════\n');

  // Step 1: extract + decrypt cookies
  console.log('1. Extracting DK session cookies from Chrome...');
  let cookies;
  try {
    cookies = getDkCookies();
    const authCookies = cookies.filter(c => ['jwe','jws_sb','jws_gs','identity_session','STE'].includes(c.name));
    console.log(`   Total DK cookies: ${cookies.length}`);
    console.log(`   Auth cookies found: ${authCookies.map(c => c.name).join(', ')}`);
  } catch (e) {
    console.error('   Cookie extraction failed:', e.message);
    process.exit(1);
  }

  // Step 2: launch browser + inject cookies
  console.log('2. Launching browser + injecting session...');
  const browser = await puppeteer.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1400,900',
    ],
    defaultViewport: { width: 1400, height: 900 }
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  // Must visit the domain before setting cookies
  await page.goto('https://sportsbook.draftkings.com', { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Inject cookies one-at-a-time; skip any that the CDP rejects
  let injected = 0, skipped = 0;
  for (const c of cookies) {
    try {
      await page.setCookie(c);
      injected++;
    } catch {
      skipped++;
    }
  }
  console.log(`   Injected ${injected} cookies (skipped ${skipped} invalid)`);

  // Step 3: navigate to live betting
  console.log('3. Navigating to live betting...');
  await page.goto('https://sportsbook.draftkings.com/live', { waitUntil: 'networkidle2', timeout: 25000 });
  await new Promise(r => setTimeout(r, 3000));

  await page.screenshot({ path: '/tmp/dk_session_loaded.png' });
  console.log('   Screenshot: /tmp/dk_session_loaded.png');
  console.log('   URL:', page.url());

  // Verify logged in
  const loggedIn = await page.evaluate(() =>
    !document.body.innerText.includes('Sign Up or Log In') &&
    !document.body.innerText.toLowerCase().includes('you must be logged in')
  );
  console.log('   Logged in:', loggedIn);

  if (!loggedIn) {
    // Maybe cookies expired — show what's on screen
    const preview = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('   Page preview:', preview);
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
    process.exit(1);
  }

  // Step 4: find outcome buttons
  console.log('\n4. Looking for live bettable outcomes...');
  const oddsMap = await page.evaluate(() => {
    return [...document.querySelectorAll('button, [role="button"]')]
      .filter(b => /^[+−\-]\d+$/.test(b.textContent.trim()))
      .slice(0, 10)
      .map(b => {
        let ancestor = b.parentElement;
        let name = null;
        for (let i = 0; i < 8 && ancestor; i++) {
          const el = [...ancestor.querySelectorAll('*')].find(e =>
            e.childElementCount === 0 &&
            e.textContent.trim().length > 2 &&
            !/^[+−\-]\d+(\.\d+)?$/.test(e.textContent.trim()) &&
            !/^\d+$/.test(e.textContent.trim()) &&
            e.closest('button, [role="button"]') === null
          );
          if (el) { name = el.textContent.trim(); break; }
          ancestor = ancestor.parentElement;
        }
        return { side: name, odds: b.textContent.trim() };
      });
  });

  console.log('   Available outcomes:');
  oddsMap.forEach(o => console.log(`     "${o.side}" → ${o.odds}`));

  if (oddsMap.length === 0 || !oddsMap[0].side) {
    console.log('\n   No live games right now. Trying MMA/UFC section...');
    await page.goto('https://sportsbook.draftkings.com/leagues/mma/ufc', {
      waitUntil: 'networkidle2', timeout: 20000
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 5: discover + place
  const outcome = await page.evaluate(DISCOVER_OUTCOME);
  if (!outcome || !outcome.side) {
    await page.screenshot({ path: '/tmp/dk_no_games.png' });
    console.log('\n   No bettable outcome found. Screenshot: /tmp/dk_no_games.png');
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
    process.exit(1);
  }

  console.log(`\n5. Placing $${AMOUNT} on "${outcome.side}" (${outcome.odds})...`);
  await page.screenshot({ path: '/tmp/dk_before_bet.png' });
  console.log('   Pre-bet: /tmp/dk_before_bet.png');

  // Step 6: run injected script with nav-error guard
  let result;
  try {
    result = await page.evaluate(INJECTED_BET_PLACER_DK, outcome.side, AMOUNT);
  } catch (navErr) {
    await new Promise(r => setTimeout(r, 2000));
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    const confirmed = /bet\s+placed|congrats|success|confirmed/i.test(body);
    result = { ok: confirmed, step: confirmed ? 'done (nav)' : 'nav_error', error: navErr.message, confirmed };
  }

  console.log('\n   BET RESULT:', JSON.stringify(result, null, 2));
  await page.screenshot({ path: '/tmp/dk_after_bet.png' });
  console.log('   Post-bet: /tmp/dk_after_bet.png');

  if (result.ok && result.confirmed) {
    console.log('\n✓ BET PLACED: $0.01 on', outcome.side, 'at', result.oddsText || outcome.odds);
  } else {
    console.log('\n✗ Step:', result.step, '|', result.error || '');
  }

  console.log('\n(Browser stays open 10s so you can see the result)');
  await new Promise(r => setTimeout(r, 10000));
  await browser.close();
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
