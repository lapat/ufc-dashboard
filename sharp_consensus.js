// sharp_consensus.js — Real-time comparison between DraftKings and Pinnacle (the sharpest book)
// Detects sharp money movement, line discrepancies, and positive expected value (+EV).

const https = require("https");
const { norm, lastName } = require("./live_fight_stats");

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = "https://api.the-odds-api.com/v4";

let _sharpCache = null;
let _sharpCacheTs = 0;
const CACHE_MS = 60000; // 60-second cache to preserve API quota

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function fetchSharpOdds() {
  const now = Date.now();
  if (_sharpCache && (now - _sharpCacheTs < CACHE_MS)) {
    return _sharpCache;
  }
  if (!ODDS_API_KEY) return null;

  try {
    const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=us,eu&markets=h2h&bookmakers=draftkings,pinnacle,bovada&oddsFormat=american`;
    const data = await getJson(url);
    if (Array.isArray(data)) {
      _sharpCache = data;
      _sharpCacheTs = now;
      return data;
    }
  } catch (e) {
    console.error("[sharp_consensus] Error fetching odds:", e.message);
  }
  return _sharpCache || [];
}

async function getSharpComparison(f1Name, f2Name, currentDk1, currentDk2) {
  if (!f1Name || !f2Name) return { hasSharpData: false };
  const events = await fetchSharpOdds();
  if (!events || !events.length) return { hasSharpData: false };

  const n1 = norm(f1Name);
  const n2 = norm(f2Name);
  const ln1 = lastName(f1Name);
  const ln2 = lastName(f2Name);

  const ev = events.find(e => {
    const home = norm(e.home_team || "");
    const away = norm(e.away_team || "");
    const homeL = lastName(e.home_team || "");
    const awayL = lastName(e.away_team || "");

    const match1 = (home.includes(n1) || n1.includes(home) || homeL === ln1);
    const match2 = (away.includes(n2) || n2.includes(away) || awayL === ln2);
    if (match1 && match2) return true;

    const rev1 = (away.includes(n1) || n1.includes(away) || awayL === ln1);
    const rev2 = (home.includes(n2) || n2.includes(home) || homeL === ln2);
    return rev1 && rev2;
  });

  if (!ev) return { hasSharpData: false };

  const bks = ev.bookmakers || [];
  const pin = bks.find(b => b.key === "pinnacle");
  const bov = bks.find(b => b.key === "bovada");
  const dk = bks.find(b => b.key === "draftkings");

  function extractPrice(bookmaker, name, lName) {
    if (!bookmaker) return null;
    const mkt = (bookmaker.markets || []).find(m => m.key === "h2h");
    if (!mkt) return null;
    const out = (mkt.outcomes || []).find(o => {
      const oNorm = norm(o.name);
      return oNorm.includes(name) || name.includes(oNorm) || lastName(o.name) === lName;
    });
    return out ? out.price : null;
  }

  const pin1 = extractPrice(pin, n1, ln1);
  const pin2 = extractPrice(pin, n2, ln2);
  const bov1 = extractPrice(bov, n1, ln1);
  const bov2 = extractPrice(bov, n2, ln2);
  const dk1 = currentDk1 != null ? currentDk1 : extractPrice(dk, n1, ln1);
  const dk2 = currentDk2 != null ? currentDk2 : extractPrice(dk, n2, ln2);

  let badge = "⚖️ Sharp Aligned";
  let detail = "Pinnacle and DraftKings in close consensus";
  let sharpLean = null;

  if (pin1 != null && dk1 != null) {
    const diff1 = pin1 - dk1;
    // If Pinnacle has fighter at -240 and DK has them at -190 (Pinnacle is sharper on F1)
    if (pin1 < 0 && dk1 < 0 && (dk1 - pin1 >= 25)) {
      badge = "💎 Sharp Edge on " + f1Name;
      detail = `Pinnacle prices ${f1Name} sharper (${pin1 > 0 ? "+" + pin1 : pin1}) vs DK (${dk1 > 0 ? "+" + dk1 : dk1})`;
      sharpLean = f1Name;
    } else if (pin2 < 0 && dk2 < 0 && (dk2 - pin2 >= 25)) {
      badge = "💎 Sharp Edge on " + f2Name;
      detail = `Pinnacle prices ${f2Name} sharper (${pin2 > 0 ? "+" + pin2 : pin2}) vs DK (${dk2 > 0 ? "+" + dk2 : dk2})`;
      sharpLean = f2Name;
    } else if (pin1 > 0 && dk1 > 0 && (dk1 - pin1 >= 20)) {
      badge = "🚨 +EV Dog on " + f1Name;
      detail = `DK offers higher dog odds on ${f1Name} (+${dk1} vs Pinnacle +${pin1})`;
      sharpLean = f1Name;
    } else if (pin2 > 0 && dk2 > 0 && (dk2 - pin2 >= 20)) {
      badge = "🚨 +EV Dog on " + f2Name;
      detail = `DK offers higher dog odds on ${f2Name} (+${dk2} vs Pinnacle +${pin2})`;
      sharpLean = f2Name;
    }
  }

  return {
    hasSharpData: true,
    event: ev.home_team + " vs " + ev.away_team,
    pinnacle: pin ? { f1: pin1, f2: pin2 } : null,
    bovada: bov ? { f1: bov1, f2: bov2 } : null,
    draftkings: dk ? { f1: dk1, f2: dk2 } : null,
    badge,
    detail,
    sharpLean
  };
}

module.exports = { fetchSharpOdds, getSharpComparison };
