# UFC Dashboard — Project Rules

## ⭐ THE FEATURES ISH ACTUALLY USES — these always have to work (2026-08-25)

Ish's own priority list. Everything else in this doc is secondary to keeping these correct:

1. **Tracking and logging all live odds** — the core recorder (see "THE CORE PURPOSE OF THIS PROJECT" below). This is the top priority.
2. **DK bet tracking/sync** — the extension pulls Ish's real open bets off DraftKings (`/api/dk-sync` → `dkBetsByUser` → `/api/dk-bets`). He relies on this being accurate.
3. **Hedge math** — Ish hedges a lot. The odds-crossover live detection (`pollLiveCrossovers`, `/api/live-crossovers`, the `tracker-status` "HEDGE MOMENT / HEDGE NOW" banner) and the hedge stake/profit math are load-bearing. Do not confuse this with the removed AI auto-hedge chat agent below — this is the manual hedge-math display Ish actually watches and uses.
4. **Bet counting + P&L** — `/api/bet-coverage`, the position tracker, total-return display. Ish said this "is a very good counter" — keep it working as-is, don't rearchitect it without reason.

### Removed 2026-08-25: the "brain" recommendation panel (verdict / crossover-probability / value-edge)

`#brain-panel` in `public/index.html` (verdict BET/LEAN/PASS, book-vs-history odds comparison + "value/edge" tag, dog ROI, crossover-probability sub-panel, reasoning trail, sequence hold/reversal — backed by `reasoning.js` and `GET /api/edge`) was a pre-fight prediction/advice feature. **Ish doesn't use it and it wasn't working** — disabled by making `runBrainAnalysis()` a no-op early-return in `public/index.html`, so the panel (which defaults to `display:none`) is never shown and `/api/edge` is never called. The backend code (`reasoning.js`, `/api/edge`) was left in place (dead but harmless) rather than deleted, in case it's revisited later — do not re-enable it without Ish asking for it back.

### The AI auto-hedge NL chat agent spec — was NEVER actually built into the UI

The "AI Betting Agent — Autonomous Hedge System Spec" section further down this doc (chat like *"Bet Canada $25, hedge Qatar if line flips"*, triple-verify, watch-triggers, auto-bet) reads like a shipped feature but isn't one. As of 2026-08-25: `public/index.html` has no chat box, no FAB button, no auto-bet panel — none of it exists client-side. `node test.js --local` confirms this: every test for `/api/assistant`, `/api/watch-triggers`, `/api/auto-bet/*`, `executePlaceBet`, `CROSSOVER_DETECTED`, popup trigger UI, etc. (~100+ tests across sections I/J/K/L/N/O/P/R/S/T/V/W/X/Y/Z/AA) fails or 404s. Treat that whole spec section as a design doc for work that was never finished, not as documentation of working functionality — don't assume any of it runs, and don't burn time debugging "why isn't the AI hedge chat working" — it was never wired up. Ish did not ask for this to be built (2026-08-25) — leave it as unimplemented unless he asks for it.

### Bug fixed 2026-08-25: bet on a second (different) game silently erased the first bet

**Root cause:** DK's WebSocket sends two distinct message shapes to `/api/dk-sync` — `result.initial.bets` is a FULL snapshot of all currently-open bets (safe to fully replace stored state with — this is how settled/fake bets correctly get cleared out). `result.update.bets` is an INCREMENTAL delta (e.g. just the bet that was just placed). `parseDKBets()` in `server.js` treated both identically and fully replaced `dkBetsByUser` on every sync — so placing a second bet (e.g. a different soccer game, or a UFC bet) that arrived as an `update` delta silently wiped out every other bet the user already had open. This is very likely also the cause of "a UFC bet didn't get counted."

**Fix:** `parseDKBets()` now only does a full replace when `data.result.initial.bets` is present; an `update`-only payload is merged into the existing per-user bet map by `betId` instead. Regression test: `test.js` → "A bet placed on one game is not wiped out by an update.bets delta for a different game" (DK Sync section). Verified with `node test.js --local` — passes, plus every pre-existing dedup/resync test in that section still passes.

---

## ⚠️ PRIORITY #1: Recording enough live data points — known issue, in progress (2026-07-13)

**Recording live fight odds is the single most important thing this project does.** Everything
else (dashboard UI, position tracker, bet sync) is secondary. If the recorder isn't capturing
enough of a fight's live odds movement, the project is failing at its core purpose.

### What was observed

Checking `/monitor` on 2026-07-13 showed several July 12 UFC fights with only 6–16 data points
each (`nikitakrylov_vs_robertwhittaker`: 9 pts, `kinggreen_vs_terrancemckinney`: 6 pts,
`corysandhagen_vs_mariobautista`: 14 pts) — far below the 200–1000+ expected for a full fight
(see "What a good fight file looks like" below). This was flagged as a priority-one bug.

### What was investigated and found

1. **The main Odds-API recorder's poll-scheduling logic (`recPoll`/`recPollSport` in `server.js`)
   looks correct** — once a UFC fight is detected live, the poll interval correctly drops to
   `UFC_POLL_MS` (3000ms, not the 1s this doc previously — incorrectly — claimed elsewhere).
   No bug found here. `recPollSport`'s try/catch means a failed Odds API call can't crash the
   loop, and `recPoll` itself has no code path that throws, so it shouldn't silently die either.
   **Still worth hardening**: there's no `process.on('unhandledRejection', ...)` anywhere in
   `server.js` — if a future change introduces a throw inside `recPoll` (outside
   `recPollSport`'s own try/catch), the `setTimeout(recPoll, delay)` line would never execute
   and the recorder would go silently dead until the next Railway restart. Nothing currently
   guards against that class of bug. Consider adding a global handler that logs and
   re-schedules `recPoll` if this ever happens.
2. **No deploy/push landed during the July 12 card window** (checked git log) — ruling out
   deploy-triggered Railway restarts as the cause of that specific gap.
3. **A real, confirmed bug WAS found and fixed**: the DK extension's supplemental odds-push
   channel (`/api/dk-odds-push`, meant to add DOM-sourced granularity beyond the Odds API poll)
   had been **completely broken since it was added**. `content.js`'s `scanOddsFromPage()`
   produces odds under the field name `american`, but `dk-extension/background.js`'s
   `ODDS_UPDATE` handler read `o1.numericOdds` / `o2.numericOdds` — a field that never existed.
   Every push therefore sent `numericOdds1: undefined, numericOdds2: undefined`, which
   `JSON.stringify` drops entirely, so the server's `/api/dk-odds-push` always rejected it with
   `400 missing fields`. This exactly matches the test suite's own documented gap ("AC3/AC4 are
   static checks... no test POSTs to `/api/dk-odds-push` and confirms a data point appears").
   **Fixed 2026-07-13** — background.js now reads `.american`.
4. **Most likely remaining explanation for sparse data**: the Odds API's live feed itself may
   simply not reflect DK's true in-fight line movement with much granularity — this project has
   already documented elsewhere that the Odds API's *historical* endpoint has no live in-play
   data at all; it's plausible the *live* endpoint used by the recorder is similarly coarse.
   This can't be confirmed without a side-by-side comparison, which is what the new ext-capture
   feature below is for.

### The fix: an independent extension-based capture, for comparison

The DK extension already scans the live page's DOM every 1 second (`content.js`,
`scanOddsFromPage`) — this reads odds directly off what Ish sees on screen, completely
bypassing the Odds API. As of 2026-07-13 this is wired up as a **fully separate recording
stream**, so the two sources can be diffed after a fight to see which one actually captures
more of the real movement:

- `findOrCreateExtCapture()` / `saveExtCapture()` in `server.js` maintain their own
  `recorderState.extCaptures` map — entirely separate from `recorderState.activeFights` (the
  Odds-API recorder's map). They are **never merged**.
- Ext captures save to **`<fightId>_ext.json`** (same directory/naming as the normal file, just
  suffixed) — e.g. `nikitakrylov_vs_robertwhittaker_2026-07-12.json` (Odds API) vs
  `nikitakrylov_vs_robertwhittaker_2026-07-12_ext.json` (extension DOM capture). Never
  overwrites the canonical file.
- Not persisted to `recording_state.json` (unlike the main recorder) — an ext capture lost to a
  mid-fight restart is an acceptable tradeoff for a comparison-only stream; don't wire this into
  the crash-recovery path without reconsidering that tradeoff.
- Saved after 5 minutes of no new push (`EXT_CAPTURE_IDLE_MS`), independent of whatever the
  Odds-API recorder thinks the fight's live status is — the whole point is to not depend on
  the same signal being investigated.
- **Only fires while `content.js` detects a "LIVE" badge / round indicator on the page**
  (`findLiveBadge()`) — MMA moneylines look identical pre-fight and live (no spread to tell
  them apart), so without this gate we'd record Ish idly browsing a pre-fight page as if it
  were a live recording. **This heuristic is unverified against a real live DK page** — check
  the browser console for `[BetBot] live badge scan` (logged every 30s) next event. If it says
  "not found" while a fight is clearly live, DK's badge markup has changed and `findLiveBadge()`
  in `content.js` needs updating.
- **Manual override backstop, added 2026-07-13**: since the badge heuristic is unverified, the
  extension popup shows a "🥊 Fight Started — capture now" button. Clicking it sets
  `manualLiveUntil` (30 min from click) in `chrome.storage.local`; `content.js` treats `live`
  as true whenever `Date.now() < manualLiveUntil`, regardless of `findLiveBadge()`. Use this if
  the console log says "not found" during a fight that's clearly live. The popup also now shows
  "Watching: Fighter A vs Fighter B" with current odds and a LIVE/not-live badge, sourced from
  `chrome.storage.local.lastSeenFight` (written by `background.js` on every `ODDS_UPDATE`,
  regardless of live status, so Ish can see what the extension is looking at even pre-fight).

**Next event: compare the two files.** After the next card, look for pairs of
`<fightId>.json` / `<fightId>_ext.json` and compare `dataPoints` and the actual odds
timestamps/values. If the ext file consistently has more/finer data, the Odds API is the
bottleneck (consider making the extension the primary source). If they're similar, the sparse
data really is just how infrequently DK moves the live moneyline.

---

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
- Polled every 3 seconds during active fights (`UFC_POLL_MS`), every 5 minutes when idle
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

## ⚠️ MANDATORY: Visual Deployment Testing After Every UI Change

After every code push that touches any UI feature, take a Playwright screenshot of the deployed site and visually confirm the feature looks correct before reporting the task done.

**Playwright path:** `/Users/louislapat/.npm/_npx/bc46ece8a1067505/node_modules/playwright`

```javascript
const { chromium } = require('/Users/louislapat/.npm/_npx/bc46ece8a1067505/node_modules/playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto('https://ufc-dashboard-production-e03d.up.railway.app/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/deploy_verify.png' });
await browser.close();
```

- After pushing, wait ~60s for Railway to redeploy, then screenshot
- Read the screenshot with the Read tool and confirm the feature appears correctly
- If the feature requires interaction (e.g. adding a bet, clicking a fight), script it in Playwright and screenshot the result
- Do NOT report a UI task as done without a screenshot proving it works on the live deployment
- Type checking and test suites verify code correctness, not visual correctness — always verify visually

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
# 1. Static code guarantees (no server needed) — 456 must pass, 0 fail
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

## Test Suite — Complete Map (`test.js`, 456 tests)

**Single file:** `test.js` in the project root.  
**Run:** `node test.js --local` (all 456, no prod server needed) | `node test.js` (456 + prod-only gates).

### Three test types — know the difference

| Type | How it works | What it proves |
|------|-------------|----------------|
| **Runtime unit** | Calls real JS functions directly (no server) | Logic is correct at execution time |
| **Server HTTP** | Sends real HTTP requests to `target` URL | Endpoint exists and returns correct shape |
| **Static/structural** | Greps source file text for string patterns | Code was written; does NOT prove it runs |

**`node test.js --local`** hits `localhost:3000` for server tests — you must have `node server.js` running locally, OR skip those (they fail gracefully with connection refused). The pure unit tests and static tests run regardless.

**`node test.js`** hits Railway prod. The 🔴 DEPLOY GATE and 🔴 AC-LIVE tests only run in this mode.

### Section map (54 sections, 456 tests)

#### Pure runtime unit tests — these actually execute logic
| Section | Count | What it covers |
|---------|-------|----------------|
| Unit Tests | 25 | Odds parsing (unicode minus), bet parsing, connection health FSM, game-switch bet clearing, bet dedup, P&L calculation, settlement detection, odds delta display, DK banner states |
| Record Engine (Unit) | 6 | `require('./record_engine')` directly: export completeness, `pushFightToGitHub` no-throw without token, `migrateToVolume` no-op and copy-to-volume behavior, World Cup live window, soccer 3-outcome odds extraction |
| Bet Chat: parseBetCmd | 8 | Chat command parsing: amounts, sides, hedge triggers, clarify cases |
| Bet Coverage: gamification | 8+5 | `applyCoverage` P&L math, parlay exclusion, multi-user isolation |
| Bet Placement: DOM | 4 | Button text patterns DraftKings uses (selector strings) |
| Bet Placement: guard | 8 | Pre-click guard logic: balance check, min bet, slip empty |
| Bet Placement: sport outcomes | 4 | 2-outcome vs 3-outcome market detection |
| AI Agent: Hedge Math | 8+5 | `americanToDecimal`, `calculateHedge`, equal-profit formula, break-even minimum, vig impact |
| AI Agent: Trigger Conditions | 5 | `positive`, `negative`, `odds_threshold` condition logic |
| AI Agent: Strategy State Machine | 6 | State transitions: IDLE→FIRST_BET_PLACED→WATCHING→BOTH_PLACED, expiry, SW-restart resume |
| AI Agent: Triple Verify | 6 | All 7 pre-hedge checks: game identity, slippage, suspension, profitability, slip empty, balance, leg1 confirmed |
| AI Agent: NL Intent Parsing | 8 | Intent → structured JSON: `bet`, `strategy`, `cancel`, `status`, `clarify` |
| AI Agent: Error Recovery | 5 | 15-scenario error modes: bet not in MyBets, odds moved, network timeout, laptop close |
| A. NL Intent Parser | 15 | `parseChatResponse` function mirrored from server.js — all 8 example pairs + edge cases |
| B. Odds watcher math | 20 | `americanToImplied`, crossover detection, `oddsTargetMet` for both positive and negative odds |
| C. Strategy state machine | 17 | State machine transitions, expiry cleanup, storage persistence |
| C. tripleVerify gate | 20 | Full 7-check gate with all failure modes |
| D. STOP countdown | 6 | 3-second cancel window, STOP keyword parsing |
| E. Idempotency key | 8 | SHA256 key generation, 30s dedup window, duplicate bet blocking |
| F. Soccer draw exposure | 10 | Draw warning trigger, 3-outcome detection, warning suppression for non-soccer |
| G. Dashboard chat queue | 20 | Command lifecycle: created→picked_up→completed/failed, 30s stale cleanup |
| H. Mybets command-poll | 15 | Background.js polls pending commands from My Bets tab, SW self-message fix |
| M. Watch trigger logic | 3 | `positive`, `negative`, `odds_threshold` condition evaluation |
| Q. Bracket classification | 6 | Straight bet vs parlay vs parlay-leg detection |

#### Server HTTP tests — need a live server at `target`
| Section | Count | What it covers |
|---------|-------|----------------|
| Health | 1 | `GET /health` returns `status` field |
| Sports APIs | 3 | `GET /api/sports` shape, `GET /api/fights` shape, `/api/fights?sport=` filter |
| DK Sync | 8 | `POST /api/dk-sync`, bet storage, `GET /api/dk-bets`, user isolation, P&L endpoint |
| Recorder | 3 | `/api/recorder/status` fields, `/api/recorder/stop/:id`, session fight list |
| Library | 1 | `GET /library` returns HTML |
| DK Auth | 17 | Login, session, token refresh, `/api/session-count`, multi-session heartbeat |
| Pages | 2 | `GET /` returns HTML, `GET /library` returns HTML |
| New Features (Server) | 10 | `/api/live-score`, `/api/live-crossovers`, live score edge cases |
| Bet Coverage (Server) | 5 | `/api/bet-coverage` P&L with real DK sync data |
| Recording (Server) | 6 | `/api/recorder/status` fields + 🔴 4 DEPLOY GATE tests (prod only) |
| Bet Placement (Server) | 8 | `/api/live-crossovers`, `/api/bet-coverage`, command queue endpoints |
| K. /api/assistant | 7 | Intent classification endpoint: `bet`, `strategy`, `cancel`, `status`, `clarify` |
| L. Watch trigger CRUD | 4 | `POST /api/watch-triggers`, `GET`, `DELETE` |
| P. Auto-bet config CRUD | 5 | `GET/POST /api/auto-bet/config` |
| R. Auto-bet guard logic | 8 | `checkAutoBet` — bracket detection, auto-bet-off guard, dry-run flag |
| S. Safety integration | 5 | Auto-bet disabled by default, no accidental bet during normal chat |
| U. Auto-bet dry-run | 5 | `/api/auto-bet/test` — returns would-bet result without placing |
| W. Auto-hedge wiring | 15 | End-to-end: place leg1 → detect crossover → verify → place hedge |
| X. Score-tie trigger | 15 | Score-tie detection, trigger fire, dedup, multi-sport |

#### Static / structural tests — grep source files for code patterns
| Section | Count | What it proves (and what it DOESN'T) |
|---------|-------|--------------------------------------|
| AB. Volume persistence | 7 | `DATA_DIR` used in paths, `persistState` called on every update, `pushFightToGitHub` in `recSave`, volume path override at boot — **does NOT prove files actually write to `/data`** |
| AC. Recording reliability | 8 | `fetchJson` 10s timeout exists, `recFightId` sorts alphabetically, `/api/dk-odds-push` endpoint exists with `oddsHistory.push`, fuzzy match tries reversed order, `background.js` sends `numericOdds1`, `content.js` detects sport from URL, `/monitor` route exists, `pollHistory` in recorderState — **does NOT prove any of this runs correctly** |
| N. background.js checks | 3 | ODDS_UPDATE forwarded to popup, auto-bet disabled flag present, credential storage in `chrome.storage.local` only |
| O. content.js checks | 5 | `scanOddsFromPage` present, `findSideNameNear` present, crossover detection logic, trigger condition check |
| T. Structural checks | 7 | `recorderState` shape, poll loop boot, GITHUB_TOKEN guard, `pushFightToGitHub` call |
| AA. Popup trigger display | 10 | `renderTriggers()` function exists in popup.js, trigger cancel wiring, strategy detail render, `#triggersList` element |
| V. Auto-bet UI redesign | 10 | `auto-bet-panel` class, config fields, toggle switch present |
| Y. Safety guard fixes | 13 | Auth header helpers, auto-bet-off guard, bet slip check, credential security |
| Z. Security/session/expiry | 14 | Token storage, session heartbeat, strategy 4h expiry, CROSSOVER_DETECTED checks expiry |

#### Prod-only tests (run with `node test.js`, skipped with `--local`)
| Section | Count | What it checks |
|---------|-------|----------------|
| 🔴 DEPLOY GATE (in Recording) | 4 | `volumeActive=true`, `historicalDir=/data/historical_data`, `ok=true`, `dataDir=/data` |
| 🔴 AC-LIVE (in AC section) | 6 | `lastPoll` within 60s, `pollRateMs < 15000`, active recording has dataPoints > 0, data points growing over 10s, `pollHistory` length ≥ 2, `/monitor` responds with HTML |

### Known gaps in test coverage

These are real behaviors with NO runtime verification:

1. **`fetchJson` timeout** — AC1 only checks the string `req.setTimeout(10000` exists in source. No test actually fires a slow HTTP call and confirms it rejects after 10 seconds.
2. **Alphabetical fightId dedup** — AC2 only checks alphabetical sort exists in `recFightId`. No test sends two polls with flipped fighter names and confirms one file is produced, not two.
3. **Extension odds push end-to-end** — AC3/AC4 are static checks. No test POSTs to `/api/dk-odds-push` and confirms a data point appears in `oddsHistory`.
4. **GitHub backup actually fires** — `pushFightToGitHub` call is verified structurally (AB6), but no test confirms it produces a commit in the repo.
5. **Volume write path** — AB tests verify `DATA_DIR` is used in code paths. No test confirms a file written during a fight ends up at `/data/historical_data/` on the Railway filesystem.
6. **Monitor page data** — AC7 checks the route exists. No test confirms the page actually shows live `activeFights` data.
7. **Monitor file browser** — No test confirms clicking a file in the browser shows correct JSON. Three bugs were found and fixed in production:
   - Template literal `\'` → `'` SyntaxError (killed entire page script)
   - `/api/recordings` returns plain array but `data.fights || []` expected an object
   - `/api/fight-history/:id` only searched flat `HISTORICAL_DIR`, missed sport subfolders
8. **Odds label correctness** — No test confirms Uruguay -245 displays as Uruguay -245 (not +900). The extension may send fighters in reversed DOM order (Away first); normalization now happens in the status endpoint.

---

## /monitor Page — Architecture and Known Pitfalls

**URL:** `https://ufc-dashboard-production-e03d.up.railway.app/monitor`

The monitor is a single inline HTML page served from `server.js` at the `/monitor` GET route (~line 1494). It polls two endpoints every 2 seconds:

- `GET /api/recorder/status?history=1` — live recording state, poll rate, full oddsHistory for charts
- `GET /api/recordings` — list of completed fight files (for the file browser)
- `GET /api/fight-history/:id` — full JSON for a selected fight file (on click)

### Critical: template literal escaping in inline HTML

The monitor HTML is a Node.js backtick template literal inside `res.send(...)`. Any `\'` inside the template becomes `'` in the rendered output — it does NOT produce a literal backslash. This caused a hard-to-find SyntaxError (the whole page script died silently):

```javascript
// BROKEN: \' in template literal renders as ', making two adjacent string literals
'onclick="selectFile(\'' + f.id + '\')"'
// → rendered: onclick="selectFile('' + f.id + '')"  ← SyntaxError

// FIXED: use data-id attribute, no escaping needed
'data-id="' + f.id + '" onclick="selectFile(this.dataset.id)"'
```

**Rule:** Never use `\'` inside the monitor's template literal. Use `data-*` attributes for any value that would need escaping in onclick strings.

### Critical: /api/recordings returns a plain array, not an object

```javascript
// WRONG:
allFiles = (data.fights || []).sort(...)  // data.fights is always undefined

// CORRECT:
allFiles = (Array.isArray(data) ? data : (data.fights || [])).sort(...)
```

### Critical: /api/fight-history/:id must search sport subfolders

Non-MMA files are saved to `HISTORICAL_DIR/<sport>/<id>.json` (e.g. `soccer_fifa_world_cup/`). The endpoint must search one level of subdirectories, not just the flat root. If it only scans the root, all soccer/basketball/etc files return 404, and the monitor silently shows `{ "oddsHistory": [] }`.

### Critical: Extension may push fighters in reversed DOM order

DraftKings renders the Away team's odds button first in the DOM. The extension sends `o1 = outcomes[0]` which may be the Away team, not the Home team. This creates a mismatch between `record.meta.fighter1` (from the Odds API or first extension push) and `lastOdds.fighter1.name`.

**Fix (in `/api/recorder/status`):** Before returning each fight's `lastOdds` and `oddsHistory`, check if `lastOdds.fighter1.name === record.meta.fighter1`. If not, swap the fighter1/fighter2 slots in the response. This normalizes display without touching storage.

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
