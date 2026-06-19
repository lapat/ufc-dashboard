// ── State ────────────────────────────────────────────────────────────────────
let betInFlight    = false;
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

// ── NL intent parser — calls /api/chat, falls back to regex ──────────────────
async function getServerUrl() {
  return new Promise(res => chrome.storage.local.get(['betBotUrl'], r =>
    res(r.betBotUrl || 'https://ufc-dashboard-production-e03d.up.railway.app')
  ));
}

// Regex fallback for when server is unreachable
function parseBetCmdLegacy(raw) {
  const cancel = /^(cancel|stop|abort|quit)$/i.test(raw.trim());
  if (cancel) return { intent: 'cancel', side: null, amount: null, trigger: { type: null, targetOdds: null } };
  const m = raw.trim().match(/^bet\s+(.+?)\s+([\d.]+)$/i);
  if (!m) return { intent: 'unknown', side: null, amount: null, trigger: { type: 'crossover', targetOdds: null } };
  return { intent: 'place_first_bet', side: m[1].trim(), amount: parseFloat(m[2]), trigger: { type: 'crossover', targetOdds: null } };
}

async function parseNLIntent(raw) {
  try {
    const url = await getServerUrl();
    const gameContext = currentOdds.length ? { sides: currentOdds.map(o => ({ side: o.side, oddsText: o.oddsText })) } : null;
    const r = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: raw, gameContext }),
      signal: AbortSignal.timeout(4000)
    });
    if (r.ok) return r.json();
  } catch {}
  return parseBetCmdLegacy(raw);
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

// ── Bet chat (main input handler) ─────────────────────────────────────────────
function initBetChat() {
  const input  = document.getElementById('betCmd');
  const goBtn  = document.getElementById('betGo');
  const stopBtn = document.getElementById('stopBtn');

  async function sendCmd() {
    if (betInFlight) return;
    const raw = input.value.trim();
    if (!raw) return;
    input.value = '';

    chatMsg('YOU', raw, 'you');

    // NL parse
    chatMsg('BOT', 'Parsing…', 'bot');
    const intent = await parseNLIntent(raw);

    // Remove "Parsing…" message
    const log = document.getElementById('chat-log');
    if (log.lastElementChild?.textContent?.includes('Parsing')) log.removeChild(log.lastElementChild);

    if (intent.intent === 'cancel') {
      handleStop();
      return;
    }

    if (intent.intent === 'query') {
      const oddsText = currentOdds.length
        ? currentOdds.map(o => `${o.side} ${o.oddsText}`).join('  ·  ')
        : 'no odds visible on DK tab';
      chatMsg('BOT', `Current: ${oddsText}`, 'bot');
      return;
    }

    if (intent.intent !== 'place_first_bet' || !intent.side || !intent.amount) {
      chatMsg('BOT', `Didn't understand. Try: <b>bet canada 10</b> or <b>bet [player] 0.01, hedge at crossover</b>`, 'err');
      return;
    }

    if (intent.amount < 0.01) { chatMsg('BOT', 'Minimum bet is $0.01', 'err'); return; }

    chatMsg('BOT',
      `Placing <b>$${intent.amount}</b> on <b>${intent.side}</b>` +
      (intent.trigger?.type === 'crossover' ? ' · auto-hedge at crossover' :
       intent.trigger?.type === 'odds_target' ? ` · hedge when odds hit ${intent.trigger.targetOdds}` : '') +
      '…', 'bot');

    betInFlight = true;
    goBtn.disabled = true;

    // Start strategy in background
    chrome.runtime.sendMessage({
      type: 'STRATEGY_START',
      leg1Side: intent.side,
      leg1Amount: intent.amount,
      leg2Side: null,    // auto-determined at crossover from current DK odds
      trigger: intent.trigger || { type: 'crossover', targetOdds: null },
    });

    // Then place the first leg
    chrome.runtime.sendMessage({ type: 'PLACE_BET', side: intent.side, amount: intent.amount });
  }

  goBtn.addEventListener('click', sendCmd);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendCmd(); });
  if (stopBtn) stopBtn.addEventListener('click', handleStop);

  // ── Listen for messages from background ────────────────────────────────────
  chrome.runtime.onMessage.addListener(msg => {

    if (msg.type === 'BET_RESULT') {
      betInFlight = false;
      goBtn.disabled = false;
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
        chatMsg('BOT', `❌ Hedge failed [${why}] — strategy reset. Type a new bet to restart.`, 'err');
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
}

initBetChat();

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

  chrome.storage.local.get(['captures','lastSync','lastBetCount','debugLog','dkUserId','wsConnected','wsLastOpen','wsLastClose','pendingStrategy'], r => {
    if (r.dkUserId) {
      const cur = document.getElementById('tabText').textContent;
      if (!cur.includes('·')) document.getElementById('tabText').textContent = cur + ` · ${r.dkUserId}`;
    }

    // Strategy state badge
    const strat = r.pendingStrategy || { state: 'IDLE' };
    const stratEl = document.getElementById('stratState');
    if (stratEl) {
      const colors = { IDLE:'#333', FIRST_BET_PENDING:'#e8b84b', FIRST_BET_PLACED:'#74c0fc', WATCHING_HEDGE:'#e8b84b', HEDGE_FIRED:'#ff6b6b', BOTH_PLACED:'#69db7c', HEDGE_FAILED:'#ff6b6b' };
      stratEl.textContent = strat.state;
      stratEl.style.color = colors[strat.state] || '#333';
    }

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
