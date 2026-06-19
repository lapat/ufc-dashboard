# Auto-Bet Strategy — Crossover Hedge System

## The Core Concept

Live UFC fights produce massive, fast odds swings. A fighter can open at -350 and hit +500 in the same fight if momentum shifts. The auto-bet system exploits this by:

1. **Betting the underdog early** — at the start of the fight when the underdog's odds are highest
2. **Waiting for a crossover** — the moment when the underdog's implied probability exceeds the favorite's (meaning the line has flipped)
3. **Auto-hedging on the original favorite** — now at plus-money — locking guaranteed profit on both outcomes

This is a risk-neutral profit strategy: you don't need to predict who wins.

---

## Why It Works: The Math

**American odds → decimal:**
- Positive: `D = 1 + (american / 100)` — e.g. +200 → 3.00
- Negative: `D = 1 + (100 / |american|)` — e.g. -350 → 1.286

**Equal-profit hedge formula:**
```
payout1     = S1 × D1
hedgeStake  = payout1 / D2
profit      = payout1 - S1 - hedgeStake
```

**Win-win condition: (D1 - 1)(D2 - 1) > 1**

When this holds, the total implied probability of your two bets is below 100%, meaning the bookmaker's vig doesn't eat your profit. This is the mathematical window where guaranteed profit exists.

**Example — slight-edge fight:**
- Fight opens: Fighter A -170 (D=1.588), Fighter B +145 (D=2.45)
- You bet Fighter B $10 @ +145 → payout = $24.50
- Line shifts: Fighter B is now -130 (D=1.769), Fighter A is now +115 (D=2.15)
- Crossover! Bet Fighter A $11.40 @ +115 → hedge stake = $24.50 / 2.15
- Fighter A wins: collect $24.50, net = $24.50 - $10 - $11.40 = **+$3.10**
- Fighter B wins: collect $24.50, net = $24.50 - $10 - $11.40 = **+$3.10**

Guaranteed $3.10 profit regardless of outcome.

**Why the vig doesn't always kill it:** DraftKings holds ~8-9% vig on balanced markets. But during a live fight, odds become highly imbalanced as sharp money floods in. When the underdog hits +200 after opening at +120, the implied probability has dropped dramatically — creating the profit gap despite the vig.

---

## Crossover Rates by Odds Range

Based on Ish's live recordings from real UFC fights:

| Odds range at fight start | Label | Crossover rate |
|---|---|---|
| Within ±120 | Even match | ~20% |
| -120 to -200 / +120 to +200 | Slight edge | **~42%** ← best |
| -200 to -400 / +200 to +400 | One-sided | ~28% |
| -400+ / +350+ | Dominant | ~8% |

**Slight-edge fights are the sweet spot.** They're competitive enough to flip but have enough of an initial gap to create a profitable hedge window when they do.

**Why heavy favorites occasionally flip:** A dominant fighter getting rocked in round 1 will see a massive line movement. The problem is the underdog needs to hit a very high plus-money line (e.g., +350+) for the hedge math to work — a narrow window that's easy to miss.

---

## The 9 Safety Guards

The system only fires when ALL of the following pass:

1. **Enabled** — config must have `enabled: true`
2. **Not a test fight** — fighter names can't start with "Test"
3. **Not already fired** — persistent `firedFights` Set (survives server restarts) prevents double-bet
4. **Session rate limit** — won't exceed `maxPerSession` bets per server session
5. **Fight not too old** — fight must have started within `maxFightAgeSecs` (default 300s = 5 min)
6. **Extension connected** — requires a live DraftKings extension heartbeat within last 5 minutes
7. **Valid odds** — opening odds must be a real number (not NaN / missing)
8. **Odds gap sufficient** — implied probability gap must be ≥ `minOddsGapPct` (default 5%)
9. **Correct bracket** — fight's opening odds must fall in a configured bracket

Guard #3 (persistent dedup) is critical — it means even if the server restarts during a live event, it won't double-bet a fight it already entered.

---

## Bracket Classification Logic

Brackets are determined by the **favorite's decimal odds** (the lower of the two):

```javascript
function classifyOddsBracket(f1Odds, f2Odds) {
  const d1 = toDecimal(f1Odds), d2 = toDecimal(f2Odds);
  const favD = Math.min(d1, d2);   // favorite always has lower decimal odds
  if (favD <= 1.333) return 'huge';   // -300+ (implied ≥ 75%)
  if (favD <= 1.500) return 'heavy';  // -200 to -300 (implied 67-75%)
  if (favD <= 1.833) return 'slight'; // -120 to -200 (implied 55-67%)
  return 'even';                      // within ±120 (implied ≤ 55%)
}
```

Thresholds match the `/api/patterns` endpoint so bracket labels are consistent across the dashboard.

---

## Crossover Detection

The crossover fires when the underdog's implied probability reaches or exceeds the favorite's:

```javascript
// content.js — runs in DraftKings tab, polls DOM every 1s
const crossed = leg2.implied >= leg1.implied;
if (crossed !== lastCrossover) {
  lastCrossover = crossed;
  if (crossed) send({ type: 'CROSSOVER_DETECTED', leg1, leg2, ts: Date.now() });
}
```

Implied probability (no vig removal — raw market):
- American > 0: `100 / (american + 100)`
- American < 0: `|american| / (|american| + 100)`

**Latency:** 1–3 seconds (reading DraftKings's own live DOM). This is faster than any API.

---

## Auto-Hedge Presets

| Preset | First bet | Brackets | Max / session | Notes |
|---|---|---|---|---|
| 🛡️ Safe | $5 | Slight only | 2 | Best crossover rate, minimal exposure |
| ⚖️ Balanced | $10 | Slight + heavy | 3 | More opportunities, still disciplined |
| 🔥 Aggressive | $15 | Even + slight + heavy | 5 | All non-dominant fights, higher volume |

Dominant fights (-400+) are excluded from all presets. The crossover rate is too low (~8%) to justify the capital exposure when leg 1 is at long underdog odds.

---

## Kelly Sizing (Future Direction)

The current system uses a fixed stake. Kelly Criterion would size leg 1 based on the estimated crossover probability and profit margin:

```
f = (p × b - q) / b
  where p = P(crossover), b = profit ratio, q = 1 - p
```

For a slight-edge fight with 42% crossover rate and +$3 profit on $10 stake:
```
f = (0.42 × 0.30 - 0.58) / 0.30 = (0.126 - 0.58) / 0.30 = -1.51
```

Kelly says don't bet — which makes sense, because without hedging you're negative EV. The hedge is what makes it +EV. A proper Kelly implementation would account for the conditional hedge profit once the crossover fires, not just the raw crossover probability.

---

## Limitations and Risks

1. **Vig eats small crossovers.** A fight that barely crosses (underdog goes from +145 to -105) produces a tiny or negative profit margin after vig.

2. **Fight ends before crossover.** If a fight ends via KO before the line crosses, leg 1 is still a live bet. The first-leg result is uncertain — you just have an underdog bet with no hedge.

3. **DraftKings suspends the market.** DK sometimes pulls odds during a fight stoppage review. The crossover watch keeps running but can't execute until the market reopens.

4. **Service worker killed during hedge.** Chrome MV3 SWs die after 30s idle. The content script keepalive port mitigates this, but if it fails, the hedge must be placed manually. The dashboard displays full manual hedge details as a fallback.

5. **Soccer/draw exposure.** MMA has two outcomes — this strategy fully covers both. Soccer has three (home/draw/away). Never use this on soccer without a third leg covering the draw.

6. **Historical data is from Ish's specific fights.** The crossover rates (42% for slight-edge, etc.) come from real recorded fights but are a sample. They may not hold across all fight styles or weight classes.
