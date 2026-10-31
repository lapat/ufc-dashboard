// bridge.js — Relays commands and synchronizes user identity between LiveBetBot and the extension

// 1. Initial Handshake: sync username between dashboard localStorage and extension
try {
  const dashUser = localStorage.getItem('dashUserId');
  if (dashUser && dashUser.trim()) {
    // If dashboard already has a username, inform the extension
    chrome.runtime.sendMessage({ type: 'SYNC_USER_ID', userId: dashUser.trim().toLowerCase() });
  } else {
    // If dashboard has no username yet, ask extension for its configured username
    chrome.runtime.sendMessage({ type: 'GET_USER_ID' }, response => {
      if (response && response.userId && !response.userId.startsWith('dev-')) {
        localStorage.setItem('dashUserId', response.userId);
        if (typeof applyDashUser === 'function') applyDashUser(response.userId);
        if (typeof syncDKBets === 'function') syncDKBets();
      }
    });
  }
} catch (_) {}

// 2. Relays 1-click commands, username changes, and tape stream launchers
window.addEventListener('message', e => {
  if (e.source !== window) return;
  if (!e.data) return;

  // When user updates their username on the dashboard
  if (e.data.type === 'DASH_USER_CHANGED' && e.data.userId) {
    try {
      chrome.runtime.sendMessage({ type: 'SYNC_USER_ID', userId: e.data.userId });
    } catch (_) {}
  }

  // When dashboard requests username from extension
  if (e.data.type === 'DASH_HANDSHAKE_REQUEST') {
    try {
      chrome.runtime.sendMessage({ type: 'GET_USER_ID' }, response => {
        if (response && response.userId && !response.userId.startsWith('dev-')) {
          localStorage.setItem('dashUserId', response.userId);
          if (typeof applyDashUser === 'function') applyDashUser(response.userId);
          if (typeof syncDKBets === 'function') syncDKBets();
        }
      });
    } catch (_) {}
  }

  // 1-Click betslip and tape commands
  if (e.data.type === 'PREFILL_BETSLIP' || e.data.type === 'LAUNCH_PARAMOUNT' || e.data.type === 'LAUNCH_FIGHTPASS') {
    try {
      chrome.runtime.sendMessage(e.data);
    } catch (_) {}
  }
});
