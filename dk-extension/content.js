// Relay intercepted API responses from page context to background
window.addEventListener('message', e => {
  if (e.source !== window || e.data?.type !== 'DK_API') return;
  chrome.runtime.sendMessage({ type: 'DK_API', url: e.data.url, data: e.data.data });
});
