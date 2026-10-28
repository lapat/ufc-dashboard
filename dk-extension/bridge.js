// Relays 1-click commands and tape stream launchers from LiveBetBot to background service worker
window.addEventListener('message', e => {
  if (e.source !== window) return;
  if (e.data && (e.data.type === 'PREFILL_BETSLIP' || e.data.type === 'LAUNCH_PARAMOUNT' || e.data.type === 'LAUNCH_FIGHTPASS')) {
    try {
      chrome.runtime.sendMessage(e.data);
    } catch (_) {}
  }
});
