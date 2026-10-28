"use strict";
/**
 * provenance_engine.js — Transparent Data Provenance & Empirical Audit Engine
 * Evaluates live recording files from historical_data/ against fighter profiles,
 * compiling 100% verifiable lists of fights for every empirical catalyst and pattern.
 */

const fs = require("fs");
const path = require("path");

const HIST_DIR = path.join(__dirname, "historical_data");
const { loadFighterProfiles } = require("./fighter_stats");

function norm(n) {
  return (n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

let _profilesCache = null;
function getProfiles() {
  if (!_profilesCache) {
    _profilesCache = loadFighterProfiles();
  }
  return _profilesCache;
}

function getProfile(name) {
  if (!name) return null;
  const profiles = getProfiles();
  if (profiles[name]) return profiles[name];
  const k = norm(name);
  return Object.values(profiles).find(p => norm(p.name) === k) || null;
}

let _auditCache = null;
let _auditCacheTime = 0;

function getAuditData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _auditCache && (now - _auditCacheTime < 60000)) {
    return _auditCache;
  }

  if (!fs.existsSync(HIST_DIR)) {
    return { error: "historical_data directory not found" };
  }

  const files = fs.readdirSync(HIST_DIR).filter(f => f.endsWith(".json") && f.includes("_vs_"));

  const prodFights = [];
  const catDogHighDef = [];
  const catReach = [];
  const catHeight = [];
  const catAge = [];
  const catGrapple = [];
  const catMulti = [];

  for (const file of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(HIST_DIR, file), "utf8"));
      const h = d.oddsHistory || [];
      if (h.length < 20) continue; // STRICT PRODUCTION QUALITY THRESHOLD (>= 20 in-fight ticks)

      const open = h[0];
      const f1Name = d.meta?.fighter1 || open.fighter1?.name || open.fighter1Name;
      const f2Name = d.meta?.fighter2 || open.fighter2?.name || open.fighter2Name;
      if (!f1Name || !f2Name) continue;

      const o1 = open.fighter1?.numericOdds ?? open.fighter1Odds ?? open.f1;
      const o2 = open.fighter2?.numericOdds ?? open.fighter2Odds ?? open.f2;
      if (o1 == null || o2 == null) continue;

      const f1IsFav = o1 < o2;
      const favName = f1IsFav ? f1Name : f2Name;
      const dogName = f1IsFav ? f2Name : f1Name;
      const favOdds = f1IsFav ? o1 : o2;
      const dogOdds = f1IsFav ? o2 : o1;

      const pFav = getProfile(favName);
      const pDog = getProfile(dogName);

      let hadCrossover = false;
      let crossoverEvents = [];
      for (let i = 1; i < h.length; i++) {
        const p = h[i-1], c = h[i];
        const p1 = p.fighter1?.numericOdds ?? p.f1;
        const c1 = c.fighter1?.numericOdds ?? c.f1;
        const p2 = p.fighter2?.numericOdds ?? p.f2;
        const c2 = c.fighter2?.numericOdds ?? c.f2;
        if (p1 != null && c1 != null && p2 != null && c2 != null) {
          if ((p1 > 0 && c1 < 0) || (p2 > 0 && c2 < 0)) {
            hadCrossover = true;
            crossoverEvents.push({
              tick: i,
              time: c.timestamp || c.ts || null,
              o1: c1,
              o2: c2
            });
          }
        }
      }

      // Extract fight date from filename or metadata
      const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
      const fightDate = dateMatch ? dateMatch[1] : (d.startTime ? d.startTime.slice(0, 10) : "Recorded");

      const fightRow = {
        file,
        date: fightDate,
        matchup: `${favName} vs ${dogName}`,
        favName,
        dogName,
        favOdds,
        dogOdds,
        favOddsFormatted: favOdds > 0 ? `+${favOdds}` : `${favOdds}`,
        dogOddsFormatted: dogOdds > 0 ? `+${dogOdds}` : `${dogOdds}`,
        crossover: hadCrossover,
        crossoverCount: crossoverEvents.length,
        dataPoints: h.length
      };

      prodFights.push(fightRow);

      let triggers = 0;
      let triggerLabels = [];

      // 1. Dog High Defense (StrDef >= 60%) vs Fav High Damage (SApM >= 3.8)
      if (pDog?.stats?.strDef && pFav?.stats?.sapm) {
        const def = pDog.stats.strDef > 1 ? pDog.stats.strDef : pDog.stats.strDef * 100;
        if (def >= 60 && pFav.stats.sapm >= 3.8) {
          catDogHighDef.push({
            ...fightRow,
            triggerSummary: `Dog StrDef: ${def.toFixed(1)}% | Fav SApM: ${pFav.stats.sapm.toFixed(2)}`,
            dogStrDef: def,
            favSApM: pFav.stats.sapm
          });
          triggers++;
          triggerLabels.push("High Defense Dog");
        }
      }

      // 2. Underdog Reach Advantage (>= +3.0")
      if (pDog?.bio?.reach && pFav?.bio?.reach) {
        const diff = pDog.bio.reach - pFav.bio.reach;
        if (diff >= 3.0) {
          catReach.push({
            ...fightRow,
            triggerSummary: `Dog Reach: ${pDog.bio.reach}" vs Fav: ${pFav.bio.reach}" (+${diff.toFixed(1)}")`,
            dogReach: pDog.bio.reach,
            favReach: pFav.bio.reach,
            reachDiff: diff
          });
          triggers++;
          triggerLabels.push(`Reach +${diff.toFixed(1)}"`);
        }
      }

      // 3. Underdog Height Advantage (>= +2.0")
      if (pDog?.bio?.height && pFav?.bio?.height) {
        const diff = pDog.bio.height - pFav.bio.height;
        if (diff >= 2.0) {
          catHeight.push({
            ...fightRow,
            triggerSummary: `Dog Height: ${pDog.bio.height}" vs Fav: ${pFav.bio.height}" (+${diff.toFixed(1)}")`,
            dogHeight: pDog.bio.height,
            favHeight: pFav.bio.height,
            heightDiff: diff
          });
          triggers++;
          triggerLabels.push(`Height +${diff.toFixed(1)}"`);
        }
      }

      // 4. Favorite Age Cliff (Fav Age >= 35)
      if (pFav?.bio?.age && pFav.bio.age >= 35) {
        const diffAge = pDog?.bio?.age ? pFav.bio.age - pDog.bio.age : null;
        const diffStr = diffAge ? ` (${diffAge > 0 ? "+" : ""}${diffAge} yrs older)` : "";
        catAge.push({
          ...fightRow,
          triggerSummary: `Fav Age: ${pFav.bio.age}${diffStr} vs Dog: ${pDog?.bio?.age || "N/A"}`,
          favAge: pFav.bio.age,
          dogAge: pDog?.bio?.age
        });
        triggers++;
        triggerLabels.push(`Fav Age ${pFav.bio.age}`);
      }

      // 5. Grappler Suppression (Fav TD Avg >= 2.0 vs Dog Bad TD Def < 65%)
      if (pFav?.stats?.tdAvg && pDog?.stats?.tdDef) {
        const tdDef = pDog.stats.tdDef > 1 ? pDog.stats.tdDef : pDog.stats.tdDef * 100;
        if (pFav.stats.tdAvg >= 2.0 && tdDef < 65) {
          catGrapple.push({
            ...fightRow,
            triggerSummary: `Fav TD Avg: ${pFav.stats.tdAvg.toFixed(2)}/15m vs Dog TD Def: ${tdDef.toFixed(1)}%`,
            favTdAvg: pFav.stats.tdAvg,
            dogTdDef: tdDef
          });
        }
      }

      // 6. Multi-Catalyst Stacking (>= 2 risk triggers on favorite)
      if (triggers >= 2) {
        catMulti.push({
          ...fightRow,
          triggerSummary: `${triggers} Stacked Triggers: ${triggerLabels.join(", ")}`,
          triggerCount: triggers,
          triggers: triggerLabels
        });
      }

    } catch (_) {}
  }

  function compileCatalyst(id, title, desc, rule, fightsList, badgeColor = "gold") {
    const total = fightsList.length;
    const crossed = fightsList.filter(f => f.crossover).length;
    const rate = total > 0 ? Math.round((crossed / total) * 1000) / 10 : 0;
    return {
      id,
      title,
      desc,
      rule,
      sample: total,
      crossovers: crossed,
      rate,
      badgeColor,
      fights: fightsList
    };
  }

  const catalysts = [
    compileCatalyst(
      "dogHighDef",
      "🛡️ High Defense Dog vs Damaged Fav",
      "Underdog has elite striking defense (StrDef >= 60%) while favorite absorbs heavy punishment (SApM >= 3.8 strikes/min).",
      "Dog StrDef >= 60% AND Fav SApM >= 3.8",
      catDogHighDef,
      "green"
    ),
    compileCatalyst(
      "multiCatalyst",
      "⚡ Multi-Catalyst Stack (2+ Triggers)",
      "Matchup triggers 2 or more distinct structural liabilities (e.g. Favorite Age 35+ stacked with Underdog physical frame advantage).",
      "Matchup triggers >= 2 distinct structural risk triggers",
      catMulti,
      "green"
    ),
    compileCatalyst(
      "reachAdvantage",
      "📏 Underdog Reach Advantage (>= +3.0 inches)",
      "Underdog possesses a 3.0 inch or greater reach advantage, enabling distance control and counter-striking range.",
      "Dog Reach - Fav Reach >= 3.0 in",
      catReach,
      "gold"
    ),
    compileCatalyst(
      "heightAdvantage",
      "📐 Underdog Height Advantage (>= +2.0 inches)",
      "Underdog is 2.0 inches or taller than the favorite, creating leverage in clinch defense and head-strike avoidance.",
      "Dog Height - Fav Height >= 2.0 in",
      catHeight,
      "gold"
    ),
    compileCatalyst(
      "ageCliff",
      "⏳ Favorite Age Cliff (Age >= 35)",
      "Favorite is 35 years or older, where deceleration in reaction speed and chin deterioration trigger in-fight collapses.",
      "Fav Age >= 35 years",
      catAge,
      "gold"
    ),
    compileCatalyst(
      "grapplerSuppression",
      "🤼 Grappler Suppression Trap",
      "Favorite possesses dominant wrestling (TD Avg >= 2.0) while underdog exhibits porous takedown defense (TD Def < 65%). Fights where crossover is suppressed.",
      "Fav TD Avg >= 2.0 AND Dog TD Def < 65%",
      catGrapple,
      "blue"
    )
  ];

  // Sort fights catalog by date descending
  prodFights.sort((a,b) => (b.date || "").localeCompare(a.date || ""));

  _auditCache = {
    generatedAt: new Date().toISOString(),
    totalFightsAnalyzed: prodFights.length,
    threshold: "oddsHistory.length >= 20 ticks",
    sources: {
      odds: "DraftKings live DOM/WebSocket captures (1-second continuous sampling)",
      stats: "Official UFC Stats database (ufcstats.com) via ufc_db.sqlite & fighter_profiles.json",
      storage: "historical_data/*.json in local repository / Railway production volume"
    },
    catalysts,
    catalog: prodFights
  };
  _auditCacheTime = Date.now();

  return _auditCache;
}

module.exports = {
  getAuditData
};
