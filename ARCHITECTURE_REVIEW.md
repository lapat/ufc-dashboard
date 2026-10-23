# UFC Dashboard — Architecture Review and Plan

## FIGHTER PHOTOS AND ROSTER PLAN (2026-10-21)

**Resolution (2026-10-23): ESPN CDN Integration & 541 Fighter Profiles Hydrated**
- **Headshots Fixed:** Official transparent PNG cutouts downloaded directly from ESPN CDN (`espn_sync.js` / `sync_espn_active.js`). Losene Keita, Robert Bryczek, Douglas Silva de Andrade, Asaf Chopurov, Kai Kamaka III, and 100% of ranked UFC fighters now have verified high-res PNG cutouts saved in `ufc_local_data/fighter_images/`.
- **Roster & Stats Database:** The background crawl finished and populated `ufc_db.sqlite` with 2,638 fighters. `analysis/fighter_profiles.json` was hydrated from 406 to 541 fighters with strike defense, takedown avg, and computed volatility scores for `crossover_predictor.js`.
- **Apify Fallback:** `apify_fighter_stats.js` staged with Apify token in `.env` for scraping unindexed fighters via cloud residential proxies.
- **Smart Path Fallback:** `fighter_images.js` updated to automatically resolve local photos from `../ufc_local_data/fighter_images/` when `DATA_DIR` is unset.


**Why Losene Keita (and others) had no photo**
1. The photo lookup took the first large image on the athlete page. On many pages that is event artwork, not the fighter. Keita's page had event art first, so the wrong picture was saved.
2. The shared-image check then rejected that picture (it was shared with other fighters' event art), so the fighter was marked "shared" and retried with the same wrong answer.
3. The job only queued fighters from our recordings, so UFC fighters who have not fought in a recording were never tried at all.
4. Misses are retried only after 30 days, so one bad answer stayed in place for a month.
5. An earlier fallback (the social-share image) was a generic picture shared across unrelated fighters. Removed.

**Fixes in this round**
- Done: the fighter's own photo is the athlete page's `hero-profile__image`. Its file name must contain the fighter's surname, otherwise it is rejected.
- Done: event artwork is never used.
- Done: audit route removes saved photos whose file name lacks the surname, and marks them for refetch.

**Roster (every UFC fighter)**
- The event pages list every fighter on the card as a relative athlete link (`athlete/<slug>`). Our first search only looked for absolute links, which is why it missed fighters.
- Plan: (a) list all events from `/events?page=N` (past and upcoming), (b) read each event page for athlete slugs, (c) union into one roster, (d) fetch each athlete page once: photo, bio, stats, full HTML into the athlete database.
- Scale: several thousand fighters at 15 seconds each is many hours of crawling. Run in the background, upcoming events first, then the last two years, then older.
- Fallback for fighters with no hero photo on UFC.com: record them as "no photo", and look at a licensed source (Wikimedia Commons) before anything else.

**Not doing:** the athlete search page (`/athletes/all`), which robots.txt disallows.

## EXTENSION CAPTURE PLAN (2026-10-20)

**Goal:** every odds change on the DraftKings page reaches the server every 2 seconds, whatever the live status, and any gap is visible and explained.

**Findings**
- Pushes were arriving only in bursts. Last minute before the plan: 0 pushes for 35 seconds, then bursts of about 5 per 15 seconds.
- Two silent drops in the extension: no odds on screen (the scanner returned without logging), and fewer than two team names found (the background dropped the push without logging).
- Ish's browser was running version 1.8, which sent odds only during a LIVE badge. Fixed by reloading version 3.1.
- The push interval was 3 seconds, not the 2 seconds wanted.

**Steps**
1. Done: push interval 2 s (`background.js`).
2. Done: scan health every 30 s (scans, with odds, no odds, missing names, pushes ok/failed) logged in the extension and stored as `lastScanStats`.
3. Done: push failures logged, not ignored.
4. Done: server reports `pushesLastMinute` and `maxGapSecondsLast10Min` on `/api/recorder/status`.
5. Done: `test_extension_scan.js` runs the shipped scanner in a real browser against a DraftKings-style page (4/4 pass).
6. Next: Ish reloads version 3.2. Test on any live game, not only UFC: `pushesLastMinute` should be about 30 while odds are on screen, and the 30-second scan logs should show "had odds" near every scan.
7. Next: if `noOdds` dominates, the page is not showing the odds (view or scroll problem), and the fix is on the page side (e.g. scroll the game into view), not the interval.
8. Next: if `noTwoTeams` dominates, the team-name lookup needs the DraftKings markup, which we can read from the logged HTML.

**Not doing:** lowering the interval below 2 s. The page does not change faster than that, and the Odds API does not update faster than its own feed.

## PRIORITY PLAN: why so few data points, and confirming the extension captures fights (2026-10-19)

**Question:** a 15-minute fight sampled every 3 seconds should give about 300 points. Most files have 5 to 100.

**What is actually happening (verified):**
1. The recorder polls every 3 seconds during a live UFC fight (`UFC_POLL_MS = 3000`), but it only saves a point when the odds change. Points = number of odds changes, not number of polls. Most polls return the same odds, so most produce nothing.
2. The upstream feed does not refresh every 3 seconds. The Odds API `last_update` stayed at the same timestamp for over a minute while polled every 3 seconds (2026-10-19 23:18–23:19). So even a perfect poller only sees what the feed publishes. Whether live fights refresh faster is still unmeasured; that needs a live card.
3. The extension DOM capture (`ext` files) is the only source that could give finer, DraftKings-side data. It has pushed **0 odds updates** since the last deploy (`/api/recorder/status` `extPushes: 0`). Its live gate depends on a "LIVE" badge that has never been verified against a live DraftKings page. So the extension is **not yet confirmed** to capture fights.

**Plan, in order:**
- **P0 — confirm the extension captures a live fight (next UFC card, Saturday).** Watch `/status`: `extPushes` should climb during the fight, and `lastExtPush` should stay recent. If it stays at 0, the badge gate is wrong. Fix the gate (the manual "capture now" override is the backstop) before anything else.
- **P0 — record every poll, not only changes.** Store one sample per poll while a fight is live, each with a `changed` flag. That yields about 300 points per 15 minutes and keeps the change-only view as a derived field. Decision needed: this increases file size by roughly 10–20x for live fights. It is a few MB per card, which is fine.
- **P1 — measure feed freshness during a live fight.** Log the Odds API `last_update` on every poll (already fetched, not stored). This shows whether odds refresh every 3 seconds or every minute during a fight, so we know whether 3-second polling is the right rate.
- **P1 — use the extension as the fine-grained source if it works.** If the DOM refreshes faster than the feed, make `ext` captures the primary timeline and keep the Odds API as the cross-check.
- **P2 — verify the ext-capture pipeline end to end locally** with fake pushes (the file save after 5 min idle, the comparison endpoint).

**Done this session that affects the plan:** the grace period and resume (no more overwritten fragments), `pollStats` per recording (present/absent/changes), the `/status` page (extension counters, backups, data quality), and the Ish P&L join in `/api/patterns` (tested end to end: a settled bet matched to its fight and counted in the heavy-favourite bucket).



Reviewed 2026-10-19. Each finding is marked **verified** (checked against live data or code) or **open** (suspected, not yet confirmed).

---

## 1. What was found

### 1.1 Data loss risk: fight recordings were not backed up  (verified, fixed in code)

- 209 recordings existed on the Railway volume but not in git/GitHub: 145 UFC, 64 soccer and other sports. All were from June through October 2026.
- No automatic backup commit (`[auto] record` / `Auto-save fight`) exists on any branch. The per-save push has effectively never landed.
- Cause, in order of importance:
  1. `ghRequest()` resolved on any HTTP response and never checked the status code. A rejected write was logged as "Backed up".
  2. The push was fire-and-forget: no retry, no queue, no later check.
  3. `/api/recorder/backup-status` reported `ok: true` whenever the env var was set, so the health gate was green while backups failed.
- Fix (commit `f8ce77b`): status checks, a retry queue, a reconcile against the backup branch (on boot and every 30 min), and a token check against GitHub.
- **Root cause of the failures, confirmed live (2026-10-19):** the `GITHUB_TOKEN` on Railway can read the repo but gets `HTTP 403 Resource not accessible by personal access token` on every write. The original code could never have succeeded. The first token check only tested read access, so it passed.
- Fix: the health check now tests write permission (`permissions.push`). It will report `ok: false` until the token is replaced.

### 1.2 Backups committed to `master` would redeploy the server  (verified, fixed in code)

- Railway redeploys on every push to `master`, and a redeploy restarts the recorder. A backup commit landing during a card would interrupt the recording.
- Fix: backups now go to a `data-backup` branch (overridable with `GITHUB_BACKUP_BRANCH`).

### 1.3 Possible overwrite of existing recordings  (verified, fixed in code)

- `recSaveRecord()` replaced any existing file with the same fight id, even when the new file had fewer data points.
- Fix: a file is never replaced by a smaller recording. The smaller one is saved beside it as `<id>.partial-<ts>.json`. Writes are atomic (tmp file, then rename).

### 1.4 Destructive and write endpoints have no authentication  (verified, open)

The public Railway URL accepts these without any credentials:

| Endpoint | Risk |
|---|---|
| `POST /api/dk-mock` | Writes a fake bet into a user's bet list, which feeds the bet tracker |
| `DELETE /api/dk-captures` | Deletes the raw DraftKings capture log |
| `POST /api/recorder/stop-all`, `POST /api/recorder/stop/:id` | Stops live recordings |
| `POST /api/recorder/test` | Creates a test fight, and sends a completion email |
| `POST /api/recorder/backup-reconcile` (new) | Starts a GitHub reconcile. Harmless, but still unauthenticated |

Plan: require an `ADMIN_TOKEN` header on all of the above. This needs a Railway environment variable, which the available CLI token can't set, so it's a decision for you (see §4).

### 1.5 A test fight is committed as real data  (verified, open)

- `historical_data/mma_mixed_martial_arts/mma__testfighter_vs_testopponent_2026-06-12.json` is a fake recording from the test endpoint.
- Plan: move it to `historical_data/_test/`. It is not deleted, because the project rules forbid removing fight files. This is a git move, so it needs your go-ahead.

### 1.6 Recordings are sparse, and the check for it is broken  (verified, open)

- UFC recordings: median 101 data points, and 205 of 411 have fewer than 100. The project notes expect 200–1000 for a full fight.
- Recent fights (September–October) show 5–28 points, with gaps of 2–5 minutes while the odds are moving.
- The extension-vs-Odds-API comparison (`/api/ext-capture-comparison`) finds **0 pairs**. The check that would tell "the recorder is missing ticks" apart from "DraftKings didn't move the line" is not producing any output.
- Some files are junk: one is labelled "Monitoring Stopped" with 2 points. Others end with near-finish odds like −100000 / +4000, which look like suspended-market values.
- Plan: log per-fight poll stats (polls, changes, errors, longest gap), fix the ext-capture pipeline, and add a data-quality flag to the file metadata.

### 1.7 Tests describe features that were removed  (verified, open)

- `node test.js --local` has 349 passing and 123 failing. Most failures test the removed AI auto-bet, chat, and watch-trigger features.
- About half the suite greps source text (static checks). Those pass whether or not the code runs.
- Plan: delete the tests for removed features, and replace static greps with runtime tests where possible.

### 1.8 Code structure  (verified, open)

- `server.js` is about 1,950 lines and mixes routes, the recorder, DraftKings sync, and scheduling.
- `recorder.js` is dead code (nothing requires it), and it contains a second, unused GitHub push path.
- `public/index.html` is about 150 KB of inline HTML, CSS and JavaScript in one file.
- Two copies of the DraftKings extension exist: `fights/dk-extension` and `ufc-dashboard/dk-extension`. They have diverged, and the project notes point to a Desktop path that doesn't exist on this machine.

### 1.9 Storage design  (verified, open)

- Recordings are JSON files on a volume, mirrored to git. Bets are a JSON map. The P&L ledger is a JSON array.
- Everything is read whole into memory, and every save rewrites the whole file.
- Git holds more than 500 data files, so every data commit to `master` is also a code deploy. The `data-backup` branch fixes this for backups.

### 1.10 Monitoring  (verified, open)

- `/health` only reports the age of the last poll. Nothing alerts when backups fail, when the recorder stalls mid-card, or when a file is rejected.

### 1.10b Bet and P&L data were wiped on every deploy  (verified, fixed in code)

- The DK bet list, raw captures, and P&L ledger were written to the app folder, not the volume. Railway wipes the app folder on every deploy.
- Result: each deploy erased Ish's bet list (including settled bets) and the P&L history. The 2026-10-19 check showed zero bets for `ish` after deploys.
- The P&L ledger's history was not recoverable from this machine. The local copy only held test entries.
- Fix: DK state now lives in `DATA_DIR/dk_state` on the volume. Verified: a bet survives a restart.
- Recovery: the extension re-syncs open bets when My Bets is reopened. Settled-bet P&L before 2026-10-19 is lost.

### 1.11 What is fine

- No secrets are committed. The search of tracked files found none.
- The reconcile never overwrites a file that already exists remotely, and volume migration only copies missing files.

---

### Railway location (reference)

- Railway project: `agile-insight` (workspace "Louis Lapat's Projects")
- Service: `ufc-dashboard` (service id `c7e3fb51-78de-4306-81ff-798fec8885e5`)
- Environment: `production` (environment id `921a5c54-4aca-4fbf-a506-f67700a28c84`)
- Set `GITHUB_TOKEN` on this service's production environment.

## 2. Target architecture

1. **Recorder as its own process**, separate from the web server, so a web deploy can't stop a live recording. This is the biggest single reliability gain.
2. **A small database** (SQLite on the volume, or Postgres if the host allows) for recordings, bets, and captures. JSON stays as the export format so existing files keep working.
3. **Backups as a job, not a side effect.** A backup table records each file's hash and remote status. A worker syncs it, and an alert fires after N failures.
4. **Auth on write routes**, with a single `ADMIN_TOKEN` for admin actions and the extension's own token for `dk-sync`.
5. **Split the monolith**: routes, recorder, DraftKings sync, odds sources, and UI modules.
6. **Tests that run the code**: a fixture-based test per parser, a recorder test driven by replayed odds, and no grep tests for behaviour.

---

## 3. Plan

### Phase 1: stop data loss (mostly done)
- [x] Backup status checks, retry queue, reconcile (`f8ce77b`)
- [x] Backups to `data-backup`, not `master`
- [x] No-overwrite guard and atomic writes
- [x] Back up the 209 unbacked recordings (`c130c95`, on `ish-version`)
- [ ] **Replace the Railway `GITHUB_TOKEN` with one that has Contents: read and write on `lapat/ufc-dashboard`** (blocking; nothing backs up until this is done)
- [ ] Verify the live reconcile covers every volume file (after the token is replaced)
- [ ] Alert when the backup queue has items for more than 30 minutes
- [ ] Decide on the `master` vs `data-backup` question (§4)

### Phase 2: security (days)
- [x] `ADMIN_TOKEN` on `dk-mock`, `dk-captures` DELETE, `backup-reconcile`, `recorder/test` (fails closed; set on Railway 2026-10-19)
- [x] `dk-mock` gated behind the token (not called by any page or the extension)
- [x] Test fight file moved out of real data to `test_fixtures/` (git rename)
- [ ] Still open: `recorder/stop`, `stop-all`, `watch`, and `dk-odds-push` are unauthenticated. Dashboard and library pages call the stop and watch routes, so they need a token-in-page design first.

### Phase 3: recording quality
- [x] Grace period: a fight ends only after 3 min missing from the feed (was: first empty poll)
- [x] Resume: a returning fight continues its saved timeline instead of overwriting it (root cause of split, overwritten recordings, see local log: `King Green vs Terrance Mckinney` started twice, second overwrote first)
- [x] Per-fight poll stats saved with each recording (`pollStats`: present, absent, changes, resumes)
- [x] Status page `/status` with recorder, backup, data-quality, and extension counters
- [ ] Verify on the next UFC card: pollStats show whether gaps are feed misses or real flat odds
- [ ] Fix the ext-capture pipeline (0 pushes recorded; the live-badge gate is still unverified against DraftKings)
- [ ] Data-quality flags in the library (thin, junk, long gap)
- [ ] Pull the recorder into its own process

### Phase 4: structure (2–4 weeks)
- [ ] Move recordings and bets into SQLite, with JSON export
- [ ] Split `server.js` into route modules
- [ ] Delete `recorder.js` and tests for removed features
- [ ] Consolidate the extension into one copy

### Phase 5: UI and features
See the UI plan below. Each item gets its own test with real data, plus a mobile check.

---

## 4. Decisions needed from Louis

1. **Admin token.** Set `ADMIN_TOKEN` on Railway, or confirm you want the write routes left open.
2. **Test fight file.** OK to move it to `historical_data/_test/`?
3. **Backup branch.** Keep `data-backup` as the backup target (recommended), or back up to `master` and accept a redeploy on each backup?
4. **Recorder process.** Split it into its own Railway service? This is more setup but removes the main cause of mid-card interruptions.

---

## 5. UI and feature plan (not yet started)

Current state: one 150 KB page. Ish uses it mainly for live odds, bet coverage, and P&L.

| Area | Problem | Improvement |
|---|---|---|
| Live view | Hedge math and the odds chart are hard to read together | One panel: odds chart, hedge line, and P&L for the live fight |
| Bets | Only open bets are shown | Settled history, per-fight P&L, filter by user |
| Recordings | No way to see data quality at a glance | Library list with point count, longest gap, and a warning badge |
| Health | Health is a single green/red state | A status page showing recorder, backup queue, and DraftKings sync, with the last error for each |
| Mobile | Not checked at phone width | Check every page at 390 px before shipping |
| Features | The auto-bet and chat features were removed but still show in docs | Remove stale docs and tests so the project describes what it actually does |

Each change follows the project rules: test the live URL, check the page at mobile width, and screenshot the result.
