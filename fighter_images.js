'use strict';
// fighter_images.js — personal-use fighter photo cache, sourced from the UFC.com athlete page.
// Rules this module follows:
//  - Only /athlete/<slug> pages and their image files. Never /athletes/all (disallowed in robots.txt).
//  - One request every 15 seconds (robots.txt crawl-delay: 15).
//  - Images live in DATA_DIR/fighter_images, NEVER in historical_data.
//  - A miss is remembered for 30 days so the same fighter is not retried on every fight.
const fs = require('fs');
const path = require('path');
const https = require('https');
const athleteDb = require('./athlete_db');

const DATA_ROOT = process.env.DATA_DIR || __dirname;
const IMG_DIR = path.join(DATA_ROOT, 'fighter_images');
const INDEX_FILE = path.join(IMG_DIR, 'index.json');
const CRAWL_DELAY_MS = 15000;
const RETRY_MISS_MS = 30 * 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (personal fight-tracker cache; contact: louislapat@gmail.com)';

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
let index = {};
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch (_) {}
const saveIndex = () => { try { fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2)); } catch (_) {} };

// "Lone'er Kavanagh" -> "loneer-kavanagh"; "Mansur Abdul-Malik" -> "mansur-abdul-malik"
function slugify(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function get(url, binary) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), binary));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Sequential queue, one fetch per CRAWL_DELAY_MS.
const queue = [];
let running = false;
let lastRequestAt = 0;
async function pause() {
  const wait = lastRequestAt + CRAWL_DELAY_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function fetchOne(name) {
  const slug = slugify(name);
  if (!slug) return;
  const entry = index[slug];
  if (entry && entry.status === 'found' && fs.existsSync(path.join(IMG_DIR, entry.file))) return;
  if (entry && entry.status === 'miss' && Date.now() - new Date(entry.checkedAt).getTime() < RETRY_MISS_MS) return;

  await pause();
  let page;
  try { page = await get(`https://www.ufc.com/athlete/${slug}`, false); }
  catch (e) { index[slug] = { status: 'error', error: e.message, checkedAt: new Date().toISOString() }; saveIndex(); return; }
  if (page.status !== 200) { index[slug] = { status: 'miss', http: page.status, checkedAt: new Date().toISOString() }; saveIndex(); return; }
  // Keep the whole page: every fetch becomes a new snapshot in the athlete database (never overwritten).
  try { await athleteDb.saveAthleteSnapshot({ slug, html: page.body, sourceUrl: `https://www.ufc.com/athlete/${slug}` }); }
  catch (e) { console.error('[athlete-db]', slug, e.message); }

  // Photo: try the best size first, then fall back. Skips generic GIF placeholders.
  const candidates = [
    /src="(https:\/\/[^"]*\/card_advance_small_280x356\/[^"]+?\.(?:jpg|jpeg|png))/i,
    /src="(https:\/\/[^"]*\/athlete_bio_full_body\/[^"]+?\.(?:jpg|jpeg|png))/i,
    /src="(https:\/\/[^"]*\/event_results_athlete_headshot\/[^"]+?\.(?:jpg|jpeg|png))/i,
  ];
  let m = null;
  for (const re of candidates) { const hit = page.body.match(re); if (hit) { m = hit; break; } }
  if (!m) { index[slug] = { status: 'miss', reason: 'no photo on page', checkedAt: new Date().toISOString() }; saveIndex(); return; }

  await pause();
  try {
    const img = await get(m[1], true);
    if (img.status !== 200 || img.body.length < 1000) throw new Error(`image HTTP ${img.status}`);
    const ext = path.extname(new URL(m[1]).pathname).toLowerCase() || '.jpg';
    const file = `${slug}${ext}`;
    const md5 = require('crypto').createHash('md5').update(img.body).digest('hex');
    const clash = Object.entries(index).find(([k, v]) => k !== slug && v.md5 === md5 && v.status === 'found');
    if (clash) {
      index[slug] = { status: 'shared', md5, sharedWith: clash[0], source: m[1], checkedAt: new Date().toISOString() };
      saveIndex();
      return;
    }
    fs.writeFileSync(path.join(IMG_DIR, file), img.body);
    index[slug] = { status: 'found', file, md5, source: m[1], checkedAt: new Date().toISOString() };
  } catch (e) {
    index[slug] = { status: 'error', error: e.message, checkedAt: new Date().toISOString() };
  }
  saveIndex();
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const name = queue.shift();
    try { await fetchOne(name); } catch (e) { console.error('[fighter-images]', name, e.message); }
  }
  running = false;
}

// Called when a fight starts recording. Queues any fighter we do not have yet.
function requestFighterImages(names) {
  for (const n of names) {
    if (!n || queue.includes(n)) continue;
    queue.push(n);
  }
  drain();
}

function imageFileFor(name) {
  const e = index[slugify(name)];
  return e && e.status === 'found' && fs.existsSync(path.join(IMG_DIR, e.file)) ? path.join(IMG_DIR, e.file) : null;
}

function status() {
  const counts = {};
  for (const e of Object.values(index)) counts[e.status] = (counts[e.status] || 0) + 1;
  return { counts, queued: queue.length, running, imageDir: IMG_DIR };
}

// Finds cached photos that more than one fighter has (a generic image), deletes them, and marks the
// fighters so they are fetched again. Returns the groups it found.
function auditSharedPhotos() {
  const byHash = {};
  for (const [slug, e] of Object.entries(index)) {
    if (e.status !== 'found' || !e.file || !fs.existsSync(path.join(IMG_DIR, e.file))) continue;
    const md5 = require('crypto').createHash('md5').update(fs.readFileSync(path.join(IMG_DIR, e.file))).digest('hex');
    e.md5 = md5;
    (byHash[md5] = byHash[md5] || []).push(slug);
  }
  const groups = [];
  for (const [md5, slugs] of Object.entries(byHash)) {
    if (slugs.length < 2) continue;
    groups.push(slugs);
    for (const slug of slugs) {
      try { fs.unlinkSync(path.join(IMG_DIR, index[slug].file)); } catch (_) {}
      index[slug] = { status: 'shared', md5, sharedWith: slugs.filter(x => x !== slug), checkedAt: new Date().toISOString() };
    }
  }
  saveIndex();
  return groups;
}

module.exports = { auditSharedPhotos, slugify, requestFighterImages, imageFileFor, status, index: () => index };
