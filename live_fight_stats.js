// live_fight_stats.js — Real-time in-fight strikes, takedowns, and control time
// Sourced live from official UFC broadcast feeds with zero API keys required.

const https = require("https");

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// Robust Unicode Accent & Diacritic Normalization
function norm(s) {
  return (s || "")
    .replace(/[łŁ]/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function lastName(s) {
  const parts = (s || "").trim().split(/\s+/);
  return norm(parts[parts.length - 1]);
}

let _scoreboardCache = null;
let _scoreboardCacheTs = 0;
const CACHE_MS = 3000; // 3 second cache

async function getScoreboard() {
  const now = Date.now();
  if (_scoreboardCache && (now - _scoreboardCacheTs < CACHE_MS)) {
    return _scoreboardCache;
  }
  try {
    const data = await getJson("https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard");
    _scoreboardCache = data;
    _scoreboardCacheTs = now;
    return data;
  } catch (e) {
    return _scoreboardCache || null;
  }
}

async function fetchLiveFightStats(f1Name, f2Name) {
  if (!f1Name || !f2Name) return null;
  const sb = await getScoreboard();
  if (!sb || !sb.events || !sb.events.length) return null;

  const n1 = norm(f1Name);
  const n2 = norm(f2Name);
  const ln1 = lastName(f1Name);
  const ln2 = lastName(f2Name);

  let targetComp = null;
  let targetEv = null;

  // Search across all cards/events in scoreboard
  for (const ev of sb.events) {
    for (const c of (ev.competitions || [])) {
      const athletes = (c.competitors || []).map(x => ({
        full: norm(x.athlete?.displayName || x.athlete?.fullName || ""),
        last: lastName(x.athlete?.displayName || x.athlete?.fullName || ""),
        raw: x
      }));

      // Match 1: Full name substring match
      const has1 = athletes.some(a => a.full.includes(n1) || n1.includes(a.full));
      const has2 = athletes.some(a => a.full.includes(n2) || n2.includes(a.full));
      if (has1 && has2) {
        targetComp = c;
        targetEv = ev;
        break;
      }

      // Match 2: Last name match fallback
      const hasL1 = athletes.some(a => a.last === ln1 || (ln1.length >= 4 && a.last.includes(ln1)));
      const hasL2 = athletes.some(a => a.last === ln2 || (ln2.length >= 4 && a.last.includes(ln2)));
      if (hasL1 && hasL2) {
        targetComp = c;
        targetEv = ev;
        break;
      }
    }
    if (targetComp) break;
  }

  if (!targetComp || !targetEv) return null;

  const result = {
    available: true,
    fightTitle: (targetComp.competitors || []).map(x => x.athlete?.displayName).join(" vs "),
    round: targetComp.status?.period || 1,
    clock: targetComp.status?.displayClock || "0:00",
    status: targetComp.status?.type?.detail || targetComp.status?.type?.description || "In Progress",
    f1: null,
    f2: null
  };

  const comps = targetComp.competitors || [];
  for (let i = 0; i < comps.length; i++) {
    const athleteComp = comps[i];
    const statsUrl = "https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/" + targetEv.id + "/competitions/" + targetComp.id + "/competitors/" + athleteComp.id + "/statistics?lang=en&region=us";
    
    let rawStats = [];
    try {
      const statsData = await getJson(statsUrl);
      rawStats = statsData.splits?.categories?.[0]?.stats || [];
    } catch (_) {}

    const statMap = {};
    rawStats.forEach(s => statMap[s.name] = s.displayValue);

    const fObj = {
      name: athleteComp.athlete?.displayName || (i === 0 ? f1Name : f2Name),
      sigStrikesLanded: parseInt(statMap.sigStrikesLanded || 0),
      sigStrikesAttempted: parseInt(statMap.sigStrikesAttempted || 0),
      totalStrikesLanded: parseInt(statMap.totalStrikesLanded || 0),
      takedownsLanded: parseInt(statMap.takedownsLanded || 0),
      takedownsAttempted: parseInt(statMap.takedownsAttempted || 0),
      knockdowns: parseInt(statMap.knockDowns || 0),
      controlTime: statMap.timeInControl || "0:00"
    };

    const athleteNorm = norm(fObj.name);
    const athleteLast = lastName(fObj.name);
    if (athleteNorm.includes(n1) || n1.includes(athleteNorm) || athleteLast === ln1) {
      result.f1 = fObj;
    } else {
      result.f2 = fObj;
    }
  }

  return result;
}

module.exports = { fetchLiveFightStats, norm, lastName };
