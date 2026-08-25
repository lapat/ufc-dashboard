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

  chrome.storage.local.get(['captures','lastSync','lastBetCount','debugLog','dkUserId','wsConnected','wsLastOpen','wsLastClose','lastSeenFight','manualLiveUntil'], r => {
    if (r.dkUserId) {
      const cur = document.getElementById('tabText').textContent;
      if (!cur.includes('·')) document.getElementById('tabText').textContent = cur + ` · ${r.dkUserId}`;
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
    renderCapturePanel(r.lastSeenFight, r.manualLiveUntil || 0);
  });
}

function fmtOdds(n) {
  if (typeof n !== 'number' || isNaN(n)) return '?';
  return n > 0 ? `+${n}` : `${n}`;
}

function renderCapturePanel(fight, manualLiveUntil) {
  const badge  = document.getElementById('capture-live-badge');
  const nameEl = document.getElementById('capture-fight');
  const oddsEl = document.getElementById('capture-odds');
  const manualActive = Date.now() < manualLiveUntil;

  // Stale snapshot (no odds seen in the last 10s) — DK tab probably closed/navigated away
  const fresh = fight && (Date.now() - fight.ts) < 10000;

  if (!fresh) {
    nameEl.textContent = 'No fight page open';
    oddsEl.textContent = '';
    badge.textContent = '—';
    badge.className = '';
  } else {
    nameEl.textContent = `${fight.fighter1} vs ${fight.fighter2}`;
    oddsEl.textContent = `${fmtOdds(fight.odds1)}  /  ${fmtOdds(fight.odds2)}`;
    if (fight.live && manualActive) { badge.textContent = 'LIVE (manual)'; badge.className = 'manual'; }
    else if (fight.live)            { badge.textContent = 'LIVE';          badge.className = 'live'; }
    else                             { badge.textContent = 'not live';      badge.className = ''; }
  }

  const row = document.getElementById('manualLiveRow');
  if (manualActive) {
    row.style.display = 'block';
    const minsLeft = Math.max(0, Math.round((manualLiveUntil - Date.now()) / 60000));
    document.getElementById('manualLiveCountdown').textContent = `${minsLeft}m left`;
  } else {
    row.style.display = 'none';
  }
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

// Username setup
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

document.getElementById('fightStartedBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SET_MANUAL_LIVE' });
  refresh();
});
document.getElementById('cancelManualLive').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_MANUAL_LIVE' });
  refresh();
});

refresh();
setInterval(refresh, 2000);
