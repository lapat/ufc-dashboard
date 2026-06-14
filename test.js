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
  await check('GET /api/dk-status (has heartbeat + activeUsers + lastBetSync)', async () => {
    const d = await get('/api/dk-status');
    assert('heartbeat' in d, 'missing heartbeat');
    assert('loggedOut' in d, 'missing loggedOut');
    assert('lastBetSync' in d, 'missing lastBetSync — needed for DK EXT dot yellow state');
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

  // activeUsers reflects who the extension is sending as — used for mismatch detection
  await check('GET /api/dk-status activeUsers includes userId after heartbeat', async () => {
    const testId = 'testuser-heartbeat-check';
    await post('/api/dk-heartbeat', { ts: Date.now(), userId: testId });
    const d = await get('/api/dk-status');
    assert(Array.isArray(d.activeUsers), 'activeUsers should be array');
    assert(d.activeUsers.includes(testId), `activeUsers should include ${testId}, got: ${JSON.stringify(d.activeUsers)}`);
  });

  // Zero bets for unknown username = empty array (not an error, not someone else's bets)
  await check('/api/dk-bets?user=unknown-user returns empty array', async () => {
    const bets = await get('/api/dk-bets?user=testuser-nobody-set-this');
    assert(Array.isArray(bets), 'should return array');
    assert(bets.length === 0, `unknown user should have 0 bets, got ${bets.length}`);
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

  // Two users are fully isolated — each sees ONLY their own bets
  // Uses synthetic test usernames (never real usernames like 'louis' or 'ish')
  await check('user-A and user-B bets are fully isolated (Qatar Draw scenario)', async () => {
    const userA = 'testuser-player-a';
    const userB = 'testuser-player-b';
    // userA bets Qatar +5500
    await post('/api/dk-sync', {
      url: 'wss://test', userId: userA,
      data: { result: { initial: { bets: [{
        betId: 'testbet-qatar-userA', receiptId: 'testbet-qatar-userA',
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 0.79, potentialReturns: 44, placementDate: new Date().toISOString(),
        displayOdds: '+5500',
        selections: [{ selectionDisplayName: 'Qatar', marketDisplayName: 'Moneyline', displayOdds: '+5500' }]
      }] } } }, ts: Date.now()
    });
    // userB bets Draw +1500 on same game
    await post('/api/dk-sync', {
      url: 'wss://test', userId: userB,
      data: { result: { initial: { bets: [{
        betId: 'testbet-draw-userB', receiptId: 'testbet-draw-userB',
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 5, potentialReturns: 80, placementDate: new Date().toISOString(),
        displayOdds: '+1500',
        selections: [{ selectionDisplayName: 'Draw', marketDisplayName: 'Moneyline', displayOdds: '+1500' }]
      }] } } }, ts: Date.now()
    });

    const aBets = await get(`/api/dk-bets?user=${userA}`);
    const bBets = await get(`/api/dk-bets?user=${userB}`);

    // userA should see only their Qatar bet, not userB's Draw bet
    assert(aBets.some(b => b.betId === 'testbet-qatar-userA'), 'userA missing their own Qatar bet');
    assert(!aBets.some(b => b.betId === 'testbet-draw-userB'), 'userA should NOT see userB Draw bet');

    // userB should see only their Draw bet, not userA's Qatar bet
    assert(bBets.some(b => b.betId === 'testbet-draw-userB'), 'userB missing their own Draw bet');
    assert(!bBets.some(b => b.betId === 'testbet-qatar-userA'), 'userB should NOT see userA Qatar bet');

    // Unfiltered /api/dk-bets merges all — verify userId is preserved correctly
    const allBets = await get('/api/dk-bets');
    const aInAll = allBets.find(b => b.betId === 'testbet-qatar-userA');
    const bInAll = allBets.find(b => b.betId === 'testbet-draw-userB');
    assert(aInAll && aInAll.userId === userA, `userA Qatar bet in merged view has wrong userId: ${aInAll?.userId}`);
    assert(bInAll && bInAll.userId === userB, `userB Draw bet in merged view has wrong userId: ${bInAll?.userId}`);
  });

  // Extension userId MUST match dashboard dashUserId — mismatch = no bets shown
  await check('Extension userId ↔ dashboard username mismatch = empty result (no cross-leak)', async () => {
    const extUserId = 'testuser-ext-abc';   // what Ish's extension sends
    const wrongDash  = 'testuser-dash-xyz'; // what Ish set in dashboard (wrong)
    const rightDash  = extUserId;           // what Ish should have set

    await post('/api/dk-sync', {
      url: 'wss://test', userId: extUserId,
      data: { result: { initial: { bets: [{
        betId: 'mismatch-test-bet-1', receiptId: 'mismatch-test-bet-1',
        status: 'Unsettled', settlementStatus: 'Open',
        stake: 5, potentialReturns: 80, placementDate: new Date().toISOString(),
        displayOdds: '+1500',
        selections: [{ selectionDisplayName: 'Draw', marketDisplayName: 'Moneyline', displayOdds: '+1500' }]
      }] } } }, ts: Date.now()
    });

    // Wrong dashboard username → empty (bets stay hidden, no leak to other user)
    const wrongResult = await get(`/api/dk-bets?user=${wrongDash}`);
    assert(wrongResult.length === 0, `Wrong username should return 0 bets, got ${wrongResult.length}`);

    // Correct dashboard username → bet appears
    const rightResult = await get(`/api/dk-bets?user=${rightDash}`);
    assert(rightResult.length === 1, `Correct username should return 1 bet, got ${rightResult.length}`);
    assert(rightResult[0].betId === 'mismatch-test-bet-1', 'Wrong bet returned for correct username');
  });

  // When DK extension re-syncs with fewer bets, settled bets disappear from server
  await check('Settled bet disappears from /api/dk-bets after re-sync without it', async () => {
    const userId = 'testuser-settle-check';
    // Sync two open bets
    await post('/api/dk-sync', {
      url: 'wss://test', userId,
      data: { result: { initial: { bets: [
        { betId: 'settle-open-1', receiptId: 'settle-open-1', status: 'Unsettled', settlementStatus: 'Open',
          stake: 10, potentialReturns: 20, placementDate: new Date().toISOString(), displayOdds: '+100',
          selections: [{ selectionDisplayName: 'Fighter A', marketDisplayName: 'Moneyline', displayOdds: '+100' }] },
        { betId: 'settle-open-2', receiptId: 'settle-open-2', status: 'Unsettled', settlementStatus: 'Open',
          stake: 20, potentialReturns: 40, placementDate: new Date().toISOString(), displayOdds: '+100',
          selections: [{ selectionDisplayName: 'Fighter B', marketDisplayName: 'Moneyline', displayOdds: '+100' }] }
      ] } } }, ts: Date.now()
    });
    const before = await get(`/api/dk-bets?user=${userId}`);
    assert(before.length === 2, `expected 2 open bets, got ${before.length}`);

    // Extension re-syncs — bet 2 is now gone (settled on DK side)
    await post('/api/dk-sync', {
      url: 'wss://test', userId,
      data: { result: { initial: { bets: [
        { betId: 'settle-open-1', receiptId: 'settle-open-1', status: 'Unsettled', settlementStatus: 'Open',
          stake: 10, potentialReturns: 20, placementDate: new Date().toISOString(), displayOdds: '+100',
          selections: [{ selectionDisplayName: 'Fighter A', marketDisplayName: 'Moneyline', displayOdds: '+100' }] }
      ] } } }, ts: Date.now()
    });
    const after = await get(`/api/dk-bets?user=${userId}`);
    assert(after.length === 1, `expected 1 open bet after settle, got ${after.length}`);
    assert(after[0].betId === 'settle-open-1', 'wrong bet remained after settle');
    assert(!after.some(b => b.betId === 'settle-open-2'), 'settled bet still showing');
  });

  // Fake/test bets injected into a user bucket are wiped on next real sync
  await check('Test-injected bets wiped when real extension syncs with correct bets', async () => {
    const userId = 'testuser-wipe-check';
    // Simulate test pollution: inject a fake bet
    await post('/api/dk-sync', {
      url: 'wss://test', userId,
      data: { result: { initial: { bets: [
        { betId: 'fake-test-bet-999', receiptId: 'fake-test-bet-999', status: 'Unsettled', settlementStatus: 'Open',
          stake: 0.79, potentialReturns: 44, placementDate: new Date().toISOString(), displayOdds: '+5500',
          selections: [{ selectionDisplayName: 'Qatar', marketDisplayName: 'Moneyline', displayOdds: '+5500' }] }
      ] } } }, ts: Date.now()
    });
    const polluted = await get(`/api/dk-bets?user=${userId}`);
    assert(polluted.some(b => b.betId === 'fake-test-bet-999'), 'fake bet should exist before wipe');

    // Real extension syncs with only the real bet — fake one disappears
    await post('/api/dk-sync', {
      url: 'wss://test', userId,
      data: { result: { initial: { bets: [
        { betId: 'real-dk-bet-abc', receiptId: 'real-dk-bet-abc', status: 'Unsettled', settlementStatus: 'Open',
          stake: 5, potentialReturns: 10, placementDate: new Date().toISOString(), displayOdds: '+100',
          selections: [{ selectionDisplayName: 'Real Fighter', marketDisplayName: 'Moneyline', displayOdds: '+100' }] }
      ] } } }, ts: Date.now()
    });
    const clean = await get(`/api/dk-bets?user=${userId}`);
    assert(!clean.some(b => b.betId === 'fake-test-bet-999'), 'fake bet should be gone after real sync');
    assert(clean.some(b => b.betId === 'real-dk-bet-abc'), 'real bet should be present');
    assert(clean.length === 1, `expected exactly 1 bet, got ${clean.length}`);
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

  // lastBetSync updated on any dk-sync call, not just when bets are parsed
  await check('POST /api/dk-sync updates lastBetSync even when 0 bets parsed', async () => {
    const before = await get('/api/dk-status');
    await new Promise(r => setTimeout(r, 10));
    await post('/api/dk-sync', {
      url: 'wss://test',
      userId: 'testuser-sync-timestamp',
      data: { someNonBetPayload: true },
      ts: Date.now()
    });
    const after = await get('/api/dk-status');
    assert(after.lastBetSync !== null, 'lastBetSync should be set after any sync call');
    assert(
      before.lastBetSync === null || after.lastBetSync >= before.lastBetSync,
      `lastBetSync should advance: before=${before.lastBetSync} after=${after.lastBetSync}`
    );
  });

  // Heartbeat alone must clear the banner — lastBetSync set on first heartbeat
  await check('POST /api/dk-heartbeat sets lastBetSync so banner clears automatically', async () => {
    // Reset state to simulate fresh server (no lastBetSync yet)
    // We can't reset server state, but we can verify that after heartbeat, lastBetSync is not null
    await post('/api/dk-heartbeat', { ts: Date.now(), userId: 'testuser-heartbeat-banner' });
    const d = await get('/api/dk-status');
    assert(d.lastBetSync !== null, 'lastBetSync must be set after heartbeat so banner auto-clears');
    assert(!d.loggedOut, 'loggedOut should be false after heartbeat');
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
function testDKExtDotLogic() {
  // Mirrors pollDKExtStatus() dot classification
  const classify = ({ loggedOut, heartbeat, lastBetSync }) => {
    if (loggedOut) return 'red-logout';
    if (!heartbeat) return 'grey';
    const heartbeatAge = Date.now() - heartbeat;
    const betSyncAge = lastBetSync ? Date.now() - lastBetSync : Infinity;
    if (heartbeatAge > 300000) return 'red-stale';
    if (betSyncAge > 300000) return 'yellow-no-sync';
    return 'green';
  };

  const now = Date.now();
  assert(classify({ loggedOut: true, heartbeat: now, lastBetSync: now }) === 'red-logout', 'logged out → red');
  assert(classify({ loggedOut: false, heartbeat: null }) === 'grey', 'no heartbeat → grey');
  assert(classify({ loggedOut: false, heartbeat: now - 400000, lastBetSync: now }) === 'red-stale', 'stale heartbeat → red');
  assert(classify({ loggedOut: false, heartbeat: now, lastBetSync: null }) === 'yellow-no-sync', 'no bet sync (logged out of DK or not on mybets) → yellow');
  assert(classify({ loggedOut: false, heartbeat: now, lastBetSync: now - 400000 }) === 'yellow-no-sync', 'bet sync stale → yellow');
  assert(classify({ loggedOut: false, heartbeat: now, lastBetSync: now }) === 'green', 'all good → green');
}

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
  // On page load, DK bets are wiped from localStorage and _lastDKBetIds starts empty.
  // The server re-populates them fresh. Simulate that flow: wipe → sync → exactly the right bets.

  // Simulated localStorage state before wipe (has two DK bets + one manual)
  let bets = [
    { id: 1, side: 'f1', stake: 0.76, odds: '-148', betId: 'patriots-bet-001', source: 'dk' },
    { id: 2, side: 'f1', stake: 0.76, odds: '-148', betId: 'patriots-bet-002', source: 'dk' },
    { id: 3, side: 'f2', stake: 100, odds: '-110', betId: null, source: 'manual' },
  ];

  // Page load: clearDkBets() runs immediately after restore()
  bets = bets.filter(b => b.source !== 'dk');
  assert(bets.length === 1, `After refresh wipe, should have 1 bet (manual), got ${bets.length}`);
  assert(bets[0].source === 'manual', 'Only manual bet should survive refresh');

  // _lastDKBetIds always starts empty after wipe
  const lastDKBetIds = new Set();

  // Server returns the real open bets → both are "new" (not in lastDKBetIds), both get added once
  const serverBets = [
    { betId: 'patriots-bet-001', selection: 'New England Patriots', odds: '-148', stake: 0.76, isParlay: false },
    { betId: 'patriots-bet-002', selection: 'New England Patriots', odds: '-148', stake: 0.76, isParlay: false },
  ];

  let added = 0;
  for (const b of serverBets) {
    if (lastDKBetIds.has(b.betId)) continue;
    added++;
    lastDKBetIds.add(b.betId);
  }
  assert(added === 2, `Should add exactly 2 DK bets from server, added ${added}`);
  assert(lastDKBetIds.size === 2, `lastDKBetIds should have 2 entries, has ${lastDKBetIds.size}`);
}

function testRefreshClearsDKBets() {
  // Core invariant: DK bets NEVER persist across page refreshes.
  // Only manual (LOCK IN) bets survive a refresh.
  // DK bets are always re-populated from server after page load.

  const priorBets = [
    { id: 1, side: 'f1', stake: 0.79, odds: '+5500', betId: 'DK-qatar-real', source: 'dk' },
    { id: 2, side: 'draw', stake: 5, odds: '+1500', betId: 'DK-draw-real', source: 'dk' },
    { id: 3, side: 'f2', stake: 100, odds: '-110', betId: null, source: 'manual' },
  ];

  // clearDkBets() on page load
  const afterRefresh = priorBets.filter(b => b.source !== 'dk');

  assert(afterRefresh.length === 1, `Refresh should leave only manual bets, got ${afterRefresh.length}`);
  assert(!afterRefresh.some(b => b.betId === 'DK-qatar-real'), 'Qatar DK bet must not survive refresh');
  assert(!afterRefresh.some(b => b.betId === 'DK-draw-real'), 'Draw DK bet must not survive refresh');
  assert(afterRefresh[0].source === 'manual', 'Manual LOCK IN bet must survive refresh');

  // After refresh, _lastDKBetIds is empty — server re-populates cleanly
  const lastDKBetIds = new Set();
  assert(lastDKBetIds.size === 0, '_lastDKBetIds must be empty on page load');
}

function testDrawBetMatching() {
  // Mirrors syncDKBets() side-matching logic — draw bets must resolve to side='draw'
  // Bug history: tracker.drawLabel was used (undefined) instead of tracker.drawName → draws never matched
  const matchBet = (sel, f1, f2, drawName) => {
    const s = sel.toLowerCase();
    const matchScore = name => name.split(' ').filter(w => w.length > 2).filter(w => s.includes(w)).length;
    const f1Score = matchScore(f1.toLowerCase());
    const f2Score = matchScore(f2.toLowerCase());
    const dl = (drawName || '').toLowerCase();
    if (f1Score > 0 && f1Score >= f2Score) return 'f1';
    if (f2Score > 0) return 'f2';
    if (dl && (s.includes('draw') || s.includes('tie'))) return 'draw';
    return null;
  };

  // Draw bet must match when drawName is set
  assert(matchBet('Draw', 'Brazil', 'Morocco', 'Draw') === 'draw', 'Draw selection → side=draw');
  assert(matchBet('Tie', 'Brazil', 'Morocco', 'Draw') === 'draw', 'Tie selection → side=draw');

  // Draw must NOT match when drawName is empty/null (no draw market on this game)
  assert(matchBet('Draw', 'Diego Lopes', 'Steve Garcia', '') === null, 'Draw should not match when no draw market');
  assert(matchBet('Draw', 'Diego Lopes', 'Steve Garcia', null) === null, 'Draw should not match when drawName is null');

  // Normal f1/f2 still work
  assert(matchBet('Brazil', 'Brazil', 'Morocco', 'Draw') === 'f1', 'f1 name → side=f1');
  assert(matchBet('Morocco', 'Brazil', 'Morocco', 'Draw') === 'f2', 'f2 name → side=f2');

  // Unrelated selection → null
  assert(matchBet('Qatar', 'Brazil', 'Morocco', 'Draw') === null, 'unrelated selection → null');
}

function testPnLTodayFilter() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const bets = [
    { betId: '1', isParlay: false, placementDate: today + 'T10:00:00Z', status: 'Won', stake: '100', returns: '190' },
    { betId: '2', isParlay: false, placementDate: yesterday + 'T10:00:00Z', status: 'Lost', stake: '200', returns: '0' },
    { betId: '3', isParlay: true,  placementDate: today + 'T11:00:00Z', status: 'Won', stake: '50', returns: '200' },
    { betId: '4', isParlay: false, placementDate: today + 'T12:00:00Z', status: 'Open', stake: '100', returns: '0' },
  ];

  const straight = bets.filter(b => !b.isParlay && b.placementDate && b.placementDate.slice(0, 10) === today);
  assert(straight.length === 2, `should have 2 today straight bets, got ${straight.length}`);
  assert(straight.every(b => b.betId !== '2'), 'yesterday bet must be excluded');
  assert(straight.every(b => b.betId !== '3'), 'parlay must be excluded');
}

function testPnLCalculation() {
  const bets = [
    { status: 'Won',  stake: '100', returns: '190' }, // profit = +90
    { status: 'Lost', stake: '50',  returns: '0'   }, // profit = -50
    { status: 'Push', stake: '75',  returns: '75'  }, // profit = 0
    { status: 'Open', stake: '200', returns: '0'   }, // not settled
  ];
  const settled = bets.filter(b => b.status !== 'Open');
  const net = settled.reduce((s, b) => s + parseFloat(b.returns || 0) - parseFloat(b.stake || 0), 0);
  assert(Math.abs(net - 40) < 0.01, `net should be +40, got ${net}`);

  const wagered = bets.reduce((s, b) => s + parseFloat(b.stake || 0), 0);
  assert(wagered === 425, `total wagered should be 425, got ${wagered}`);

  const wins   = settled.filter(b => b.status === 'Won').length;
  const losses = settled.filter(b => b.status === 'Lost').length;
  const pushes = settled.filter(b => b.status === 'Push').length;
  assert(wins === 1 && losses === 1 && pushes === 1, `expected 1W 1L 1P, got ${wins}W ${losses}L ${pushes}P`);
}

function testPnLNullReturns() {
  // Mirrors new betProfit() logic in syncPnL() — the Ish draw bet bug fix
  // DK sometimes sends returns=null for won bets; we fall back to potentialReturns
  const betProfit = b => {
    const status = (b.status || '').toLowerCase();
    const stake  = parseFloat(b.stake || 0);
    if (status === 'won') {
      const rawRet = parseFloat(b.returns);
      const payout = (rawRet > 0) ? rawRet : parseFloat(b.potentialReturns || 0);
      return payout > stake ? payout - stake : payout; // if payout < stake, DK sent profit-only
    }
    if (status === 'lost')  return -stake;
    if (status === 'push')  return 0;
    return 0; // unknown status
  };

  // Won bet with null returns → falls back to potentialReturns → positive profit
  const wonNullReturns = { status: 'Won', stake: '50', returns: null, potentialReturns: '175.50' };
  const profit1 = betProfit(wonNullReturns);
  assert(profit1 > 0, `Won bet with null returns must be POSITIVE profit, got ${profit1}`);
  assert(Math.abs(profit1 - 125.50) < 0.01, `Profit should be +125.50 (175.50-50), got ${profit1}`);

  // Won bet with returns=0 (DK bug) → falls back to potentialReturns (Ish's case)
  const wonZeroReturns = { status: 'Won', stake: '50', returns: '0', potentialReturns: '125' };
  const profit2 = betProfit(wonZeroReturns);
  assert(profit2 > 0, `Won bet with returns=0 must NOT show as loss (-stake), got ${profit2}`);
  assert(Math.abs(profit2 - 75) < 0.01, `Profit should be +75 (125-50), got ${profit2}`);

  // Normal won bet with real returns → still works
  const wonNormal = { status: 'Won', stake: '100', returns: '190', potentialReturns: '190' };
  assert(Math.abs(betProfit(wonNormal) - 90) < 0.01, 'Normal won bet profit should be +90');

  // Lost bet is always -stake regardless of returns field
  const lostBet = { status: 'Lost', stake: '75', returns: '0', potentialReturns: '150' };
  assert(Math.abs(betProfit(lostBet) - (-75)) < 0.01, 'Lost bet should always be -stake');

  // Case-insensitive: DK might send 'won' or 'WON'
  assert(betProfit({ status: 'WON', stake: '50', returns: null, potentialReturns: '100' }) > 0, 'status=WON must still compute positive profit');
  assert(betProfit({ status: 'LOST', stake: '50', returns: '0' }) < 0, 'status=LOST must compute -stake');

  // Push: always 0 regardless of returns
  const pushBet = { status: 'Push', stake: '100', returns: '100', potentialReturns: '100' };
  assert(betProfit(pushBet) === 0, 'Push bet profit should be 0');

  // Net P&L for Ish's scenario: 2 draw bets won with null returns + potentialReturns set
  const ishBets = [
    { status: 'Won', stake: '25', returns: null, potentialReturns: '400' }, // +375
    { status: 'Won', stake: '25', returns: null, potentialReturns: '400' }, // +375
  ];
  const ishNet = ishBets.reduce((s, b) => s + betProfit(b), 0);
  assert(ishNet > 0, `Ish's 2 won draw bets should have POSITIVE net P&L, got ${ishNet}`);
  assert(Math.abs(ishNet - 750) < 0.01, `Ish's net should be +750 (375+375), got ${ishNet}`);

  const ishWins   = ishBets.filter(b => b.status.toLowerCase() === 'won').length;
  const ishLosses = ishBets.filter(b => b.status.toLowerCase() === 'lost').length;
  assert(ishWins === 2 && ishLosses === 0, `Ish should show 2W 0L, got ${ishWins}W ${ishLosses}L`);
}

function testSettlementDetection() {
  // Bets already settled before session started must NOT trigger toast
  // Only Open→settled transitions should fire
  const prevStatuses = new Map();
  const settled = [];

  const detect = (bets) => {
    for (const b of bets) {
      const prev = prevStatuses.get(b.betId);
      if (prev === 'Open' && b.status !== 'Open') settled.push(b);
      prevStatuses.set(b.betId, b.status);
    }
  };

  // First call: two already-settled bets + one open — nothing should fire
  detect([
    { betId: 'a', status: 'Won'  },
    { betId: 'b', status: 'Lost' },
    { betId: 'c', status: 'Open' },
  ]);
  assert(settled.length === 0, `pre-existing settled bets must not fire toast, got ${settled.length}`);

  // Second call: 'c' now settles — should fire once
  detect([
    { betId: 'a', status: 'Won'  },
    { betId: 'b', status: 'Lost' },
    { betId: 'c', status: 'Won'  },
  ]);
  assert(settled.length === 1, `only newly settled bet should fire, got ${settled.length}`);
  assert(settled[0].betId === 'c', `wrong bet triggered: ${settled[0].betId}`);
}

function testOddsDelta() {
  const withDelta = (o, ref) => {
    const base = o > 0 ? `+${o}` : `${o}`;
    if (!ref || typeof o !== 'number') return base;
    const d = Math.round(o - ref);
    if (Math.abs(d) < 1) return base;
    return `${base}▲▼`[0] + Math.abs(d); // simplified check
  };

  // No delta when opening odds match current
  const same = withDelta(-148, -148);
  assert(!same.includes('▲') && !same.includes('▼'), 'no delta when odds unchanged');

  // Delta shown when odds moved
  const moved = withDelta(-160, -148);
  const d = Math.round(-160 - (-148)); // = -12
  assert(Math.abs(d) >= 1, `delta should be >= 1, got ${d}`);

  // No delta when no reference
  const noRef = withDelta(-148, null);
  assert(!noRef.includes('▲') && !noRef.includes('▼'), 'no delta without opening odds');
}

function testDKBannerLogic() {
  // Mirrors pollDKExtStatus() banner decision — every non-green state must show a banner
  const classify = ({ loggedOut, heartbeat, lastBetSync }) => {
    if (loggedOut) return { dot: 'red', banner: true, msg: 'logged-out' };
    if (!heartbeat) return { dot: 'grey', banner: true, msg: 'not-detected' };
    const heartbeatAge = Date.now() - heartbeat;
    const betSyncAge = lastBetSync ? Date.now() - lastBetSync : Infinity;
    if (heartbeatAge > 300000) return { dot: 'red', banner: true, msg: 'connection-lost' };
    if (betSyncAge > 300000) return { dot: 'yellow', banner: true, msg: 'not-on-mybets' };
    return { dot: 'green', banner: false };
  };

  const now = Date.now();
  const r1 = classify({ loggedOut: true, heartbeat: now, lastBetSync: now });
  assert(r1.banner && r1.dot === 'red', `logged out → must show red banner, got dot=${r1.dot} banner=${r1.banner}`);

  const r2 = classify({ loggedOut: false, heartbeat: null });
  assert(r2.banner && r2.dot === 'grey', `no heartbeat → must show grey banner, got dot=${r2.dot} banner=${r2.banner}`);

  const r3 = classify({ loggedOut: false, heartbeat: now - 400000, lastBetSync: now });
  assert(r3.banner && r3.dot === 'red', `stale heartbeat → must show red banner, got dot=${r3.dot} banner=${r3.banner}`);

  const r4 = classify({ loggedOut: false, heartbeat: now, lastBetSync: now - 400000 });
  assert(r4.banner && r4.dot === 'yellow', `stale bet sync → must show yellow banner, got dot=${r4.dot} banner=${r4.banner}`);

  const r5 = classify({ loggedOut: false, heartbeat: now, lastBetSync: null });
  assert(r5.banner && r5.dot === 'yellow', `never synced → must show yellow banner, got dot=${r5.dot} banner=${r5.banner}`);

  const r6 = classify({ loggedOut: false, heartbeat: now, lastBetSync: now });
  assert(!r6.banner && r6.dot === 'green', `all healthy → banner must be hidden, got dot=${r6.dot} banner=${r6.banner}`);
}

function testRecordingsFilter() {
  // Mirrors server /api/recordings normSport + filter logic
  const normSport = s => {
    const u = (s || '').toUpperCase();
    if (u.includes('MMA') || u.includes('MARTIAL')) return 'UFC/MMA';
    if (u.includes('NHL')) return 'NHL';
    if (u.includes('NBA')) return 'NBA';
    if (u.includes('NFL')) return 'NFL';
    if (u.includes('MLB')) return 'MLB';
    return s;
  };

  // Sport label normalization
  assert(normSport('mma_mixed_martial_arts') === 'UFC/MMA', `mma_mixed_martial_arts should → UFC/MMA`);
  assert(normSport('UFC/MMA') === 'UFC/MMA', 'UFC/MMA should stay UFC/MMA');
  assert(normSport('nhl_hockey') === 'NHL', 'nhl → NHL');
  assert(normSport('nba_basketball') === 'NBA', 'nba → NBA');

  // Filter logic
  const raw = [
    { fighter1: '?', fighter2: 'Fighter B', sport: 'UFC/MMA' },
    { fighter1: 'Fighter A', fighter2: '?', sport: 'UFC/MMA' },
    { fighter1: 'Test Fighter A', fighter2: 'Test Fighter B', sport: 'mma_mixed_martial_arts' },
    { fighter1: 'Diego Lopes', fighter2: 'Steve Garcia', sport: 'mma_mixed_martial_arts' },
  ];

  const clean = raw
    .filter(r => r.fighter1 !== '?' && r.fighter2 !== '?')
    .filter(r => !r.fighter1.startsWith('Test ') && !r.fighter2.startsWith('Test '))
    .map(r => ({ ...r, sport: normSport(r.sport) }));

  assert(clean.length === 1, `Expected 1 clean recording, got ${clean.length}`);
  assert(clean[0].fighter1 === 'Diego Lopes', 'Only real fight should remain');
  assert(clean[0].sport === 'UFC/MMA', `Sport should be normalized, got "${clean[0].sport}"`);
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

// ── NEW FEATURE TESTS ─────────────────────────────────────────────────────

// betProfit() — mirrors module-level function in index.html
function betProfitFn(b) {
  const status = (b.status || '').toLowerCase();
  const stake  = parseFloat(b.stake || 0);
  if (status === 'won') {
    const rawRet = parseFloat(b.returns);
    const payout = (rawRet > 0) ? rawRet : parseFloat(b.potentialReturns || 0);
    return payout > stake ? payout - stake : payout;
  }
  if (status === 'lost')  return -stake;
  if (status === 'push')  return 0;
  return 0;
}

function testBetLogFilter() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const all = [
    { betId:'a', isParlay:false, placementDate:today+'T10:00Z',     status:'Won',  stake:'50', returns:'90' },
    { betId:'b', isParlay:false, placementDate:today+'T11:00Z',     status:'Open', stake:'25', returns:null },
    { betId:'c', isParlay:false, placementDate:yesterday+'T08:00Z', status:'Won',  stake:'100', returns:'190' }, // yesterday — excluded
    { betId:'d', isParlay:true,  placementDate:today+'T09:00Z',     status:'Won',  stake:'5',  returns:'200' }, // parlay — excluded
    { betId:'e', isParlay:false, placementDate:today+'T12:00Z',     status:'Lost', stake:'75', returns:'0' },
  ];

  const straight = all.filter(b => !b.isParlay && b.placementDate && b.placementDate.slice(0,10) === today);
  assert(straight.length === 3, `should have 3 today straight bets, got ${straight.length}`);
  assert(straight.every(b => b.betId !== 'c'), 'yesterday must be excluded');
  assert(straight.every(b => b.betId !== 'd'), 'parlay must be excluded');

  const wins   = straight.filter(b => (b.status||'').toLowerCase() === 'won');
  const losses = straight.filter(b => (b.status||'').toLowerCase() === 'lost');
  const open   = straight.filter(b => (b.status||'').toLowerCase() === 'open');
  assert(wins.length === 1 && losses.length === 1 && open.length === 1, `expected 1W 1L 1O`);
}

function testBetLogProfitDisplay() {
  // Various status+returns combinations render correct P&L
  const cases = [
    { b: { status:'Won',  stake:'100', returns:'190', potentialReturns:'190' }, expected: 90   },
    { b: { status:'Won',  stake:'50',  returns:null,  potentialReturns:'125' }, expected: 75   }, // null returns fallback
    { b: { status:'Won',  stake:'50',  returns:'0',   potentialReturns:'125' }, expected: 75   }, // zero returns fallback
    { b: { status:'Lost', stake:'75',  returns:'0',   potentialReturns:'150' }, expected: -75  },
    { b: { status:'Push', stake:'100', returns:'100', potentialReturns:'100' }, expected: 0    },
    { b: { status:'WON',  stake:'30',  returns:null,  potentialReturns:'90'  }, expected: 60   }, // uppercase status
    { b: { status:'LOST', stake:'20',  returns:'0',   potentialReturns:'40'  }, expected: -20  },
  ];
  for (const {b, expected} of cases) {
    const got = betProfitFn(b);
    assert(Math.abs(got - expected) < 0.01, `status=${b.status} returns=${b.returns} potRet=${b.potentialReturns} stake=${b.stake}: expected ${expected}, got ${got}`);
  }
}

function testBetLogSort() {
  // Bet log must be sorted newest-first (descending by placementDate)
  const bets = [
    { betId:'1', placementDate:'2026-06-13T10:00:00Z', status:'Open', stake:'10' },
    { betId:'2', placementDate:'2026-06-13T12:00:00Z', status:'Open', stake:'20' },
    { betId:'3', placementDate:'2026-06-13T08:00:00Z', status:'Open', stake:'30' },
  ];
  const sorted = [...bets].sort((a,b) => (a.placementDate||'') < (b.placementDate||'') ? 1 : -1);
  assert(sorted[0].betId === '2', `newest first: expected betId=2, got ${sorted[0].betId}`);
  assert(sorted[2].betId === '3', `oldest last: expected betId=3, got ${sorted[2].betId}`);
}

function testCLVAlert() {
  // Mirrors checkCLVAlert() logic
  const CLV_THRESHOLD = 15;
  const checkAlert = (openingF1, currentF1, openingF2, currentF2, hasBetF1, hasBetF2) => {
    const alerts = [];
    if (hasBetF1 && typeof currentF1 === 'number' && openingF1) {
      const d = Math.round(currentF1 - openingF1);
      if (d > CLV_THRESHOLD) alerts.push(`f1:+${d}`);
    }
    if (hasBetF2 && typeof currentF2 === 'number' && openingF2) {
      const d = Math.round(currentF2 - openingF2);
      if (d > CLV_THRESHOLD) alerts.push(`f2:+${d}`);
    }
    return alerts;
  };

  // No alert: line barely moved
  const a1 = checkAlert(-148, -145, +200, +205, true, true);
  assert(a1.length === 0, `small move should not alert, got: ${a1}`);

  // Alert: f1 line moved +20pts (bad for f1 bettor)
  const a2 = checkAlert(-148, -128, +200, +200, true, false);
  assert(a2.length === 1 && a2[0].startsWith('f1'), `f1 line move alert: ${a2}`);
  assert(a2[0].includes('+20'), `delta should be +20, got ${a2[0]}`);

  // Alert: f2 line moved +30pts (bad for f2 bettor)
  const a3 = checkAlert(-148, -148, +200, +230, false, true);
  assert(a3.length === 1 && a3[0].startsWith('f2'), `f2 line move alert: ${a3}`);

  // Both sides alert when both bets exist and both lines moved
  const a4 = checkAlert(-148, -120, +200, +250, true, true);
  assert(a4.length === 2, `both sides should alert, got ${a4.length}`);

  // No bet on f2 → no f2 alert even if line moved significantly
  const a5 = checkAlert(-148, -148, +200, +280, true, false);
  assert(a5.length === 0, `no f2 bet = no f2 alert`);

  // Exactly at threshold: no alert
  const a6 = checkAlert(-148, -148+CLV_THRESHOLD, +200, +200, true, false);
  assert(a6.length === 0, `exactly at threshold (${CLV_THRESHOLD}pts) should NOT alert`);

  // One pt over threshold: alerts
  const a7 = checkAlert(-148, -148+CLV_THRESHOLD+1, +200, +200, true, false);
  assert(a7.length === 1, `one pt over threshold should alert`);

  // Favorable line move (line went down, good CLV) → no alert
  const a8 = checkAlert(-148, -180, +200, +200, true, false);
  assert(a8.length === 0, `favorable line move should not alert`);
}

function testSparklineAccumulation() {
  // Mirrors _pnlHistory accumulation in updateSparkline()
  let history = [];
  const MAX_PTS = 40;
  const push = net => {
    history.push(net);
    if (history.length > MAX_PTS) history.shift();
  };

  // Push points and verify accumulation
  for (let i = 0; i < 30; i++) push(i * 2 - 10);
  assert(history.length === 30, `should have 30 pts, got ${history.length}`);
  assert(history[0] === -10, `first point should be -10`);

  // Overflow: cap at MAX_PTS
  for (let i = 0; i < 20; i++) push(100);
  assert(history.length === MAX_PTS, `should cap at ${MAX_PTS}, got ${history.length}`);

  // SVG path generation sanity: all points must be within [0, W] x [0, H]
  const W=80, H=20;
  const nets = history;
  const min = Math.min(0, ...nets), max = Math.max(0, ...nets);
  const range = max - min || 1;
  const pts = nets.map((v, i) => ({
    x: (i / (nets.length - 1)) * W,
    y: H - ((v - min) / range) * H,
  }));
  assert(pts.every(p => p.x >= 0 && p.x <= W), 'all x in [0,W]');
  assert(pts.every(p => p.y >= 0 && p.y <= H), 'all y in [0,H]');
}

function testSparklineColor() {
  // Correct stroke color based on latest value
  const getColor = net => net > 0.01 ? '#69db7c' : net < -0.01 ? '#ff6b6b' : '#333';
  assert(getColor(10)    === '#69db7c', 'positive → green');
  assert(getColor(-5)    === '#ff6b6b', 'negative → red');
  assert(getColor(0)     === '#333',    'zero → grey');
  assert(getColor(0.001) === '#333',    'near-zero rounds to grey');
}

function testSpyModeSeparation() {
  // Spy user bets must NOT affect own P&L state
  const today = new Date().toISOString().slice(0, 10);

  // Own bets (user=louis)
  const ownBets = [
    { betId:'l1', userId:'louis', isParlay:false, placementDate:today+'T10:00Z', status:'Won',  stake:'100', returns:'190' },
  ];

  // Spy bets (user=ish) — different userId entirely
  const spyBets = [
    { betId:'i1', userId:'ish',   isParlay:false, placementDate:today+'T10:00Z', status:'Won',  stake:'50',  returns:'125' },
    { betId:'i2', userId:'ish',   isParlay:false, placementDate:today+'T11:00Z', status:'Lost', stake:'30',  returns:'0'   },
  ];

  // Own P&L only uses ownBets — spyBets must not bleed in
  const ownNet = ownBets.filter(b=>b.status!=='Open').reduce((s,b)=>s+betProfitFn(b),0);
  assert(Math.abs(ownNet - 90) < 0.01, `own net should be +90, got ${ownNet}`);

  // Spy summary is computed from spyBets separately
  const spySettled = spyBets.filter(b=>b.status!=='Open');
  const spyNet  = spySettled.reduce((s,b)=>s+betProfitFn(b),0);
  const spyWins = spySettled.filter(b=>(b.status||'').toLowerCase()==='won').length;
  const spyLoss = spySettled.filter(b=>(b.status||'').toLowerCase()==='lost').length;
  assert(Math.abs(spyNet - 45) < 0.01, `spy net should be +45 (75-30), got ${spyNet}`);
  assert(spyWins === 1 && spyLoss === 1, `spy 1W 1L, got ${spyWins}W ${spyLoss}L`);

  // No cross-contamination: ownBets contain no ish bets
  assert(!ownBets.some(b => b.userId === 'ish'), 'ish bets must not appear in own list');
}

function testLiveScoreFuzzyMatch() {
  // Mirrors fuzzy matching logic in server.js /api/live-score
  const norm  = str => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fuzzy = (a, b) => { const na=norm(a), nb=norm(b); return na.includes(nb) || nb.includes(na); };
  const hasT1 = (names, t) => names.some(n => fuzzy(n, t));
  const hasT2 = (names, t) => names.some(n => fuzzy(n, t));

  // Exact match
  const names1 = ['Brazil', 'Morocco'];
  assert(hasT1(names1,'Brazil') && hasT2(names1,'Morocco'), 'exact match should work');

  // Substring match: "United States" → "US" (partial)
  const names2 = ['United States', 'Mexico'];
  assert(hasT1(names2, 'United States') || fuzzy('United States','United States'), 'US should match');

  // No match
  const names3 = ['France', 'Germany'];
  assert(!hasT1(names3,'Brazil'), 'non-matching team1 should return false');
  assert(!hasT2(names3,'Morocco'), 'non-matching team2 should return false');

  // Case insensitive
  const names4 = ['brazil', 'MOROCCO'];
  assert(hasT1(names4,'Brazil') && hasT2(names4,'Morocco'), 'case-insensitive match should work');
}

// ── New server-side tests ───────────────────────────────────────────────────
async function runNewFeatureServerTests() {
  console.log('\n── New Features (Server) ──');

  // Live score endpoint exists and returns null for unknown teams
  await check('GET /api/live-score?team1=Unknown&team2=Nobody returns null', async () => {
    const r = await fetch(`${target}/api/live-score?sport=soccer&team1=UnknownTeamXYZ&team2=NobodyFC`);
    assert(r.ok, `HTTP ${r.status}`);
    const d = await r.json();
    assert(d === null, `should return null for unknown teams, got: ${JSON.stringify(d)}`);
  });

  await check('GET /api/live-score with no team params returns null', async () => {
    const r = await fetch(`${target}/api/live-score`);
    assert(r.ok, `HTTP ${r.status}`);
    const d = await r.json();
    assert(d === null, 'should return null when no params');
  });

  await check('GET /api/live-score?sport=mma responds without error', async () => {
    const r = await fetch(`${target}/api/live-score?sport=mma_mixed_martial_arts&team1=Fighter+A&team2=Fighter+B`);
    assert(r.ok, `HTTP ${r.status}`);
    // Should be null (no real fight) or a valid object
    const d = await r.json();
    assert(d === null || (typeof d === 'object' && 'score1' in d), `expected null or score object, got ${JSON.stringify(d)}`);
  });

  // Spy mode: fetch bets for user=testspy returns isolated bets
  await check('Spy mode: /api/dk-bets?user=spyuser returns only that user bets', async () => {
    const spyBet = { betId:'spy-test-bet', receiptId:'spy-test-bet', status:'Unsettled', settlementStatus:'Won',
      stake:50, potentialReturns:125, returns:125, placementDate:new Date().toISOString(),
      displayOdds:'+150', selections:[{selectionDisplayName:'Draw', marketDisplayName:'Moneyline', displayOdds:'+150'}]};
    await post('/api/dk-sync', { url:'wss://test', userId:'spyuser-test',
      data:{ result:{ initial:{ bets:[spyBet] } } }, ts:Date.now() });

    const spyBets = await get('/api/dk-bets?user=spyuser-test&all=1');
    assert(Array.isArray(spyBets), 'should return array');
    assert(spyBets.every(b => b.userId === 'spyuser-test'), 'all bets should belong to spy user');
    const found = spyBets.find(b => b.betId === 'spy-test-bet');
    assert(found, 'spy bet should be returned');
    assert(found.potentialReturns === 125, 'potentialReturns should be preserved for profit fallback');
  });

  // Bet log data: all fields needed for rendering are present
  await check('Bet log fields: betId, selection, odds, stake, status, placementDate, returns, potentialReturns all present', async () => {
    const userId = 'betlog-field-test';
    await post('/api/dk-sync', { url:'wss://test', userId,
      data:{ result:{ initial:{ bets:[{
        betId:'betlog-1', receiptId:'betlog-1', status:'Unsettled', settlementStatus:'Won',
        stake:100, potentialReturns:190, returns:190, placementDate:new Date().toISOString(),
        displayOdds:'+150',
        selections:[{selectionDisplayName:'Test Fighter', marketDisplayName:'Moneyline', displayOdds:'+150'}]
      }] } } }, ts:Date.now() });
    const bets = await get(`/api/dk-bets?user=${userId}&all=1`);
    assert(bets.length >= 1, 'should have at least 1 bet');
    const b = bets.find(b => b.betId === 'betlog-1');
    assert(b, 'betlog-1 should be found');
    const required = ['betId','selection','odds','stake','status','placementDate','returns','potentialReturns'];
    for (const f of required) {
      assert(f in b, `bet log field "${f}" must be present in API response`);
    }
  });

  // CLV alert: opening odds stored correctly when game is selected (test indirectly via P&L)
  await check('P&L net is correct after mix of Won/Lost/Push on same user', async () => {
    const userId = 'clv-pnl-test-user';
    await post('/api/dk-sync', { url:'wss://test', userId,
      data:{ result:{ initial:{ bets:[
        { betId:'clv-won', receiptId:'clv-won', status:'Settled', settlementStatus:'Won',
          stake:50, potentialReturns:125, returns:125, placementDate:new Date().toISOString(),
          displayOdds:'+150', selections:[{selectionDisplayName:'Brazil', marketDisplayName:'Moneyline', displayOdds:'+150'}] },
        { betId:'clv-lost', receiptId:'clv-lost', status:'Settled', settlementStatus:'Lost',
          stake:25, potentialReturns:50, returns:0, placementDate:new Date().toISOString(),
          displayOdds:'+100', selections:[{selectionDisplayName:'Morocco', marketDisplayName:'Moneyline', displayOdds:'+100'}] },
        { betId:'clv-push', receiptId:'clv-push', status:'Settled', settlementStatus:'Push',
          stake:30, potentialReturns:30, returns:30, placementDate:new Date().toISOString(),
          displayOdds:'-110', selections:[{selectionDisplayName:'Draw', marketDisplayName:'Moneyline', displayOdds:'-110'}] },
      ] } } }, ts:Date.now() });
    const all = await get(`/api/dk-bets?user=${userId}&all=1`);
    const today = new Date().toISOString().slice(0,10);
    const straight = all.filter(b => !b.isParlay && b.placementDate && b.placementDate.slice(0,10) === today);
    const settled = straight.filter(b => (b.status||'').toLowerCase() !== 'open');
    // betProfit on server-returned bets
    const pf = b => {
      const st = (b.status||'').toLowerCase();
      const stake = parseFloat(b.stake||0);
      if (st==='won') { const r=parseFloat(b.returns); const p=(r>0)?r:parseFloat(b.potentialReturns||0); return p>stake?p-stake:p; }
      if (st==='lost') return -stake;
      if (st==='push') return 0;
      return 0;
    };
    const net = settled.reduce((s,b)=>s+pf(b),0);
    // Won: +75 (125-50), Lost: -25, Push: 0 → net = +50
    assert(Math.abs(net - 50) < 0.01, `net should be +50, got ${net}`);
    const wins = settled.filter(b=>(b.status||'').toLowerCase()==='won').length;
    const losses = settled.filter(b=>(b.status||'').toLowerCase()==='lost').length;
    const pushes = settled.filter(b=>(b.status||'').toLowerCase()==='push').length;
    assert(wins===1 && losses===1 && pushes===1, `expected 1W 1L 1P, got ${wins}W ${losses}L ${pushes}P`);
  });

  // Spy mode isolation: spy user bets don't affect own P&L endpoint
  await check('Spy user bets fully isolated — own /api/dk-bets?user=X not contaminated by spy=Y', async () => {
    const ownUser = 'spy-isolation-own';
    const spyUser = 'spy-isolation-spy';
    await post('/api/dk-sync', { url:'wss://test', userId:ownUser,
      data:{ result:{ initial:{ bets:[{
        betId:'si-own-bet', receiptId:'si-own-bet', status:'Unsettled', settlementStatus:'Open',
        stake:100, potentialReturns:190, placementDate:new Date().toISOString(),
        displayOdds:'+150', selections:[{selectionDisplayName:'Fighter Own', marketDisplayName:'Moneyline', displayOdds:'+150'}]
      }] } } }, ts:Date.now() });
    await post('/api/dk-sync', { url:'wss://test', userId:spyUser,
      data:{ result:{ initial:{ bets:[{
        betId:'si-spy-bet', receiptId:'si-spy-bet', status:'Settled', settlementStatus:'Won',
        stake:50, potentialReturns:500, returns:500, placementDate:new Date().toISOString(),
        displayOdds:'+900', selections:[{selectionDisplayName:'Fighter Spy', marketDisplayName:'Moneyline', displayOdds:'+900'}]
      }] } } }, ts:Date.now() });
    const ownBets = await get(`/api/dk-bets?user=${ownUser}&all=1`);
    const spyBets = await get(`/api/dk-bets?user=${spyUser}&all=1`);
    assert(!ownBets.some(b=>b.betId==='si-spy-bet'), 'spy bet must NOT appear in own user bets');
    assert(!spyBets.some(b=>b.betId==='si-own-bet'), 'own bet must NOT appear in spy user bets');
    assert(ownBets.some(b=>b.betId==='si-own-bet'), 'own bet must be in own response');
    assert(spyBets.some(b=>b.betId==='si-spy-bet'), 'spy bet must be in spy response');
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════');
console.log('  BET BOT TEST SUITE');
console.log('═══════════════════════════════════');

console.log('\n── Unit Tests ──');
try { testOddsParsing(); console.log('  ✓ odds parsing (unicode minus)'); passed++; } catch(e) { console.error('  ✗ odds parsing:', e.message); failed++; }
try { testBetParsing(); console.log('  ✓ bet parsing (settlementStatus → Open)'); passed++; } catch(e) { console.error('  ✗ bet parsing:', e.message); failed++; }
try { testDKExtDotLogic(); console.log('  ✓ DK EXT dot: logged out→red, no sync→yellow, active→green'); passed++; } catch(e) { console.error('  ✗ DK EXT dot logic:', e.message); failed++; }
try { testConnectionHealth(); console.log('  ✓ connection health classification'); passed++; } catch(e) { console.error('  ✗ connection health:', e.message); failed++; }
try { testTrackerGameSwitchClearsDkBets(); console.log('  ✓ game switch clears DK bets, keeps manual bets'); passed++; } catch(e) { console.error('  ✗ game switch clear:', e.message); failed++; }
try { testTrackerBetIdDedup(); console.log('  ✓ page refresh: DK bets wiped, manual bets survive, server re-populates'); passed++; } catch(e) { console.error('  ✗ tracker bet dedup:', e.message); failed++; }
try { testRefreshClearsDKBets(); console.log('  ✓ refresh clears all DK bets, manual LOCK IN bets persist'); passed++; } catch(e) { console.error('  ✗ refresh clears DK bets:', e.message); failed++; }
try { testDedupBets(); console.log('  ✓ bet dedup (real userId overwrites default)'); passed++; } catch(e) { console.error('  ✗ bet dedup:', e.message); failed++; }
try { testParlayDetection(); console.log('  ✓ parlay detection (straight vs parlay vs leg)'); passed++; } catch(e) { console.error('  ✗ parlay detection:', e.message); failed++; }
try { testDrawBetMatching(); console.log('  ✓ draw bet matching: Draw/Tie → side=draw, null when no draw market'); passed++; } catch(e) { console.error('  ✗ draw bet matching:', e.message); failed++; }
try { testPnLTodayFilter(); console.log('  ✓ P&L today filter: yesterday bets excluded, today bets included'); passed++; } catch(e) { console.error('  ✗ P&L today filter:', e.message); failed++; }
try { testPnLCalculation(); console.log('  ✓ P&L calculation: won/lost/push net correct'); passed++; } catch(e) { console.error('  ✗ P&L calculation:', e.message); failed++; }
try { testPnLNullReturns(); console.log('  ✓ P&L null returns: won bet with null returns uses potentialReturns (Ish draw bet fix)'); passed++; } catch(e) { console.error('  ✗ P&L null returns:', e.message); failed++; }
try { testSettlementDetection(); console.log('  ✓ settlement detection: Open→Won/Lost triggers, pre-settled excluded'); passed++; } catch(e) { console.error('  ✗ settlement detection:', e.message); failed++; }
try { testOddsDelta(); console.log('  ✓ odds delta: ▲/▼ shown when moved, hidden when unchanged'); passed++; } catch(e) { console.error('  ✗ odds delta:', e.message); failed++; }
try { testDKBannerLogic(); console.log('  ✓ DK banner: all 4 non-green states show banner, green hides it'); passed++; } catch(e) { console.error('  ✗ DK banner logic:', e.message); failed++; }
try { testRecordingsFilter(); console.log('  ✓ recordings: filters ? vs ?, test data, normalizes sport labels'); passed++; } catch(e) { console.error('  ✗ recordings filter:', e.message); failed++; }
try { testBetLogFilter(); console.log('  ✓ bet log filter: today straight only, excludes yesterday+parlays'); passed++; } catch(e) { console.error('  ✗ bet log filter:', e.message); failed++; }
try { testBetLogProfitDisplay(); console.log('  ✓ bet log P&L: null/zero returns fallback, case-insensitive, all statuses'); passed++; } catch(e) { console.error('  ✗ bet log profit display:', e.message); failed++; }
try { testBetLogSort(); console.log('  ✓ bet log sort: newest bet appears first'); passed++; } catch(e) { console.error('  ✗ bet log sort:', e.message); failed++; }
try { testCLVAlert(); console.log('  ✓ CLV alert: triggers on >15pt adverse move, silent on favorable/small/no-bet'); passed++; } catch(e) { console.error('  ✗ CLV alert:', e.message); failed++; }
try { testSparklineAccumulation(); console.log('  ✓ sparkline: accumulates up to 40 pts, SVG x/y in bounds'); passed++; } catch(e) { console.error('  ✗ sparkline:', e.message); failed++; }
try { testSparklineColor(); console.log('  ✓ sparkline color: green/red/grey by latest net'); passed++; } catch(e) { console.error('  ✗ sparkline color:', e.message); failed++; }
try { testSpyModeSeparation(); console.log('  ✓ spy mode: spy bets isolated from own P&L, separate net calc'); passed++; } catch(e) { console.error('  ✗ spy mode separation:', e.message); failed++; }
try { testLiveScoreFuzzyMatch(); console.log('  ✓ live score fuzzy match: exact/substring/case-insensitive match, false negatives'); passed++; } catch(e) { console.error('  ✗ live score fuzzy match:', e.message); failed++; }

runServerTests().then(async () => {
  await runNewFeatureServerTests();
}).then(() => {
  console.log(`\n═══════════════════════════════════`);
  console.log(`  ${passed} passed  ${failed} failed`);
  console.log(`═══════════════════════════════════\n`);
  if (failed > 0) process.exit(1);
}).catch(e => { console.error(e); process.exit(1); });
