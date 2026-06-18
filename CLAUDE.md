# UFC Dashboard — Project Rules

## ⚠️ THE CORE PURPOSE OF THIS PROJECT

**This project records LIVE in-fight DraftKings odds every second during UFC fights.**

That is the entire point. Ish watches live UFC fights and needs a tool that:
1. **Automatically detects when a UFC fight goes live** on DraftKings
2. **Records the live h2h moneyline every second** as it shifts during the fight
3. **Only saves a data point when odds change** (no duplicate timestamps)
4. **Persists the full odds arc** (start of fight → finish) to a JSON file in `historical_data/`
5. **Auto-pushes to GitHub** immediately after each fight via the Contents API

This live odds movement (e.g., Fighter A: -220 → +380 → -950 within a single fight) is what
Ish uses to identify live betting opportunities. It is NOT pre-fight odds. It is NOT Odds API
historical backfill. It is the live DraftKings line as it moves round by round.

### How it works

**The live endpoint:** `GET /v4/sports/mma_mixed_martial_arts/odds/?regions=us&markets=h2h&bookmakers=draftkings`
- Returns all upcoming AND in-progress UFC fights with current DraftKings odds
- Polled every 1 second during active fights, every 5 minutes when idle
- When a fight's `commence_time` is in the past and within 3 hours, it's treated as "live"
- DraftKings keeps h2h odds live throughout the fight as the action unfolds

**The recorder loop** lives inside `server.js` (function `recPoll`, starts automatically at boot).
- It runs 24/7 on Railway as part of `npm start` → `node server.js`
- Both the web server AND the recorder run in the same process
- No separate recorder process needed — it's embedded

**What a good fight file looks like:**
- 200–1000+ data points over 10–40 minutes (only odds-change events saved)
- Massive odds swings: e.g., Luna vs Pacheco — Luna opened -770, closed -6000 (743 pts, 38 min)
- `startTime` ≈ fight's actual in-ring start, `endTime` ≈ when fight leaves the live feed

### Verifying the recorder is alive

```bash
curl https://<railway-url>/api/recorder/status
curl https://<railway-url>/health
```

`/health` returns 503 if the last poll was >10 min ago (recorder stalled).

### If recording missed a fight

DraftKings live MMA odds are NOT available in the Odds API **historical** endpoint.
Testing confirmed: the historical API returns NO ODDS for fights during their in-progress window
(DraftKings appears to suspend the standard API endpoint for in-play lines, routing them through
their own live-betting platform instead). This means:

- **There is NO way to recover live in-fight odds for past fights from any known API**
- The Odds API historical endpoint (`/v4/historical/...`) only captures pre-fight line movement
- The `odds_api_backfill/` folder contains pre-fight data only — useful for line-movement
  context but NOT representative of how odds actually moved during the fight
- If the recorder was down during a card, that data is gone

**Implication:** Keep the recorder running at all times. Every missed fight = permanently lost data.

---

## ⚠️ CRITICAL: Historical Data Is Sacred — Never Destroy It

`historical_data/*.json` files are the core asset of this project. They represent
real fight recordings that cannot be recreated. Treat them like a database.

### NEVER do any of the following:
- Push code changes without first committing all new/modified `historical_data/` files
- Run `git checkout`, `git reset --hard`, or `git restore` on `historical_data/`
- Delete or truncate any fight JSON file
- Overwrite a fight file with fewer data points than it already has (backfill.js already enforces this — keep it)
- Push to Railway (via `git push`) while a live UFC event is recording — Railway redeploys on every push, killing the recorder and wiping any in-flight data not yet committed to git

### Before EVERY git push:
1. Run `git status` and check for any untracked or modified files in `historical_data/`
2. If any exist: `git add historical_data/ && git commit -m "Add/update fight recordings"`
3. THEN push your code changes

### How fight files are protected:
- **Live recordings**: `recorder.js` calls `pushFightToGitHub()` after each save — auto-commits to GitHub via Contents API. Requires `GITHUB_TOKEN` env var on Railway.
- **Backfill**: `node backfill.js YYYY-MM-DD` recovers data from Odds API historical endpoint. Only overwrites if recovered file has MORE data points.
- **GitHub = source of truth**: Railway's filesystem is ephemeral — it wipes on every deploy. Only what's in git survives.

### The three types of historical data files:
1. `historical_data/*.json` — fight odds recordings (committed to git, backed up to GitHub)
2. `historical_data/dk_bets_by_user.json` — Ish's DK bets (gitignored, repopulated by extension)
3. `historical_data/dk_captures.json` — raw DK captures (gitignored, repopulated by extension)

Files 2 and 3 are gitignored intentionally — they contain personal bet data and are
repopulated automatically. Do NOT add them to git.

---

## ⚠️ TODO: Cancel TheRundown Subscription

**Cancel at therundown.io** — logged-in account → billing → cancel Starter API plan ($49/mo).

Confirmed before canceling: TheRundown has NO historical in-play/live odds data accessible
via REST API on the Starter plan. In-play market (market_id=41) is absent on all past events.
Price history endpoint returns `{"error":"invalid marketID"}` for every format tried. The only
live data they have comes from the websocket feed (Pro plan only, real-time only — not archived).

Safe to cancel.

---

## Chrome Extension — Location and Reload

**Canonical extension path:** `/Users/louislapat/Desktop/vibe/fights/ufc-dashboard/dk-extension`

Chrome must be pointed at this exact folder. If the popup shows a stale version number
after reloading, Chrome is loading from a different folder (an old copy somewhere else).

**To verify / fix:**
1. `chrome://extensions` → find "Bet Bot — DK Sync" → click **Details**
2. Check the **Source** path — must be the path above
3. If wrong: click **Remove**, then **Load unpacked**, select the path above

**After any code change to `dk-extension/`:**
1. `chrome://extensions` → find "Bet Bot — DK Sync" → click **↺ reload**
2. Open the popup and verify the version matches `manifest.json`
3. Chrome does NOT auto-reload unpacked extensions — this step is always required

---

## After Every UFC Event — Checklist

1. Verify new fight files auto-committed to GitHub by recorder (check git log)
2. `git add historical_data/ && git commit -m "Add [event name] recordings"` if any weren't auto-committed
3. `git push`
4. ONLY THEN make any code changes

---

## ⚠️ CRITICAL: Data Sources — What Is What, Never Confuse Them

### Three completely separate data sources. Never mix them up.

**1. `historical_data/` — Ish's live recordings (CANONICAL SOURCE OF TRUTH)**
- Every file here was recorded in real-time by `recorder.js` while Ish was watching a live fight
- Auto-committed to GitHub via `pushFightToGitHub()` in recorder.js
- **This is the ONLY authoritative source.** Git history is the backup.
- When in doubt about what belongs here: `git log --oneline` → find the pre-backfill commit (429ba49) → that's the baseline of Ish's real recordings

**2. `"Bet Data Dec 2025 - May 2026"` folder (Desktop) — LOCAL BACKUP, NOT CANONICAL, OFTEN STALE**
- This is a manual local copy. It is NOT automatically updated when new fights are recorded.
- It will always lag behind `historical_data/` — after every UFC card, new fights will be in `historical_data/` but missing from this folder.
- **NEVER use this as the canonical source.** Use `historical_data/` (backed by git).
- To sync it: `comm -23 <(ls historical_data/*.json | xargs -I{} basename {} | sort) <(ls "Bet Data Dec 2025 - May 2026"/*.json | xargs -I{} basename {} | sort) | xargs -I{} cp historical_data/{} "Bet Data Dec 2025 - May 2026"/`

### Rules that exist because of past fuck-ups:

**NEVER restore `historical_data/` from `"Bet Data Dec 2025 - May 2026"`** — it is stale and incomplete.
The canonical restore point is git: `git checkout <commit> -- historical_data/`
The pre-backfill baseline is commit `429ba49`.

**NEVER run `trim-fights.js` on `historical_data/`** — it modifies live recordings.

**The Odds API historical endpoint does NOT contain live in-fight odds.** It captures pre-fight
snapshots every 5 minutes. DraftKings suspends its standard API feed when a fight goes live.
`backfill.js` and `odds_api_backfill/` have been deleted — do not recreate them. They were
useless for this project's actual purpose.

**After every UFC event**, sync `"Bet Data Dec 2025 - May 2026"` immediately:
```bash
comm -23 <(ls historical_data/*.json | xargs -I{} basename {} | grep -vE "^(dk_|bench|fighter)" | sort) \
         <(ls "/Users/louislapat/Desktop/vibe/fights/Bet Data Dec 2025 - May 2026/"*.json | xargs -I{} basename {} | sort) \
| while read f; do cp "historical_data/$f" "/Users/louislapat/Desktop/vibe/fights/Bet Data Dec 2025 - May 2026/"; done
```

---

## Railway / Deployment

- Every `git push` to master triggers a Railway redeploy
- Railway filesystem is wiped on every deploy — nothing outside git survives
- `GITHUB_TOKEN` must be set on Railway for live auto-commit to work
- Never push during a live UFC event (main cards: Sat ~10pm–2am ET)
