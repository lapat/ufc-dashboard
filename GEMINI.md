# UFC Dashboard — System Architecture & Core Mandate

## ⚡ THE CORE 3-STEP ALGORITHM (HOW LIVEBETBOT WORKS)
1. **Capture bets from the live bets page using the extension:**
   - The user keeps a DraftKings **My Bets** tab open (https://sportsbook.draftkings.com/mybets).
   - The extension captures all open bets and in-play placements in real time via WebSocket and fetch interception, streaming them to /api/dk-sync.
2. **Capture odds from the odds page using the extension (ALWAYS 2 TABS OPEN):**
   - The user keeps a DraftKings **Fight/Event Odds** tab open (e.g. https://sportsbook.draftkings.com/event/...).
   - The extension automatically scans the live DOM moneylines every 1 second and pushes odds to /api/dk-odds-push every 2 seconds (fully automatic, zero button pressing required).
   - **Crucial Rule:** The user will ALWAYS have **two DraftKings tabs open** simultaneously: Tab 1 for My Bets, and Tab 2 for Live Odds.
3. **Show this on the website (LiveBetBot.com):**
   - The website correlates the user's real open bets against the moving odds in real time, calculating P&L, position coverage, and live hedge crossover targets.
   - **Backup Recorder:** The Odds API also runs continuously 24/7 as an always-on recorder backup capturing all live UFC fights.

## 🎯 CORE SYSTEM MANDATE (THE TWO NON-NEGOTIABLE FEATURES)
This application exists strictly to execute two primary features:
1. **Track bets in DraftKings via the extension:**
   - Real open bets pulled off DraftKings via `/api/dk-sync` into `dkBetsByUser` and served through `/api/dk-bets`.
   - Ish relies on this being 100% accurate for live P&L, position management, and hedge counting.
2. **Write down odds to data via the extension (PRIMARY), with the Odds API as BACKUP:**
   - The Chrome extension captures live odds directly off the DraftKings DOM every 2 seconds (`ext` files / `dk_captures.json`) as the fine-grained primary source of truth.
   - The external Odds API serves strictly as the secondary backup polling source when the extension is not actively streaming.

All other capabilities (dashboard UI, hedge math, crossover alerts, fighter photos) are strictly subordinate to keeping these two core data pipelines healthy and uncorrupted.

### 🚀 HIGH-DENSITY 1-SECOND FIGHT RECORDING (2026-10-24)
- **Problem Solved:** Fights previously appeared with only ~30 data points because:
  1. The server only pushed to `oddsHistory` when odds changed (`if (changed) record.oddsHistory.push(odds)`), discarding ~97% of samples.
  2. DraftKings `/event/...` pages lacked `/mma` in the URL path, causing `content.js` to tag them as sport `unknown` and dropping the pushes.
  3. The extension push interval was throttled to 2 seconds.
- **The 1-Second Capture Mandate:**
  1. `content.js` scans every 1 second and recognizes UFC fight event pages via title/round markers even without `/mma` in the URL.
  2. `background.js` pushes every 1 second (`PUSH_INTERVAL_MS = 1000`).
  3. `server.js` records **every single 1-second sample directly into `oddsHistory`**, guaranteeing **900+ data points for a 15-minute fight** and **1,500+ data points for a 25-minute championship fight**.
  4. `findSideNameNear` filters out social proof badge junk (e.g. "1.7k people placed this bet").

---

## Hard Operational Rules
1. **UFC Only:** Only UFC fights are recorded in `historical_data/`. Non-UFC data is quarantined to `quarantine_non_ufc/`.
2. **Persistence on Railway:** `DATA_DIR=/data` routes all writes to the persistent volume.
3. **Photos:** Sourced via ESPN CDN transparent cutouts into `DATA_DIR/fighter_images/`.
4. **Stats & Volatility:** Cached in `analysis/fighter_profiles.json` and sourced from `ufc_db.sqlite` (Apify cloud scraper as secondary).
