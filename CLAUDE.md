# UFC Dashboard — Project Rules

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

## Backfill

```bash
node backfill.js YYYY-MM-DD              # single date
node backfill.js 2025-08-01 2025-10-31  # date range
```

- Probes first: 2 API calls to check if any UFC fights exist for that date, skips if not
- Only overwrites existing files if recovered data has MORE points
- Run after every UFC event before touching any code

## After Every UFC Event — Checklist

1. `node backfill.js YYYY-MM-DD` (the event date)
2. Verify files in `historical_data/` look right
3. `git add historical_data/ && git commit -m "Add [event name] recordings"`
4. `git push`
5. ONLY THEN make any code changes

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

**3. `odds_api_backfill/` — Historical Odds API data (BROWSE ONLY)**
- Added by `backfill.js` from The Odds API historical endpoint
- Quality is inconsistent — sparse snapshots for old fights, trimming logic sometimes wrong
- **NEVER** use for AI brain, analysis, or answering questions
- **NEVER** move these files into `historical_data/` — they are not live recordings
- Browseable via the "Historical (Odds API)" tab on the library page only

### Rules that exist because of past fuck-ups:

**NEVER restore `historical_data/` from `"Bet Data Dec 2025 - May 2026"`** — it is stale and incomplete.
The canonical restore point is git: `git checkout <commit> -- historical_data/`
The pre-backfill baseline is commit `429ba49`.

**NEVER run `backfill.js` without checking if the target files already exist in `historical_data/`**
and have real live-recorded data. The no-overwrite logic is not foolproof — check manually first.

**NEVER run `trim-fights.js` on `historical_data/`** — it modifies live recordings.
It was written for old backfill data and has no business touching Ish's real recordings.

**NEVER overwrite a live recording with Odds API data**, even if the API data has more points.
Live data = Ish was watching. API data = pre-fight static odds reconstructed after the fact.

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
