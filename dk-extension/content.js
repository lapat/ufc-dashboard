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

  // Junk text on DK cards that is definitely NOT a fighter name
  const JUNK_NAME_REGEX = /placed this bet|same game parlay|cash out|popular|boost|sgp|live|round|\d+\.?\d*k?\s*people/i;

  // Walk the DOM to find the player/team name nearest to an odds button
  // Walk the DOM to find the player/team name nearest to an odds button
  function findSideNameNear(btn) {
    // 1. Try button aria-label (e.g. "Tainara Lisboa -140" or "Lucia Szabova +120")
    const aria = btn.getAttribute("aria-label") || "";
    if (aria) {
      const m = aria.match(/^(.+?)\s+[+−\-]\d+$/);
      if (m && m[1] && !JUNK_NAME_REGEX.test(m[1].trim())) return m[1].trim();
    }

    // 2. Try finding nearest outcome label cell
    const outcomeLabel = btn.closest(".sportsbook-outcome-cell, [class*=\"outcome-cell\"]")?.querySelector(".sportsbook-outcome-cell__label, [class*=\"outcome-cell__label\"]");
    if (outcomeLabel && outcomeLabel.textContent.trim()) {
      const t = outcomeLabel.textContent.trim();
      if (!JUNK_NAME_REGEX.test(t)) return t;
    }

    // 3. Try previous siblings within the cell/card
    let sib = btn.previousElementSibling;
    while (sib) {
      if (!sib.querySelector("button") && sib.tagName !== "BUTTON") {
        const text = sib.textContent.trim();
        if (text.length > 2 && !/^[+−\-]\d+$/.test(text) && !JUNK_NAME_REGEX.test(text)) return text;
      }
      sib = sib.previousElementSibling;
    }

    // 4. Try outcome row name element
    const outcomeRow = btn.closest("tr, [role=\"row\"], .sportsbook-table__row, [class*=\"event-cell\"]");
    if (outcomeRow) {
      const rowName = outcomeRow.querySelector(".sportsbook-row-name, [class*=\"row-name\"], [class*=\"player-name\"], [class*=\"team-name\"]");
      if (rowName && !JUNK_NAME_REGEX.test(rowName.textContent.trim())) return rowName.textContent.trim();
    }

    // 5. Fall back to shallow parent search with junk filtering (max 3 levels up)
    let ancestor = btn.parentElement;
    for (let i = 0; i < 3 && ancestor; i++) {
      const nameEl = [...ancestor.querySelectorAll("*")].find(el =>
        el.childElementCount === 0 &&
        el.textContent.trim().length > 1 &&
        !/^[+−\-]\d+(\.\d+)?$/.test(el.textContent.trim()) &&
        !/^\d+$/.test(el.textContent.trim()) &&
        !JUNK_NAME_REGEX.test(el.textContent.trim()) &&
        el.closest("button, [role=\"button\"]") === null
      );
      if (nameEl) return nameEl.textContent.trim();
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function scanOddsFromPage() {
    let rootEl = document;
    const isLeagueCardPage = window.location.href.includes("/leagues/mma") || window.location.href.includes("/sports/mma");
    if (isLeagueCardPage) {
      const liveBadge = findLiveBadge();
      if (liveBadge) {
        const liveContainer = liveBadge.closest(".sportsbook-event-accordion__children, .sportsbook-table, [class*=\"event-card\"], [class*=\"event-cell\"], tr, [role=\"row\"]")
          || liveBadge.parentElement?.parentElement?.parentElement;
        if (liveContainer) rootEl = liveContainer;
      }
    }

    const raw = [...rootEl.querySelectorAll("button, [role=\"button\"]")]
      .flatMap(btn => {
        const full = btn.textContent.trim();
        if (/^[+−\-]\d+$/.test(full)) return [{ btn, oddsText: full }];
        const oddsSpan = [...btn.querySelectorAll("*")].find(
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

    // CRITICAL: Self-Fight Disambiguation & Prevention
    if (raw.length >= 2) {
      const s0 = (raw[0].side || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const s1 = (raw[1].side || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (s0 === s1 || !raw[0].side || !raw[1].side) {
        const header = document.querySelector("h1, [class*=\"event-header\"], [class*=\"matchup-header\"], [class*=\"event-cell__title\"]")?.textContent || document.title || "";
        const vsMatch = header.match(/([a-zA-Z\s.'-]+?)\s+(?:vs\.?|v)\s+([a-zA-Z\s.'-]+)/i);
        if (vsMatch && vsMatch[1].trim() && vsMatch[2].trim()) {
          const h1 = vsMatch[1].trim();
          const h2 = vsMatch[2].trim();
          if (h1.toLowerCase().replace(/[^a-z0-9]/g, "") !== h2.toLowerCase().replace(/[^a-z0-9]/g, "")) {
            raw[0].side = h1;
            raw[1].side = h2;
          }
        }
      }
      const f0 = (raw[0].side || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const f1 = (raw[1].side || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (f0 === f1) return [];
    }

    return raw;
  }

  // ── Robust Live-Fight Detection (Is the fight actually in progress?) ──
  function findLiveBadge() {
    const liveSelectors = [
      "[data-testid*=\"live\"]",
      ".sportsbook-live-badge",
      "[class*=\"live-badge\"]",
      "[class*=\"live-indicator\"]",
      ".sportsbook-event-accordion__status--live",
      "[class*=\"in-game\"]",
      "[class*=\"in-play\"]"
    ];
    for (const sel of liveSelectors) {
      const el = document.querySelector(sel);
      if (el && (el.offsetParent !== null || el.textContent.trim().length > 0)) {
        if (/live/i.test(el.textContent.trim())) return el;
      }
    }
    const candidates = [...document.querySelectorAll("span, div, p, em, b, strong")];
    return candidates.find(el => {
      if (el.childElementCount > 0) return false;
      const t = el.textContent.trim();
      if (!t || t.length > 18) return false;
      return /^live$/i.test(t) ||
             /^(rd|round)\s*[1-5]/i.test(t) ||
             /^(end\s+of\s+rd|end\s+of\s+round)\s*[1-5]/i.test(t) ||
             /^[1-5]\s*(st|nd|rd|th)\s*round/i.test(t) ||
             /^\d{1,2}:\d{2}$/.test(t);
    }) || null;
  }

  let _manualLiveUntil = 0;
  chrome.storage.local.get(['manualLiveUntil'], r => { _manualLiveUntil = r.manualLiveUntil || 0; });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.manualLiveUntil) _manualLiveUntil = changes.manualLiveUntil.newValue || 0;
  });

  let _lastLiveLogTs = 0;
  // Scan health, reported to the background every 30 s so silent drops show up in the logs.
  const scanStats = { scans: 0, withOdds: 0, noOdds: 0, noTwoTeams: 0, sent: 0 };
  setInterval(() => {
    scanStats.scans++;
    const outcomes = scanOddsFromPage();
    if (outcomes.length === 0) { scanStats.noOdds++; return; }
    scanStats.withOdds++;
    if (outcomes.filter(o => o.side).length < 2) scanStats.noTwoTeams++;
    scanStats.sent++;

    // Detect sport from URL or page context for server-side recording
    const bodyText = document.body?.innerText || '';
    const pageTitle = document.title || '';
    const isUfcContext = href.includes('/mma') || href.includes('/ufc') ||
      (href.includes('/event/') && (
        /mma|ufc/i.test(pageTitle) ||
        /(round|rd)\s*\d/i.test(bodyText) ||
        /mma|ufc/i.test(bodyText.slice(0, 3000))
      ));

    const sport = href.includes('/soccer') ? 'soccer_fifa_world_cup'
      : isUfcContext ? 'mma_mixed_martial_arts'
      : href.includes('/basketball') ? 'basketball_nba'
      : href.includes('/hockey') || href.includes('/nhl') ? 'icehockey_nhl'
      : href.includes('/football') || href.includes('/nfl') ? 'americanfootball_nfl'
      : href.includes('/baseball') || href.includes('/mlb') ? 'baseball_mlb'
      : 'unknown';

    const liveBadge = findLiveBadge();
    const manualLive = Date.now() < _manualLiveUntil;
    const live = !!liveBadge || manualLive;
    // Log once every 30s (not every 1s) so this is checkable in the console without spam
    if (Date.now() - _lastLiveLogTs > 30000) {
      _lastLiveLogTs = Date.now();
      const why = liveBadge ? `badge FOUND ("${liveBadge.textContent.trim()}")` : manualLive ? 'manual override active' : 'not found';
      console.log(`[BetBot] live check: ${why} — ext capture ${live ? 'will' : 'will NOT'} fire`);
    }

    // Always report current odds so background + popup can display them
    send({ type: 'ODDS_UPDATE', outcomes, sport, live, ts: Date.now() });
  }, 1000);
  setInterval(() => {
    chrome.runtime.sendMessage({ type: 'SCAN_STATS', href, stats: { ...scanStats }, ts: Date.now() }).catch(() => {});
    for (const k of Object.keys(scanStats)) scanStats[k] = 0;
  }, 30000);
}

// ── 1-Click Bet Slip Pre-fill Execution ─────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'EXECUTE_PREFILL') {
    executePrefillOnDraftKings(msg.fighter, msg.stake, msg.odds);
  }
});

function executePrefillOnDraftKings(fighterName, stake, odds) {
  if (!fighterName) return;
  const nTarget = (fighterName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const outcomes = scanOddsFromPage();
  const match = outcomes.find(o => {
    const nSide = (o.side || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return nSide.includes(nTarget) || nTarget.includes(nSide);
  });
  if (match && match.btn) {
    match.btn.click();
    setTimeout(() => {
      const inputs = [...document.querySelectorAll('input')];
      const stakeInput = inputs.find(i =>
        i.classList.contains('sportsbook-wager-input') ||
        /stake|wager|amount/i.test(i.getAttribute('aria-label') || '') ||
        /stake|wager/i.test(i.name || '') ||
        /0\.00|$0/i.test(i.placeholder || '')
      );
      if (stakeInput) {
        stakeInput.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(stakeInput, String(stake));
        stakeInput.dispatchEvent(new Event('input', { bubbles: true }));
        stakeInput.dispatchEvent(new Event('change', { bubbles: true }));
        const placeBtn = [...document.querySelectorAll('button')].find(b =>
          /place bet|place wager/i.test(b.textContent || '')
        );
        if (placeBtn) {
          placeBtn.style.outline = '3px solid #69db7c';
          placeBtn.focus();
        }
      }
    }, 400);
  }
}
