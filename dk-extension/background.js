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

// ── Command poll — runs in SW (no CORS restrictions) ────────────────────────
// content.js opens a 'keepalive' port which keeps this SW alive while DK tab is open.
// We start a 5s command poll for each connected port and stop it when the port closes.
// This avoids CORS issues: SW fetch is not subject to page CORS policy.
let cmdPollInterval = null;
let activePorts = 0;

async function pollForCommands() {
  try {
    const r = await fetch(`${betBotUrl}/api/pending-commands`);
    if (!r.ok) { addLog(`cmd poll ${r.status}`); return; }
    const body = await r.json();
    if (body.command) {
      addLog(`CMD POLL: received ${body.command.type} ${body.command.side || ''} $${body.command.amount || ''} [${body.command.id}]`);
      handleExecuteCommand(body.command);
    }
  } catch (e) {
    if (!pollForCommands._lastErrLog || Date.now() - pollForCommands._lastErrLog > 30000) {
      addLog(`cmd poll error: ${e.message}`);
      pollForCommands._lastErrLog = Date.now();
    }
  }

  // Also poll watch triggers and push them to content tabs
  try {
    const tr = await fetch(`${betBotUrl}/api/watch-triggers`);
    if (tr.ok) {
      const tbody = await tr.json();
      const triggers = tbody.triggers || [];
      // Broadcast to all DK sportsbook content tabs
      const tabs = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'SET_WATCH_TRIGGERS', triggers }).catch(() => {});
      }
    }
  } catch {}
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'keepalive') return;
  activePorts++;
  addLog(`keepalive port connected (${activePorts} active) — cmd poll started`);
  if (!cmdPollInterval) {
    cmdPollInterval = setInterval(pollForCommands, 5000);
  }
  port.onMessage.addListener(() => {}); // absorb pings
  port.onDisconnect.addListener(() => {
    activePorts = Math.max(0, activePorts - 1);
    addLog(`keepalive port disconnected (${activePorts} remaining)`);
    if (activePorts === 0 && cmdPollInterval) {
      clearInterval(cmdPollInterval);
      cmdPollInterval = null;
      addLog('cmd poll stopped — no DK tabs open');
    }
  });
});

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

// ── Pure strategy helpers (no chrome.* calls — testable as plain functions) ──

// American → decimal odds. Returns null if input is invalid.
function americanToDecimal(american) {
  if (typeof american !== 'number' || isNaN(american) || american === 0) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function strategyTransition(current, event) {
  const table = {
    IDLE:              { BET_INITIATED:       'FIRST_BET_PENDING' },
    FIRST_BET_PENDING: { BET_CONFIRMED:       'FIRST_BET_PLACED', BET_FAILED: 'IDLE' },
    FIRST_BET_PLACED:  { CROSSOVER_DETECTED:  'WATCHING_HEDGE',   STRATEGY_CANCELLED: 'IDLE', STRATEGY_EXPIRED: 'IDLE' },
    WATCHING_HEDGE:    { VERIFY_PASSED:       'HEDGE_FIRED',       VERIFY_FAILED: 'HEDGE_FAILED' },
    HEDGE_FIRED:       { BET_CONFIRMED:       'BOTH_PLACED',      BET_FAILED: 'HEDGE_FAILED' },
    BOTH_PLACED:       {},
    HEDGE_FAILED:      {},
  };
  return (table[current] || {})[event] || current;
}

// 7-check gate — pure function, all state passed as args
function tripleVerify(strategy, domState) {
  const checks = [
    { name: 'game_identity',    pass: !strategy.gameId || !domState.gameId || strategy.gameId === domState.gameId },
    { name: 'odds_slippage',    pass: !strategy.expectedHedgeOdds || Math.abs((domState.leg2Odds || 0) - strategy.expectedHedgeOdds) <= 8 },
    { name: 'market_active',    pass: !domState.suspended },
    { name: 'hedge_profitable', pass: domState.hedgeProfit === undefined || domState.hedgeProfit > 0 },
    { name: 'slip_empty',       pass: !domState.slipHasBets },
    { name: 'balance_sufficient', pass: domState.balance === undefined || domState.balance >= (strategy.hedgeAmount || 0) },
    { name: 'leg1_confirmed',   pass: strategy.leg1Confirmed === true },
  ];
  const failed = checks.filter(c => !c.pass);
  return { pass: failed.length === 0, checks, failed };
}

// Called from both: the SW command poll (background fetch, no CORS) and
// the EXECUTE_COMMAND message handler (legacy path, kept for fallback).
function handleExecuteCommand(command) {
  if (!command) return;
  addLog(`handleExecuteCommand: ${command.type} ${command.side || ''} $${command.amount || ''} [${command.id}]`);
  console.log('[BetBot BG] handleExecuteCommand:', JSON.stringify(command));

  if (command.type === 'cancel') {
    (async () => {
      await chrome.storage.local.set({ pendingStrategy: { state: 'IDLE', updatedAt: Date.now() } });
      const tabs = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
      tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'STOP_WATCHING' }).catch(() => {}));
      postToServer('/api/command-result', { commandId: command.id, result: { ok: true, message: 'Strategy cancelled' } });
      chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy: { state: 'IDLE' } }).catch(() => {});
    })();
    return;
  }

  if (command.type === 'place_bet' && command.side && command.amount) {
    (async () => {
      const strategy = {
        state: 'FIRST_BET_PENDING',
        leg1Side:          command.side,
        leg1Amount:        command.amount,
        leg2Side:          command.leg2Side || null,
        leg1OddsAmerican:  command.leg1OddsAmerican || null,
        leg1OddsDecimal:   americanToDecimal(command.leg1OddsAmerican),
        trigger:           command.trigger || { type: 'crossover', targetOdds: null },
        leg1Confirmed:     false,
        startedAt:         Date.now(),
        updatedAt:         Date.now(),
        commandId:         command.id,
      };
      await chrome.storage.local.set({ pendingStrategy: strategy });
      chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy }).catch(() => {});
      postToServer('/api/strategy-update', { commandId: command.id, state: 'FIRST_BET_PENDING', message: `Placing $${command.amount} on ${command.side}…` });
      executePlaceBet(command.side, command.amount, command.id, false);
    })();
  }
}

// ── PLACE_BET execution — called directly (SW cannot message itself) ────────
// MV3 service workers cannot receive chrome.runtime.sendMessage sent from
// themselves. Extracting the logic here lets pollForCommands and
// CROSSOVER_DETECTED call it directly without going through the message bus.
// isRetry=true on AI-assisted second attempt — prevents infinite recursion
async function executePlaceBet(side, amount, commandId, isAutoHedge, isRetry = false) {
  // ── Idempotency check — block duplicate bets within 30s ──────────────
  const betKey = `${dkUserId}|${side}|${amount}`;
  const idempotent = await chrome.storage.local.get(['lastBetKey', 'lastBetKeyTs']);
  const keyAge = idempotent.lastBetKeyTs ? Date.now() - idempotent.lastBetKeyTs : Infinity;
  if (idempotent.lastBetKey === betKey && keyAge < 30000) {
    addLog(`IDEMPOTENT: duplicate PLACE_BET blocked — ${side} $${amount} (${Math.round(keyAge/1000)}s ago)`);
    chrome.runtime.sendMessage({ type: 'BET_RESULT', ok: false, step: 'duplicate', error: `Duplicate bet blocked — same bet was placed ${Math.round(keyAge/1000)}s ago` }).catch(() => {});
    return;
  }
  await chrome.storage.local.set({ lastBetKey: betKey, lastBetKeyTs: Date.now() });

  // Find the sportsbook tab to place on — must NOT be /mybets (no odds buttons there)
  const allDk = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
  const allUrls = allDk.map(t => `tab${t.id}:${(t.url||'').replace('https://sportsbook.draftkings.com','')}`).join(', ');
  addLog(`PLACE_BET: tabs found: [${allUrls || 'none'}]`);
  console.log('[BetBot BG] PLACE_BET tab search:', allUrls || 'NO TABS');

  const target = allDk.find(t => !t.url?.includes('/mybets') && t.active)
              || allDk.find(t => !t.url?.includes('/mybets'));

  if (!target) {
    const errMsg = allDk.length === 0
      ? 'No DraftKings tab open — open sportsbook.draftkings.com and navigate to the fight'
      : `Only My Bets tab found (${allDk.length} tab(s)) — open the fight page on DraftKings sportsbook first, then retry`;
    addLog(`PLACE_BET FAILED: ${errMsg}`);
    console.warn('[BetBot BG] PLACE_BET FAILED:', errMsg);
    if (commandId) await chrome.storage.local.remove(['lastBetKey', 'lastBetKeyTs']);
    chrome.runtime.sendMessage({ type: 'BET_RESULT', ok: false, step: 'no_tab', error: errMsg }).catch(() => {});
    if (commandId) postToServer('/api/command-result', { commandId, result: { ok: false, error: errMsg } });
    return;
  }
  addLog(`PLACE_BET: ${side} $${amount} → tab ${target.id} (${(target.url||'').replace('https://sportsbook.draftkings.com','')})`);
  console.log('[BetBot BG] PLACE_BET executing on tab', target.id, target.url);
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

        // Common alternate names/abbreviations — try all of them
        const ALIASES = {
          'us': ['usa', 'united states'],
          'usa': ['us', 'united states'],
          'uk': ['england', 'great britain', 'united kingdom'],
          'south korea': ['korea', 'republic of korea'],
          'korea': ['south korea', 'republic of korea'],
          'north korea': ['korea dpr', 'dpr korea'],
          'iran': ['ir iran'],
          'uae': ['united arab emirates'],
          'czech republic': ['czechia'],
          'czechia': ['czech republic'],
        };
        const sideAlts = [sideL, ...(ALIASES[sideL] || [])];

        const allClickable = [...document.querySelectorAll('button, [role="button"]')];
        let outcomeBtn = null;

        // ── Strategy A: team name IS inside the button ───────────────────
        // Works for MMA fight pages where fighter name lives inside the bet button.
        for (const alt of sideAlts) {
          for (const el of allClickable) {
            const spans = el.querySelectorAll('span, div, p');
            const labelSpan = [...spans].find(s =>
              s.childElementCount === 0 && s.textContent.trim().toLowerCase() === alt
            );
            if (labelSpan) { outcomeBtn = el; break; }
          }
          if (outcomeBtn) break;
        }

        // ── Strategy B: looser full-text match on button ─────────────────
        if (!outcomeBtn) {
          for (const alt of sideAlts) {
            outcomeBtn = allClickable.find(el => {
              const t = el.textContent.trim().toLowerCase();
              return (t === alt || t.startsWith(alt + '\n') || t.startsWith(alt + ' '));
            });
            if (outcomeBtn) break;
          }
        }

        // ── Strategy C: team name is a ROW LABEL, not inside the button ──
        // Works for soccer/league pages where odds buttons only show odds numbers
        // (-165, +330, +425) and the team name is a separate element in the same row.
        if (!outcomeBtn) {
          const allText = [...document.querySelectorAll('span, div, p, td, th, li, a, h1, h2, h3')];
          let nameEl = null;
          for (const alt of sideAlts) {
            nameEl = allText.find(el =>
              el.childElementCount === 0 &&
              el.textContent.trim().toLowerCase() === alt &&
              !el.closest('button, [role="button"]')
            );
            if (nameEl) break;
          }
          if (nameEl) {
            // Walk up to find a row/container that contains an odds button
            let ancestor = nameEl;
            for (let depth = 0; depth < 8; depth++) {
              ancestor = ancestor.parentElement;
              if (!ancestor) break;
              // Odds button text is just the odds value like "-165" or "+330"
              const oddsBtn = [...ancestor.querySelectorAll('button, [role="button"]')]
                .find(btn => /^[+-]\d+$/.test(btn.textContent.trim().replace(/\s+/g, '')));
              if (oddsBtn) { outcomeBtn = oddsBtn; break; }
            }
          }
        }

        if (!outcomeBtn) {
          // Collect all visible button texts for debug
          const allButtonTexts = [...document.querySelectorAll('button, [role="button"]')]
            .map(b => b.textContent.trim().slice(0, 50).replace(/\s+/g, ' '))
            .filter(t => t.length > 0)
            .slice(0, 60);

          // Collect text elements NEAR odds buttons — these are likely team/player names.
          // On league pages (soccer, NBA), team names sit in the same row as odds buttons
          // but are NOT inside the button element itself.
          const oddsButtons = [...document.querySelectorAll('button, [role="button"]')]
            .filter(btn => /^[+-]\d+$/.test(btn.textContent.trim().replace(/\s+/g, '')));
          const nearbySet = new Set();
          oddsButtons.forEach(btn => {
            let ancestor = btn;
            for (let depth = 0; depth < 8; depth++) {
              ancestor = ancestor.parentElement;
              if (!ancestor) break;
              [...ancestor.querySelectorAll('span, div, p, td, th, li, a')]
                .filter(el =>
                  el.childElementCount === 0 &&
                  el.textContent.trim().length >= 2 &&
                  el.textContent.trim().length <= 50 &&
                  !/^[+-]\d+$/.test(el.textContent.trim())
                )
                .forEach(el => nearbySet.add(el.textContent.trim()));
              // Stop climbing once we're at a row container with multiple odds buttons
              const rowOddsCount = [...ancestor.querySelectorAll('button, [role="button"]')]
                .filter(b => /^[+-]\d+$/.test(b.textContent.trim().replace(/\s+/g, ''))).length;
              if (rowOddsCount >= 2) break;
            }
          });
          const nearbyLabels = [...nearbySet].slice(0, 80);

          console.warn('[BetBot] find_button failed for side:', side, 'alts tried:', sideAlts,
            '— buttons:', allButtonTexts.slice(0, 10), '— nearbyLabels:', nearbyLabels.slice(0, 10));
          return {
            ok: false, step: 'find_button',
            error: `No button found for "${side}" — make sure the game is visible on screen`,
            needsAIResolve: true,
            nearbyLabels,
            allButtonTexts,
          };
        }

        // Read the odds BEFORE logging (fixes TDZ: oddsEl was referenced before its declaration)
        const oddsEl = [...outcomeBtn.querySelectorAll('span, div')].find(s =>
          s.childElementCount === 0 && /^[+-]\d+$/.test(s.textContent.trim())
        );
        const oddsText = oddsEl ? oddsEl.textContent.trim() : '?';
        console.log('[BetBot] found outcome button for', side, '— odds:', oddsText);

        const alreadySelected = outcomeBtn.classList.toString().toLowerCase().includes('active')
                             || outcomeBtn.getAttribute('aria-pressed') === 'true';
        void alreadySelected; // informational only

        outcomeBtn.click();
        await sleep(1200);

        // ── Step 2: find bet slip amount input ───────────────────────────
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
          const allInputs = [...document.querySelectorAll('input')].map(i => `type=${i.type} label=${i.getAttribute('aria-label')||''} ph=${i.placeholder||''}`);
          console.warn('[BetBot] find_input failed — all inputs:', allInputs);
          return { ok: false, step: 'find_input', oddsText, error: 'Bet slip did not open or amount input not found — try opening the bet slip manually first', debugInputs: allInputs };
        }
        console.log('[BetBot] bet slip input found, setting amount:', amount);

        amtInput.focus();
        setReactInput(amtInput, String(amount));
        await sleep(600);

        // ── Step 3: find and click Place Bet button ───────────────────────
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
    let result = results?.[0]?.result || { ok: false, error: 'No result from tab' };

    // ── AI-assisted name resolution (only on find_button failure, only once) ──
    // The injected script returns needsAIResolve=true with nearbyLabels collected
    // from the DOM. We ask Haiku which label best matches the user's intended side,
    // then retry once with the resolved name. This handles US→USA, Korea→South Korea,
    // and any page-layout mismatch where the name isn't inside the button itself.
    if (!result.ok && result.step === 'find_button' && result.needsAIResolve && !isRetry) {
      addLog(`find_button failed for "${side}" — asking AI to resolve from ${(result.nearbyLabels||[]).length} page labels`);
      try {
        const resolveR = await fetch(`${betBotUrl}/api/resolve-bet-target`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            side,
            nearbyLabels:   result.nearbyLabels   || [],
            allButtonTexts: result.allButtonTexts || [],
            userId: dkUserId,
          })
        });
        if (resolveR.ok) {
          const resolveResult = await resolveR.json();
          if (resolveResult.ok && resolveResult.resolvedSide) {
            addLog(`AI resolved "${side}" → "${resolveResult.resolvedSide}" (${Math.round((resolveResult.confidence||0)*100)}%) — retrying`);
            // Recursive call with isRetry=true so we don't loop if it fails again
            result = await executePlaceBet(resolveResult.resolvedSide, amount, commandId, isAutoHedge, true);
            // executePlaceBet handles logging/posting internally on the retry path; return here
            return result;
          } else if (resolveResult.ambiguous) {
            const opts = (resolveResult.options || []).slice(0, 5).join(', ');
            const errMsg = `Couldn't auto-resolve "${side}" — did you mean one of: ${opts}?`;
            addLog(`AI resolve ambiguous: ${errMsg}`);
            result = { ok: false, step: 'find_button', error: errMsg };
          } else {
            addLog(`AI resolve failed: ${resolveResult.error || 'unknown'}`);
          }
        }
      } catch(resolveErr) {
        addLog(`AI resolve network error: ${resolveErr.message}`);
        // Fall through — report original find_button error below
      }
    }

    const logLine = result.ok
      ? `BET_RESULT ok: ${result.side} $${result.amount} @ ${result.oddsText} confirmed=${result.confirmed}`
      : `BET_RESULT FAIL [${result.step}]: ${result.error}` +
        (result.debugInputs ? ` | inputs: ${result.debugInputs.slice(0,3).join(', ')}` : '');
    addLog(logLine);
    console.log('[BetBot BG] BET_RESULT:', JSON.stringify(result));
    if (!result.ok) await chrome.storage.local.remove(['lastBetKey', 'lastBetKeyTs']);
    chrome.runtime.sendMessage({ type: 'BET_RESULT', ...result }).catch(() => {});
    if (commandId) {
      postToServer('/api/command-result', { commandId, result });
      if (result.ok) {
        postToServer('/api/strategy-update', {
          commandId,
          state: 'FIRST_BET_PLACED',
          message: `✅ ${result.side} $${result.amount} @ ${result.oddsText || '?'} placed${result.confirmed ? ' — confirmed ✓' : ''}`,
        });
      }
    }

    // ── Advance state machine based on bet outcome ────────────────────
    (async () => {
      const r2 = await chrome.storage.local.get(['pendingStrategy']);
      const strat = r2.pendingStrategy || { state: 'IDLE' };
      const event = result.ok && result.confirmed ? 'BET_CONFIRMED' : 'BET_FAILED';
      const nextState = strategyTransition(strat.state, event);
      if (nextState === strat.state) return;

      const updated = { ...strat, state: nextState, updatedAt: Date.now() };
      if (strat.state === 'FIRST_BET_PENDING' && event === 'BET_CONFIRMED') {
        updated.leg1Confirmed = true;
        updated.leg1Odds = result.oddsText || strat.leg1Odds;
        const tabs = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
        if (strat.leg2Side) {
          tabs.forEach(t => chrome.tabs.sendMessage(t.id, {
            type: 'WATCH_SIDES',
            leg1Side: strat.leg1Side,
            leg2Side: strat.leg2Side,
          }).catch(() => {}));
        }
      }
      if (nextState === 'BOTH_PLACED' || nextState === 'HEDGE_FAILED') {
        const tabs2 = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
        tabs2.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'STOP_WATCHING' }).catch(() => {}));
        if (strat.commandId) {
          const termMsg = nextState === 'BOTH_PLACED'
            ? '🎯 **Both legs placed — WIN-WIN locked!** Guaranteed profit regardless of outcome.'
            : '❌ Hedge failed — strategy reset.';
          postToServer('/api/command-result', {
            commandId: strat.commandId,
            result: { ok: nextState === 'BOTH_PLACED', bothPlaced: nextState === 'BOTH_PLACED', message: termMsg },
          });
        }
      }
      await chrome.storage.local.set({ pendingStrategy: updated });
      addLog(`State: ${strat.state} → ${nextState} (${event})`);
      chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy: updated }).catch(() => {});
    })();
  } catch(e) {
    addLog(`BET_RESULT error: ${e.message}`);
    chrome.runtime.sendMessage({ type: 'BET_RESULT', ok: false, error: e.message }).catch(() => {});
  }
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

  // ── Strategy state machine messages ──────────────────────────────────────
  // State stored in chrome.storage.local as `pendingStrategy`.
  // Schema: { state, leg1Side, leg1Amount, leg1Odds, leg2Side, trigger,
  //           gameId, startedAt, updatedAt, leg1Confirmed, hedgeAmount, expectedHedgeOdds }

  // ── Dashboard chat → extension command relay ─────────────────────────────
  if (msg.type === 'EXECUTE_COMMAND') {
    const fromTab = sender?.tab ? `tab ${sender.tab.id} (${(sender.tab.url||'').slice(0,60)})` : 'SW poll';
    addLog(`EXECUTE_COMMAND via message from ${fromTab}: ${msg.command?.type} ${msg.command?.side || ''} $${msg.command?.amount || ''}`);
    handleExecuteCommand(msg.command);
    return;
  }

  if (msg.type === 'STRATEGY_START') {
    // Popup sends this after user types "bet $X on Y, auto-hedge at Z"
    const { leg1Side, leg1Amount, trigger, gameId } = msg;
    (async () => {
      const strategy = {
        state: 'FIRST_BET_PENDING',
        leg1Side, leg1Amount, trigger, gameId: gameId || null,
        leg1Confirmed: false, startedAt: Date.now(), updatedAt: Date.now()
      };
      await chrome.storage.local.set({ pendingStrategy: strategy });
      addLog(`Strategy started: ${leg1Side} $${leg1Amount} trigger=${JSON.stringify(trigger)}`);
      chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy }).catch(() => {});
    })();
    return;
  }

  if (msg.type === 'STRATEGY_CANCEL') {
    (async () => {
      await chrome.storage.local.set({ pendingStrategy: { state: 'IDLE', updatedAt: Date.now() } });
      // Tell content.js to stop watching
      const tabs = await chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' });
      tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'STOP_WATCHING' }).catch(() => {}));
      addLog('Strategy cancelled → IDLE');
      chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy: { state: 'IDLE' } }).catch(() => {});
    })();
    return;
  }

  if (msg.type === 'CROSSOVER_DETECTED') {
    (async () => {
      const r = await chrome.storage.local.get(['pendingStrategy']);
      const strategy = r.pendingStrategy || { state: 'IDLE' };

      // Only act in FIRST_BET_PLACED state
      if (strategy.state !== 'FIRST_BET_PLACED') {
        addLog(`CROSSOVER_DETECTED ignored — state is ${strategy.state}`);
        return;
      }

      // ── Hedge math — must have leg1OddsDecimal stored from first bet ────────
      const D1 = strategy.leg1OddsDecimal;
      const D2 = americanToDecimal(msg.leg2?.american);
      if (!D1 || !D2) {
        addLog(`CROSSOVER: missing odds for hedge calc (D1=${D1}, D2=${D2}) — cannot auto-hedge`);
        return;
      }
      const payout1    = strategy.leg1Amount * D1;
      const hedgeAmount  = parseFloat((payout1 / D2).toFixed(2));
      const hedgeProfit  = parseFloat((payout1 - strategy.leg1Amount - hedgeAmount).toFixed(2));

      // ── Win-win window check: (D1-1)(D2-1) > 1 ─────────────────────────────
      // The crossover (implied probs flip) is necessary but not sufficient for profit.
      // The vig means we need the odds gap to be wide enough. Stay in FIRST_BET_PLACED
      // if the window hasn't opened yet — don't lock out future CROSSOVER_DETECTED events.
      if ((D1 - 1) * (D2 - 1) <= 1) {
        addLog(`CROSSOVER: not in win-win window yet (D1=${D1.toFixed(3)}, D2=${D2.toFixed(3)}, hedgeProfit=$${hedgeProfit}) — waiting for better odds`);
        return;
      }

      addLog(`Crossover in win-win window: ${msg.leg1?.oddsText} vs ${msg.leg2?.oddsText} — hedge $${hedgeAmount}, profit $${hedgeProfit}`);
      const nextStrategy = { ...strategy, state: 'WATCHING_HEDGE', hedgeAmount, hedgeProfit, updatedAt: Date.now() };
      await chrome.storage.local.set({ pendingStrategy: nextStrategy });
      chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy: nextStrategy }).catch(() => {});

      // ── Triple-verify gate (7 checks) before auto-hedging ───────────────────
      const domState = {
        gameId:           msg.gameId || null,
        leg2Odds:         msg.leg2?.american,
        suspended:        msg.suspended || false,
        hedgeProfit,
        slipHasBets:      msg.slipHasBets || false,
        balance:          msg.balance,
      };

      const verify = tripleVerify({ ...strategy, hedgeAmount, expectedHedgeOdds: msg.leg2?.american }, domState);
      if (!verify.pass) {
        addLog(`Triple verify FAILED: ${verify.failed.map(c => c.name).join(', ')}`);
        const failed = { ...nextStrategy, state: 'HEDGE_FAILED', verifyFailures: verify.failed, updatedAt: Date.now() };
        await chrome.storage.local.set({ pendingStrategy: failed });
        chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy: failed }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'HEDGE_BLOCKED', reason: verify.failed }).catch(() => {});
        return;
      }

      // All 7 checks pass — show 3s STOP countdown before firing
      const hedgeSide = strategy.leg2Side || msg.leg2?.side;
      const hedgeOdds = msg.leg2?.oddsText || '?';
      addLog(`Triple verify PASSED — 3s countdown before hedge: ${hedgeSide} $${hedgeAmount} @ ${hedgeOdds} (profit $${hedgeProfit})`);

      // Notify popup to show STOP button countdown
      chrome.runtime.sendMessage({ type: 'HEDGE_COUNTDOWN', side: hedgeSide, amount: hedgeAmount, oddsText: hedgeOdds, hedgeProfit }).catch(() => {});

      // Wait 3s — user can send STRATEGY_CANCEL during this window
      await new Promise(res => setTimeout(res, 3000));

      // Re-check strategy wasn't cancelled during the 3s window
      const r2 = await chrome.storage.local.get(['pendingStrategy']);
      const stratNow = r2.pendingStrategy || { state: 'IDLE' };
      if (stratNow.state !== 'WATCHING_HEDGE') {
        addLog(`Hedge aborted — state changed to ${stratNow.state} during countdown`);
        return;
      }

      const firedStrategy = { ...stratNow, state: 'HEDGE_FIRED', updatedAt: Date.now() };
      await chrome.storage.local.set({ pendingStrategy: firedStrategy });
      chrome.runtime.sendMessage({ type: 'STRATEGY_UPDATE', strategy: firedStrategy }).catch(() => {});
      addLog(`Firing hedge: ${hedgeSide} $${hedgeAmount}`);
      if (stratNow.commandId) {
        postToServer('/api/strategy-update', {
          commandId: stratNow.commandId,
          state: 'HEDGE_FIRED',
          message: `⚡ WIN-WIN WINDOW OPEN — placing hedge: ${hedgeSide} $${hedgeAmount} @ ${hedgeOdds} | Locked profit: $${hedgeProfit}`,
        });
      }

      executePlaceBet(hedgeSide, hedgeAmount, stratNow.commandId || null, true);
    })();
    return;
  }

  if (msg.type === 'ODDS_UPDATE') {
    // Forward to popup for display — no state machine logic here
    chrome.runtime.sendMessage({ type: 'ODDS_UPDATE', outcomes: msg.outcomes, ts: msg.ts }).catch(() => {});
    return;
  }

  if (msg.type === 'PLACE_BET') {
    const { side, amount, commandId } = msg;
    executePlaceBet(side, amount, commandId, false);
    return true;
  }

  if (msg.type === 'TRIGGER_MET') {
    const { triggerId, side, amount, currentOdds } = msg;
    addLog(`TRIGGER_MET: ${side} $${amount} @ ${currentOdds} [trigger ${triggerId}]`);
    // Fire the bet and delete the trigger from the server
    executePlaceBet(side, amount, null, false);
    fetch(`${betBotUrl}/api/watch-triggers/${triggerId}`, { method: 'DELETE' }).catch(() => {});
    // Clear trigger from all content tabs so it doesn't re-fire
    chrome.tabs.query({ url: 'https://sportsbook.draftkings.com/*' }).then(tabs => {
      tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'CLEAR_TRIGGERS' }).catch(() => {}));
    }).catch(() => {});
    return;
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
