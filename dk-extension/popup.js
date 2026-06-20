// ── State ────────────────────────────────────────────────────────────────────
let currentStrategy = { state: 'IDLE' };
let currentOdds    = [];       // latest ODDS_UPDATE outcomes
let countdownTimer = null;
let countdownLeft  = 0;
let drawnWarned    = false;    // soccer draw warning shown once per strategy

// ── Chat helpers ─────────────────────────────────────────────────────────────
function chatMsg(who, html, cls) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'cm';
  div.innerHTML = `<span class="cm-who ${cls||who}">${who.toUpperCase()}</span><span class="cm-text">${html}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ── Soccer draw exposure warning ──────────────────────────────────────────────
function checkSoccerDrawExposure(outcomes, strategy) {
  if (drawnWarned) return;
  if (!outcomes || outcomes.length < 3) return;
  if (strategy.state !== 'FIRST_BET_PLACED' && strategy.state !== 'WATCHING_HEDGE') return;
  const hasDrawOutcome = outcomes.some(o => /\bdraw\b/i.test(o.side || ''));
  if (!hasDrawOutcome) return;
  drawnWarned = true;
  chatMsg('BOT',
    '⚠️ <b>Soccer game detected — 3 outcomes (Home / Draw / Away).</b><br>' +
    'A 2-leg hedge only covers 2/3 outcomes. <b>Draw is exposed.</b> ' +
    'If the match ends in a draw, both legs lose. Consider a 3-way hedge or accept draw risk.',
    'err');
}

// ── STOP countdown ────────────────────────────────────────────────────────────
function clearCountdown() {
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = null;
  countdownLeft = 0;
  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) stopBtn.style.display = 'none';
  // Remove stale countdown div so "in Xs…" message doesn't linger after hedge fires/cancels
  const cd = document.querySelector('[data-countdown="1"]');
  if (cd) cd.remove();
}

function showCountdown(side, amount, oddsText) {
  countdownLeft = 3;
  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) stopBtn.style.display = 'inline-block';

  function tick() {
    if (countdownLeft <= 0) {
      clearCountdown();
      return;
    }
    // Replace last countdown message or append new one
    const log = document.getElementById('chat-log');
    const last = log.lastElementChild;
    const isCountdown = last && last.dataset.countdown === '1';
    const html = `🤖 Auto-hedging <b>${side}</b> $${amount} ${oddsText} in <b>${countdownLeft}s</b>…`;
    if (isCountdown) {
      last.querySelector('.cm-text').innerHTML = html;
    } else {
      const div = document.createElement('div');
      div.className = 'cm';
      div.dataset.countdown = '1';
      div.innerHTML = `<span class="cm-who bot">BOT</span><span class="cm-text">${html}</span>`;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }
    countdownLeft--;
    countdownTimer = setTimeout(tick, 1000);
  }
  tick();
}

function handleStop() {
  clearCountdown();
  drawnWarned = false;
  chatMsg('BOT', '🛑 Hedge cancelled — watching paused. Strategy reset.', 'err');
  chrome.runtime.sendMessage({ type: 'STRATEGY_CANCEL' });
}

// ── Strategy status listener ──────────────────────────────────────────────────
document.getElementById('stopBtn').addEventListener('click', handleStop);

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'BET_RESULT') {
    if (msg.ok) {
      const confirmed = msg.confirmed ? ' <b>Confirmed ✓</b>' : ' (check DK slip)';
      chatMsg('BOT', `Bet placed: <b>${msg.side}</b> ${msg.oddsText} $${msg.amount}.${confirmed}`, 'ok');
    } else {
      chatMsg('BOT', `Failed [${msg.step||'?'}]: ${msg.error}`, 'err');
    }
  }

  if (msg.type === 'STRATEGY_UPDATE') {
    currentStrategy = msg.strategy || { state: 'IDLE' };
    const s = currentStrategy;
    if (s.state === 'FIRST_BET_PLACED') {
      chatMsg('BOT', `✅ Leg 1 confirmed — watching for crossover on <b>${s.leg1Side}</b>`, 'ok');
      drawnWarned = false;
      checkSoccerDrawExposure(currentOdds, s);
    }
    if (s.state === 'BOTH_PLACED') {
      clearCountdown();
      chatMsg('BOT', `🎯 <b>Both legs placed!</b> Hedge complete — locked profit either way.`, 'ok');
    }
    if (s.state === 'HEDGE_FAILED') {
      clearCountdown();
      const why = s.verifyFailures ? s.verifyFailures.map(c => c.name).join(', ') : 'unknown';
      chatMsg('BOT', `❌ Hedge failed [${why}] — strategy reset.`, 'err');
    }
  }

  if (msg.type === 'HEDGE_COUNTDOWN') {
    showCountdown(msg.side, msg.amount, msg.oddsText || '');
  }

  if (msg.type === 'HEDGE_BLOCKED') {
    clearCountdown();
    const why = (msg.reason || []).map(c => c.name).join(', ');
    chatMsg('BOT', `⛔ Hedge blocked — verify failed: <b>${why}</b>`, 'err');
  }

  if (msg.type === 'ODDS_UPDATE') {
    currentOdds = msg.outcomes || [];
    checkSoccerDrawExposure(currentOdds, currentStrategy);
  }
});

// ── Status polling ────────────────────────────────────────────────────────────
function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s/60)}m ago`;
}

function setDot(id, cls) {
  document.getElementById(id).className = 'dot ' + cls;
}

function timeStr(ts) {
  if (!ts) return '??:??';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function refresh() {
  const tabs = await chrome.tabs.query({ url: 'https://*.draftkings.com/*' });
  const hasDK = tabs.length > 0;
  const onMyBets = tabs.some(t => t.url?.includes('/mybets'));
  setDot('tabDot', hasDK ? 'green' : 'red');
  document.getElementById('tabText').textContent = hasDK
    ? (onMyBets ? 'My Bets ✓' : 'Open (go to mybets)')
    : 'Not found';

  chrome.storage.local.get(['captures','lastSync','lastBetCount','debugLog','dkUserId','wsConnected','wsLastOpen','wsLastClose','pendingStrategy','activeTriggers'], r => {
    if (r.dkUserId) {
      const cur = document.getElementById('tabText').textContent;
      if (!cur.includes('·')) document.getElementById('tabText').textContent = cur + ` · ${r.dkUserId}`;
    }

    // Strategy state badge + detail line
    const strat = r.pendingStrategy || { state: 'IDLE' };
    const stratEl = document.getElementById('stratState');
    const detailEl = document.getElementById('stratDetail');
    if (stratEl) {
      const colors = { IDLE:'#333', FIRST_BET_PENDING:'#e8b84b', FIRST_BET_PLACED:'#74c0fc', WATCHING_HEDGE:'#e8b84b', HEDGE_FIRED:'#ff6b6b', BOTH_PLACED:'#69db7c', HEDGE_FAILED:'#ff6b6b' };
      stratEl.textContent = strat.state;
      stratEl.style.color = colors[strat.state] || '#333';
    }
    if (detailEl) {
      if (!strat.state || strat.state === 'IDLE') {
        detailEl.textContent = '';
      } else {
        const parts = [];
        if (strat.leg1Side)   parts.push(strat.leg1Side);
        if (strat.leg1Amount) parts.push(`$${strat.leg1Amount}`);
        if (strat.leg1Odds)   parts.push(`@ ${strat.leg1Odds}`);
        if (strat.hedgeAmount) parts.push(`→ hedge $${strat.hedgeAmount}`);
        if (strat.expiresAt) {
          const msLeft = Math.max(0, strat.expiresAt - Date.now());
          const h = Math.floor(msLeft / 3600000), m = Math.floor((msLeft % 3600000) / 60000);
          parts.push(`(${h}h ${m}m left)`);
        }
        detailEl.textContent = parts.join(' · ');
      }
    }

    // Active triggers list
    renderTriggers(r.activeTriggers || []);

    const wsConnected = r.wsConnected;
    setDot('wsDot', wsConnected === true ? 'green' : wsConnected === false ? 'red' : 'yellow');
    document.getElementById('wsText').textContent = wsConnected === true ? 'Connected'
      : wsConnected === false ? 'Dropped — reconnecting' : (hasDK && onMyBets ? 'Waiting for DK…' : 'No DK tab');

    const syncAge = r.lastSync ? Date.now() - r.lastSync : Infinity;
    const syncEl = document.getElementById('syncAge');
    syncEl.textContent = ago(r.lastSync);
    syncEl.style.color = syncAge < 120000 ? '#69db7c' : syncAge < 600000 ? '#e8b84b' : '#ff6b6b';

    document.getElementById('betCount').textContent = r.lastBetCount != null ? r.lastBetCount : '—';
    renderLog(r.debugLog || []);
    renderCaptures(r.captures || []);
  });
}

function renderLog(log) {
  const el = document.getElementById('debugLog');
  if (!log.length) { el.innerHTML = '<div style="color:#252525;font-size:0.65rem;padding:4px 0">No events yet</div>'; return; }
  el.innerHTML = log.slice(0, 15).map(e => {
    const isBets = e.msg.includes('bets') || e.msg.includes('BETS');
    const isErr = e.msg.includes('✗') || e.msg.includes('error');
    const isWs = e.msg.startsWith('WS:');
    return `<div class="log-entry"><span class="log-ts">${timeStr(e.ts)}</span><span class="log-msg${isBets?' bets':isErr?' err':isWs?' ws':''}">${e.msg}</span></div>`;
  }).join('');
}

function renderCaptures(captures) {
  const el = document.getElementById('captures');
  if (!captures.length) { el.innerHTML = '<div id="empty">Go to DraftKings mybets — data will appear here</div>'; return; }
  el.innerHTML = captures.slice(0, 8).map(c => {
    const url = c.url.replace(/https?:\/\/[^/]+/, '').slice(0, 60);
    return `<div class="capture${c.isBets?' bets':''}"><div class="url">${url}</div><div class="preview${c.isBets?' bets':''}">${ago(c.ts)} · ${(c.preview||'').slice(0,80)}</div></div>`;
  }).join('');
}

function renderTriggers(triggers) {
  const section = document.getElementById('triggers-section');
  const list = document.getElementById('triggersList');
  const count = document.getElementById('triggerCount');
  if (!section || !list) return;
  if (!triggers.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  count.textContent = `(${triggers.length})`;
  list.innerHTML = triggers.map(t => {
    const side = t.side || '?';
    const amt  = t.amount ? `$${t.amount}` : '';
    const odds = t.targetOdds ? `@ ${t.targetOdds > 0 ? '+' : ''}${t.targetOdds}` : '';
    const type = t.type === 'score_tie' ? '🔄 score tie' : '📈 odds';
    const desc = [type, side, amt, odds].filter(Boolean).join(' ');
    const msLeft = t.expiresAt ? Math.max(0, t.expiresAt - Date.now()) : null;
    const timeLeft = msLeft != null ? `${Math.floor(msLeft/3600000)}h ${Math.floor((msLeft%3600000)/60000)}m` : '';
    return `<div class="trigger-row">
      <span class="trigger-desc" title="${desc}">${desc}</span>
      <span class="trigger-time">${timeLeft}</span>
      <button class="trigger-cancel" data-id="${t.id}">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.trigger-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'CANCEL_TRIGGER', triggerId: btn.dataset.id });
    });
  });
}

// Cancel-all triggers
document.getElementById('clrTriggers').addEventListener('click', () => {
  chrome.storage.local.get(['activeTriggers'], r => {
    for (const t of (r.activeTriggers || [])) {
      chrome.runtime.sendMessage({ type: 'CANCEL_TRIGGER', triggerId: t.id });
    }
  });
});

// Username + credentials setup
chrome.storage.local.get(['dkUserId'], r => { if (r.dkUserId) document.getElementById('userInput').value = r.dkUserId; });
document.getElementById('saveUser').addEventListener('click', () => {
  const val = document.getElementById('userInput').value.trim();
  if (!val) return;
  chrome.storage.local.set({ dkUserId: val });
  const btn = document.getElementById('saveUser');
  btn.textContent = 'Saved ✓'; btn.className = 'saved';
  setTimeout(() => { btn.textContent = 'Set'; btn.className = ''; }, 2000);
});

chrome.storage.local.get(['botToken'], r => {
  if (r.botToken) document.getElementById('botToken').value = r.botToken;
});
document.getElementById('saveToken').addEventListener('click', () => {
  const val = document.getElementById('botToken').value.trim();
  if (!val) return;
  chrome.storage.local.set({ botToken: val });
  const btn = document.getElementById('saveToken');
  btn.textContent = 'Saved ✓'; btn.className = 'saved';
  setTimeout(() => { btn.textContent = 'Set'; btn.className = ''; }, 2000);
});

chrome.storage.local.get(['dkEmail','dkPassword','dkAutoLogin'], r => {
  if (r.dkEmail) document.getElementById('dkEmail').value = r.dkEmail;
  if (r.dkPassword) document.getElementById('dkPassword').value = r.dkPassword;
  document.getElementById('dkAutoLogin').checked = !!r.dkAutoLogin;
});
document.getElementById('saveCreds').addEventListener('click', () => {
  const email = document.getElementById('dkEmail').value.trim();
  const pass = document.getElementById('dkPassword').value;
  const auto = document.getElementById('dkAutoLogin').checked;
  if (!email || !pass) return;
  chrome.storage.local.set({ dkEmail: email, dkPassword: pass, dkAutoLogin: auto });
  const btn = document.getElementById('saveCreds');
  btn.textContent = 'Saved ✓'; btn.className = 'saved';
  setTimeout(() => { btn.textContent = 'Save'; btn.className = ''; }, 2000);
});
document.getElementById('dkAutoLogin').addEventListener('change', e => chrome.storage.local.set({ dkAutoLogin: e.target.checked }));
document.getElementById('clrLog').addEventListener('click', () => {
  chrome.storage.local.set({ debugLog: [], captures: [], wsConnected: null, wsLastOpen: null, wsLastClose: null });
});

refresh();
setInterval(refresh, 2000);
