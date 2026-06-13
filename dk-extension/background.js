const DEFAULT_URL = 'https://ufc-dashboard-production-e03d.up.railway.app';

let betBotUrl = DEFAULT_URL;
let dkUserId = null;
let manualUserId = null;

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';
  if (url.includes('draftkings.com') && (url.includes('/login') || url.includes('/sportsbook-auth') || url.includes('sign-in'))) {
    postToServer('/api/dk-logout', { ts: Date.now() });
    chrome.storage.local.set({ dkLoggedOut: true });
  } else if (url.includes('draftkings.com/mybets')) {
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

chrome.runtime.onMessage.addListener((msg) => {
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
