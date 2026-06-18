// ── Chat / bet placement ────────────────────────────────────────────────────
function chatMsg(who, html, cls) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'cm';
  div.innerHTML = `<span class="cm-who ${cls||who}">${who.toUpperCase()}</span><span class="cm-text">${html}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function parseBetCmd(raw) {
  // "bet canada 0.01"  "bet draw 5"  "bet away 10"  "bet home 2.50"
  const m = raw.trim().match(/^bet\s+(.+?)\s+([\d.]+)$/i);
  if (!m) return null;
  return { side: m[1].trim(), amount: parseFloat(m[2]) };
}

let betInFlight = false;

function initBetChat() {
  const input = document.getElementById('betCmd');
  const goBtn = document.getElementById('betGo');

  function sendBet() {
    if (betInFlight) return;
    const raw = input.value.trim();
    if (!raw) return;
    const parsed = parseBetCmd(raw);
    if (!parsed) {
      chatMsg('BOT', `Didn't understand. Try: <b>bet canada 0.01</b> or <b>bet draw 0.01</b>`, 'err');
      return;
    }
    if (parsed.amount < 0.01) { chatMsg('BOT', 'Minimum $0.01', 'err'); return; }

    chatMsg('YOU', `${parsed.side} — $${parsed.amount}`, 'you');
    chatMsg('BOT', `Finding <b>${parsed.side}</b> button on DK tab…`, 'bot');
    betInFlight = true;
    goBtn.disabled = true;
    input.value = '';

    chrome.runtime.sendMessage({ type: 'PLACE_BET', side: parsed.side, amount: parsed.amount });
  }

  goBtn.addEventListener('click', sendBet);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendBet(); });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type !== 'BET_RESULT') return;
    betInFlight = false;
    goBtn.disabled = false;
    if (msg.ok) {
      const confirmed = msg.confirmed ? ' <b>Confirmed in slip ✓</b>' : ' (check DK for confirmation)';
      chatMsg('BOT', `Bet placed: <b>${msg.side}</b> ${msg.oddsText} for $${msg.amount}.${confirmed}`, 'ok');
    } else {
      chatMsg('BOT', `Failed [${msg.step||'?'}]: ${msg.error}`, 'err');
    }
  });
}

initBetChat();

// ── Status polling ──────────────────────────────────────────────────────────
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
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function refresh() {
  const tabs = await chrome.tabs.query({ url: 'https://*.draftkings.com/*' });
  const hasDK = tabs.length > 0;
  const onMyBets = tabs.some(t => t.url?.includes('/mybets'));
  setDot('tabDot', hasDK ? 'green' : 'red');
  document.getElementById('tabText').textContent = hasDK
    ? (onMyBets ? 'My Bets ✓' : 'Open (go to mybets)')
    : 'Not found';

  chrome.storage.local.get(['captures', 'lastSync', 'lastBetCount', 'debugLog', 'dkUserId', 'wsConnected', 'wsLastOpen', 'wsLastClose'], r => {
    // Show detected username
    if (r.dkUserId) {
      const current = document.getElementById('tabText').textContent;
      if (!current.includes('·')) {
        document.getElementById('tabText').textContent = current + ` · ${r.dkUserId}`;
      }
    }

    // WS connection status
    const wsConnected = r.wsConnected;
    let wsDotCls, wsLabel;
    if (wsConnected === true) {
      wsDotCls = 'green';
      wsLabel = 'Connected';
    } else if (wsConnected === false) {
      wsDotCls = 'red';
      wsLabel = r.wsLastClose ? `Dropped — reconnecting` : 'Disconnected';
    } else {
      wsDotCls = 'yellow';
      wsLabel = hasDK && onMyBets ? 'Waiting for DK…' : 'No DK tab';
    }
    setDot('wsDot', wsDotCls);
    document.getElementById('wsText').textContent = wsLabel;

    // Last sync with age-based coloring
    const syncAge = r.lastSync ? Date.now() - r.lastSync : Infinity;
    const syncEl = document.getElementById('syncAge');
    syncEl.textContent = ago(r.lastSync);
    syncEl.style.color = syncAge < 120000 ? '#69db7c' : syncAge < 600000 ? '#e8b84b' : '#ff6b6b';

    document.getElementById('betCount').textContent = r.lastBetCount != null ? r.lastBetCount : '—';

    renderLog(r.debugLog || []);
    const captures = r.captures || [];
    renderCaptures(captures);
  });
}

function renderLog(log) {
  const el = document.getElementById('debugLog');
  if (!log.length) {
    el.innerHTML = '<div style="color:#252525;font-size:0.65rem;padding:4px 0">No events yet — reload extension then refresh DK tab</div>';
    return;
  }
  el.innerHTML = log.slice(0, 15).map(e => {
    const isBets = e.msg.includes('bets') || e.msg.includes('BETS');
    const isErr = e.msg.includes('✗') || e.msg.includes('error');
    const isWs = e.msg.startsWith('WS:');
    return `<div class="log-entry">
      <span class="log-ts">${timeStr(e.ts)}</span>
      <span class="log-msg${isBets ? ' bets' : isErr ? ' err' : isWs ? ' ws' : ''}">${e.msg}</span>
    </div>`;
  }).join('');
}

function renderCaptures(captures) {
  const el = document.getElementById('captures');
  if (!captures.length) {
    el.innerHTML = '<div id="empty">Go to DraftKings mybets — data will appear here</div>';
    return;
  }
  el.innerHTML = captures.slice(0, 8).map(c => {
    const url = c.url.replace(/https?:\/\/[^/]+/, '').slice(0, 60);
    const isBets = c.isBets;
    return `<div class="capture${isBets ? ' bets' : ''}">
      <div class="url">${url}</div>
      <div class="preview${isBets ? ' bets' : ''}">${ago(c.ts)} · ${(c.preview || '').slice(0, 80)}</div>
    </div>`;
  }).join('');
}

// Username setup
chrome.storage.local.get(['dkUserId'], r => {
  if (r.dkUserId) document.getElementById('userInput').value = r.dkUserId;
});

document.getElementById('saveUser').addEventListener('click', () => {
  const val = document.getElementById('userInput').value.trim();
  if (!val) return;
  chrome.storage.local.set({ dkUserId: val });
  const btn = document.getElementById('saveUser');
  btn.textContent = 'Saved ✓';
  btn.className = 'saved';
  setTimeout(() => { btn.textContent = 'Set'; btn.className = ''; }, 2000);
});

// Auto-login credentials
chrome.storage.local.get(['dkEmail', 'dkPassword', 'dkAutoLogin'], r => {
  if (r.dkEmail) document.getElementById('dkEmail').value = r.dkEmail;
  if (r.dkPassword) document.getElementById('dkPassword').value = r.dkPassword;
  document.getElementById('dkAutoLogin').checked = !!r.dkAutoLogin;
});

document.getElementById('saveCreds').addEventListener('click', () => {
  const email = document.getElementById('dkEmail').value.trim();
  const pass = document.getElementById('dkPassword').value;
  const autoLogin = document.getElementById('dkAutoLogin').checked;
  if (!email || !pass) return;
  chrome.storage.local.set({ dkEmail: email, dkPassword: pass, dkAutoLogin: autoLogin });
  const btn = document.getElementById('saveCreds');
  btn.textContent = 'Saved ✓';
  btn.className = 'saved';
  setTimeout(() => { btn.textContent = 'Save'; btn.className = ''; }, 2000);
});

document.getElementById('dkAutoLogin').addEventListener('change', e => {
  chrome.storage.local.set({ dkAutoLogin: e.target.checked });
});

document.getElementById('clrLog').addEventListener('click', () => {
  chrome.storage.local.set({ debugLog: [], captures: [], wsConnected: null, wsLastOpen: null, wsLastClose: null });
});

refresh();
setInterval(refresh, 2000);
