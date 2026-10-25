// Relays 1-click pre-fill commands from LiveBetBot to background service worker
window.addEventListener('message', e => {
  if (e.source !== window) return;
  if (e.data && e.data.type === 'PREFILL_BETSLIP') {
    try {
      chrome.runtime.sendMessage(e.data);
    } catch (_) {}
  }
});
