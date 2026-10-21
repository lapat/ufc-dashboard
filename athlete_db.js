'use strict';
// athlete_db.js — stores every UFC.com athlete page we fetch, for personal use.
// Each fetch is a new SNAPSHOT: nothing is overwritten. Tables:
//   athlete_snapshots  one row per fetch (slug, time, name, source URL, full HTML file)
//   athlete_bio        bio fields (Status, Height, Reach, Weight, ...) for a snapshot
//   athlete_stats      stat blocks (Sig. Str. Landed Per Min, Takedown Avg, By Position, ...)
// The database is SQLite run through sql.js (WebAssembly), so it needs no native build and
// works on any Node version. The file ufc_db.sqlite is rewritten after every save.
// Raw HTML is kept in DATA_DIR/athlete_pages/ so the full page is always available.
const fs = require('fs');
const path = require('path');

const DATA_ROOT = process.env.DATA_DIR || __dirname;
const PAGES_DIR = path.join(DATA_ROOT, 'athlete_pages');
const DB_FILE = path.join(DATA_ROOT, 'ufc_db.sqlite');
if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });

let db = null;
let initPromise = null;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS athlete_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL, name TEXT, fetched_at TEXT NOT NULL,
    source_url TEXT, html_file TEXT, html_bytes INTEGER
  );
  CREATE TABLE IF NOT EXISTS athlete_bio (
    snapshot_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT
  );
  CREATE TABLE IF NOT EXISTS athlete_stats (
    snapshot_id INTEGER NOT NULL, section TEXT, label TEXT, suffix TEXT, value TEXT, ord INTEGER
  );
  CREATE TABLE IF NOT EXISTS athlete_targets (
    snapshot_id INTEGER NOT NULL, target TEXT, pct TEXT, count TEXT
  );
  CREATE TABLE IF NOT EXISTS athlete_fights (
    snapshot_id INTEGER NOT NULL, status TEXT, date TEXT, opponent TEXT, result TEXT,
    method TEXT, round TEXT, time TEXT, event_url TEXT, ord INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_snap_slug ON athlete_snapshots(slug, fetched_at);
`;

// Loads (or creates) the database. Safe to call many times; disabled with a logged error if it fails.
function init() {
  if (!initPromise) {
    initPromise = require('sql.js')().then(SQL => {
      db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
      db.run(SCHEMA);
      persist();
      return true;
    }).catch(e => {
      console.error('[athlete-db] disabled:', e.message);
      return false;
    });
  }
  return initPromise;
}

function persist() {
  if (db) fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally { stmt.free(); }
}

const clean = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// Parses the fields we know about. The raw HTML is stored too, so nothing is lost if parsing is incomplete.
function parseAthlete(html) {
  const name = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
  const bio = [];
  const bioRe = /<div class="c-bio__label">([\s\S]*?)<\/div>\s*<div class="c-bio__text">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = bioRe.exec(html))) bio.push({ key: clean(m[1]), value: clean(m[2]) });

  const stats = [];
  let ord = 0;
  // Two-number comparison blocks: "8.26 Sig. Str. Landed Per Min"
  // Each group: number, label, and an optional unit ("Per Min"). Both sides of a block are picked up.
  const cmpRe = /<div class="c-stat-compare__number">([\s\S]*?)<\/div>\s*<div class="c-stat-compare__label">([\s\S]*?)<\/div>(?:\s*<div class="c-stat-compare__label-suffix">([\s\S]*?)<\/div>)?/g;
  while ((m = cmpRe.exec(html))) stats.push({ section: 'compare', label: clean(m[2]), suffix: m[3] ? clean(m[3]) : null, value: clean(m[1]), ord: ord++ });
  // Breakdown bars: title + "Standing 1230 (87%)"
  const barRe = /<h2 class="c-stat-3bar__title">([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2 class="c-stat-3bar__title">|<\/section>|$)/g;
  while ((m = barRe.exec(html))) {
    const title = clean(m[1]);
    const groupRe = /<div class="c-stat-3bar__label">([\s\S]*?)<\/div>\s*<div class="c-stat-3bar__value">([\s\S]*?)<\/div>/g;
    let g;
    while ((g = groupRe.exec(m[2]))) stats.push({ section: title, label: clean(g[1]), suffix: null, value: clean(g[2]), ord: ord++ });
  }
  // Hero block: record "18-2-0 (W-L-D)", division, rank, status, nickname, and finish counts ("9 Wins by Knockout").
  const heroI = html.indexOf('hero-profile__info');
  const hero = heroI >= 0 ? clean(html.slice(heroI, heroI + 6000)) : '';
  const rec = hero.match(/(\d+)-(\d+)-(\d+)\s*\(W-L-D\)/);
  if (rec) bio.push({ key: 'Record (W-L-D)', value: `${rec[1]}-${rec[2]}-${rec[3]}` });
  const finRe = /(\d+)\s+(Wins by [A-Za-z ]+|First Round Finishes|Finishes)/g;
  let f;
  while ((f = finRe.exec(hero))) bio.push({ key: f[2].trim(), value: f[1] });
  const nick = clean((html.match(/&quot;([^&]+)&quot;/) || [])[1] || '');
  if (nick) bio.push({ key: 'Nickname', value: nick });

  // Sig. Str. by target: each target block is percentage, count, label (Head / Body / Leg).
  const targets = [];
  const bodyI = html.indexOf('c-stat-body__diagram');
  if (bodyI >= 0) {
    const bodyText = clean(html.slice(bodyI, bodyI + 20000));
    const tRe = /(\d+%)\s+(\d+)\s+(Head|Body|Leg|Clinch|Ground|Distance)/g;
    let t;
    while ((t = tRe.exec(bodyText))) targets.push({ target: t[3], pct: t[1], count: t[2] });
  }

  // Fight history: past results (c-card-event--athlete-results) and upcoming (c-card-event--athlete-fight).
  const fights = [];
  const fRe = /<div class="c-card-event--athlete-(results|fight)__fight-container"([\s\S]*?)(?=<div class="c-card-event--athlete-(?:results|fight)__fight-container"|<\/section>|$)/g;
  let fm, fOrd = 0;
  while ((fm = fRe.exec(html))) {
    const block = fm[2];
    const txt = clean(block);
    const date = (txt.match(/([A-Z][a-z]{2}\. \d{1,2}, \d{4})/) || [])[1] || null;
    const val = label => (txt.match(new RegExp(label + ' (.+?)(?= (?:Round|Time|Method|Decision|Submission|KO|TKO|Round|Time|Method) |$)')) || [])[1] || null;
    const names = (txt.match(/([A-Za-z\-\' .]+?) vs ([A-Za-z\-\' .]+?)(?= [A-Z][a-z]{2}\. |$| Round| Time| Method)/) || []);
    const result = /class="[^"]*\bwin\b/.test(block) ? 'win' : /class="[^"]*\bloss\b/.test(block) ? 'loss' : /class="[^"]*\bdraw\b/.test(block) ? 'draw' : null;
    const eventUrl = (block.match(/href="([^"]*\/event\/[^"]*)"/) || [])[1] || null;
    fights.push({ status: fm[1] === 'fight' ? 'upcoming' : 'past', date, opponent: names[2] ? names[2].trim() : null,
      athlete: name, result, method: val('Method'), round: val('Round'), time: val('Time'),
      eventUrl, ord: fOrd++ });
  }
  return { name, bio, stats, targets, fights };
}

// Saves one fetch as a new snapshot. Returns the snapshot id. Throws if the database is unavailable.
async function saveAthleteSnapshot({ slug, html, sourceUrl }) {
  if (!(await init())) throw new Error('athlete database unavailable');
  const fetchedAt = new Date().toISOString();
  const file = `${slug}__${fetchedAt.replace(/[:.]/g, '-')}.html`;
  fs.writeFileSync(path.join(PAGES_DIR, file), html);
  const { name, bio, stats, targets, fights } = parseAthlete(html);
  db.run('BEGIN');
  try {
    db.run('INSERT INTO athlete_snapshots (slug, name, fetched_at, source_url, html_file, html_bytes) VALUES (?,?,?,?,?,?)',
      [slug, name || null, fetchedAt, sourceUrl, file, Buffer.byteLength(html)]);
    const id = all('SELECT last_insert_rowid() AS id')[0].id;
    for (const b of bio) db.run('INSERT INTO athlete_bio (snapshot_id, key, value) VALUES (?,?,?)', [id, b.key, b.value]);
    for (const s of stats) db.run('INSERT INTO athlete_stats (snapshot_id, section, label, suffix, value, ord) VALUES (?,?,?,?,?,?)',
      [id, s.section, s.label, s.suffix, s.value, s.ord]);
    for (const t of targets) db.run('INSERT INTO athlete_targets (snapshot_id, target, pct, count) VALUES (?,?,?,?)', [id, t.target, t.pct, t.count]);
    for (const f of fights) db.run('INSERT INTO athlete_fights (snapshot_id, status, date, opponent, result, method, round, time, event_url, ord) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, f.status, f.date, f.opponent, f.result, f.method, f.round, f.time, f.eventUrl, f.ord]);
    db.run('COMMIT');
    persist();
    return id;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

async function latestSnapshot(slug) {
  if (!(await init())) return null;
  return all('SELECT * FROM athlete_snapshots WHERE slug = ? ORDER BY fetched_at DESC LIMIT 1', [slug])[0] || null;
}

async function snapshotDetail(id) {
  if (!(await init())) return null;
  return {
    bio: all('SELECT key, value FROM athlete_bio WHERE snapshot_id = ?', [id]),
    stats: all('SELECT section, label, suffix, value FROM athlete_stats WHERE snapshot_id = ? ORDER BY ord', [id]),
  };
}

async function counts() {
  if (!(await init())) return { enabled: false, athletes: 0, snapshots: 0, statRows: 0 };
  return {
    enabled: true,
    athletes: all('SELECT COUNT(DISTINCT slug) AS n FROM athlete_snapshots')[0].n,
    snapshots: all('SELECT COUNT(*) AS n FROM athlete_snapshots')[0].n,
    statRows: all('SELECT COUNT(*) AS n FROM athlete_stats')[0].n,
  };
}

module.exports = { init, saveAthleteSnapshot, latestSnapshot, snapshotDetail, parseAthlete, counts };
