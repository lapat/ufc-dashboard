'use strict';
// roster.js — builds the full UFC roster from UFC.com and collects every fighter's data.
//  1. Walks /events?page=N until a page has no events (past and upcoming).
//  2. Reads each event page: every fighter on the card (athlete/<slug> links).
//  3. For each fighter, once per 30 days: saves the full athlete page into the database (bio, stats,
//     strike targets, fight history, whole HTML) and fetches the photo from that same page.
// One request at a time with the robots.txt crawl delay (15 s). Progress is saved in
// DATA_DIR/roster/state.json, so a restart resumes where it stopped.
const fs = require('fs');
const path = require('path');
const fi = require('./fighter_images');
const athleteDb = require('./athlete_db');

const DATA_ROOT = process.env.DATA_DIR || __dirname;
const ROSTER_DIR = path.join(DATA_ROOT, 'roster');
const STATE_FILE = path.join(ROSTER_DIR, 'state.json');
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
if (!fs.existsSync(ROSTER_DIR)) fs.mkdirSync(ROSTER_DIR, { recursive: true });

let state = { pagesDone: {}, eventsDone: false, events: {}, athletes: {}, running: false, lastError: null, startedAt: null, updatedAt: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), running: false }; } catch (_) {}
const save = () => { state.updatedAt = new Date().toISOString(); try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch (_) {} };

const uniq = arr => [...new Set(arr)];
// Retries a request up to 4 times with a growing pause (timeouts happen on UFC.com). Never throws.
let current = null; // what the crawler is doing right now, shown on roster-status
async function getRetry(url, binary = false) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    current = { url, attempt, since: new Date().toISOString() };
    try { const r = await fi.politeGet(url, binary); current = { ...current, lastHttp: r.status, done: new Date().toISOString() }; return r; }
    catch (e) { lastErr = e; current = { ...current, lastErr: e.message, failedAt: new Date().toISOString() }; await new Promise(r => setTimeout(r, 30000 * attempt)); }
  }
  return { status: 0, body: '', error: lastErr ? lastErr.message : 'unknown' };
}
const eventLinks = html => uniq([...html.matchAll(/href="[^"]*\/event\/([a-z0-9-]+)(?:#[^"]*)?"/g)].map(m => m[1]));
const athleteLinks = html => uniq([...html.matchAll(/href="[^"]*\/athlete\/([a-z0-9-]+)"/g)].map(m => m[1])).filter(s => s && s !== 'all');
const nameFromSlug = slug => slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

async function fetchAthlete(slug) {
  const rec = state.athletes[slug] || (state.athletes[slug] = { status: 'pending', from: [] });
  const latest = await athleteDb.latestSnapshot(slug);
  const fresh = latest && Date.now() - new Date(latest.fetched_at).getTime() < REFRESH_MS;
  if (fresh && rec.status === 'done') return;
  const r = await getRetry(`https://www.ufc.com/athlete/${slug}`);
  if (r.status !== 200) { rec.status = r.status === 404 ? 'miss' : 'retry'; rec.http = r.status; rec.checkedAt = new Date().toISOString(); return; }
  await athleteDb.saveAthleteSnapshot({ slug, html: r.body, sourceUrl: `https://www.ufc.com/athlete/${slug}` });
  await fi.photoFromPage(slug, nameFromSlug(slug), r.body);
  rec.status = 'done';
  rec.checkedAt = new Date().toISOString();
}

async function run() {
  if (state.running) return false;
  state.running = true; state.startedAt = state.startedAt || new Date().toISOString(); save();
  try {
    // 1. every page of the events list
    for (let page = 0; page < 5000 && !state.eventsDone; page++) {
      if (state.pagesDone[page]) continue;
      const r = await getRetry(`https://www.ufc.com/events?page=${page}`);
      if (r.status !== 200) { state.lastError = `events page ${page}: HTTP ${r.status} ${r.error || ''}`.trim(); save(); break; }
      const slugs = eventLinks(r.body);
      if (!slugs.length) { state.eventsDone = true; break; }
      for (const s of slugs) state.events[s] = state.events[s] || { page, done: false };
      state.pagesDone[page] = slugs.length;
      save();
    }
    // 2. every event: its fighters, and each fighter's data
    for (const [evSlug, ev] of Object.entries(state.events)) {
      if (ev.done) continue;
      const r = await getRetry(`https://www.ufc.com/event/${evSlug}`);
      if (r.status !== 200) { ev.error = `HTTP ${r.status} ${r.error || ''}`.trim(); save(); continue; }
      const athletes = athleteLinks(r.body);
      ev.athletes = athletes.length;
      for (const a of athletes) {
        const rec = state.athletes[a] || (state.athletes[a] = { status: 'pending', from: [] });
        if (!rec.from.includes(evSlug)) rec.from.push(evSlug);
      }
      save();
      for (const a of athletes) {
        try { await fetchAthlete(a); }
        catch (e) { state.athletes[a].status = 'error'; state.athletes[a].error = e.message; }
        save();
      }
      ev.done = true;
      save();
    }
  } catch (e) {
    state.lastError = e.message;
  } finally {
    state.running = false;
    save();
  }
  return true;
}

function status() {
  const byStatus = {};
  for (const a of Object.values(state.athletes)) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const events = Object.values(state.events);
  return {
    running: state.running,
    eventsFound: events.length,
    eventsDone: events.filter(e => e.done).length,
    eventsListComplete: state.eventsDone,
    athletes: Object.keys(state.athletes).length,
    athletesByStatus: byStatus,
    lastError: state.lastError,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    current,
    pagesDoneCount: Object.keys(state.pagesDone).length,
  };
}

module.exports = { run, status, eventLinks, athleteLinks };
