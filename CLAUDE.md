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

---

## ⚠️ CRITICAL: Three Non-Negotiable Guarantees — Fight Data Must Always Be

### 1. ALWAYS RECORDING — recorder must be running 24/7
- `recPoll` starts automatically at boot inside `server.js` — no separate process needed
- Verify: `GET /health` → `status: ok`. A `503` means the recorder stalled (last poll >10 min ago)
- Verify: `GET /api/recorder/status` → check `lastPoll` timestamp

### 2. ALWAYS WRITTEN TO PERSISTENT STORAGE — never the ephemeral filesystem
- Railway volume `ufc-dashboard-volume` is mounted at `/data`
- `DATA_DIR=/data` env var MUST be set on Railway — this is what routes all writes to the volume
- Without it, fight files go to `/app/historical_data` which is wiped on every redeploy
- Verify: `GET https://ufc-dashboard-production-e03d.up.railway.app/api/recorder/backup-status`
  - `volumeActive` must be `true`
  - `historicalDir` must be `/data/historical_data`
  - `ok` must be `true`
- **If `volumeActive` is ever `false`: DO NOT PUSH. Fix Railway env vars first.**

### 3. ALWAYS BACKED UP TO GITHUB — every completed fight pushed automatically
- `pushFightToGitHub()` is called in `recSave()` immediately when a fight ends
- `GITHUB_TOKEN` env var must be set on Railway (repo: `lapat/ufc-dashboard`)
- Verify: check `ok: true` in `/api/recorder/backup-status` (requires both DATA_DIR + GITHUB_TOKEN)

### Pre-deploy test commands — run BOTH before every push

```bash
# 1. Static code guarantees (no server needed) — 448 must pass, 0 fail
node test.js --local

# 2. Live server deploy gate — hits Railway, verifies volume + backup are active
node test.js
# Look for the 🔴 DEPLOY GATE tests — all 4 must pass
# If any fail: DO NOT DEPLOY until Railway env vars / volume are fixed
```

### What the deploy gate tests check (`node test.js`, prod only)
- `🔴 DEPLOY GATE: volumeActive must be true` — DATA_DIR points at mounted volume
- `🔴 DEPLOY GATE: historicalDir must be /data/historical_data` — not an ephemeral app path
- `🔴 DEPLOY GATE: ok must be true` — both DATA_DIR and GITHUB_TOKEN configured
- `🔴 DEPLOY GATE: write test` — dataDir is `/data`, not a git checkout path

### Railway env vars required (both must be set)
| Var | Value | Purpose |
|-----|-------|---------|
| `DATA_DIR` | `/data` | Routes all fight file writes to the persistent volume |
| `GITHUB_TOKEN` | (token) | Auto-commits completed fights to `lapat/ufc-dashboard` |

---

## AI Betting Agent — Autonomous Hedge System Spec

**Committed 2026-06-18. Deep research completed before implementation.**

### Vision

User types: *"Bet Canada $25, hedge on Qatar if the line flips"*
→ Claude Haiku parses intent → bot places leg 1 immediately → monitors DK DOM for crossover → auto-places hedge when triggered → guarantees profit on both outcomes.

### Stack

- `popup.js` — chat UI, strategy display
- `background.js` — message routing, bet placement via `chrome.scripting.executeScript`
- `content.js` — DK DOM watching (persistent, survives service worker kill), SSE relay
- Railway server — `/api/chat` (new), `/api/live-crossovers`, `/api/bet-coverage`
- Claude `claude-haiku-4-5-20251001` — intent parsing, <800ms latency target

### 1. NL Intent Parsing (`POST /api/chat`)

Server calls Claude Haiku with game context + open bets. Returns structured JSON:

```json
{
  "action": "bet" | "strategy" | "cancel" | "status" | "clarify",
  "bets": [{"side": "Canada", "amount": 25, "timing": "now" | "wait"}],
  "hedge": {"trigger": "crossover" | "odds_target" | "manual", "targetOdds": null, "autoExecute": true},
  "clarificationNeeded": null
}
```

System prompt template:
```
You are BetBot for DraftKings live sports. Parse the user's message into the JSON schema below.
Return ONLY valid JSON — no prose, no markdown fences.
Current game: {{gameContext}}
Open bets: {{openBets}}
Rules:
- side values must exactly match fighter/team names from the current game
- amount must be a positive USD number; if missing set action="clarify"
- "if line flips" / "when odds cross" → trigger="crossover", autoExecute=true
- "if line hits -120" → trigger="odds_target", targetOdds=-120
- When ambiguous: action="clarify", ask ONE specific question
```

Use prompt caching on the system block (`cache_control: {type: "ephemeral"}`). Cache reads cost 10% of full Haiku price.

**8 example input → output pairs to include as few-shot examples:**
1. `"Bet Canada $25"` → simple bet, timing=now
2. `"Bet Canada $25, hedge Qatar if line flips"` → strategy, crossover trigger
3. `"Put money on Canada"` → clarify (no amount)
4. `"Bet USA $30"` (game: Canada vs Qatar) → clarify (team not found)
5. `"Bet Qatar $30, hedge Canada when line hits -120"` → strategy, odds_target
6. `"Cancel the hedge"` → cancel
7. `"Bet Canada $20 and Qatar $20 right now"` → two immediate bets
8. `"What's the current strategy?"` → status

### 2. Hedge Math

**American odds → decimal:**
- Positive: `D = 1 + (american / 100)` (+150 → 2.50)
- Negative: `D = 1 + (100 / |american|)` (-350 → 1.286)

**Equal-profit hedge formula:**
```
payout1 = S1 × D1
S2 = payout1 / D2          (hedge stake for equal profit on both sides)
guaranteedProfit = payout1 - S1 - S2
```

**Break-even minimum hedge odds:**
```
Required D2 ≥ D1 / (D1 - 1)
Example: -350 (D1=1.286) → D2 ≥ 4.50 (+350 American)
```

**Vig kills small crossovers:** DK's combined implied probability is always >100% (~109% on -110/-110 markets). A hedge is only profitable when the combined implied probability of your two bets falls below 100%. This requires catching the dog at a significant underdog price (e.g., +300) before the line shifts.

**Worked example showing NOT profitable:** $25 at -350 (D1=1.286, payout=$32.14), hedge at +105 (D2=2.050) → S2=$15.68, total staked=$40.68, net=-$8.54. The line must move to at least +350 to break even on a -350 first leg.

**Soccer critical insight:** Soccer has 3 outcomes (home/draw/away). A two-leg hedge only covers 2/3 outcomes. Always detect `game.sport === "soccer"` and warn about draw exposure after placing both legs.

### 3. Trigger Architecture

**Primary (fastest): Content script watches DK DOM every 1s**
```javascript
// content.js polls odds buttons every 1s
// Reads aria-label or button text for current American odds
// When dogImplied >= favImplied → fire crossoverDetected event
```
Latency: 1–3s (DK's own live feed). Zero Odds API lag.

**Fallback: Server polls `/api/live-crossovers` every 5s**
Latency: up to 20s total (5s poll + 3-15s Odds API poll).

**MV3 service worker survival:**
- The 30s idle kill means `setInterval` in background.js is unreliable
- Content.js (runs in DK tab) is persistent — hold the watch loop there
- Use `chrome.runtime.connect` port from content.js → background to keep SW alive (Chrome 114+: open port resets idle timer)
- `chrome.alarms` at 1-minute intervals as a second-level fallback

### 4. Strategy State Machine

States: `IDLE → FIRST_BET_PENDING → FIRST_BET_PLACED → WATCHING_HEDGE → HEDGE_FIRED → BOTH_PLACED | HEDGE_FAILED`

Persisted in `chrome.storage.local` under key `"pendingStrategy"`:
```javascript
{
  id, state, game: {id, fighter1, fighter2, sport},
  leg1: {side, amount, odds, placedAt, betId, confirmed},
  hedgeConfig: {trigger, autoExecute, targetOdds, minProfitUSD: 1.00},
  leg2: {side, targetOdds, actualOdds, amount, placedAt, betId, confirmed},
  math: {leg1Payout, guaranteedProfit, totalStaked},
  createdAt, expiresAt,  // 4-hour expiry
  chatHistory, errorLog
}
```

**On service worker restart:** Read from storage. If state is `FIRST_BET_PENDING` or `HEDGE_FIRED`, check `/api/dk-bets` to verify if the bet landed. If state is `FIRST_BET_PLACED`, check if crossover already occurred while offline and notify user.

**On laptop close:** Hedge watch dies. On wake, check crossover status and inform user if they missed the window.

### 5. Error Modes (15 scenarios)

1. First bet placed but not in DK My Bets after 10s → pause strategy, alert user
2. Odds moved >8 points during verify window → abort hedge, keep watching
3. Market suspended during hedge attempt → wait for reopen, re-check
4. Service worker killed mid-hedge (MV3 30s limit) → on wake, check `/api/dk-bets`
5. Laptop closed with leg 1 open → on wake, notify of missed crossover window
6. Crossover on wrong game (two live simultaneously) → filter by `strategy.game.id`
7. Odds changed between verify and click → abort, notify with old vs new
8. DK "Accept New Odds" dialog during hedge → re-calculate profit, auto-accept if still profitable
9. Insufficient balance for hedge amount → show shortfall, offer reduced stake
10. First leg stake so small that hedge is below DK minimum ($1) → warn before entering WATCHING
11. User types "cancel" after leg 1 placed → clear strategy, warn that leg 1 is irrevocable
12. Network timeout during Place Bet → check My Bets before retrying (never blindly retry)
13. User navigated away from DK during 3s countdown → inject fails, provide manual hedge details
14. Both legs placed but one shows "Pending Review" → warn profit not guaranteed
15. Odds API outage → DOM watch becomes sole trigger; surface to user with current math

### 6. Triple-Verify (all 7 must pass before auto-hedge click)

1. **Game identity** — both team names in DOM match `strategy.game.fighter1/fighter2`
2. **Odds slippage** — current DK odds within ±8 American points of trigger odds
3. **Market not suspended** — no "Market Suspended" text in DOM
4. **Hedge still profitable** — re-run hedge math with current odds, profit ≥ `minProfitUSD`
5. **Bet slip empty** — no pre-existing bets in slip
6. **Balance sufficient** — DK available balance ≥ calculated hedge stake
7. **Leg 1 confirmed** — leg 1 betId exists in `/api/dk-bets` (not just "placed")

Any single failure → abort, set `HEDGE_FAILED`, surface all failed checks with specific messages, preserve full hedge details for manual placement.

### 7. Model Selection

**Use `claude-haiku-4-5-20251001` for all intent parsing.**

Cost: $1/$5 per MTok (3x cheaper than Sonnet). TTFT: ~200-400ms. Sufficient for slot-filling tasks.

With prompt caching on the system block: effective cost ~$0.20-0.25 per 1,000 bet commands.

**Escalate to Sonnet only when:** confidence < 0.60 (second-opinion parse), or command is multi-layered/complex.

**Idempotency:** Generate a deterministic key from intent fields before placing:
```javascript
sha256(userId + gameId + side + amount + Math.floor(Date.now() / 30000))
```
Store in Redis/chrome.storage. If key exists → return cached result, don't re-place.

### 8. UX Conversation Flow (happy path)

```
YOU:  Bet Canada $25, hedge Qatar if line flips

BOT:  Leg 1: Canada $25 @ -350 | Leg 2: Qatar auto-hedge on crossover
      Placing now — confirm? (y / cancel)

YOU:  y

BOT:  ✓ Leg 1 placed: Canada $25 @ -350 (payout: $32.14)
      [● WATCHING — Canada $25 @ -350]

[Line moves: Qatar hits -108]

BOT:  ⚡ CROSSOVER — Qatar -108 (was +280). Verifying (7/7 checks)...
      Hedge: Qatar $15.67 → Canada wins +$6.47 | Qatar wins +$5.52
      Auto-placing in 3s... (type STOP to cancel)

BOT:  ✓ Leg 2 placed: Qatar $15.67 @ -108. WIN-WIN LOCKED.
      ⚠ DRAW NOT COVERED — this is soccer (3 outcomes). Type "bet draw $X" to complete.
```

### 9. Tests (38 unit tests in test.js)

See `── AI Agent: Hedge Math ──`, `── AI Agent: Strategy Logic ──`, `── AI Agent: Trigger Conditions ──`, `── AI Agent: Triple Verify ──`, `── AI Agent: Error Recovery ──`, `── AI Agent: NL Intent Parsing ──` sections in test.js.

**All tests run with `node test.js --local` (no server needed for unit tests — they run before the async server block).**

### Implementation Checklist

- [ ] `POST /api/chat` server endpoint (Claude Haiku call + JSON parse + fallback)
- [ ] `americanToDecimal()`, `calculateHedge()`, `getSportOutcomes()` in shared utils
- [ ] `content.js` odds DOM watcher (1s poll on DK sportsbook tab)
- [ ] `background.js` strategy state machine (load/save chrome.storage.local)
- [ ] `background.js` triple-verify runner (7 checks before hedge click)
- [ ] `popup.js` strategy display + STOP command + 3s countdown
- [ ] Server: `GET /api/chat/status` for current strategy state
- [ ] Idempotency key before every bet placement
- [ ] Soccer 3-outcome draw exposure warning
