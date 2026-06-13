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

  chrome.storage.local.get(['captures', 'lastSync', 'lastBetCount', 'debugLog', 'dkUserId'], r => {
    if (r.dkUserId) {
      document.getElementById('tabText').textContent = hasDK
        ? (onMyBets ? `My Bets ✓ · ${r.dkUserId}` : `Open · ${r.dkUserId}`)
        : `Not found · ${r.dkUserId}`;
    }
    const captures = r.captures || [];
    document.getElementById('captureAge').textContent = ago(captures[0]?.ts);
    document.getElementById('syncAge').textContent = ago(r.lastSync);
    document.getElementById('betCount').textContent = r.lastBetCount != null ? r.lastBetCount : '—';
    renderLog(r.debugLog || []);
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
    return `<div class="log-entry">
      <span class="log-ts">${timeStr(e.ts)}</span>
      <span class="log-msg${isBets ? ' bets' : isErr ? ' err' : ''}">${e.msg}</span>
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

document.getElementById('clrLog').addEventListener('click', () => {
  chrome.storage.local.set({ debugLog: [], captures: [] });
});

refresh();
setInterval(refresh, 2000);
