# LiveBetBot / UFC Dashboard — Production Architecture & Engineering Bible

> **Project Stewardship:** Completely overhauled, maintained, and actively operated for Louis Lapat & Ish (Iskander Bagautdinov).  
> **Production Live URL:** https://www.livebetbot.com (https://ufc-dashboard-production-e03d.up.railway.app)  
> **Source Repository:** https://github.com/lapat/ufc-dashboard.git (Active branches: master and ish-version)

---

## ⚡ 1. The Core 3-Step Operating Algorithm (How LiveBetBot Works)

Ish's live fight-night routine is strictly two concurrent browser tabs on DraftKings paired with LiveBetBot:
1. **Tab 1: Bet Position Capture (sportsbook.draftkings.com/mybets):**
   * The Chrome extension intercepts DraftKings WebSocket packets and fetch traffic in real time.
   * Streams all open, in-play, and settled bet slips to /api/dk-sync.
2. **Tab 2: Live Odds Capture (sportsbook.draftkings.com/event/...):**
   * The extension scans the live in-play DOM moneyline buttons every 1 second.
   * Streams live odds to /api/dk-odds-push every 1 second (100% automated, zero clicks required).
3. **Live Analysis & Hedge Execution (livebetbot.com):**
   * Correlates real open positions against live price swings, calculates real-time P&L, and displays the Equal-Profit Hedge Lock (S2 = (S1 * D1) / D2).
   * **Backup Recorder:** The Odds API poller runs 24/7 as an always-on secondary recording daemon.

---

## 🔒 2. Non-Negotiable Hard Rules (The System Mandates)

1. **Strict In-Fight Live Window Only (Bell-to-Bell):**
   * Fights must **ONLY** record from the moment Round 1 begins (opening bell) until the referee stops the fight or final bell rings.
   * **Pre-fight odds (walkouts, scheduled start times, days in advance) must NEVER be recorded.**
   * TV broadcast start time (commence_time) is completely ignored because cage walks are dictated by prior bout finishes, not scheduled hours.
   * Only active DraftKings in-play indicators (LIVE badge, active round indicators like Round 1-5, or running countdown clock) permit recording.
2. **Zero Self-Fights / Distinct Fighter Mandate:**
   * Both buttons must resolve to two distinct human fighters. If both buttons resolve identically, the extension falls back to the event header (Fighter A vs Fighter B). If two names cannot be confirmed, the scan is aborted.
   * All names are decomposed via NFD Unicode normalization so diacritics (e.g. Lucia Szabova vs Lucia Szabová) never bypass equality checks.
   * /api/recordings strictly filters out any file where fighter1 === fighter2.
3. **UFC Only:**
   * Non-UFC fights (boxing, regional promotions) are automatically quarantined to quarantine_non_ufc/ and never pollute historical fight statistics.
4. **Volume Persistence on Host:**
   * DATA_DIR=/data routes all historical writes, state, and SQLite to the persistent host volume.

---

## 📊 3. The Quantitative Edge & Empirical Playbook

Mined across **398 live UFC fight recordings** paired with **2,701 fighter profiles**:

### A. The Crossover Catalyst Matrix (Line Flip Drivers)
* **Base Crossover Rate:** **41.5%** (165 of 398 fights experienced a moneyline flip).
* **🛡️ High Defense Dog vs Heavy Damage Fav:** **61.5% Crossover Rate** (Underdog StrDef > 60% vs Fav SApM > 4.0).
* **⚡ Multi-Catalyst Stacking (2+ flags):** **62.5% Crossover Rate** (e.g. Favorite Age 35+ stacked with Dog +3.0" reach advantage).
* **📏 Physical Reach Disparity (Dog >= +3.0"):** **48.3% Crossover Rate**.
* **⏳ Favorite Age Cliff (Age 35+):** **47.6% Crossover Rate**.
* **🛑 Grappler Suppression Warning:** **34.8% Crossover Rate** (Fav TD Avg >= 2.5 vs Dog TD Def < 60%) — *Wrestlers smother momentum; DO NOT bet the underdog.*

### B. Short-Notice Replacement Analytics (<14 Days)
* **Win Rate:** **32.0%** (Loss / Fade Rate: **68.0%**).
* **<7 Days Notice:** **28.0% Win Rate** (72.0% Loss Rate).
* **The Playbook (The Round 2 Cardio Cliff):** Short-notice fighters suffer severe cardio depletion from emergency weight cuts. If they fail to score a finish in Round 1, their gas tank collapses at **2:30 of Round 2**. Ish waits for the Round 1 stool break to bet the opponent at heavily discounted odds.

### C. In-Fight Timing Arc (When Crossovers Peak)
* **Round 1 (0:00–5:00):** **57%** — Primary live entry window during opening flurry.
* **Round 2 (5:00–10:00):** **39%** — Cardio fade / gas tank depletion window.
* **Round 3+ (10:00+):** **4%** — Hail Mary window (If the line has not flipped by Round 3, do not chase it).

### D. In-Fight Latency Arbitrage Alert (ESPN vs DraftKings Lag)
* The official ESPN UFC live scoreboard pushes strikes, knockdowns, and takedowns every 3 seconds.
* DraftKings traders experience a 3–8 second latency buffer before adjusting lines or suspending markets.
* When a knockdown or takedown occurs and DraftKings odds are stale (> 4.0 seconds old), the HUD displays:
  "⚡ ACTION SPIKE: Knockdown/Takedown logged on ESPN. DK line is stale by 4.8s. Exploit edge before suspension."

### E. The Equal-Profit Hedge Formula
The exact mathematical formula to equalize net profit on both fighters down to the penny:
  S2 = (S1 * D1) / D2
Where S1 is Dog Stake, D1 is Dog Decimal Odds, and D2 is Favorite Live Decimal Odds.
Win-Win condition guaranteed when: (D1 - 1) * (D2 - 1) > 1.

---

## 🎬 4. The Film Room & Video Architecture (/tape)

* **The Problem:** Ish watches the last 3 fights for every fighter on the upcoming card (~72 fights per card).
* **Video Platform Reality:**
  * **UFC Fight Pass:** Contains 100% of UFC/PRIDE/WEC fights unedited with corner audio. Deep links via https://ufcfightpass.com/search?query=...
  * **ESPN+:** Official US broadcast archive. Deep links via https://www.espn.com/watch/search/ufc%20...
  * **YouTube:** Official free fight drops and extended finish highlights.
  * *Important YouTube Rule:* YouTube deprecated listType=search in November 2020 (causes "Video unavailable"). **The Film Room strictly embeds verified 11-character YouTube video IDs** via /api/tape-embed.
* **Zero Dead Ends:** Every bout provides 1-click launchers for **[▶ Load in Theater]**, **[🥋 Fight Pass Master Tape]**, **[📺 ESPN+]**, and **[YouTube ↗]**.

---

## 🏗️ 5. Deployment & Infrastructure Strategy

### Why NOT Vercel for the Entire Backend?
Vercel is serverless (AWS Lambda). Functions freeze after each request and terminate after 10–60 seconds. LiveBetBot requires:
1. An always-on 24/7 background recorder (recPoll).
2. High-density 1-second WebSocket/HTTP streaming from the Chrome extension.
3. Stateful in-memory odds trajectory tracking (900+ points per fight).
4. Persistent volume storage (/data).
*Deploying the full backend to Vercel will kill the live fight recorder.*

### The Recommended Modernization Blueprint:
1. **Frontend Decoupling:**
   * Move public/ (Dashboard, /tape, /patterns, /library) to Cloudflare Pages or Vercel Edge.
   * Deploys in 3 seconds globally with instant cache invalidation.
2. **Backend Daemon (Stateful Container):**
   * Switch Railway from Nixpacks to a multi-stage Dockerfile.
   * Replaces 3-minute cold builds with **12-second Docker-layer cached builds**.
   * Alternative: Deploy container to Fly.io (flyctl deploy) with an attached NVMe volume.

---

## 🧪 6. Automated Production Test Harness

Run all test suites before any production deployment:
npm test

**Test Coverage (10 Suites, 153 Tests Verified):**
* test_fighter_stats.js: Volatility scoring, striking defense, cardio ratings.
* test_crossover_predictor.js: Tier mapping, implied probabilities, mathematical symmetry.
* test_crossover_detector.js: Live threshold triggers, trajectory analyzers.
* test_deriver.js: Round estimation, dominance scoring, finish speed.
* tests/1_test_hedge_math.js: Decimal conversion, equal-profit proofs.
* tests/2_test_stale_line_edge.js: ESPN vs DraftKings latency arbitrage triggers.
* tests/3_test_patterns_endpoint.js: API contract integrity, short-notice schemas.
* tests/4_test_live_and_self_fight_prevention.js: NFD Unicode normalization, self-fight rejection, live-only gate.
* tests/5_test_tape_engine.js: Past 3 bouts resolver, Fight Pass/ESPN/YouTube link generation.
* tests/6_test_tape_player.js: Dynamic real YouTube videoId resolution, zero "Video unavailable" errors.
