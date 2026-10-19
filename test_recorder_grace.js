'use strict';
// test_recorder_grace.js — runs the REAL server against a fake Odds API so a fight can be
// made to drop out of and reappear in the feed on demand. Checks that:
//  1. a one-poll gap does NOT end the recording (no second START, no overwrite)
//  2. a sustained absence DOES end it, and the file keeps every point plus poll stats
//  3. a fight that comes back resumes its saved timeline (RESUME, never a smaller overwrite)
// Run: node test_recorder_grace.js   (uses ports 4555 and 3300, a temp DATA_DIR, no GitHub)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const FAKE_PORT = 4555, SERVER_PORT = 3300;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-grace-'));
let mode = 'present'; // 'present' | 'absent'
let tick = 0;
const fakeStart = new Date(Date.now() - 60 * 1000).toISOString();

const fake = http.createServer((req, res) => {
  const isUfc = req.url.includes('/sports/mma_mixed_martial_arts/odds/');
  let body = [];
  if (isUfc && mode === 'present') {
    tick++;
    body = [{
      id: 'fake-1', sport_key: 'mma_mixed_martial_arts', home_team: 'Fighter Alpha', away_team: 'Fighter Beta',
      commence_time: fakeStart,
      bookmakers: [{ key: 'draftkings', markets: [{ key: 'h2h', outcomes: [
        { name: 'Fighter Alpha', price: -200 - tick }, { name: 'Fighter Beta', price: 150 + tick }] }] }],
    }];
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'x-requests-remaining': '999' });
  res.end(JSON.stringify(body));
});

const logLines = [];
const server = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(SERVER_PORT), DATA_DIR, ODDS_BASE_URL: `http://localhost:${FAKE_PORT}/v4`,
    ODDS_API_KEY: 'test-key', RECORDER_GRACE_MS: '3000', IDLE_POLL_MS: '3000', GITHUB_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => logLines.push(...String(d).split('\n')));
server.stderr.on('data', d => logLines.push(...String(d).split('\n')));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = async () => JSON.parse(await (await fetch(`http://localhost:${SERVER_PORT}/api/recorder/status`)).text());
const fightId = 'fighteralpha_vs_fighterbeta_' + new Date().toISOString().slice(0, 10);
const fileFor = () => path.join(DATA_DIR, 'historical_data', `${fightId}.json`);
const starts = () => logLines.filter(l => l.includes('REC START') && l.includes('Fighter Alpha')).length;
const resumes = () => logLines.filter(l => l.includes('REC RESUME') && l.includes('Fighter Alpha')).length;

(async () => {
  let passed = 0;
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.log('  ✗', name, '-', e.message); process.exitCode = 1; }
  };
  await new Promise(r => fake.listen(FAKE_PORT, r));
  console.log('starting server (fake Odds API on :' + FAKE_PORT + ')...');
  for (let i = 0; i < 40; i++) { try { await status(); break; } catch (_) { await sleep(250); } }

  console.log('── recorder grace / resume (real server, fake Odds API) ──');
  mode = 'present';
  await sleep(9000);
  await check('fight starts recording once it is in the feed', async () => {
    const s = await status();
    assert.ok(s.activeFights.some(f => f.id === fightId), 'not recording ' + fightId);
    assert.strictEqual(starts(), 1, 'expected exactly one START');
  });

  mode = 'absent';
  await sleep(4000);
  await check('a short gap (less than the grace period) does NOT end the recording', async () => {
    const s = await status();
    assert.ok(s.activeFights.some(f => f.id === fightId), 'recording ended on a short gap');
    assert.ok(!fs.existsSync(fileFor()), 'file written too early');
  });

  mode = 'present';
  await sleep(6000);
  await check('fight reappearing does not restart the recording (no second START)', async () => {
    assert.strictEqual(starts(), 1, `START logged ${starts()} times`);
    const s = await status();
    assert.ok(s.activeFights.some(f => f.id === fightId), 'lost the recording');
  });

  mode = 'absent';
  await sleep(18000);
  await check('a sustained absence ends the recording and saves every point with poll stats', async () => {
    assert.ok(fs.existsSync(fileFor()), 'file not saved after sustained absence');
    const f = JSON.parse(fs.readFileSync(fileFor(), 'utf8'));
    assert.ok(f.dataPoints >= 6, `expected >= 6 points, got ${f.dataPoints}`);
    assert.strictEqual(f.oddsHistory.length, f.dataPoints);
    assert.ok(f.pollStats && f.pollStats.present > 0 && f.pollStats.absent > 0, 'pollStats missing: ' + JSON.stringify(f.pollStats));
    assert.ok(Array.isArray(f.samples) && f.samples.length >= f.pollStats.present, `samples (${f.samples && f.samples.length}) must include every poll (present=${f.pollStats.present})`);
    assert.ok(f.samples.length >= f.dataPoints, 'samples must be at least as many as change points');
    assert.strictEqual(f.samplePoints, f.samples.length, 'samplePoints must match samples');
    global.savedPoints = f.dataPoints;
  });

  mode = 'present';
  await sleep(12000);
  await check('a fight that returns after being saved resumes its file, never shrinks it', async () => {
    if (resumes() < 1) console.log('DEBUG recorder lines:', logLines.filter(l => /REC|Saved|error/i.test(l)).slice(-8));
    assert.ok(resumes() >= 1, 'expected a RESUME log line');
    const f = JSON.parse(fs.readFileSync(fileFor(), 'utf8'));
    assert.ok(f.dataPoints >= global.savedPoints, `file shrank: ${global.savedPoints} -> ${f.dataPoints}`);
  });

  await check('every Odds API poll is kept in the raw poll log, whatever the live status', async () => {
    const dir = path.join(DATA_DIR, 'poll_log');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('_mma_mixed_martial_arts.jsonl'));
    assert.ok(files.length >= 1, 'no poll log written');
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const polls = lines.length;
    assert.ok(polls >= global.savedPoints, `poll log (${polls}) should have at least as many polls as points saved`);
    assert.ok(lines.some(l => l.fights.some(f => f.home === 'Fighter Alpha')), 'poll log must include the fight');
  });

  await check('an extension push is recorded even when the fight is not marked live', async () => {
    const r = await fetch(`http://localhost:${SERVER_PORT}/api/dk-odds-push`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport: 'mma_mixed_martial_arts', fighter1: 'Pre Fight A', fighter2: 'Pre Fight B', numericOdds1: -130, numericOdds2: 110, live: false }),
    });
    const d = await r.json();
    assert.ok(r.ok && d.ok, 'push rejected: ' + JSON.stringify(d));
    assert.strictEqual(d.live, false, 'live flag must be kept');
    assert.ok(d.samples >= 1, 'sample must be recorded');
  });

  await check('every Odds API poll is kept in the raw poll log, whatever the live status', async () => {
    const dir = path.join(DATA_DIR, 'poll_log');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('_mma_mixed_martial_arts.jsonl'));
    assert.ok(files.length >= 1, 'no poll log written');
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.length >= global.savedPoints, `poll log (${lines.length}) should cover at least the saved points`);
    assert.ok(lines.some(l => l.fights.some(f => f.home === 'Fighter Alpha')), 'poll log must include the fight');
  });

  await check('an extension push is recorded even when the fight is not marked live', async () => {
    const r = await fetch(`http://localhost:${SERVER_PORT}/api/dk-odds-push`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport: 'mma_mixed_martial_arts', fighter1: 'Pre Fight A', fighter2: 'Pre Fight B', numericOdds1: -130, numericOdds2: 110, live: false }),
    });
    const d = await r.json();
    assert.ok(r.ok && d.ok, 'push rejected: ' + JSON.stringify(d));
    assert.strictEqual(d.live, false, 'live flag must be kept');
    assert.ok(d.samples >= 1, 'sample must be recorded');
  });

  console.log(`\n${passed} passed`);
  server.kill();
  fake.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('harness error', e); server.kill(); fake.close(); process.exit(1); });
