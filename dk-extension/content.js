// Relay intercepted messages from page context to background service worker
window.addEventListener('message', e => {
  if (e.source !== window) return;
  if (e.data?.type === 'DK_API') {
    chrome.runtime.sendMessage({ type: 'DK_API', url: e.data.url, data: e.data.data });
  }
  if (e.data?.type === 'DK_WS_STATUS') {
    chrome.runtime.sendMessage({ type: 'DK_WS_STATUS', connected: e.data.connected, url: e.data.url, ts: e.data.ts, code: e.data.code });
  }
  // Detect 401 from any DK API response
  if (e.data?.type === 'DK_API') {
    if (e.data?.data?.statusCode === 401 || e.data?.data?.code === 'UNAUTHORIZED') {
      chrome.runtime.sendMessage({ type: 'DK_LOGOUT' });
    }
  }
});

// Detect logout page
const href = window.location.href;
if (href.includes('/auth/login') || href.includes('/login') || href.includes('sign-in')) {
  chrome.runtime.sendMessage({ type: 'DK_LOGOUT' });
}

// Auto-refresh My Bets tab every 20 seconds — keeps live bet data current
// setTimeout (not setInterval): fires once → reload → content script re-runs → repeat
if (href.includes('/mybets')) {
  setTimeout(() => location.reload(), 20000);
}
