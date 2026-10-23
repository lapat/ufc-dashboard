# UFC Dashboard — System Architecture & Core Mandate

## 🎯 CORE SYSTEM MANDATE (THE TWO NON-NEGOTIABLE FEATURES)
This application exists strictly to execute two primary features:
1. **Track bets in DraftKings via the extension:**
   - Real open bets pulled off DraftKings via `/api/dk-sync` into `dkBetsByUser` and served through `/api/dk-bets`.
   - Ish relies on this being 100% accurate for live P&L, position management, and hedge counting.
2. **Write down odds to data via the extension (PRIMARY), with the Odds API as BACKUP:**
   - The Chrome extension captures live odds directly off the DraftKings DOM every 2 seconds (`ext` files / `dk_captures.json`) as the fine-grained primary source of truth.
   - The external Odds API serves strictly as the secondary backup polling source when the extension is not actively streaming.

All other capabilities (dashboard UI, hedge math, crossover alerts, fighter photos) are strictly subordinate to keeping these two core data pipelines healthy and uncorrupted.

---

## Hard Operational Rules
1. **UFC Only:** Only UFC fights are recorded in `historical_data/`. Non-UFC data is quarantined to `quarantine_non_ufc/`.
2. **Persistence on Railway:** `DATA_DIR=/data` routes all writes to the persistent volume.
3. **Photos:** Sourced via ESPN CDN transparent cutouts into `DATA_DIR/fighter_images/`.
4. **Stats & Volatility:** Cached in `analysis/fighter_profiles.json` and sourced from `ufc_db.sqlite` (Apify cloud scraper as secondary).
