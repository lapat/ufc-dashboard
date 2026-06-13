#!/usr/bin/env node
// Bet Bot test suite — run before every push: node test.js
// Tests all server endpoints and core parsing logic

const BASE = process.env.TEST_URL || 'https://ufc-dashboard-production-e03d.up.railway.app';
const LOCAL = process.env.LOCAL_URL || 'http://localhost:3000';
const target = process.argv[2] === '--local' ? LOCAL : BASE;

let passed = 0, failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function get(path) {
  const r = await fetch(`${target}${path}`);
  assert(r.ok, `HTTP ${r.status}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(`${target}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert(r.ok, `HTTP ${r.status}`);
  return r.json();
}

// ── Unit tests: DK odds parsing ────────────────────────────────────────────
function testOddsParsing() {
  // unicode minus (U+2212) must parse correctly
  const odds = '−148';
  const normalized = (odds || '').replace('−', '-').replace('−', '-');
  const parsed = parseInt(normalized);
  assert(parsed === -148, `unicode minus parse failed: got ${parsed}`);

  const pos = '+170';
  assert(parseInt(pos) === 170, `positive odds parse failed`);
}

function testBetParsing() {
  // simulate parseDKBets logic
  const rawBet = {
    betId: 'test123',
    receiptId: 'test456',
    status: 'Unsettled',
    settlementStatus: 'Open',
    stake: 0.76,
    potentialReturns: 1.27,
    placementDate: '2026-06-13T16:48:00.049Z',
    selections: [{
      selectionDisplayName: 'Diego Lopes',
      marketDisplayName: 'Moneyline',
      displayOdds: '−148',
    }],
    displayOdds: '−148',
  };

  const sel = rawBet.selections[0];
  const status = rawBet.settlementStatus || rawBet.status;
  const odds = (sel.displayOdds || rawBet.displayOdds || '').replace('−', '-');

  assert(status === 'Open', `status should be Open, got ${status}`);
  assert(parseInt(odds) === -148, `odds should be -148, got ${parseInt(odds)}`);
  assert(rawBet.stake === 0.76, `stake wrong`);
}

// ── Live server tests ──────────────────────────────────────────────────────
async function runServerTests() {
  console.log(`\nTesting: ${target}\n`);

  // Health
  console.log('── Health ──');
  await check('GET /health', async () => {
    const d = await get('/health');
    assert(d.status, 'no status field');
  });

  // Sports data
  console.log('\n── Sports APIs ──');
  await check('GET /api/fights (returns array)', async () => {
    const d = await get('/api/fights');
    assert(Array.isArray(d), 'not array');
  });
  await check('GET /api/sports (returns array)', async () => {
    const d = await get('/api/sports');
    assert(Array.isArray(d), 'not array');
  });
  await check('GET /api/soccer (returns array)', async () => {
    const d = await get('/api/soccer');
    assert(Array.isArray(d), 'not array');
  });

  // DK sync
  console.log('\n── DK Sync ──');
  await check('GET /api/dk-bets (returns array)', async () => {
    const d = await get('/api/dk-bets');
    assert(Array.isArray(d), 'not array');
  });
  await check('GET /api/dk-bets?all=1 (returns array)', async () => {
    const d = await get('/api/dk-bets?all=1');
    assert(Array.isArray(d), 'not array');
  });
  await check('GET /api/dk-status (has heartbeat + activeUsers)', async () => {
    const d = await get('/api/dk-status');
    assert('heartbeat' in d, 'missing heartbeat');
    assert('loggedOut' in d, 'missing loggedOut');
    assert(Array.isArray(d.activeUsers), 'missing activeUsers array');
  });
  await check('Multi-user: /api/dk-bets?user= filters by userId', async () => {
    // Send bets as two different users
    const syncBet = (userId, fighter) => post('/api/dk-sync', {
      url: 'wss://test',
      userId,
      data: { result: { initial: { bets: [{
        betId: `${userId}-bet`, receiptId: `${userId}-bet`,
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 5, potentialReturns: 8, placementDate: new Date().toISOString(),
        displayOdds: '+150',
        selections: [{ selectionDisplayName: fighter, marketDisplayName: 'Moneyline', displayOdds: '+150' }]
      }] } } },
      ts: Date.now()
    });
    await syncBet('userA', 'Fighter A');
    await syncBet('userB', 'Fighter B');
    const a = await get('/api/dk-bets?user=userA');
    const b = await get('/api/dk-bets?user=userB');
    assert(Array.isArray(a) && a.length > 0, 'userA bets missing');
    assert(Array.isArray(b) && b.length > 0, 'userB bets missing');
    assert(a.every(x => x.userId === 'userA'), 'userA bets contain wrong userId');
    assert(b.every(x => x.userId === 'userB'), 'userB bets contain wrong userId');
    assert(!a.some(x => x.userId === 'userB'), 'userA results leaked userB data');
  });
  await check('POST /api/dk-heartbeat', async () => {
    const d = await post('/api/dk-heartbeat', { ts: Date.now() });
    assert(d.ok, 'not ok');
  });
  await check('POST /api/dk-sync detects parlay bets (isParlay field)', async () => {
    const d = await post('/api/dk-sync', {
      url: 'wss://test',
      data: { result: { initial: { bets: [
        // Straight bet
        { betId: 'str-1', receiptId: 'str-1', status: 'Unsettled', settlementStatus: 'Open',
          stake: 10, potentialReturns: 15, placementDate: new Date().toISOString(),
          displayOdds: '+150', betType: 'SINGLE',
          selections: [{ selectionDisplayName: 'Fighter A', marketDisplayName: 'Moneyline', displayOdds: '+150' }] },
        // Parlay by betType
        { betId: 'par-1', receiptId: 'par-1', status: 'Unsettled', settlementStatus: 'Open',
          stake: 0.10, potentialReturns: 907, placementDate: new Date().toISOString(),
          displayOdds: '+9070', betType: 'PARLAY',
          selections: [
            { selectionDisplayName: 'Team X', marketDisplayName: 'Moneyline', displayOdds: '-148' },
            { selectionDisplayName: 'Team Y', marketDisplayName: 'Moneyline', displayOdds: '+170' },
          ] },
        // Parlay leg by parentBetId
        { betId: 'leg-1', receiptId: 'leg-1', status: 'Unsettled', settlementStatus: 'Open',
          stake: 5, potentialReturns: 8, placementDate: new Date().toISOString(),
          displayOdds: '-148', parentBetId: 'par-1',
          selections: [{ selectionDisplayName: 'New York Knicks', marketDisplayName: 'Moneyline', displayOdds: '-148' }] },
      ] } } },
      ts: Date.now()
    });
    assert(Array.isArray(d.bets), 'bets not array');
    const straight = d.bets.find(b => b.betId === 'str-1');
    const parlay = d.bets.find(b => b.betId === 'par-1');
    const leg = d.bets.find(b => b.betId === 'leg-1');
    assert(straight && !straight.isParlay, 'straight bet should have isParlay=false');
    assert(parlay && parlay.isParlay, 'parlay should have isParlay=true');
    assert(leg && leg.isParlay, 'parlay leg (parentBetId) should have isParlay=true');
  });
  await check('POST /api/dk-sync with WebSocket bet data', async () => {
    const mockData = {
      url: 'wss://gateway.northamerica-northeast2.prod.dkapis.com/test',
      data: {
        result: {
          initial: {
            bets: [{
              betId: 'test-ws-001',
              receiptId: 'test-ws-001',
              status: 'Unsettled',
              settlementStatus: 'Open',
              stake: 5.00,
              potentialReturns: 8.50,
              placementDate: new Date().toISOString(),
              displayOdds: '−148',
              selections: [{
                selectionDisplayName: 'Test Fighter',
                marketDisplayName: 'Moneyline',
                displayOdds: '−148',
              }],
            }]
          }
        }
      },
      ts: Date.now()
    };
    const d = await post('/api/dk-sync', mockData);
    assert(d.received, 'not received');
    assert(Array.isArray(d.bets), 'bets not array');
    assert(d.bets.length === 1, `expected 1 bet, got ${d.bets.length}`);
    assert(d.bets[0].status === 'Open', `status should be Open, got ${d.bets[0].status}`);
    assert(d.bets[0].odds === '-148', `odds should be -148, got ${d.bets[0].odds}`);
  });

  // Mock DK injection (from fetch/XHR path)
  await check('POST /api/dk-mock (requires fighter)', async () => {
    const d = await post('/api/dk-mock', { fighter: 'Diego Lopes', odds: '-148', stake: 0.76 });
    assert(d.ok, 'not ok');
    assert(d.bet.selection === 'Diego Lopes', 'wrong fighter');
    assert(d.bet.status === 'Open', `status should be Open, got ${d.bet.status}`);
  });

  // Recorder
  console.log('\n── Recorder ──');
  await check('GET /api/recorder/status', async () => {
    const d = await get('/api/recorder/status');
    assert(Array.isArray(d.activeFights), 'activeFights not array');
    assert(typeof d.totalSaved === 'number', 'totalSaved not number');
  });
  await check('POST /api/recorder/watch (sets clientWatching)', async () => {
    const d = await post('/api/recorder/watch', {
      sport: 'soccer_usa_mls',
      team1: 'Team A',
      team2: 'Team B'
    });
    assert(d.ok, 'not ok');
  });
  await check('POST /api/recorder/stop-all', async () => {
    const d = await post('/api/recorder/stop-all', {});
    assert(d.ok, 'not ok');
    assert(Array.isArray(d.stopped), 'stopped not array');
  });

  // Recordings library
  console.log('\n── Library ──');
  await check('GET /api/recordings (returns array)', async () => {
    const d = await get('/api/recordings');
    assert(Array.isArray(d), 'not array');
  });

  // DK logout
  console.log('\n── DK Auth ──');
  await check('POST /api/dk-logout sets loggedOut', async () => {
    await post('/api/dk-logout', { ts: Date.now() });
    const d = await get('/api/dk-status');
    assert(d.loggedOut === true, 'loggedOut should be true after logout');
    // Reset it
    await post('/api/dk-heartbeat', { ts: Date.now() });
    const d2 = await get('/api/dk-status');
    assert(d2.loggedOut === false, 'loggedOut should be false after heartbeat');
  });

  // DK bets open filter
  await check('/api/dk-bets only returns Open bets', async () => {
    // Must use a real userId (not default) since default bucket is now hidden when real users exist
    await post('/api/dk-sync', {
      url: 'wss://test', userId: 'open-filter-testuser',
      data: { result: { initial: { bets: [
        { betId: 'open-filter-1', receiptId: 'open-filter-1', status: 'Unsettled', settlementStatus: 'Open', stake: 10, potentialReturns: 15, placementDate: new Date().toISOString(), displayOdds: '+150', selections: [{ selectionDisplayName: 'Fighter Open', marketDisplayName: 'Moneyline', displayOdds: '+150' }] },
        { betId: 'won-filter-1', receiptId: 'won-filter-1', status: 'Settled', settlementStatus: 'Won', stake: 10, potentialReturns: 15, returns: 15, placementDate: new Date().toISOString(), displayOdds: '+150', selections: [{ selectionDisplayName: 'Fighter Won', marketDisplayName: 'Moneyline', displayOdds: '+150' }] },
      ] } } },
      ts: Date.now()
    });
    const open = await get('/api/dk-bets?user=open-filter-testuser');
    const all = await get('/api/dk-bets?user=open-filter-testuser&all=1');
    assert(open.length < all.length, `open (${open.length}) should be fewer than all (${all.length})`);
    assert(open.every(b => b.status === 'Open'), 'all open bets should have status Open');
  });

  // Dedup: same betId from default user and real user should not duplicate
  await check('GET /api/dk-bets deduplicates same betId across users', async () => {
    const syncBet = (userId) => post('/api/dk-sync', {
      url: 'wss://test', userId,
      data: { result: { initial: { bets: [{
        betId: 'dedup-test-bet', receiptId: 'dedup-test-bet',
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 5, potentialReturns: 8, placementDate: new Date().toISOString(),
        displayOdds: '+150',
        selections: [{ selectionDisplayName: 'Dedup Fighter', marketDisplayName: 'Moneyline', displayOdds: '+150' }]
      }] } } },
      ts: Date.now()
    });
    await syncBet('default');
    await syncBet('realUser');
    const bets = await get('/api/dk-bets');
    const dedupBets = bets.filter(b => b.betId === 'dedup-test-bet');
    assert(dedupBets.length === 1, `expected 1 dedup bet, got ${dedupBets.length}`);
    assert(dedupBets[0].userId === 'realUser', `real userId should win, got ${dedupBets[0].userId}`);
  });

  // Recorder watching state
  await check('POST /api/recorder/watch sets clientWatching in status', async () => {
    await post('/api/recorder/watch', { sport: 'soccer_test_league', team1: 'Team X', team2: 'Team Y' });
    const d = await get('/api/recorder/status');
    assert(Array.isArray(d.watching), 'watching should be array');
    const watchStr = d.watching.join(' ');
    assert(watchStr.includes('Team X') || watchStr.includes('Team Y') || watchStr.includes('soccer_test'),
      `watching should mention the game, got: ${watchStr}`);
  });
  await check('GET /api/recorder/status includes watching field', async () => {
    const d = await get('/api/recorder/status');
    assert('watching' in d, 'missing watching field');
    assert('recording' in d, 'missing recording field');
    assert('lastPoll' in d, 'missing lastPoll field');
  });

  // User isolation: /api/dk-bets?user= only returns that user's bets
  await check('/api/dk-bets?user=X does not return user Y bets', async () => {
    await post('/api/dk-sync', {
      url: 'wss://test', userId: 'isolationUserX',
      data: { result: { initial: { bets: [{
        betId: 'iso-x-1', receiptId: 'iso-x-1',
        status: 'Unsettled', settlementStatus: 'Open', stake: 5,
        potentialReturns: 8, placementDate: new Date().toISOString(),
        displayOdds: '+150',
        selections: [{ selectionDisplayName: 'Team X', marketDisplayName: 'Moneyline', displayOdds: '+150' }]
      }] } } }, ts: Date.now()
    });
    await post('/api/dk-sync', {
      url: 'wss://test', userId: 'isolationUserY',
      data: { result: { initial: { bets: [{
        betId: 'iso-y-1', receiptId: 'iso-y-1',
        status: 'Unsettled', settlementStatus: 'Open', stake: 5,
        potentialReturns: 8, placementDate: new Date().toISOString(),
        displayOdds: '+200',
        selections: [{ selectionDisplayName: 'Team Y', marketDisplayName: 'Moneyline', displayOdds: '+200' }]
      }] } } }, ts: Date.now()
    });
    const xBets = await get('/api/dk-bets?user=isolationUserX');
    const yBets = await get('/api/dk-bets?user=isolationUserY');
    assert(xBets.every(b => b.userId === 'isolationUserX'), 'isolationUserX got wrong bets');
    assert(yBets.every(b => b.userId === 'isolationUserY'), 'isolationUserY got wrong bets');
    assert(!xBets.some(b => b.betId === 'iso-y-1'), 'isolationUserX should not see Y bets');
    assert(!yBets.some(b => b.betId === 'iso-x-1'), 'isolationUserY should not see X bets');
  });

  // Default-bucket bets must NOT leak when real users exist (root cause of Ish's bets showing on Louis's dashboard)
  await check('Default user bets hidden when real users exist', async () => {
    // Post a unique bet as 'default' (simulates Ish's extension before username was set)
    const ishBetId = `ish-leak-test-${Date.now()}`;
    await post('/api/dk-sync', {
      url: 'wss://test', userId: 'default',
      data: { result: { initial: { bets: [{
        betId: ishBetId, receiptId: ishBetId,
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 800, potentialReturns: 1400, placementDate: new Date().toISOString(),
        displayOdds: '-120',
        selections: [{ selectionDisplayName: 'Carolina Hurricanes', marketDisplayName: 'Moneyline', displayOdds: '-120' }]
      }] } } },
      ts: Date.now()
    });
    // Post a real-user bet (simulates Louis's extension with username detected)
    await post('/api/dk-sync', {
      url: 'wss://test', userId: 'louislapat',
      data: { result: { initial: { bets: [{
        betId: 'louis-real-bet', receiptId: 'louis-real-bet',
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 50, potentialReturns: 80, placementDate: new Date().toISOString(),
        displayOdds: '+150',
        selections: [{ selectionDisplayName: 'Diego Lopes', marketDisplayName: 'Moneyline', displayOdds: '+150' }]
      }] } } },
      ts: Date.now()
    });
    // Unfiltered /api/dk-bets should NOT contain the default-user bet
    const bets = await get('/api/dk-bets');
    const ishBet = bets.find(b => b.betId === ishBetId);
    assert(!ishBet, `Default user bet (Ish's Carolina Hurricanes) should not appear when real users exist — got ${JSON.stringify(ishBet)}`);
    // Louis's bet should still be there
    const louisBet = bets.find(b => b.betId === 'louis-real-bet');
    assert(louisBet, 'Real user bet (Louis) should still appear');
  });

  // Re-sync same bet should not duplicate it (root cause of "4x Detroit Lions" bug)
  await check('Re-syncing same bet multiple times produces exactly 1 entry', async () => {
    const userId = 'dedup-resync-user';
    const syncSameBet = () => post('/api/dk-sync', {
      url: 'wss://test', userId,
      data: { result: { initial: { bets: [{
        betId: 'resync-bet-001', receiptId: 'resync-bet-001',
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 5, potentialReturns: 8, placementDate: new Date().toISOString(),
        displayOdds: '+150',
        selections: [{ selectionDisplayName: 'Detroit Lions', marketDisplayName: 'Moneyline', displayOdds: '+150' }]
      }] } } },
      ts: Date.now()
    });
    await syncSameBet();
    await syncSameBet();
    await syncSameBet();
    const bets = await get(`/api/dk-bets?user=${userId}`);
    const matching = bets.filter(b => b.betId === 'resync-bet-001');
    assert(matching.length === 1, `Expected 1 entry after 3 syncs of same bet, got ${matching.length}`);
  });

  // Recorder stop specific
  await check('POST /api/recorder/stop/:id returns 404 for unknown', async () => {
    const r = await fetch(`${target}/api/recorder/stop/nonexistent-id`, { method: 'POST' });
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  // Pages load
  console.log('\n── Pages ──');
  await check('GET / (dashboard loads)', async () => {
    const r = await fetch(`${target}/`);
    assert(r.ok, `HTTP ${r.status}`);
    const html = await r.text();
    assert(html.includes('Bet Bot') || html.includes('BET BOT'), 'missing Bet Bot title');
    assert(html.includes('FIGHTS') || html.includes('fights'), 'missing FIGHTS sport tab');
  });
  await check('GET /library (library page loads)', async () => {
    const r = await fetch(`${target}/library`);
    assert(r.ok, `HTTP ${r.status}`);
    const html = await r.text();
    assert(html.includes('Recordings'), 'missing Recordings title');
  });
}

// ── Connection health logic tests ──────────────────────────────────────────
function testConnectionHealth() {
  // Thresholds used by popup and keepAlive
  const LIVE_MS   = 120000;  // < 2min = green
  const STALE_MS  = 300000;  // 2-5min = yellow (WS open but quiet)
  const DEAD_MS   = 600000;  // > 5min = red, trigger reload

  const classify = (age, wsConnected) => {
    if (wsConnected === false) return 'disconnected';
    if (age < LIVE_MS) return 'live';
    if (age < DEAD_MS) return 'stale';
    return 'dead';
  };

  assert(classify(30000, true) === 'live', 'fresh sync should be live');
  assert(classify(30000, null) === 'live', 'fresh sync, unknown ws = live');
  assert(classify(200000, true) === 'stale', '3m+ stale');
  assert(classify(700000, true) === 'dead', '10m+ dead');
  assert(classify(0, false) === 'disconnected', 'ws=false always disconnected');
  assert(classify(700000, false) === 'disconnected', 'ws=false overrides age');
}

function testParlayDetection() {
  // Simulate parseDKBets parlay detection logic
  const detectIsParlay = (b) => {
    const numLegs = b.selections?.length || 1;
    const rawType = (b.betType || b.wagerType || b.type || '').toLowerCase();
    return numLegs > 1
      || rawType.includes('parlay')
      || rawType.includes('round_robin')
      || !!b.parlayId
      || !!b.legId
      || !!b.parentBetId;
  };

  // Single bet
  const straight = { betId: 'a', selections: [{ selectionDisplayName: 'Diego Lopes' }], betType: 'SINGLE' };
  assert(!detectIsParlay(straight), 'straight bet should not be parlay');

  // Parlay by betType
  const parlayByType = { betId: 'b', selections: [{ selectionDisplayName: 'Team A' }], betType: 'PARLAY' };
  assert(detectIsParlay(parlayByType), 'betType=PARLAY should detect as parlay');

  // Parlay by multiple selections
  const parlayByLegs = { betId: 'c', selections: [{ selectionDisplayName: 'A' }, { selectionDisplayName: 'B' }] };
  assert(detectIsParlay(parlayByLegs), 'multiple selections should detect as parlay');

  // Parlay leg by parentBetId
  const parlayLeg = { betId: 'd', selections: [{ selectionDisplayName: 'Team C' }], parentBetId: 'parent123' };
  assert(detectIsParlay(parlayLeg), 'parentBetId should detect as parlay leg');
}

function testTrackerGameSwitchClearsDkBets() {
  // Switching games must wipe DK-sourced bets but keep manually-locked bets
  const bets = [
    { id: 1, side: 'f1', stake: 0.76, odds: '-148', betId: 'ish-car-bet', source: 'dk' },
    { id: 2, side: 'f1', stake: 100, odds: '-110', betId: null, source: 'manual' },
  ];
  // Simulate clearDkBets()
  const afterSwitch = bets.filter(b => b.source !== 'dk');
  assert(afterSwitch.length === 1, `Should have 1 bet after switch, got ${afterSwitch.length}`);
  assert(afterSwitch[0].source === 'manual', 'Remaining bet should be manual');
  assert(!afterSwitch.some(b => b.betId === 'ish-car-bet'), 'DK bet should be cleared on game switch');
}

function testTrackerBetIdDedup() {
  // Simulate the page-reload duplication bug:
  // tracker.bets restored from localStorage, _lastDKBetIds starts fresh → same bet added again
  // Fix: initialize _lastDKBetIds from tracker.bets on page load

  // Simulate persisted tracker bets (restored from localStorage)
  const persistedBets = [
    { id: 1, side: 'f1', stake: 0.76, odds: '-148', betId: 'patriots-bet-001' },
    { id: 2, side: 'f1', stake: 0.76, odds: '-148', betId: 'patriots-bet-002' },
  ];

  // Correct init: _lastDKBetIds built from tracker.bets
  const lastDKBetIds = new Set(persistedBets.filter(b => b.betId).map(b => b.betId));

  // Simulate a sync that returns the same two bets
  const incomingBets = [
    { betId: 'patriots-bet-001', selection: 'New England Patriots', odds: '-148', stake: 0.76, isParlay: false },
    { betId: 'patriots-bet-002', selection: 'New England Patriots', odds: '-148', stake: 0.76, isParlay: false },
  ];

  let added = 0;
  for (const b of incomingBets) {
    if (lastDKBetIds.has(b.betId)) continue; // already in tracker
    added++;
    lastDKBetIds.add(b.betId);
  }
  assert(added === 0, `Page reload should not re-add persisted bets — added ${added} duplicates`);
}

function testDedupBets() {
  // Simulate getAllBets dedup logic: real userId overwrites DEFAULT_USER
  const bets = new Map();
  const DEFAULT = 'default';
  const defBets = [
    { betId: 'bet-1', userId: DEFAULT, selection: 'Fighter A' },
    { betId: 'bet-2', userId: DEFAULT, selection: 'Fighter B' },
  ];
  const realBets = [
    { betId: 'bet-1', userId: 'louislapat', selection: 'Fighter A' }, // same id, real user
  ];

  // Insert default first, then real (real wins)
  for (const b of defBets) bets.set(b.betId, b);
  for (const b of realBets) bets.set(b.betId, b);

  const result = Array.from(bets.values());
  assert(result.length === 2, `should have 2 unique bets, got ${result.length}`);
  const bet1 = result.find(b => b.betId === 'bet-1');
  assert(bet1.userId === 'louislapat', `bet-1 should belong to real user, got ${bet1.userId}`);
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════');
console.log('  BET BOT TEST SUITE');
console.log('═══════════════════════════════════');

console.log('\n── Unit Tests ──');
try { testOddsParsing(); console.log('  ✓ odds parsing (unicode minus)'); passed++; } catch(e) { console.error('  ✗ odds parsing:', e.message); failed++; }
try { testBetParsing(); console.log('  ✓ bet parsing (settlementStatus → Open)'); passed++; } catch(e) { console.error('  ✗ bet parsing:', e.message); failed++; }
try { testConnectionHealth(); console.log('  ✓ connection health classification'); passed++; } catch(e) { console.error('  ✗ connection health:', e.message); failed++; }
try { testTrackerGameSwitchClearsDkBets(); console.log('  ✓ game switch clears DK bets, keeps manual bets'); passed++; } catch(e) { console.error('  ✗ game switch clear:', e.message); failed++; }
try { testTrackerBetIdDedup(); console.log('  ✓ tracker bet dedup (page reload does not re-add persisted bets)'); passed++; } catch(e) { console.error('  ✗ tracker bet dedup:', e.message); failed++; }
try { testDedupBets(); console.log('  ✓ bet dedup (real userId overwrites default)'); passed++; } catch(e) { console.error('  ✗ bet dedup:', e.message); failed++; }
try { testParlayDetection(); console.log('  ✓ parlay detection (straight vs parlay vs leg)'); passed++; } catch(e) { console.error('  ✗ parlay detection:', e.message); failed++; }

runServerTests().then(() => {
  console.log(`\n═══════════════════════════════════`);
  console.log(`  ${passed} passed  ${failed} failed`);
  console.log(`═══════════════════════════════════\n`);
  if (failed > 0) process.exit(1);
}).catch(e => { console.error(e); process.exit(1); });
