'use strict';
// athlete_db.js — stores every UFC.com athlete page we fetch, for personal use.
// Each fetch is a new SNAPSHOT: nothing is overwritten. Tables:
//   athlete_snapshots  one row per fetch (slug, time, name, source URL, full HTML file)
//   athlete_bio        bio fields (Status, Height, Reach, Weight, Age, ...) for a snapshot
//   athlete_stats      stat blocks (Sig. Str. Landed Per Min, Takedown Avg, By Position, ...)
// Raw HTML is kept in DATA_DIR/athlete_pages/ so the full page is always available.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_ROOT = process.env.DATA_DIR || __dirname;
const PAGES_DIR = path.join(DATA_ROOT, 'athlete_pages');
if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_ROOT, 'ufc_db.sqlite'));
db.exec(`
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
  CREATE INDEX IF NOT EXISTS idx_snap_slug ON athlete_snapshots(slug, fetched_at);
`);

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
  return { name, bio, stats };
}

// Saves one fetch as a new snapshot. Returns the snapshot id.
function saveAthleteSnapshot({ slug, html, sourceUrl }) {
  const fetchedAt = new Date().toISOString();
  const file = `${slug}__${fetchedAt.replace(/[:.]/g, '-')}.html`;
  fs.writeFileSync(path.join(PAGES_DIR, file), html);
  const { name, bio, stats } = parseAthlete(html);
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO athlete_snapshots (slug, name, fetched_at, source_url, html_file, html_bytes) VALUES (?,?,?,?,?,?)`)
      .run(slug, name || null, fetchedAt, sourceUrl, file, Buffer.byteLength(html));
    const id = Number(r.lastInsertRowid);
    const insBio = db.prepare('INSERT INTO athlete_bio (snapshot_id, key, value) VALUES (?,?,?)');
    for (const b of bio) insBio.run(id, b.key, b.value);
    const insStat = db.prepare('INSERT INTO athlete_stats (snapshot_id, section, label, suffix, value, ord) VALUES (?,?,?,?,?,?)');
    for (const s of stats) insStat.run(id, s.section, s.label, s.suffix, s.value, s.ord);
    db.exec('COMMIT');
    return id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function latestSnapshot(slug) {
  return db.prepare('SELECT * FROM athlete_snapshots WHERE slug = ? ORDER BY fetched_at DESC LIMIT 1').get(slug) || null;
}

function snapshotDetail(id) {
  return {
    bio: db.prepare('SELECT key, value FROM athlete_bio WHERE snapshot_id = ?').all(id),
    stats: db.prepare('SELECT section, label, suffix, value FROM athlete_stats WHERE snapshot_id = ? ORDER BY ord').all(id),
  };
}

function counts() {
  return {
    athletes: db.prepare('SELECT COUNT(DISTINCT slug) AS n FROM athlete_snapshots').get().n,
    snapshots: db.prepare('SELECT COUNT(*) AS n FROM athlete_snapshots').get().n,
    statRows: db.prepare('SELECT COUNT(*) AS n FROM athlete_stats').get().n,
  };
}

module.exports = { saveAthleteSnapshot, latestSnapshot, snapshotDetail, parseAthlete, counts, db };
