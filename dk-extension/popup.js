const statusEl = document.getElementById('status');
const capturesEl = document.getElementById('captures');

const DEFAULT_URL = 'https://ufc-dashboard-production-e03d.up.railway.app';

chrome.storage.local.get(['betBotUrl', 'captures', 'lastSync', 'lastBetCount'], r => {
  statusEl.textContent = `Connected to Bet Bot`;
  statusEl.className = 'ok';
  renderCaptures(r.captures || []);
});

function renderCaptures(captures) {
  if (!captures.length) return;
  capturesEl.innerHTML = captures.map(c => {
    const ago = Math.round((Date.now() - c.ts) / 1000);
    const agoStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago/60)}m ago`;
    return `<div class="capture">
      <div class="url">${c.url.replace('https://api.draftkings.com','')}</div>
      <div>${agoStr} · ${c.preview.slice(0,80)}...</div>
    </div>`;
  }).join('');
}

// Refresh captures every 2s while popup is open
setInterval(() => {
  chrome.storage.local.get(['captures'], r => renderCaptures(r.captures || []));
}, 2000);
