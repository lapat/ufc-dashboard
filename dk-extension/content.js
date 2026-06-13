// Relay intercepted API responses from page context to background
window.addEventListener('message', e => {
  if (e.source !== window || e.data?.type !== 'DK_API') return;
  chrome.runtime.sendMessage({ type: 'DK_API', url: e.data.url, data: e.data.data });
});

// Detect logout — if we land on auth/login page, fire DK_LOGOUT immediately
const href = window.location.href;
if (href.includes('/auth/login') || href.includes('/login') || href.includes('sign-in')) {
  chrome.runtime.sendMessage({ type: 'DK_LOGOUT' });
}

// Also detect if mybets API returns 401
window.addEventListener('message', e => {
  if (e.source !== window || e.data?.type !== 'DK_API') return;
  if (e.data?.data?.statusCode === 401 || e.data?.data?.code === 'UNAUTHORIZED') {
    chrome.runtime.sendMessage({ type: 'DK_LOGOUT' });
  }
});
