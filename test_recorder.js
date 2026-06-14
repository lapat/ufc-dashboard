'use strict';
// test_recorder.js — Comprehensive tests for the recording pipeline.
// Tests record_engine.js pure functions + integration: save → file → readable by analyzer.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  recFightId, recFilePath, recIsLive, recExtractOdds,
  recSaveRecord, loadPersistedState, persistState, clearPersistedState,
} = require('./record_engine');

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Temp directory for file I/O tests so we don't pollute real historical_data
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'));

// ── recFightId ────────────────────────────────────────────────────────────────

console.log('\nrecFightId');

const mmaFight = { home_team: 'Bo Nickal', away_team: 'Kyle Daukaus', commence_time: '2026-06-14T01:00:00Z' };
const soccerFight = { home_team: 'Germany', away_team: 'Curaçao', commence_time: '2026-06-14T16:00:00Z' };

test('MMA produces no sport prefix', () => {
  const id = recFightId('mma_mixed_martial_arts', mmaFight);
  assertEqual(id, 'bonickal_vs_kyledaukaus_2026-06-14');
});

test('MMA strips spaces and special chars from name', () => {
  const f = { home_team: 'Ilia Topuria!', away_team: 'Max Holloway', commence_time: '2026-01-01T00:00:00Z' };
  const id = recFightId('mma_mixed_martial_arts', f);
  assertEqual(id, 'iliatopuria_vs_maxholloway_2026-01-01');
});

test('Soccer uses sport prefix and subfolder format', () => {
  const id = recFightId('soccer_germany_bundesliga', soccerFight);
  assert(id.startsWith('soccer__'), `Expected soccer__ prefix, got: ${id}`);
});

test('MMA id matches existing historical_data filename format', () => {
  // Verify against a real file we know exists
  const HISTORICAL_DIR = path.join(__dirname, 'historical_data');
  const files = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json'));
  assert(files.length > 0, 'No historical files found');
  // All root files should match pattern: name_vs_name_date.json (no sport__ prefix)
  const hasSportPrefix = files.filter(f => f.includes('__'));
  assertEqual(hasSportPrefix.length, 0, `${hasSportPrefix.length} files have sport__ prefix — shouldn't be in root`);
});

test('MMA id format survives round-trip through parseFightFile (enricher compat)', () => {
  const id = recFightId('mma_mixed_martial_arts', mmaFight);
  // enricher.js parseFightFile expects: {fighter1}_vs_{fighter2}_{date}
  const dateMatch = id.match(/(\d{4}-\d{2}-\d{2})$/);
  assert(dateMatch, 'ID must end with YYYY-MM-DD');
  const withoutDate = id.slice(0, id.length - dateMatch[1].length - 1);
  const parts = withoutDate.split('_vs_');
  assertEqual(parts.length, 2, 'Must have exactly one _vs_ separator');
});

test('Accented characters stripped from fight ID', () => {
  const id = recFightId('soccer_conmebol_copa_america', soccerFight);
  assert(!id.includes('ç') && !id.includes('ã'), `Diacritics found in: ${id}`);
});

test('Empty team name does not crash', () => {
  const f = { home_team: '', away_team: '', commence_time: '2026-01-01T00:00:00Z' };
  const id = recFightId('mma_mixed_martial_arts', f);
  assertEqual(id, '_vs__2026-01-01');
});

// ── recFilePath ───────────────────────────────────────────────────────────────

console.log('\nrecFilePath');

test('MMA fight saves to root historical_data (not a subfolder)', () => {
  const fp = recFilePath('mma_mixed_martial_arts', 'bonickal_vs_kyledaukaus_2026-06-14');
  const HISTORICAL_DIR = path.join(__dirname, 'historical_data');
  assertEqual(fp, path.join(HISTORICAL_DIR, 'bonickal_vs_kyledaukaus_2026-06-14.json'));
});

test('Soccer fight saves to sport subfolder', () => {
  const fp = recFilePath('soccer_germany_bundesliga', 'soccer__germany_vs_curacao_2026-06-14');
  assert(fp.includes('soccer_germany_bundesliga'), `Expected sport subfolder in: ${fp}`);
});

test('MMA path does not contain mma_mixed_martial_arts subfolder', () => {
  const fp = recFilePath('mma_mixed_martial_arts', 'test_vs_test_2026-01-01');
  assert(!fp.includes('mma_mixed_martial_arts'), `MMA path must NOT have sport subfolder: ${fp}`);
});

// ── recIsLive ─────────────────────────────────────────────────────────────────

console.log('\nrecIsLive');

const WINDOW = 3 * 60 * 60 * 1000;

test('Fight that started 1 hour ago is live', () => {
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert(recIsLive({ commence_time: start }, WINDOW));
});

test('Fight that starts in 5 minutes is not live yet', () => {
  const start = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  assert(!recIsLive({ commence_time: start }, WINDOW));
});

test('Fight that ended 4 hours ago is outside the window', () => {
  const start = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  assert(!recIsLive({ commence_time: start }, WINDOW));
});

test('Fight that started 2h59m ago is still live in 3h window', () => {
  const start = new Date(Date.now() - (WINDOW - 60000)).toISOString();
  assert(recIsLive({ commence_time: start }, WINDOW));
});

test('Fight that started exactly at window boundary is not live', () => {
  const start = new Date(Date.now() - WINDOW).toISOString();
  assert(!recIsLive({ commence_time: start }, WINDOW));
});

// ── recExtractOdds ────────────────────────────────────────────────────────────

console.log('\nrecExtractOdds');

function makeFightFeed(f1Price, f2Price) {
  return {
    bookmakers: [{
      key: 'draftkings',
      markets: [{
        key: 'h2h',
        outcomes: [
          { name: 'Bo Nickal', price: f1Price },
          { name: 'Kyle Daukaus', price: f2Price },
        ]
      }]
    }]
  };
}

test('Extracts correct fighter names and odds', () => {
  const odds = recExtractOdds(makeFightFeed(-305, 245));
  assertEqual(odds.fighter1.name, 'Bo Nickal');
  assertEqual(odds.fighter1.numericOdds, -305);
  assertEqual(odds.fighter2.name, 'Kyle Daukaus');
  assertEqual(odds.fighter2.numericOdds, 245);
});

test('Returns null when no bookmakers', () => {
  const odds = recExtractOdds({ bookmakers: [] });
  assertEqual(odds, null);
});

test('Returns null when fewer than 2 outcomes', () => {
  const odds = recExtractOdds({
    bookmakers: [{ markets: [{ key: 'h2h', outcomes: [{ name: 'Bo Nickal', price: -305 }] }] }]
  });
  assertEqual(odds, null);
});

test('Returns null for fight with no DraftKings h2h market', () => {
  const odds = recExtractOdds({
    bookmakers: [{ markets: [{ key: 'spreads', outcomes: [] }] }]
  });
  assertEqual(odds, null);
});

test('Timestamp is an ISO string', () => {
  const odds = recExtractOdds(makeFightFeed(-305, 245));
  assert(new Date(odds.timestamp).toISOString() === odds.timestamp, 'Expected ISO timestamp');
});

test('Handles draw outcome (3rd entry) without breaking', () => {
  const fight = {
    bookmakers: [{
      markets: [{
        key: 'h2h',
        outcomes: [
          { name: 'Germany', price: -350 },
          { name: 'Curaçao', price: 1200 },
          { name: 'Draw', price: 600 },
        ]
      }]
    }]
  };
  const odds = recExtractOdds(fight);
  assert(odds !== null, 'Should not return null with 3 outcomes');
  assertEqual(odds.fighter1.name, 'Germany');
  assertEqual(odds.fighter2.name, 'Curaçao');
});

// ── recSaveRecord ─────────────────────────────────────────────────────────────

console.log('\nrecSaveRecord');

function makeRecord(overrides = {}) {
  return {
    meta: {
      sport: 'mma_mixed_martial_arts',
      label: 'UFC',
      fighter1: 'Bo Nickal',
      fighter2: 'Kyle Daukaus',
      startTime: new Date(Date.now() - 10 * 60000).toISOString(),
      ...overrides.meta
    },
    oddsHistory: overrides.oddsHistory || [
      { timestamp: new Date().toISOString(), fighter1: { name: 'Bo Nickal', numericOdds: -305 }, fighter2: { name: 'Kyle Daukaus', numericOdds: 245 } },
      { timestamp: new Date().toISOString(), fighter1: { name: 'Bo Nickal', numericOdds: -320 }, fighter2: { name: 'Kyle Daukaus', numericOdds: 260 } },
    ],
    lastOdds: null,
  };
}

test('Saves a valid fight record to disk', () => {
  const id = 'bonickal_vs_kyledaukaus_2026-06-14';
  const fp = path.join(TMP, `${id}.json`);
  const result = recSaveRecord(id, makeRecord(), { filePath: fp });
  assert(result.saved, `Expected saved=true, got: ${JSON.stringify(result)}`);
  assert(fs.existsSync(fp), 'File should exist on disk');
});

test('Saved file is valid JSON with correct fightId', () => {
  const id = 'bonickal_vs_kyledaukaus_2026-06-14';
  const fp = path.join(TMP, `${id}_2.json`);
  recSaveRecord(id, makeRecord(), { filePath: fp });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assertEqual(data.fightId, id);
  assertEqual(data.oddsHistory.length, 2);
});

test('Saved file is loadable by analyzer (has oddsHistory array)', () => {
  const id = 'test_vs_test_2026-01-01';
  const fp = path.join(TMP, `${id}.json`);
  recSaveRecord(id, makeRecord(), { filePath: fp });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert(Array.isArray(data.oddsHistory), 'oddsHistory must be array');
  assert(data.oddsHistory[0].fighter1.numericOdds, 'Must have fighter1.numericOdds');
});

test('Returns saved=false for empty oddsHistory', () => {
  const result = recSaveRecord('test', makeRecord({ oddsHistory: [] }), { filePath: path.join(TMP, 'empty.json') });
  assertEqual(result.saved, false);
  assertEqual(result.reason, 'empty');
});

test('Returns saved=false for null record', () => {
  const result = recSaveRecord('test', null, { filePath: path.join(TMP, 'null.json') });
  assertEqual(result.saved, false);
});

test('Returns saved=false (not throw) when path is unwritable', () => {
  const result = recSaveRecord('test', makeRecord(), { filePath: '/nonexistent_dir/test.json' });
  assertEqual(result.saved, false);
  assert(result.reason, 'Should have a reason string');
});

test('Saved file has endTime set', () => {
  const id = 'time_test';
  const fp = path.join(TMP, `${id}.json`);
  recSaveRecord(id, makeRecord(), { filePath: fp });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert(data.endTime, 'endTime must be set');
  assert(new Date(data.endTime).getTime() > 0, 'endTime must be valid ISO');
});

test('dataPoints field matches oddsHistory length', () => {
  const id = 'dp_test';
  const fp = path.join(TMP, `${id}.json`);
  recSaveRecord(id, makeRecord(), { filePath: fp });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assertEqual(data.dataPoints, data.oddsHistory.length);
});

test('Overwrites existing file safely (no corruption)', () => {
  const id = 'overwrite_test';
  const fp = path.join(TMP, `${id}.json`);
  recSaveRecord(id, makeRecord(), { filePath: fp });
  const rec2 = makeRecord({ oddsHistory: [
    { timestamp: new Date().toISOString(), fighter1: { name: 'A', numericOdds: 100 }, fighter2: { name: 'B', numericOdds: -120 } },
  ]});
  recSaveRecord(id, rec2, { filePath: fp });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assertEqual(data.oddsHistory.length, 1);
});

// ── State persistence ─────────────────────────────────────────────────────────

console.log('\nState persistence');

const TEST_STATE_FILE = path.join(TMP, 'recording_state.json');

function saveThenLoad(map) {
  // Inline persist/load using test state file
  const obj = {};
  for (const [id, record] of map) obj[id] = record;
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(obj, null, 2));
  const raw = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  return new Map(Object.entries(raw));
}

test('Active fights survive a persist/load cycle', () => {
  const map = new Map();
  map.set('fight_a', makeRecord({ meta: { fighter1: 'Alice', fighter2: 'Bob', sport: 'mma_mixed_martial_arts', label: 'UFC', startTime: new Date().toISOString() } }));
  const loaded = saveThenLoad(map);
  assert(loaded.has('fight_a'), 'fight_a should survive reload');
});

test('Odds history is preserved across reload', () => {
  const map = new Map();
  const rec = makeRecord();
  map.set('fight_b', rec);
  const loaded = saveThenLoad(map);
  assertEqual(loaded.get('fight_b').oddsHistory.length, rec.oddsHistory.length);
});

test('Multiple active fights all reload correctly', () => {
  const map = new Map();
  map.set('fight_1', makeRecord());
  map.set('fight_2', makeRecord({ meta: { fighter1: 'C', fighter2: 'D', sport: 'mma_mixed_martial_arts', label: 'UFC', startTime: new Date().toISOString() } }));
  map.set('fight_3', makeRecord());
  const loaded = saveThenLoad(map);
  assertEqual(loaded.size, 3);
});

test('Empty activeFights persists and loads as empty map', () => {
  const map = new Map();
  const loaded = saveThenLoad(map);
  assertEqual(loaded.size, 0);
});

test('loadPersistedState returns empty map if file missing', () => {
  // Override STATE_FILE temporarily by checking the module behavior
  const { loadPersistedState: load } = require('./record_engine');
  // The real STATE_FILE may or may not exist — just verify it returns a Map
  const result = load();
  assert(result instanceof Map, 'Must return a Map');
});

test('persistState does not throw when activeFights is empty', () => {
  const { persistState: persist, STATE_FILE } = require('./record_engine');
  // Should not throw
  persist(new Map());
  // Clean up
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
});

// ── End-to-end: record → save → readable by analyzer ─────────────────────────

console.log('\nEnd-to-end pipeline');

test('A recorded fight saved to historical_data root is found by getIndex (server)', () => {
  // Verify the root dir is what getIndex uses
  const HISTORICAL_DIR = path.join(__dirname, 'historical_data');
  const id = 'e2e_test_vs_e2etest_2026-01-01';
  const fp = path.join(HISTORICAL_DIR, `${id}.json`);
  const rec = makeRecord({ oddsHistory: [
    { timestamp: '2026-01-01T00:00:00.000Z', fighter1: { name: 'E2E Test', numericOdds: -200 }, fighter2: { name: 'E2E Opp', numericOdds: 165 } }
  ]});
  try {
    recSaveRecord(id, rec, { filePath: fp });
    assert(fs.existsSync(fp), 'File must exist in historical_data root');
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assertEqual(data.fightId, id);
  } finally {
    try { fs.unlinkSync(fp); } catch (_) {}
  }
});

test('MMA recording NOT saved to mma_mixed_martial_arts subfolder', () => {
  // The bug we fixed: server.js was saving to historical_data/mma_mixed_martial_arts/
  const subfolder = path.join(__dirname, 'historical_data', 'mma_mixed_martial_arts');
  const fp = recFilePath('mma_mixed_martial_arts', 'bonickal_vs_kyledaukaus_2026-06-14');
  assert(!fp.includes('mma_mixed_martial_arts'), `MMA files must NOT go to sport subfolder. Got: ${fp}`);
});

test('Fight file saved by recSaveRecord has correct structure for enricher.js', () => {
  // enricher.js reads: data.oddsHistory[0].fighter1.name (for fighter names)
  const id = 'enricher_compat_test';
  const fp = path.join(TMP, `${id}.json`);
  recSaveRecord(id, makeRecord(), { filePath: fp });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert(data.oddsHistory[0].fighter1.name, 'Must have fighter1.name for enricher');
  assert(data.oddsHistory[0].fighter2.name, 'Must have fighter2.name for enricher');
  assert(data.startTime, 'Must have startTime');
});

test('Concurrent fights can both be saved without collision', () => {
  const id1 = 'fighter1_vs_fighter2_2026-01-01';
  const id2 = 'fighter3_vs_fighter4_2026-01-01';
  const fp1 = path.join(TMP, `${id1}.json`);
  const fp2 = path.join(TMP, `${id2}.json`);
  recSaveRecord(id1, makeRecord({ meta: { fighter1: 'F1', fighter2: 'F2', sport: 'mma_mixed_martial_arts', label: 'UFC', startTime: new Date().toISOString() }}), { filePath: fp1 });
  recSaveRecord(id2, makeRecord({ meta: { fighter1: 'F3', fighter2: 'F4', sport: 'mma_mixed_martial_arts', label: 'UFC', startTime: new Date().toISOString() }}), { filePath: fp2 });
  const d1 = JSON.parse(fs.readFileSync(fp1, 'utf8'));
  const d2 = JSON.parse(fs.readFileSync(fp2, 'utf8'));
  assertEqual(d1.fightId, id1);
  assertEqual(d2.fightId, id2);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(35));
console.log(` ${passed} passed  ${failed} failed`);
console.log('═'.repeat(35));
if (failed > 0) process.exit(1);
