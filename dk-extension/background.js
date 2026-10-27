const DEFAULT_URL = 'https://www.livebetbot.com';

const PUSH_INTERVAL_MS = 1000; // High-density 1-second capture
let pushedCount = 0;
let pushFailCount = 0;
let lastPushMs = 0;
let betBotUrl = DEFAULT_URL;
let dkUserId = null;
let manualUserId = null;
let botToken = null;
let handlingLogin = false; // prevents both tabs racing to the login page

function genDeviceId() {
  return 'dev-' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Load storage first — dkUserId must NEVER be null when we post
chrome.storage.local.get(['betBotUrl', 'dkUserId', 'manualUserId', 'deviceId', 'botToken'], r => {
  betBotUrl = r.betBotUrl || DEFAULT_URL;
  botToken   = r.botToken || null;
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
  if (changes.betBotUrl)  betBotUrl  = changes.betBotUrl.newValue;
  if (changes.botToken)   botToken   = changes.botToken.newValue;
  if (changes.manualUserId) { manualUserId = changes.manualUserId.newValue; dkUserId = manualUserId; }
  else if (changes.dkUserId && !manualUserId) dkUserId = changes.dkUserId.newValue;
});

function authHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (botToken) h['X-Bot-Token'] = botToken;
  return h;
}

function postToServer(path, body) {
  if (!betBotUrl) return;
  fetch(`${betBotUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(),
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
  if (msg.type === 'SCAN_STATS') {
    const st = msg.stats || {};
    const line = `scan 30s: ${st.scans} scans, ${st.withOdds} had odds, ${st.noOdds} no odds on screen, ${st.noTwoTeams} missing team names, pushes ok ${pushedCount} / failed ${pushFailCount}`;
    addLog(line);
    chrome.storage.local.set({ lastScanStats: { ...st, href: msg.href, ts: msg.ts, pushedTotal: pushedCount, pushFailTotal: pushFailCount } });
    return;
  }

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

  if (msg.type === 'SET_MANUAL_LIVE') {
    const until = Date.now() + 30 * 60 * 1000; // 30-minute window, matches a typical fight length
    chrome.storage.local.set({ manualLiveUntil: until });
    addLog(`Manual "Fight Started" — forcing live capture for 30 min`);
    return;
  }

  if (msg.type === 'PREFILL_BETSLIP') {
    chrome.tabs.query({ url: 'https://*.draftkings.com/*' }, tabs => {
      if (!tabs || !tabs.length) return;
      const targetTab = tabs.find(t => !t.url.includes('/mybets')) || tabs[0];
      if (targetTab && targetTab.id) {
        chrome.tabs.update(targetTab.id, { active: true });
        chrome.tabs.sendMessage(targetTab.id, {
          type: 'EXECUTE_PREFILL',
          fighter: msg.fighter,
          stake: msg.stake,
          odds: msg.odds
        });
      }
    });
    return;
  }

  if (msg.type === 'CLEAR_MANUAL_LIVE') {
    chrome.storage.local.set({ manualLiveUntil: 0 });
    addLog('Manual live override cleared');
    return;
  }

  if (msg.type === 'ODDS_UPDATE') {
    chrome.runtime.sendMessage({ type: 'ODDS_UPDATE', outcomes: msg.outcomes, ts: msg.ts }).catch(() => {});
    const teams = (msg.outcomes || []).filter(o => o.side && !/^(draw|x)$/i.test(o.side.trim()));
    // Snapshot what's currently on screen so the popup can show "watching X vs Y"
    // regardless of whether it's live enough to actually push to the server.
    if (teams.length >= 2) {
      const [t1, t2] = teams;
      chrome.storage.local.set({
        lastSeenFight: {
          fighter1: t1.side, fighter2: t2.side,
          odds1: t1.american, odds2: t2.american,
          live: !!msg.live, sport: msg.sport, ts: msg.ts,
        },
      });
    }
    // MANDATE: Only push to live recording server when the fight has ACTUALLY started (live === true)
    // Pre-fight browsing must NEVER generate recordings.
    if (!msg.live) return;

    const nowMs = Date.now();
    if (nowMs - lastPushMs < PUSH_INTERVAL_MS) return;
    if (betBotUrl && teams.length >= 2 && msg.sport && msg.sport === 'mma_mixed_martial_arts') {
      const [o1, o2] = teams;
      // Refuse to push if both fighter names resolved identically
      if (o1.side.trim().toLowerCase() === o2.side.trim().toLowerCase()) return;

      lastPushMs = nowMs;
      fetch(`${betBotUrl}/api/dk-odds-push`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          sport: msg.sport,
          fighter1: o1.side,
          fighter2: o2.side,
          numericOdds1: o1.american,
          numericOdds2: o2.american,
          live: true,
        }),
      }).then(r => { if (r.ok) pushedCount++; else { pushFailCount++; addLog(`✗ odds push HTTP ${r.status}`); } })
        .catch(e => { pushFailCount++; addLog(`✗ odds push failed: ${e.message}`); });
    }
    return;
  }

  if (msg.type !== 'DK_API') return;

  const url = msg.url;
  const data = msg.data;

  const extractedId = tryExtractUserId(url, data);
  if (extractedId && !manualUserId && extractedId !== dkUserId) {
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
    headers: authHeaders(),
    body: JSON.stringify({ url, data, ts: Date.now(), userId: dkUserId })
  }).then(async r => {
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      addLog(`✗ server HTTP ${r.status}`);
      return null;
    }
    return r.json().catch(err => {
      addLog(`✗ server invalid json`);
      return null;
    });
  }).then(res => {
    if (!res) return;
    if (res.bets?.length) {
      chrome.storage.local.set({ lastSync: Date.now(), lastBetCount: res.bets.length });
      addLog(`✓ server parsed ${res.bets.length} bets`);
    } else {
      addLog(`server: no bets parsed`);
    }
  }).catch(e => addLog(`✗ server error: ${e.message}`));
});
