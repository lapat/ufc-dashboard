const DEFAULT_URL = 'https://ufc-dashboard-production-e03d.up.railway.app';

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s/60)}m ago`;
}

function setDot(id, cls) {
  const el = document.getElementById(id);
  el.className = 'dot ' + cls;
}

async function refresh() {
  // Check for active DK tab
  const tabs = await chrome.tabs.query({ url: 'https://*.draftkings.com/*' });
  const hasDK = tabs.length > 0;
  const onMyBets = tabs.some(t => t.url?.includes('/mybets'));
  setDot('tabDot', hasDK ? 'green' : 'red');
  document.getElementById('tabText').textContent = hasDK
    ? (onMyBets ? 'My Bets' : 'Open')
    : 'Not found';

  chrome.storage.local.get(['captures', 'lastSync', 'lastBetCount'], r => {
    const captures = r.captures || [];
    const lastCap = captures[0]?.ts;
    document.getElementById('captureAge').textContent = ago(lastCap);
    document.getElementById('syncAge').textContent = ago(r.lastSync);
    document.getElementById('betCount').textContent = r.lastBetCount != null ? r.lastBetCount : '—';
    renderCaptures(captures);
  });
}

function renderCaptures(captures) {
  const el = document.getElementById('captures');
  if (!captures.length) {
    el.innerHTML = '<div id="empty">Go to DraftKings — API calls will appear here</div>';
    return;
  }
  el.innerHTML = captures.slice(0, 10).map(c => {
    const url = c.url.replace('https://api.draftkings.com','').replace(/https:\/\/[^/]+/,'');
    return `<div class="capture">
      <div class="url">${url}</div>
      <div>${ago(c.ts)} · ${(c.preview||'').slice(0,80)}</div>
    </div>`;
  }).join('');
}

refresh();
setInterval(refresh, 2000);
