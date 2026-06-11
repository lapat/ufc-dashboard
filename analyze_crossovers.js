const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'Bet Data Dec 2025 - May 2026');

function toDecimal(o) {
  return o > 0 ? (o / 100) + 1 : (100 / Math.abs(o)) + 1;
}

// Guaranteed profit condition for two live bets both placed at plus money
// Bet 1: $S1 at +O1 (pre-crossover underdog)
// Bet 2: $S2 at +O2 (post-crossover new underdog)
// Win-win exists when: O1 * O2 > 10000
// Optimal S2 given S1: anywhere in range S1/(O2/100) < S2 < S1*(O1/100)
// Max profit % at midpoint stake
function calcWinWin(o1, o2) {
  if (o1 <= 0 || o2 <= 0) return null;
  const product = o1 * o2;
  if (product <= 10000) return null; // no guaranteed profit window

  const d1 = toDecimal(o1);
  const d2 = toDecimal(o2);

  // Per $100 on Bet 1, optimal Bet 2 stake that equalizes both outcomes
  const s1 = 100;
  const s2 = s1 * Math.sqrt((d1 - 1) / (d2 - 1)); // geometric midpoint = max guaranteed profit
  const payoutIfA = s1 * d1 - s1 - s2;
  const payoutIfB = s2 * d2 - s2 - s1;
  const guaranteedProfit = Math.min(payoutIfA, payoutIfB);
  const roi = (guaranteedProfit / (s1 + s2)) * 100;

  // Stake range for any positive outcome
  const s2Min = s1 / (o2 / 100);   // B-win must beat cost
  const s2Max = s1 * (o1 / 100);   // A-win must beat cost

  return {
    o1Product: product,
    guaranteedProfitPer100: +guaranteedProfit.toFixed(2),
    roi: +roi.toFixed(2),
    optimalS2Per100: +s2.toFixed(2),
    s2Range: [+s2Min.toFixed(2), +s2Max.toFixed(2)],
  };
}

function analyzeFight(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const fight = JSON.parse(raw);
  const h = fight.oddsHistory;
  if (!h || h.length < 2) return null;

  const crossovers = [];

  for (let i = 1; i < h.length; i++) {
    const prev = h[i - 1];
    const curr = h[i];
    const pf1 = prev.fighter1.numericOdds;
    const cf1 = curr.fighter1.numericOdds;
    const pf2 = prev.fighter2.numericOdds;
    const cf2 = curr.fighter2.numericOdds;

    // Fighter1 was the underdog (+), now becomes favorite (-)
    // Fighter2 simultaneously flips to underdog (+)
    if (pf1 > 0 && cf1 < 0) {
      const o1 = pf1;   // Ish's first bet odds (Fighter1 pre-crossover)
      const o2 = cf2;   // Ish's second bet odds (Fighter2 post-crossover)
      const winWin = o2 > 0 ? calcWinWin(o1, o2) : null;
      crossovers.push({
        timestamp: curr.timestamp,
        underdogBet: { name: prev.fighter1.name, odds: o1 },
        newUnderdog: { name: curr.fighter2.name, odds: o2 },
        winWin,
        secondBetPlusMoney: o2 > 0,
      });
    }

    // Fighter2 was the underdog (+), now becomes favorite (-)
    // Fighter1 simultaneously flips to underdog (+)
    if (pf2 > 0 && cf2 < 0) {
      const o1 = pf2;
      const o2 = cf1;
      const winWin = o2 > 0 ? calcWinWin(o1, o2) : null;
      crossovers.push({
        timestamp: curr.timestamp,
        underdogBet: { name: prev.fighter2.name, odds: o1 },
        newUnderdog: { name: curr.fighter1.name, odds: o2 },
        winWin,
        secondBetPlusMoney: o2 > 0,
      });
    }
  }

  return {
    fightId: fight.fightId,
    dataPoints: h.length,
    crossoverCount: crossovers.length,
    crossovers,
  };
}

function run() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const results = [];
  for (const file of files) {
    try {
      const r = analyzeFight(path.join(DATA_DIR, file));
      if (r) results.push(r);
    } catch (e) {}
  }

  const total = results.length;
  const withCrossover     = results.filter(r => r.crossoverCount > 0);
  const withMultiple      = results.filter(r => r.crossoverCount > 1);
  const allMoments        = withCrossover.flatMap(r => r.crossovers);
  const secondLegPlus     = allMoments.filter(c => c.secondBetPlusMoney);
  const winWinMoments     = allMoments.filter(c => c.winWin !== null);

  // Q3: crossovers where odds don't get "larger" than -200
  // Meaning: at the crossover, the second leg is not worse than +200 (modest plus)
  // OR: neither leg exceeds the -200 magnitude (both are in the -200 to +200 range)
  const within200         = allMoments.filter(c =>
    Math.abs(c.underdogBet.odds) <= 200 && Math.abs(c.newUnderdog.odds) <= 200
  );

  console.log('='.repeat(65));
  console.log('ISH CROSSOVER ANALYSIS — UFC Live Odds Dec 2025 – May 2026');
  console.log('Crossover = underdog flips to favorite; second leg at new underdog price');
  console.log('='.repeat(65));
  console.log(`\nTotal fights analyzed:                  ${total}`);
  console.log(`\nQ1  Fights with ANY crossover:          ${withCrossover.length} / ${total} (${pct(withCrossover.length, total)}%)`);
  console.log(`Q2  Fights with MULTIPLE crossovers:    ${withMultiple.length} / ${total} (${pct(withMultiple.length, total)}%)`);
  console.log(`\n    Total crossover moments:            ${allMoments.length}`);
  console.log(`    Second leg also at plus money:       ${secondLegPlus.length} / ${allMoments.length} (${pct(secondLegPlus.length, allMoments.length)}%)`);
  console.log(`    WIN-WIN windows (O1×O2 > 10,000):   ${winWinMoments.length} / ${allMoments.length} (${pct(winWinMoments.length, allMoments.length)}%)`);
  console.log(`Q3  Both legs ≤ ±200 at crossover:      ${within200.length} / ${allMoments.length} (${pct(within200.length, allMoments.length)}%)`);

  if (winWinMoments.length > 0) {
    const best = winWinMoments.sort((a, b) => b.winWin.roi - a.winWin.roi).slice(0, 10);
    console.log('\n--- TOP WIN-WIN CROSSOVERS BY GUARANTEED ROI ---');
    best.forEach(c => {
      const f = results.find(r => r.crossovers.includes(c));
      console.log(`  ${f?.fightId}`);
      console.log(`    Bet 1: ${c.underdogBet.name} +${c.underdogBet.odds} → Crossover → Bet 2: ${c.newUnderdog.name} +${c.newUnderdog.odds}`);
      console.log(`    Guaranteed: $${c.winWin.guaranteedProfitPer100} profit per $100 Bet 1 (${c.winWin.roi}% ROI) | Optimal Bet 2: $${c.winWin.optimalS2Per100} | Bet 2 range: $${c.winWin.s2Range[0]}–$${c.winWin.s2Range[1]}`);
    });
  }

  console.log('\n--- FIGHTS WITH MOST CROSSOVERS ---');
  withCrossover.sort((a, b) => b.crossoverCount - a.crossoverCount).slice(0, 10).forEach(r => {
    const ww = r.crossovers.filter(c => c.winWin).length;
    console.log(`  ${r.fightId}: ${r.crossoverCount} crossovers (${ww} win-win)`);
  });

  fs.writeFileSync(
    path.join(__dirname, 'crossover_results.json'),
    JSON.stringify({ generated: new Date().toISOString(), total, withCrossover: withCrossover.length, withMultiple: withMultiple.length, allMoments: allMoments.length, secondLegPlus: secondLegPlus.length, winWinMoments: winWinMoments.length, within200: within200.length, fights: results }, null, 2)
  );
  console.log('\nSaved → crossover_results.json');
}

function pct(n, d) { return d === 0 ? '0.0' : ((n / d) * 100).toFixed(1); }

run();
