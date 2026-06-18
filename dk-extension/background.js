const DEFAULT_URL = 'https://ufc-dashboard-production-e03d.up.railway.app';

let betBotUrl = DEFAULT_URL;
let dkUserId = null;
let manualUserId = null;
let handlingLogin = false; // prevents both tabs racing to the login page

function genDeviceId() {
  return 'dev-' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Load storage first — dkUserId must NEVER be null when we post
chrome.storage.local.get(['betBotUrl', 'dkUserId', 'manualUserId', 'deviceId'], r => {
  betBotUrl = r.betBotUrl || DEFAULT_URL;
  manualUserId = r.manualUserId || null;
  let deviceId = r.deviceId;
  if (!deviceId) {
    deviceId = genDeviceId();
    chrome.storage.local.set({ deviceId });
    addLog(`Device ID generated: ${deviceId}`);
  }
  // Priority: manual > DK auto-detected > stable device UUID (never null)
  dkUserId = manualUserId || r.dkUserId || deviceId;
  addLog(`userId ready: ${dkUserId}`);
  // Send heartbeat only AFTER userId is known — fixes startup race condition
  postToServer('/api/dk-heartbeat', { ts: Date.now() });
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.betBotUrl) betBotUrl = changes.betBotUrl.newValue;
  if (changes.manualUserId) { manualUserId = changes.manualUserId.newValue; dkUserId = manualUserId; }
  else if (changes.dkUserId && !manualUserId) dkUserId = changes.dkUserId.newValue;
});

function postToServer(path, body) {
  if (!betBotUrl) return;
  fetch(`${betBotUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, userId: dkUserId })
  }).catch(() => {});
}

function addLog(msg) {
  chrome.storage.local.get(['debugLog'], r => {
    const log = r.debugLog || [];
    log.unshift({ ts: Date.now(), msg });
    chrome.storage.local.set({ debugLog: log.slice(0, 30) });
  });
}

// Use Chrome Alarms for reliable periodic tasks (MV3 service workers get killed otherwise)
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') {
    postToServer('/api/dk-heartbeat', { ts: Date.now() });
  }

  if (alarm.name === 'keepAlive') {
    const tabs = await chrome.tabs.query({ url: 'https://*.draftkings.com/*' });
    if (!tabs.length) return;
    const myBetsTab = tabs.find(t => t.url?.includes('/mybets'));
    if (!myBetsTab?.id) return;

    const r = await chrome.storage.local.get(['wsConnected', 'lastSync']);
    const wsDown = r.wsConnected === false;
    const syncAge = r.lastSync ? Date.now() - r.lastSync : Infinity;
    const stale = syncAge > 300000; // no data for 5+ min while ws should be live

    if (wsDown) {
      // WS explicitly closed — reload the tab to reconnect
      addLog(`⚠ WS closed — reloading mybets tab`);
      chrome.tabs.reload(myBetsTab.id);
      chrome.storage.local.set({ wsConnected: null });
    } else if (stale && r.wsConnected === true) {
      // WS shows open but no bets data in 5+ min — something stalled
      addLog(`⚠ WS stale (${Math.round(syncAge / 60000)}m) — reloading mybets tab`);
      chrome.tabs.reload(myBetsTab.id);
      chrome.storage.local.set({ wsConnected: null });
    } else {
      // All good — just ping to keep DK session alive
      try {
        await chrome.scripting.executeScript({
          target: { tabId: myBetsTab.id },
          func: () => fetch('https://sportsbook-nash.draftkings.com/sites/US-IL-SB/api/v5/users/me?format=json', { credentials: 'include' }).catch(() => {})
        });
      } catch (_) {}
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';

  if (url.includes('draftkings.com') && (url.includes('/login') || url.includes('/sportsbook-auth') || url.includes('sign-in'))) {
    postToServer('/api/dk-logout', { ts: Date.now() });
    chrome.storage.local.set({ dkLoggedOut: true });
    return;
  }

  // Successful login: tab just landed on sportsbook — set flag, content.js will signal when ready
  if (url.startsWith('https://sportsbook.draftkings.com/') && !url.includes('/login')) {
    const r = await chrome.storage.local.get(['dkLoggedOut']);
    if (r.dkLoggedOut) {
      chrome.storage.local.set({ dkLoggedOut: false, dkWaitingForTabs: true });
      addLog('Login success — waiting for location check');
    }
  }

  if (url.includes('draftkings.com/mybets')) {
    chrome.storage.local.set({ dkLoggedOut: false });
  }
});


function tryExtractUserId(url, data) {
  if (url.includes('/social/user/') && data?.username) return data.username;
  if (url.includes('/users/me') && (data?.username || data?.displayName || data?.userId)) {
    return data.username || data.displayName || String(data.userId);
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'DK_WS_STATUS') {
    if (msg.connected) {
      chrome.storage.local.set({ wsConnected: true, wsLastOpen: msg.ts });
      addLog(`WS: connected`);
    } else {
      chrome.storage.local.set({ wsConnected: false, wsLastClose: msg.ts });
      addLog(`WS: disconnected (code ${msg.code || '?'})`);
    }
    return;
  }

  if (msg.type === 'DK_LOGOUT') {
    postToServer('/api/dk-logout', { ts: Date.now() });
    chrome.storage.local.set({ dkLoggedOut: true });
    addLog('LOGOUT detected');
    return;
  }

  if (msg.type === 'DK_SPORTSBOOK_READY') {
    // Location check cleared on the tab that just logged in.
    // Navigate the OTHER (untouched) DK tab to mybets.
    handlingLogin = false;
    const mainTabId = sender?.tab?.id;
    (async () => {
      const dkTabs = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
      dkTabs.sort((a, b) => a.index - b.index);
      const secondTab = dkTabs.find(t => t.id !== mainTabId && !t.url?.includes('/mybets'));
      if (secondTab) {
        chrome.tabs.update(secondTab.id, { url: 'https://sportsbook.draftkings.com/mybets' });
        addLog('Location check cleared — sending second tab to mybets');
      } else {
        chrome.tabs.create({ url: 'https://sportsbook.draftkings.com/mybets', openerTabId: mainTabId });
        addLog('Location check cleared — no second tab, created mybets tab');
      }
    })();
    return;
  }

  if (msg.type === 'DK_NEEDS_LOGIN') {
    // Only the leftmost DK tab handles login — ignore if already handling
    if (handlingLogin) return;
    handlingLogin = true;
    chrome.storage.local.set({ dkLoggedOut: true });
    addLog('Logout detected — navigating leftmost DK tab to login');
    (async () => {
      const dkTabs = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
      dkTabs.sort((a, b) => a.index - b.index);
      if (dkTabs.length > 0) {
        chrome.tabs.update(dkTabs[0].id, {
          url: 'https://myaccount.draftkings.com/auth/login?product=sportsbook&returnPath=https%3A%2F%2Fsportsbook.draftkings.com%2F'
        });
      }
    })();
    return;
  }

  if (msg.type === 'PLACE_BET') {
    const { side, amount, tabId: requestedTabId } = msg;
    const popupPort = sender;
    (async () => {
      // Find the sportsbook tab to place on (prefer active, fall back to any non-mybets DK tab)
      const allDk = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
      const target = allDk.find(t => !t.url?.includes('/mybets') && t.active)
                  || allDk.find(t => !t.url?.includes('/mybets'))
                  || allDk[0];
      if (!target) {
        chrome.runtime.sendMessage({ type: 'BET_RESULT', ok: false, error: 'No DK sportsbook tab open — go to sportsbook.draftkings.com first' });
        return;
      }
      addLog(`PLACE_BET: ${side} $${amount} on tab ${target.id}`);
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: target.id },
          func: async (side, amount) => {
            function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

            function setReactInput(el, value) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(el, value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // ── Step 1: find the outcome button ─────────────────────────────
            const sideL = side.toLowerCase().trim();
            // Grab bet-slip count before so we can detect the click registered
            const slipBefore = document.querySelectorAll('[class*="betslip"], [class*="bet-slip"], [class*="BetSlip"]').length;

            // Find clickable element whose immediate text matches the side
            // DK buttons: <button ...><span class="...label">Canada</span><span class="...odds">-1600</span></button>
            const allClickable = [
              ...document.querySelectorAll('button, [role="button"]'),
            ];
            let outcomeBtn = null;

            for (const el of allClickable) {
              // Use direct child text so we don't match "Canada vs Qatar" game title buttons
              const spans = el.querySelectorAll('span, div, p');
              const labelSpan = [...spans].find(s =>
                s.childElementCount === 0 && s.textContent.trim().toLowerCase() === sideL
              );
              if (labelSpan) { outcomeBtn = el; break; }
            }

            // Fallback: looser match — button whose text starts with or equals side
            if (!outcomeBtn) {
              outcomeBtn = allClickable.find(el => {
                const t = el.textContent.trim().toLowerCase();
                return (t === sideL || t.startsWith(sideL + '\n') || t.startsWith(sideL + ' '));
              });
            }

            if (!outcomeBtn) {
              return { ok: false, step: 'find_button', error: `No button found for "${side}" — make sure the game is visible on screen` };
            }

            // Read the odds off the button for verification
            const oddsEl = [...outcomeBtn.querySelectorAll('span, div')].find(s =>
              s.childElementCount === 0 && /^[+-]\d+$/.test(s.textContent.trim())
            );
            const oddsText = oddsEl ? oddsEl.textContent.trim() : '?';

            // Check if it's already selected (active class)
            const alreadySelected = outcomeBtn.classList.toString().toLowerCase().includes('active')
                                 || outcomeBtn.getAttribute('aria-pressed') === 'true';

            outcomeBtn.click();
            await sleep(1200);

            // ── Step 2: find bet slip amount input ───────────────────────────
            // DK bet slip uses input with aria-label="Wager" or placeholder "Enter Wager"
            let amtInput = null;
            for (let attempt = 0; attempt < 8; attempt++) {
              amtInput = [...document.querySelectorAll('input')]
                .find(el =>
                  /wager|amount|stake|bet amount/i.test(el.getAttribute('aria-label') || el.placeholder || '') ||
                  el.type === 'number' && el.closest('[class*="betslip"], [class*="bet-slip"], [class*="BetSlip"], [class*="sportsbook-betslip"]')
                );
              if (amtInput) break;
              await sleep(400);
            }

            if (!amtInput) {
              return { ok: false, step: 'find_input', oddsText, error: 'Bet slip did not open or amount input not found — try opening the bet slip manually first' };
            }

            // Clear and set amount
            amtInput.focus();
            setReactInput(amtInput, String(amount));
            await sleep(600);

            // ── Step 3: find and click Place Bet button ───────────────────────
            let placeBtn = [...document.querySelectorAll('button')]
              .find(btn => /place\s*bet|bet\s*now|submit/i.test(btn.textContent.trim()) && !btn.disabled);

            if (!placeBtn) {
              // Try disabled version to diagnose
              const disabledBtn = [...document.querySelectorAll('button')]
                .find(btn => /place\s*bet|bet\s*now/i.test(btn.textContent.trim()));
              if (disabledBtn) {
                return { ok: false, step: 'btn_disabled', oddsText, amount, error: `Place Bet button is disabled — check balance or if odds changed` };
              }
              return { ok: false, step: 'find_placebtn', oddsText, amount, error: 'Place Bet button not found' };
            }

            placeBtn.click();
            await sleep(1500);

            // ── Step 4: detect confirmation ───────────────────────────────────
            const bodyText = document.body.innerText;
            const confirmed = /bet\s+placed|congrats|success|confirmed/i.test(bodyText);
            const oddsChanged = /odds\s+(have\s+)?changed|accept\s+new\s+odds/i.test(bodyText);
            const suspended = /market\s+suspended|betting\s+suspended/i.test(bodyText);

            if (oddsChanged) {
              return { ok: false, step: 'odds_changed', oddsText, amount, error: 'DK says odds changed — click "Accept New Odds" in the slip and retry' };
            }
            if (suspended) {
              return { ok: false, step: 'suspended', oddsText, error: 'Market suspended (goal? halftime?) — retry in 30s' };
            }

            return { ok: true, side, oddsText, amount, confirmed, step: 'done' };
          },
          args: [side, amount]
        });
        const result = results?.[0]?.result || { ok: false, error: 'No result from tab' };
        addLog(`BET_RESULT: ${JSON.stringify(result)}`);
        chrome.runtime.sendMessage({ type: 'BET_RESULT', ...result });
      } catch(e) {
        addLog(`BET_RESULT error: ${e.message}`);
        chrome.runtime.sendMessage({ type: 'BET_RESULT', ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type !== 'DK_API') return;

  const url = msg.url;
  const data = msg.data;

  const extractedId = tryExtractUserId(url, data);
  if (extractedId && extractedId !== dkUserId) {
    dkUserId = extractedId;
    chrome.storage.local.set({ dkUserId: extractedId });
    addLog(`User identified: ${extractedId}`);
  }

  chrome.storage.local.get(['captures'], r => {
    const captures = r.captures || [];
    const isBets = !!(data?.result?.initial?.bets || data?.result?.update?.bets);
    const betCount = (data?.result?.initial?.bets || data?.result?.update?.bets || []).length;
    const preview = isBets ? `[WS BETS] ${betCount} bets found` : JSON.stringify(data).slice(0, 120);
    captures.unshift({ url, ts: Date.now(), preview, isBets });
    chrome.storage.local.set({ captures: captures.slice(0, 50) });
    if (isBets) addLog(`WS: captured ${betCount} bets`);
  });

  if (!betBotUrl) return;
  addLog(`→ syncing: ${url.replace(/https?:\/\/[^/]+/, '').slice(0, 60)}`);
  fetch(`${betBotUrl}/api/dk-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, data, ts: Date.now(), userId: dkUserId })
  }).then(r => r.json()).then(res => {
    if (res.bets?.length) {
      chrome.storage.local.set({ lastSync: Date.now(), lastBetCount: res.bets.length });
      addLog(`✓ server parsed ${res.bets.length} bets`);
    } else {
      addLog(`server: no bets parsed`);
    }
  }).catch(e => addLog(`✗ server error: ${e.message}`));
});
