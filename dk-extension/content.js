// Safe wrapper — chrome.runtime becomes unavailable after extension reload/update
// while the page is still open. All sendMessage calls must go through this.
function send(msg) {
  try { chrome.runtime.sendMessage(msg); } catch (_) {}
}

// Relay intercepted messages from page context to background service worker
window.addEventListener('message', e => {
  if (e.source !== window) return;
  if (e.data?.type === 'DK_API') {
    send({ type: 'DK_API', url: e.data.url, data: e.data.data });
  }
  if (e.data?.type === 'DK_WS_STATUS') {
    send({ type: 'DK_WS_STATUS', connected: e.data.connected, url: e.data.url, ts: e.data.ts, code: e.data.code });
  }
  if (e.data?.type === 'DK_API') {
    if (e.data?.data?.statusCode === 401 || e.data?.data?.code === 'UNAUTHORIZED') {
      send({ type: 'DK_LOGOUT' });
    }
  }
});

const href = window.location.href;

// ── Detect logout page ──────────────────────────────────────────────────────
if (href.includes('/auth/login') || href.includes('/login') || href.includes('sign-in')) {
  send({ type: 'DK_LOGOUT' });
}

// ── Auto-fill login page ────────────────────────────────────────────────────
if (href.includes('myaccount.draftkings.com') && href.includes('/login')) {
  chrome.storage.local.get(['dkEmail', 'dkPassword', 'dkAutoLogin'], ({ dkEmail, dkPassword, dkAutoLogin }) => {
    if (!dkEmail || !dkPassword || !dkAutoLogin) return;

    function setReactInput(el, value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function tryFill(attempts) {
      if (attempts <= 0) return;
      const emailInput = document.querySelector('input[type="email"], input[name="username"]')
        || [...document.querySelectorAll('input')].find(i => /email/i.test(i.placeholder || ''));
      const passInput = document.querySelector('input[type="password"]');
      if (!emailInput || !passInput) {
        setTimeout(() => tryFill(attempts - 1), 600);
        return;
      }
      emailInput.focus();
      setReactInput(emailInput, dkEmail);
      setTimeout(() => {
        passInput.focus();
        setReactInput(passInput, dkPassword);
        setTimeout(() => {
          const btn = document.querySelector('button[type="submit"]')
            || [...document.querySelectorAll('button')].find(b => /log.?in/i.test(b.textContent));
          if (btn && !btn.disabled) btn.click();
        }, 500);
      }, 400);
    }

    setTimeout(() => tryFill(10), 1500);
  });
}

// ── Wait for location check to clear, then open mybets ──────────────────────
// DK shows "Checking your location..." overlay after login before the sportsbook loads.
// Poll until it's gone (or 15s timeout), then signal background to open mybets.
if (href.startsWith('https://sportsbook.draftkings.com/') && !href.includes('/mybets') && !href.includes('/login') && !href.includes('/auth/')) {
  chrome.storage.local.get(['dkWaitingForTabs'], ({ dkWaitingForTabs }) => {
    if (!dkWaitingForTabs) return;
    let tries = 0;
    const locPoll = setInterval(() => {
      tries++;
      const bodyText = document.body?.innerText || '';
      const stillChecking = /checking.{0,10}location|verifying.{0,10}location/i.test(bodyText);
      if (!stillChecking || tries >= 15) {
        clearInterval(locPoll);
        chrome.storage.local.set({ dkWaitingForTabs: false });
        send({ type: 'DK_SPORTSBOOK_READY' });
      }
    }, 1000);
  });
}

// ── Persistent logout detection on sportsbook pages ─────────────────────────
// DraftKings is a SPA — logging out re-renders in place with no URL change.
// A one-time observer misses this. Poll every 3s forever instead.
if (href.startsWith('https://sportsbook.draftkings.com') && !href.includes('/login') && !href.includes('/auth/')) {
  let alerted = false;

  function isLoggedOut() {
    const bodyText = document.body?.innerText || '';
    // Multiple indicators — any one is enough
    if (/oops[^a-z]*you'?re logged out/i.test(bodyText)) return true;
    if (/you must be logged in/i.test(bodyText)) return true;
    if ([...document.querySelectorAll('a, button, span')].some(
      el => /sign\s*up\s*or\s*log\s*in/i.test(el.textContent?.trim())
    )) return true;
    return false;
  }

  // Poll every 3 seconds — never stops while page is open
  // This is the only reliable approach for a SPA where logout is a DOM swap, not a navigation
  const logoutPoll = setInterval(() => {
    if (alerted) { clearInterval(logoutPoll); return; }
    if (isLoggedOut()) {
      alerted = true;
      clearInterval(logoutPoll);
      send({ type: 'DK_NEEDS_LOGIN' });
      window.location.href = 'https://myaccount.draftkings.com/auth/login?product=sportsbook&returnPath=https%3A%2F%2Fsportsbook.draftkings.com%2F';
    }
  }, 3000);
}

// ── Auto-refresh My Bets tab every 20 seconds ───────────────────────────────
if (href.includes('/mybets')) {
  setTimeout(() => location.reload(), 20000);
}
