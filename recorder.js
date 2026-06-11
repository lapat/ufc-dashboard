require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ODDS_API_KEY;
const POLL_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 60000;
const DATA_DIR = path.join(__dirname, 'historical_data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const activeFights = new Map();

function fetchOdds() {
  return new Promise((resolve, reject) => {
    const url = `https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ fights: JSON.parse(data), remaining: res.headers['x-requests-remaining'] });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fightId(fight) {
  const a = fight.home_team.toLowerCase().replace(/\s+/g, '');
  const b = fight.away_team.toLowerCase().replace(/\s+/g, '');
  const date = fight.commence_time.slice(0, 10);
  return `${a}_vs_${b}_${date}`;
}

function isLive(fight) {
  const now = Date.now();
  const start = new Date(fight.commence_time).getTime();
  return start <= now && now - start < 3 * 60 * 60 * 1000;
}

function extractOdds(fight) {
  const dk = fight.bookmakers?.[0];
  const market = dk?.markets?.find(m => m.key === 'h2h');
  const outcomes = market?.outcomes ?? [];
  if (outcomes.length < 2) return null;
  return {
    timestamp: new Date().toISOString(),
    fighter1: {
      name: outcomes[0].name,
      odds: outcomes[0].price > 0 ? `+${outcomes[0].price}` : `${outcomes[0].price}`,
      numericOdds: outcomes[0].price,
    },
    fighter2: {
      name: outcomes[1].name,
      odds: outcomes[1].price > 0 ? `+${outcomes[1].price}` : `${outcomes[1].price}`,
      numericOdds: outcomes[1].price,
    },
    isLocked: false,
  };
}

function toDecimal(o) {
  return o > 0 ? (o / 100) + 1 : (100 / Math.abs(o)) + 1;
}

// Win-win check for ANY combination of Bet 1 / Bet 2 odds
// Condition: (D1-1)(D2-1) > 1 where D = decimal odds
// Works for plus/plus, minus/plus, even minus/minus if swing is big enough
function calcWinWin(o1, o2) {
  const d1 = toDecimal(o1);
  const d2 = toDecimal(o2);
  const condition = (d1 - 1) * (d2 - 1);
  if (condition <= 1) return null;

  // Optimal Bet 2 per $100 on Bet 1 (geometric midpoint = max guaranteed profit)
  const s1 = 100;
  const s2 = s1 * Math.sqrt((d1 - 1) / (d2 - 1));
  const payoutIfA = s1 * d1 - s1 - s2;
  const payoutIfB = s2 * d2 - s2 - s1;
  const guaranteed = Math.min(payoutIfA, payoutIfB);
  const roi = (guaranteed / (s1 + s2)) * 100;

  const s2Min = s1 / (d2 - 1);
  const s2Max = s1 * (d1 - 1);

  return {
    condition: +condition.toFixed(4),
    guaranteed: +guaranteed.toFixed(2),
    roi: +roi.toFixed(2),
    optimalS2: +s2.toFixed(2),
    s2Range: [+s2Min.toFixed(2), +s2Max.toFixed(2)],
  };
}

function checkCrossover(prev, curr) {
  const pf1 = prev.fighter1.numericOdds, cf1 = curr.fighter1.numericOdds;
  const pf2 = prev.fighter2.numericOdds, cf2 = curr.fighter2.numericOdds;

  const crossovers = [];

  // Fighter1 just became the favorite (odds went more negative or crossed from + to -)
  // Fighter2 just became the underdog (odds went more positive or crossed from - to +)
  const f1BecameFav = cf1 < pf1 && cf2 > pf2;
  const f2BecameFav = cf2 < pf2 && cf1 > pf1;

  if (f1BecameFav || f2BecameFav) {
    // o1 = what Bet 1 was placed at (pre-crossover underdog or any prior odds)
    // o2 = what Bet 2 can be placed at now (post-crossover)
    // We evaluate using the pre-crossover odds as Bet 1
    const o1 = f1BecameFav ? pf2 : pf1; // the fighter who was underdog before
    const o2 = f1BecameFav ? cf2 : cf1; // their new odds after crossover

    const ww = calcWinWin(o1, o2);
    if (ww) {
      crossovers.push({
        type: ww ? 'WIN-WIN' : 'CROSSOVER',
        bet1Fighter: f1BecameFav ? prev.fighter2.name : prev.fighter1.name,
        bet1Odds: o1,
        bet2Fighter: f1BecameFav ? curr.fighter2.name : curr.fighter1.name,
        bet2Odds: o2,
        winWin: ww,
      });
    }
  }

  return crossovers;
}

function saveFight(id) {
  const record = activeFights.get(id);
  if (!record || record.oddsHistory.length === 0) return;
  const filePath = path.join(DATA_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    fightId: id,
    fightTitle: record.meta.title,
    startTime: record.meta.startTime,
    endTime: new Date().toISOString(),
    duration: Date.now() - new Date(record.meta.startTime).getTime(),
    dataPoints: record.oddsHistory.length,
    oddsHistory: record.oddsHistory,
  }, null, 2));
  console.log(`\nSaved: ${id} (${record.oddsHistory.length} data points)`);
}

async function poll() {
  let liveFightCount = 0;

  try {
    const { fights, remaining } = await fetchOdds();
    const now = new Date().toISOString();
    const currentLiveIds = new Set();

    for (const fight of fights) {
      if (!isLive(fight)) continue;
      const odds = extractOdds(fight);
      if (!odds) continue;

      const id = fightId(fight);
      currentLiveIds.add(id);
      liveFightCount++;

      if (!activeFights.has(id)) {
        console.log(`\nLIVE FIGHT DETECTED: ${fight.home_team} vs ${fight.away_team}`);
        activeFights.set(id, {
          meta: { title: `${fight.home_team} vs ${fight.away_team}`, startTime: now },
          oddsHistory: [],
          lastOdds: null,
        });
      }

      const record = activeFights.get(id);
      const last = record.lastOdds;
      const oddsChanged = !last
        || last.fighter1.numericOdds !== odds.fighter1.numericOdds
        || last.fighter2.numericOdds !== odds.fighter2.numericOdds;

      if (oddsChanged) {
        // Check for crossover before pushing
        if (last) {
          const crossovers = checkCrossover(last, odds);
          for (const c of crossovers) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`WIN-WIN WINDOW: ${fight.home_team} vs ${fight.away_team}`);
            console.log(`  Bet 1: ${c.bet1Fighter} ${c.bet1Odds > 0 ? '+' : ''}${c.bet1Odds}`);
            console.log(`  Bet 2: ${c.bet2Fighter} ${c.bet2Odds > 0 ? '+' : ''}${c.bet2Odds}`);
            console.log(`  Guaranteed: $${c.winWin.guaranteed} per $100 Bet 1 (${c.winWin.roi}% ROI)`);
            console.log(`  Optimal Bet 2: $${c.winWin.optimalS2} | Range: $${c.winWin.s2Range[0]}–$${c.winWin.s2Range[1]}`);
            console.log(`${'='.repeat(60)}\n`);
          }
        }

        record.oddsHistory.push(odds);
        record.lastOdds = odds;
        process.stdout.write(`\r[${now.slice(11,19)}] ${remaining} req left | Live: ${liveFightCount} | ${fight.home_team}: ${odds.fighter1.numericOdds > 0 ? '+' : ''}${odds.fighter1.numericOdds} vs ${fight.away_team}: ${odds.fighter2.numericOdds > 0 ? '+' : ''}${odds.fighter2.numericOdds}   `);
      }
    }

    // Save fights no longer in live feed
    for (const [id] of activeFights) {
      if (!currentLiveIds.has(id)) {
        console.log(`\nFight ended: ${id}`);
        saveFight(id);
        activeFights.delete(id);
      }
    }

  } catch (e) {
    console.error('\nPoll error:', e.message);
  }

  setTimeout(poll, liveFightCount > 0 ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS);
}

console.log('UFC Live Odds Recorder');
console.log(`Data dir: ${DATA_DIR}`);
console.log(`Poll: ${POLL_INTERVAL_MS / 1000}s live / ${IDLE_INTERVAL_MS / 1000}s idle\n`);
poll();
