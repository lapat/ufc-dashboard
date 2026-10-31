'use strict';

const TAG_CATALOG = [
  { id: 'heavy_wrestler',   short: '🤼 Wrestler' },
  { id: 'takedown_defense', short: '🛡️ TD Def' },
  { id: 'striking_power',   short: '💥 Power' },
  { id: 'efficient_striker',short: '🥊 Striker' },
  { id: 'older',            short: '⏳ Older' },
  { id: 'size_advantage',   short: '📏 Size' },
  { id: 'cardio_machine',   short: '🔋 Cardio' },
  { id: 'gas_tank_risk',    short: '⚠️ Bad Tank' }
];

let _activeFightKey = '';
let _currentStats = null;

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return 'Idle';
}

function setDot(id, cls) {
  const el = document.getElementById(id);
  if (el) el.className = 'dot ' + cls;
}

function timeStr(ts) {
  if (!ts) return '??:??';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtOdds(n) {
  if (typeof n !== 'number' || isNaN(n)) return '?';
  return n > 0 ? `+${n}` : `${n}`;
}

async function refresh() {
  const tabs = await chrome.tabs.query({ url: 'https://*.draftkings.com/*' });
  const hasDK = tabs.length > 0;
  const onMyBets = tabs.some(t => t.url?.includes('/mybets'));
  const onOdds = tabs.some(t => !t.url?.includes('/mybets'));

  // Health Pill in Header
  const healthPill = document.getElementById('health-pill');
  if (onMyBets && onOdds) {
    healthPill.className = 'ready';
    healthPill.textContent = '🟢 2 Tabs Ready';
  } else if (hasDK) {
    healthPill.className = 'warn';
    healthPill.textContent = onMyBets ? '🟡 Need UFC Odds Tab' : '🟡 Need My Bets Tab';
  } else {
    healthPill.className = 'idle';
    healthPill.textContent = '🔴 Tabs Offline';
  }

  setDot('tabDot', hasDK ? 'green' : 'red');
  document.getElementById('tabText').textContent = hasDK
    ? (onMyBets ? 'My Bets ✓' : 'Odds only (need mybets)')
    : 'Not found';

  chrome.storage.local.get(['captures','lastSync','lastBetCount','debugLog','dkUserId','wsConnected','lastSeenFight','manualLiveUntil'], r => {
    if (r.dkUserId) {
      const cur = document.getElementById('tabText').textContent;
      if (!cur.includes('·')) document.getElementById('tabText').textContent = cur + ` · ${r.dkUserId}`;
    }

    const wsConnected = r.wsConnected;
    setDot('wsDot', wsConnected === true ? 'green' : wsConnected === false ? 'red' : 'yellow');
    document.getElementById('wsText').textContent = wsConnected === true ? 'Connected'
      : wsConnected === false ? 'Reconnecting' : (hasDK && onMyBets ? 'Waiting for DK…' : 'No DK tab');

    const syncAge = r.lastSync ? Date.now() - r.lastSync : Infinity;
    const syncEl = document.getElementById('syncAge');
    syncEl.textContent = ago(r.lastSync);
    syncEl.style.color = syncAge < 120000 ? '#69db7c' : syncAge < 3600000 ? '#aaa' : '#666';

    document.getElementById('betCount').textContent = r.lastBetCount != null ? r.lastBetCount : '—';
    renderLog(r.debugLog || []);
    renderCapturePanel(r.lastSeenFight, r.manualLiveUntil || 0);
  });
}

async function renderCapturePanel(fight, manualLiveUntil) {
  const badge  = document.getElementById('capture-live-badge');
  const nameEl = document.getElementById('capture-fight');
  const oddsEl = document.getElementById('capture-odds');
  const taggerWrap = document.getElementById('ext-tagger-wrap');
  const manualActive = Date.now() < manualLiveUntil;

  // Stale snapshot check (15s)
  const fresh = fight && (Date.now() - fight.ts) < 15000;

  if (!fresh) {
    nameEl.textContent = 'No fight page open';
    oddsEl.textContent = 'Navigate to a UFC event on DraftKings';
    badge.textContent = '—';
    badge.className = '';
    taggerWrap.style.display = 'none';
    _activeFightKey = '';
    return;
  }

  const f1 = fight.fighter1;
  const f2 = fight.fighter2;
  nameEl.textContent = `${f1} vs ${f2}`;
  oddsEl.textContent = `${fmtOdds(fight.odds1)}  /  ${fmtOdds(fight.odds2)}`;
  
  if (fight.live && manualActive) { badge.textContent = 'LIVE (manual)'; badge.className = 'manual'; }
  else if (fight.live)            { badge.textContent = 'LIVE';          badge.className = 'live'; }
  else                             { badge.textContent = 'not live';      badge.className = ''; }

  const row = document.getElementById('manualLiveRow');
  if (manualActive) {
    row.style.display = 'block';
    const minsLeft = Math.max(0, Math.round((manualLiveUntil - Date.now()) / 60000));
    document.getElementById('manualLiveCountdown').textContent = `${minsLeft}m left`;
  } else {
    row.style.display = 'none';
  }

  // Fetch fighter tags and dynamic crossover edge from LiveBetBot
  const fightKey = `${f1}_vs_${f2}_${fight.odds1}_${fight.odds2}`;
  if (_activeFightKey !== fightKey) {
    _activeFightKey = fightKey;
    taggerWrap.style.display = 'block';
    document.getElementById('ext-f1-name').textContent = f1;
    document.getElementById('ext-f2-name').textContent = f2;
    await fetchAndRenderTags(f1, f2, fight.odds1, fight.odds2);
  }
}

async function fetchAndRenderTags(f1, f2, o1, o2) {
  try {
    const oQuery = (o1 != null && o2 != null) ? `&o1=${encodeURIComponent(o1)}&o2=${encodeURIComponent(o2)}` : '';
    const res = await fetch(`https://www.livebetbot.com/api/fighter-stats?f1=${encodeURIComponent(f1)}&f2=${encodeURIComponent(f2)}${oQuery}`);
    const stats = await res.json();
    if (!stats || stats.error) return;
    _currentStats = stats;

    const f1Tags = stats.f1?.tags?.tags || [];
    const f2Tags = stats.f2?.tags?.tags || [];
    const f1Dog = !!stats.f1?.tags?.isRawDog;
    const f2Dog = !!stats.f2?.tags?.isRawDog;

    // Render Raw Dog Buttons
    const f1DogBtn = document.getElementById('ext-f1-dog');
    f1DogBtn.className = 'ext-dog-btn' + (f1Dog ? ' active' : '');
    f1DogBtn.onclick = async () => {
      await fetch('https://www.livebetbot.com/api/fighter-tags/rawdog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f1 })
      });
      fetchAndRenderTags(f1, f2, o1, o2);
    };

    const f2DogBtn = document.getElementById('ext-f2-dog');
    f2DogBtn.className = 'ext-dog-btn' + (f2Dog ? ' active' : '');
    f2DogBtn.onclick = async () => {
      await fetch('https://www.livebetbot.com/api/fighter-tags/rawdog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f2 })
      });
      fetchAndRenderTags(f1, f2, o1, o2);
    };

    // Render Quick Tag Pills
    const renderPills = (containerId, currentTags, fighterName) => {
      const c = document.getElementById(containerId);
      c.innerHTML = TAG_CATALOG.map(t => {
        const active = currentTags.includes(t.id);
        return `<button class="ext-pill${active ? ' active' : ''}" data-tag="${t.id}">${t.short}</button>`;
      }).join('');
      c.querySelectorAll('.ext-pill').forEach(btn => {
        btn.onclick = async () => {
          await fetch('https://www.livebetbot.com/api/fighter-tags/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: fighterName, tagId: btn.dataset.tag })
          });
          fetchAndRenderTags(f1, f2, o1, o2);
        };
      });
    };

    renderPills('ext-f1-pills', f1Tags, f1);
    renderPills('ext-pills' in window ? 'ext-pills' : 'ext-f2-pills', f2Tags, f2);

    // Render Dynamic Crossover Advice Box
    const adviceBox = document.getElementById('ext-advice-box');
    if (stats.taggedCrossover && (stats.taggedCrossover.hasTags || stats.taggedCrossover.catalysts.length)) {
      adviceBox.style.display = 'block';
      const tc = stats.taggedCrossover;
      document.getElementById('ext-advice-title').textContent = `⚡ Line-Flip Edge: ${tc.taggedCrossoverPct}% (${tc.delta >= 0 ? '+' : ''}${tc.delta}%) · Dog Win: ${tc.expectedDogWinPct}%`;
      const cats = tc.catalysts.concat(tc.warnings);
      document.getElementById('ext-advice-desc').textContent = cats.length ? cats.join(' · ') : tc.advice;
    } else {
      adviceBox.style.display = 'none';
    }
  } catch (_) {}
}

function renderLog(log) {
  const el = document.getElementById('debugLog');
  if (!el) return;
  if (!log.length) { el.innerHTML = '<div style="color:#333;font-size:0.6rem;padding:2px 0">No recent events</div>'; return; }
  el.innerHTML = log.slice(0, 10).map(e => {
    const isBets = e.msg.includes('bets') || e.msg.includes('BETS');
    const isErr = e.msg.includes('✗') || e.msg.includes('error');
    return `<div class="log-entry"><span class="log-ts">${timeStr(e.ts)}</span><span class="log-msg${isBets?' bets':isErr?' err':''}">${e.msg}</span></div>`;
  }).join('');
}

// Diagnostics Accordion Toggle
const drawerToggle = document.getElementById('btnToggleDrawer');
const drawerBody = document.getElementById('drawer-body');
const drawerArrow = document.getElementById('drawerArrow');

drawerToggle.addEventListener('click', () => {
  const isOpen = drawerBody.style.display === 'block';
  drawerBody.style.display = isOpen ? 'none' : 'block';
  drawerArrow.textContent = isOpen ? '▾' : '▴';
});

// Username setup
chrome.storage.local.get(['dkUserId', 'manualUserId'], r => {
  const u = r.manualUserId || r.dkUserId;
  if (u) document.getElementById('userInput').value = u;
});
document.getElementById('saveUser').addEventListener('click', () => {
  const val = document.getElementById('userInput').value.trim();
  if (!val) return;
  chrome.storage.local.set({ dkUserId: val, manualUserId: val });
  const btn = document.getElementById('saveUser');
  btn.textContent = 'Saved ✓'; btn.className = 'saved';
  setTimeout(() => { btn.textContent = 'Set'; btn.className = ''; }, 2000);
});

document.getElementById('clrLog').addEventListener('click', () => {
  chrome.storage.local.set({ debugLog: [], captures: [], wsConnected: null, wsLastOpen: null, wsLastClose: null });
});

document.getElementById('btnLaunchTabs')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://sportsbook.draftkings.com/mybets' });
  chrome.tabs.create({ url: 'https://sportsbook.draftkings.com/leagues/mma/ufc' });
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
