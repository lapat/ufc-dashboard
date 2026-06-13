const DEFAULT_URL = 'https://ufc-dashboard-production-e03d.up.railway.app';

// Load saved server URL, default to Railway app
let betBotUrl = DEFAULT_URL;
chrome.storage.local.get(['betBotUrl'], r => { betBotUrl = r.betBotUrl || DEFAULT_URL; });
chrome.storage.onChanged.addListener(changes => {
  if (changes.betBotUrl) betBotUrl = changes.betBotUrl.newValue;
});

function postToServer(path, body) {
  if (!betBotUrl) return;
  fetch(`${betBotUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}

// Heartbeat every 2 minutes so the dashboard knows the extension is alive
setInterval(() => postToServer('/api/dk-heartbeat', { ts: Date.now() }), 120000);
postToServer('/api/dk-heartbeat', { ts: Date.now() }); // immediate on load

// Keep DK session alive — every 3 minutes, ping the mybets API from inside the DK tab
async function keepDKAlive() {
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
setInterval(keepDKAlive, 180000);
keepDKAlive();

// Detect logout: DK navigates to /login or /sportsbook-auth
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DK_LOGOUT') {
    postToServer('/api/dk-logout', { ts: Date.now() });
    chrome.storage.local.set({ dkLoggedOut: true });
    return;
  }
  if (msg.type !== 'DK_API') return;

  const url = msg.url;
  const data = msg.data;

  // Log everything we see for discovery
  console.log('[BetBot DK] API call:', url);

  // Store raw capture for popup display
  chrome.storage.local.get(['captures'], r => {
    const captures = r.captures || [];
    captures.unshift({ url, ts: Date.now(), preview: JSON.stringify(data).slice(0, 200) });
    chrome.storage.local.set({ captures: captures.slice(0, 50) });
  });

  // Send to Bet Bot server
  if (!betBotUrl) return;
  fetch(`${betBotUrl}/api/dk-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, data, ts: Date.now() })
  }).then(r => r.json()).then(res => {
    if (res.bets?.length) {
      chrome.storage.local.set({ lastSync: Date.now(), lastBetCount: res.bets.length });
    }
  }).catch(() => {});
});
