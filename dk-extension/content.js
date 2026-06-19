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
      // Background picks the leftmost DK tab to redirect — don't navigate directly here
      send({ type: 'DK_NEEDS_LOGIN' });
    }
  }, 3000);
}

// ── Auto-refresh My Bets tab every 20 seconds ───────────────────────────────
if (href.includes('/mybets')) {
  setTimeout(() => location.reload(), 20000);
}

// ── Live odds watcher — 1s DOM poll for crossover detection ─────────────────
// Runs on any DK sportsbook page (not mybets/login). Sends ODDS_UPDATE every
// second and CROSSOVER_DETECTED when the underdog's implied prob surpasses the
// favorite's — which is the primary hedge trigger.

if (href.startsWith('https://sportsbook.draftkings.com/') &&
    !href.includes('/mybets') && !href.includes('/login') && !href.includes('/auth/')) {

  // American odds → implied probability (no vig removal — raw market implied)
  function americanToImplied(american) {
    if (american > 0) return 100 / (american + 100);
    return Math.abs(american) / (Math.abs(american) + 100);
  }

  // Parse odds text that may use Unicode minus (−) instead of hyphen-minus (-)
  function parseAmericanOdds(text) {
    const n = parseInt(text.replace(/[−–]/g, '-'), 10);
    return isNaN(n) ? null : n;
  }

  // Walk the DOM to find the player/team name nearest to an odds button
  function findSideNameNear(btn) {
    let ancestor = btn.parentElement;
    for (let i = 0; i < 8 && ancestor; i++) {
      const nameEl = [...ancestor.querySelectorAll('*')].find(el =>
        el.childElementCount === 0 &&
        el.textContent.trim().length > 1 &&
        !/^[+−\-]\d+(\.\d+)?$/.test(el.textContent.trim()) &&
        !/^\d+$/.test(el.textContent.trim()) &&
        el.closest('button, [role="button"]') === null
      );
      if (nameEl) return nameEl.textContent.trim();
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function scanOddsFromPage() {
    return [...document.querySelectorAll('button, [role="button"]')]
      .flatMap(btn => {
        // Try full button text first (flat odds-only button)
        const full = btn.textContent.trim();
        if (/^[+−\-]\d+$/.test(full)) return [{ btn, oddsText: full }];
        // DK often renders <button><span>Team</span><span>-350</span></button>
        // In that case full text is "Team-350" — find the child span that is purely odds
        const oddsSpan = [...btn.querySelectorAll('*')].find(
          el => el.childElementCount === 0 && /^[+−\-]\d+$/.test(el.textContent.trim())
        );
        if (oddsSpan) return [{ btn, oddsText: oddsSpan.textContent.trim() }];
        return [];
      })
      .map(({ btn, oddsText }) => {
        const american = parseAmericanOdds(oddsText);
        if (american === null) return null;
        return {
          side:    findSideNameNear(btn),
          american,
          oddsText,
          implied: americanToImplied(american),
        };
      })
      .filter(Boolean);
  }

  // watchedSides is set by background.js via WATCH_SIDES message when a strategy starts
  let watchedSides = null;
  let lastCrossover = null; // true/false — only fire on CHANGE to avoid spam

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'WATCH_SIDES') {
      watchedSides = { leg1Side: msg.leg1Side, leg2Side: msg.leg2Side };
      lastCrossover = null; // reset on new strategy
    }
    if (msg.type === 'STOP_WATCHING') {
      watchedSides = null;
      lastCrossover = null;
    }
  });

  // Poll server every 5s for bet commands typed in the dashboard chat
  chrome.storage.local.get(['betBotUrl'], ({ betBotUrl }) => {
    const serverUrl = (betBotUrl || 'https://ufc-dashboard-production-e03d.up.railway.app').replace(/\/$/, '');
    setInterval(async () => {
      try {
        const r = await fetch(`${serverUrl}/api/pending-commands`);
        if (!r.ok) return;
        const { command } = await r.json();
        if (command) send({ type: 'EXECUTE_COMMAND', command });
      } catch {}
    }, 5000);
  });

  setInterval(() => {
    const outcomes = scanOddsFromPage();
    if (outcomes.length === 0) return;

    // Always report current odds so background + popup can display them
    send({ type: 'ODDS_UPDATE', outcomes, ts: Date.now() });

    // Crossover check only when a strategy is active
    if (!watchedSides) return;
    const sL = s => (s || '').toLowerCase();
    const leg1 = outcomes.find(o => sL(o.side) === sL(watchedSides.leg1Side));
    const leg2 = outcomes.find(o => sL(o.side) === sL(watchedSides.leg2Side));
    if (!leg1 || !leg2) return;

    // Crossover = hedge side's implied prob has reached/passed the original side's implied prob
    const crossed = leg2.implied >= leg1.implied;
    if (crossed !== lastCrossover) {
      lastCrossover = crossed;
      if (crossed) {
        send({ type: 'CROSSOVER_DETECTED', leg1, leg2, ts: Date.now() });
      }
    }
  }, 1000);
}
