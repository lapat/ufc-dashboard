const DEFAULT_URL = 'https://ufc-dashboard-production-e03d.up.railway.app';

let betBotUrl = DEFAULT_URL;
let dkUserId = null; // auto-detected from DK API responses

chrome.storage.local.get(['betBotUrl', 'dkUserId'], r => {
  betBotUrl = r.betBotUrl || DEFAULT_URL;
  dkUserId = r.dkUserId || null;
});
chrome.storage.onChanged.addListener(changes => {
  if (changes.betBotUrl) betBotUrl = changes.betBotUrl.newValue;
  if (changes.dkUserId) dkUserId = changes.dkUserId.newValue;
});

function postToServer(path, body) {
  if (!betBotUrl) return;
  fetch(`${betBotUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, userId: dkUserId })
  }).catch(() => {});
}

// Use Chrome Alarms for reliable periodic tasks
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') {
    postToServer('/api/dk-heartbeat', { ts: Date.now() });
  }
  if (alarm.name === 'keepAlive') {
    const tabs = await chrome.tabs.query({ url: 'https://*.draftkings.com/*' });
    if (!tabs.length) return;
    const tab = tabs.find(t => t.url?.includes('/mybets')) || tabs[0];
    if (!tab?.id) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => fetch('https://sportsbook-nash.draftkings.com/sites/US-IL-SB/api/v5/users/me?format=json', { credentials: 'include' }).catch(() => {})
      });
    } catch (_) {}
  }
});

postToServer('/api/dk-heartbeat', { ts: Date.now() });

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

function addLog(msg) {
  chrome.storage.local.get(['debugLog'], r => {
    const log = r.debugLog || [];
    log.unshift({ ts: Date.now(), msg });
    chrome.storage.local.set({ debugLog: log.slice(0, 30) });
  });
}

// Try to extract userId from various DK API responses
function tryExtractUserId(url, data) {
  // From /social/user/me.json — has username
  if (url.includes('/social/user/') && data?.username) {
    return data.username;
  }
  // From /users/me — has displayName or userId
  if (url.includes('/users/me') && (data?.username || data?.displayName || data?.userId)) {
    return data.username || data.displayName || String(data.userId);
  }
  // From bets payload — receiptId prefix often encodes user
  if (data?.result?.initial?.bets?.[0]?.betId) {
    // betId format: 639169660797770899 — first part after receipts is consistent per user
    // Not reliable enough, skip
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DK_LOGOUT') {
    postToServer('/api/dk-logout', { ts: Date.now() });
    chrome.storage.local.set({ dkLoggedOut: true });
    addLog('LOGOUT detected');
    return;
  }
  if (msg.type !== 'DK_API') return;

  const url = msg.url;
  const data = msg.data;

  // Auto-detect userId from API responses
  const extractedId = tryExtractUserId(url, data);
  if (extractedId && extractedId !== dkUserId) {
    dkUserId = extractedId;
    chrome.storage.local.set({ dkUserId: extractedId });
    addLog(`User identified: ${extractedId}`);
  }

  // Store raw capture for popup display
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
