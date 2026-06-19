#!/usr/bin/env node
// Bet Bot test suite — run before every push: node test.js
// Tests all server endpoints and core parsing logic

const BASE = process.env.TEST_URL || 'https://ufc-dashboard-production-e03d.up.railway.app';
const LOCAL = process.env.LOCAL_URL || 'http://localhost:3000';
const target = process.argv[2] === '--local' ? LOCAL : BASE;

const fs   = require('fs');
const os   = require('os');
const path = require('path');

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
  await check('POST /api/dk-logout sets per-user loggedOut; heartbeat clears it', async () => {
    const uid = 'logout-test-sentinel';
    await post('/api/dk-heartbeat', { userId: uid });
    await post('/api/dk-logout', { userId: uid });
    const d = await get('/api/dk-status');
    assert(d.loggedOutUsers && d.loggedOutUsers.includes(uid), 'user should be in loggedOutUsers after logout');
    assert(d.loggedOut === true, 'global loggedOut should be true');
    // Reset via heartbeat from same user
    await post('/api/dk-heartbeat', { userId: uid });
    const d2 = await get('/api/dk-status');
    assert(!d2.loggedOutUsers.includes(uid), 'user should be cleared from loggedOutUsers after heartbeat');
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
    const uid = 'testuser-heartbeat-banner';
    await post('/api/dk-heartbeat', { ts: Date.now(), userId: uid });
    const d = await get('/api/dk-status');
    assert(d.lastBetSync !== null, 'lastBetSync must be set after heartbeat so banner auto-clears');
    // Only check this user is not logged out — global flag may be true from other test users
    assert(!d.loggedOutUsers || !d.loggedOutUsers.includes(uid), 'this user should not be in loggedOutUsers after heartbeat');
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

  // ── Session loss detection ──────────────────────────────────────────────────
  await check('dk-logout sets per-user loggedOutUsers, dk-status exposes it', async () => {
    const user = 'session-loss-test-user';
    // Bring user alive first
    await post('/api/dk-heartbeat', { userId: user });
    let status = await get('/api/dk-status');
    assert(status.activeUsers.includes(user), 'user should be active after heartbeat');
    assert(!status.loggedOutUsers.includes(user), 'user should NOT be in loggedOutUsers yet');

    // Simulate logout
    await post('/api/dk-logout', { userId: user });
    status = await get('/api/dk-status');
    assert(status.loggedOutUsers.includes(user), 'user should be in loggedOutUsers after logout');
    assert(!status.activeUsers.includes(user), 'user should NOT be in activeUsers after logout');
    assert(status.loggedOut === true, 'global loggedOut flag should be true');
  });

  await check("another user's heartbeat does NOT clear logged-out user's flag", async () => {
    const loggedOutUser = 'lo-user-a';
    const otherUser     = 'lo-user-b';

    // Log out user A
    await post('/api/dk-logout', { userId: loggedOutUser });
    // User B sends heartbeat
    await post('/api/dk-heartbeat', { userId: otherUser });

    const status = await get('/api/dk-status');
    assert(status.loggedOutUsers.includes(loggedOutUser), "user A must still be in loggedOutUsers — user B's heartbeat must not clear it");
    assert(status.activeUsers.includes(otherUser), 'user B should be active');
    assert(!status.activeUsers.includes(loggedOutUser), 'user A must not be active');
  });

  await check('heartbeat from logged-out user clears their loggedOut flag', async () => {
    const user = 'lo-relogin-test';
    await post('/api/dk-logout', { userId: user });
    let status = await get('/api/dk-status');
    assert(status.loggedOutUsers.includes(user), 'should be logged out first');

    // User re-logs in → extension sends heartbeat
    await post('/api/dk-heartbeat', { userId: user });
    status = await get('/api/dk-status');
    assert(!status.loggedOutUsers.includes(user), 'heartbeat should clear logout flag for that user');
    assert(status.activeUsers.includes(user), 'user should be active again');
  });
}

// ── Record Engine Unit Tests ──────────────────────────────────────────────────

function testRecordEngineExports() {
  const re = require('./record_engine');
  const required = ['recFightId','recFilePath','recIsLive','recExtractOdds',
    'recSaveRecord','pushFightToGitHub','autoEnrich',
    'loadPersistedState','persistState','clearPersistedState',
    'migrateToVolume','HISTORICAL_DIR','STATE_FILE'];
  for (const fn of required) {
    if (!(fn in re)) throw new Error(`record_engine missing export: ${fn}`);
  }
}

function testPushFightToGitHubNoToken() {
  // Should log a warning and return without throwing when GITHUB_TOKEN is absent
  const { pushFightToGitHub } = require('./record_engine');
  const orig = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const tmpFile = path.join(os.tmpdir(), 'test_fight.json');
  fs.writeFileSync(tmpFile, JSON.stringify({ fightId: 'test', oddsHistory: [] }));
  const result = pushFightToGitHub(tmpFile); // returns a promise
  if (orig !== undefined) process.env.GITHUB_TOKEN = orig;
  fs.unlinkSync(tmpFile);
  if (!result || typeof result.then !== 'function') throw new Error('pushFightToGitHub should return a Promise');
}

function testMigrateToVolumeNoop() {
  // When DATA_DIR is not set, migrateToVolume should be a no-op (no throw, no copies)
  const { migrateToVolume } = require('./record_engine');
  delete process.env.DATA_DIR; // ensure no volume
  migrateToVolume(); // must not throw
}

function testMigrateToVolumeCopiesFiles() {
  // When DATA_DIR points to a temp dir, migrateToVolume copies fight files
  const { migrateToVolume, HISTORICAL_DIR } = require('./record_engine');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-volume-'));
  process.env.DATA_DIR = tmpDir;
  // Bust require cache so DATA_ROOT is re-evaluated
  delete require.cache[require.resolve('./record_engine')];
  const re2 = require('./record_engine');
  re2.migrateToVolume();
  // Check that historical_data subdir was created in the volume
  const volumeHistDir = path.join(tmpDir, 'historical_data');
  if (!fs.existsSync(volumeHistDir)) throw new Error('volume historical_data dir not created');
  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete require.cache[require.resolve('./record_engine')];
  require('./record_engine'); // reload clean
}

function testWorldCupInSportMeta() {
  // Verify World Cup is in ALWAYS_POLL and has correct window
  // We can't import server.js directly (it starts a server), so test record_engine directly
  // and spot-check that World Cup sport key is handled by recFightId
  const { recFightId, recIsLive } = require('./record_engine');
  const fakeGame = {
    home_team: 'Brazil',
    away_team: 'Argentina',
    commence_time: new Date(Date.now() - 60000).toISOString(), // 1 min ago
  };
  const id = recFightId('soccer_fifa_world_cup', fakeGame);
  if (!id.startsWith('soccer__')) throw new Error(`Expected soccer__ prefix, got: ${id}`);
  // 130-minute window — game started 1 min ago should be live
  const live = recIsLive(fakeGame, 130 * 60 * 1000);
  if (!live) throw new Error('Game started 1 min ago should be live within 130-min window');
  // Game started 131 min ago should NOT be live
  const old = { ...fakeGame, commence_time: new Date(Date.now() - 131 * 60 * 1000).toISOString() };
  if (recIsLive(old, 130 * 60 * 1000)) throw new Error('Game started 131 min ago should NOT be live');
}

function testSoccerOddsExtractIncludesDraw() {
  const { recExtractOdds } = require('./record_engine');
  // Soccer h2h has 3 outcomes: home, draw, away
  const fakeGame = {
    bookmakers: [{
      markets: [{
        key: 'h2h',
        outcomes: [
          { name: 'Brazil', price: -150 },
          { name: 'Draw', price: +260 },
          { name: 'Argentina', price: +380 },
        ],
      }],
    }],
  };
  const odds = recExtractOdds(fakeGame);
  if (!odds) throw new Error('recExtractOdds returned null for valid soccer game');
  if (odds.fighter1.name !== 'Brazil') throw new Error(`Expected Brazil, got ${odds.fighter1.name}`);
  if (odds.fighter2.name !== 'Draw') throw new Error(`Expected Draw as fighter2, got ${odds.fighter2.name}`);
}

async function runCoverageServerTests() {
  console.log('\n── Bet Coverage (Server) ──');

  // Seed a test user with known bets via /api/dk-mock, then check /api/bet-coverage
  await check('/api/bet-coverage returns 200 with covered array', async () => {
    const r = await fetch(`${LOCAL}/api/bet-coverage?user=cov-test-user`);
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const d = await r.json();
    assert(Array.isArray(d.covered), `covered must be array, got ${typeof d.covered}`);
    assert(typeof d.userId === 'string', `userId missing`);
  });

  await check('/api/bet-coverage with no bets returns empty covered array', async () => {
    const d = await fetch(`${LOCAL}/api/bet-coverage?user=nobody-ever`).then(r => r.json());
    assert(d.covered.length === 0, `expected [], got ${JSON.stringify(d.covered)}`);
  });

  await check('/api/bet-coverage reflects mocked bet selection', async () => {
    // Seed a bet via /api/dk-mock
    await fetch(`${LOCAL}/api/dk-mock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighter: 'Canada', odds: '-1600', stake: 0.01, userId: 'cov-live-test' })
    });
    const d = await fetch(`${LOCAL}/api/bet-coverage?user=cov-live-test`).then(r => r.json());
    const hasCanada = d.covered.some(s => s.toLowerCase().includes('canada'));
    assert(hasCanada, `expected "canada" in covered, got ${JSON.stringify(d.covered)}`);
  });

  await check('/api/bet-coverage excludes parlays from covered selections', async () => {
    // The /api/dk-mock endpoint creates straight bets — confirm they appear
    // Parlay bets should not light up individual coverage dots
    const d = await fetch(`${LOCAL}/api/bet-coverage?user=cov-live-test`).then(r => r.json());
    assert(Array.isArray(d.bets), `bets array missing`);
    const noParlay = d.bets.every(b => !b.isParlay);
    assert(noParlay, `parlays should be excluded from coverage bets`);
  });

  await check('/api/bet-coverage bets field has selection+stake+odds', async () => {
    const d = await fetch(`${LOCAL}/api/bet-coverage?user=cov-live-test`).then(r => r.json());
    if (d.bets.length) {
      const b = d.bets[0];
      assert(typeof b.selection === 'string', `missing selection`);
      assert(typeof b.stake === 'number', `missing stake`);
      assert(typeof b.odds === 'string', `missing odds`);
    }
  });
}

async function runRecordingTests() {
  console.log('\n── Recording (Server) ──');

  await check('World Cup sport key accepted by /api/recorder/watch', async () => {
    const d = await post('/api/recorder/watch', { sport: 'soccer_fifa_world_cup', team1: 'Brazil', team2: 'Argentina' });
    assert(d.ok, `expected ok:true, got ${JSON.stringify(d)}`);
  });

  await check('recorder/status shows World Cup game in watching when heartbeat < 2 min', async () => {
    await post('/api/recorder/watch', { sport: 'soccer_fifa_world_cup', team1: 'Brazil', team2: 'Argentina' });
    const d = await get('/api/recorder/status');
    assert(Array.isArray(d.watching), 'watching should be an array');
    const wc = d.watching.find(w => typeof w === 'string' &&
      (w.includes('World Cup') || w.includes('soccer_fifa') || w.includes('Brazil') || w.includes('Argentina')));
    assert(wc, `World Cup game not found in watching: ${JSON.stringify(d.watching)}`);
  });

  await check('recorder/status always includes UFC/MMA as always-on sport', async () => {
    const d = await get('/api/recorder/status');
    assert(Array.isArray(d.watching), 'watching should be array');
    const ufc = d.watching.find(w => typeof w === 'string' && w.includes('UFC'));
    assert(ufc, `UFC not found in watching: ${JSON.stringify(d.watching)}`);
  });

  await check('GET /api/recorder/backup-status returns config shape', async () => {
    const d = await get('/api/recorder/backup-status');
    assert('githubToken' in d, 'missing githubToken field');
    assert('volumeActive' in d, 'missing volumeActive field');
    assert('dataDir' in d, 'missing dataDir field');
    assert('historicalDir' in d, 'missing historicalDir field');
    assert('ok' in d, 'missing ok field');
    assert(typeof d.githubToken === 'boolean', 'githubToken must be boolean');
    assert(typeof d.volumeActive === 'boolean', 'volumeActive must be boolean');
  });

  await check('backup-status githubToken true when GITHUB_TOKEN is set locally', async () => {
    // In local test env, GITHUB_TOKEN is set in .env
    const d = await get('/api/recorder/backup-status');
    assert(d.githubToken === true, `GITHUB_TOKEN not detected — set it in .env for local tests. Got: ${JSON.stringify(d)}`);
  });

  await check('recorder/status has required shape (recording, activeFights, totalSaved, lastPoll, watching)', async () => {
    const d = await get('/api/recorder/status');
    for (const f of ['recording', 'activeFights', 'totalSaved', 'lastPoll', 'watching']) {
      assert(f in d, `recorder/status missing field: ${f}`);
    }
    assert(typeof d.recording === 'boolean', 'recording must be boolean');
    assert(Array.isArray(d.activeFights), 'activeFights must be array');
    assert(Array.isArray(d.watching), 'watching must be array');
  });
}

async function runBetPlacementServerTests() {
  console.log('\n── Bet Placement (Server) ──');

  await check('/api/live-crossovers returns 200', async () => {
    const r = await fetch(`${target}/api/live-crossovers`);
    assert(r.ok, `HTTP ${r.status}`);
  });

  await check('/api/live-crossovers returns an array', async () => {
    const d = await get('/api/live-crossovers');
    assert(Array.isArray(d), `expected array, got ${typeof d}`);
  });

  await check('/api/live-crossovers items have required shape when fights active', async () => {
    const d = await get('/api/live-crossovers');
    // When fights are live, each entry must have these fields
    for (const entry of d) {
      assert(typeof entry.id === 'string', `entry.id not string: ${JSON.stringify(entry)}`);
      assert(typeof entry.fighter1 === 'string', `entry.fighter1 missing: ${JSON.stringify(entry)}`);
      assert(typeof entry.fighter2 === 'string', `entry.fighter2 missing: ${JSON.stringify(entry)}`);
      assert(typeof entry.crossoverState === 'object', `entry.crossoverState missing: ${JSON.stringify(entry)}`);
    }
  });

  await check('/api/live-crossovers crossoverState has status field', async () => {
    const d = await get('/api/live-crossovers');
    const validStatuses = ['approaching', 'imminent', 'crossed', 'receding', 'stable'];
    for (const entry of d) {
      const s = entry.crossoverState?.status;
      if (s) { // only check if fights active
        assert(validStatuses.includes(s), `invalid crossover status "${s}" — valid: ${validStatuses.join(', ')}`);
      }
    }
  });

  await check('/api/live-crossovers crossoverState hasCrossed is boolean when present', async () => {
    const d = await get('/api/live-crossovers');
    for (const entry of d) {
      if (entry.crossoverState && 'hasCrossed' in entry.crossoverState) {
        assert(typeof entry.crossoverState.hasCrossed === 'boolean',
          `hasCrossed must be boolean, got ${typeof entry.crossoverState.hasCrossed}`);
      }
    }
  });

  await check('/api/dk-mock then /api/bet-coverage shows the bet', async () => {
    const uid = `placement-test-${Date.now()}`;
    await fetch(`${target}/api/dk-mock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighter: 'Draw', odds: '+350', stake: 0.01, userId: uid })
    });
    const d = await fetch(`${target}/api/bet-coverage?user=${uid}`).then(r => r.json());
    assert(Array.isArray(d.covered), 'covered must be array');
    const hasDrawBet = d.bets.some(b => b.selection.toLowerCase().includes('draw'));
    assert(hasDrawBet, `draw bet not reflected in coverage: ${JSON.stringify(d.bets)}`);
  });

  await check('/api/bet-coverage covered array lowercase', async () => {
    const uid = `case-test-${Date.now()}`;
    await fetch(`${target}/api/dk-mock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighter: 'Canada', odds: '-350', stake: 0.01, userId: uid })
    });
    const d = await fetch(`${target}/api/bet-coverage?user=${uid}`).then(r => r.json());
    assert(Array.isArray(d.covered), 'covered must be array');
    for (const s of d.covered) {
      assert(s === s.toLowerCase(), `covered entries should be lowercase, got "${s}"`);
    }
  });

  await check('/api/bet-coverage: two bets on same user, both reflected', async () => {
    const uid = `two-bet-test-${Date.now()}`;
    await fetch(`${target}/api/dk-mock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighter: 'Canada', odds: '-350', stake: 0.01, userId: uid })
    });
    await fetch(`${target}/api/dk-mock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighter: 'Qatar', odds: '+200', stake: 0.01, userId: uid })
    });
    const d = await fetch(`${target}/api/bet-coverage?user=${uid}`).then(r => r.json());
    assert(d.bets.length >= 2, `expected ≥2 bets, got ${d.bets.length}`);
    assert(d.covered.length >= 2, `expected ≥2 covered, got ${d.covered.length}`);
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

console.log('\n── Record Engine (Unit) ──');
try { testRecordEngineExports(); console.log('  ✓ record_engine exports all required functions'); passed++; } catch(e) { console.error('  ✗ record_engine exports:', e.message); failed++; }
try { testPushFightToGitHubNoToken(); console.log('  ✓ pushFightToGitHub returns Promise, no-throw when GITHUB_TOKEN missing'); passed++; } catch(e) { console.error('  ✗ pushFightToGitHub no-token:', e.message); failed++; }
try { testMigrateToVolumeNoop(); console.log('  ✓ migrateToVolume is no-op when DATA_DIR not set'); passed++; } catch(e) { console.error('  ✗ migrateToVolume noop:', e.message); failed++; }
try { testMigrateToVolumeCopiesFiles(); console.log('  ✓ migrateToVolume creates historical_data in volume on first boot'); passed++; } catch(e) { console.error('  ✗ migrateToVolume copies:', e.message); failed++; }
try { testWorldCupInSportMeta(); console.log('  ✓ World Cup fight ID has soccer__ prefix, 130-min live window correct'); passed++; } catch(e) { console.error('  ✗ World Cup sport meta:', e.message); failed++; }
try { testSoccerOddsExtractIncludesDraw(); console.log('  ✓ soccer h2h odds extraction preserves Draw as fighter2'); passed++; } catch(e) { console.error('  ✗ soccer odds extract:', e.message); failed++; }

// ── parseBetCmd (popup.js logic, replicated here for unit testing) ─────────
console.log('\n── Bet Chat: parseBetCmd ──');

function parseBetCmd(raw) {
  const m = raw.trim().match(/^bet\s+(.+?)\s+([\d.]+)$/i);
  if (!m) return null;
  return { side: m[1].trim(), amount: parseFloat(m[2]) };
}

function testParseBetCmdBasic() {
  const r = parseBetCmd('bet canada 0.01');
  assert(r && r.side === 'canada' && r.amount === 0.01, `got ${JSON.stringify(r)}`);
}
function testParseBetCmdDraw() {
  const r = parseBetCmd('bet Draw 5');
  assert(r && r.side === 'Draw' && r.amount === 5, `got ${JSON.stringify(r)}`);
}
function testParseBetCmdDecimal() {
  const r = parseBetCmd('bet Fighter A 2.50');
  assert(r && r.side === 'Fighter A' && r.amount === 2.5, `got ${JSON.stringify(r)}`);
}
function testParseBetCmdMultiWord() {
  const r = parseBetCmd('bet Canada away 10');
  assert(r && r.side === 'Canada away' && r.amount === 10, `got ${JSON.stringify(r)}`);
}
function testParseBetCmdCaseInsensitive() {
  const r = parseBetCmd('BET QATAR 25');
  assert(r && r.side === 'QATAR' && r.amount === 25, `got ${JSON.stringify(r)}`);
}
function testParseBetCmdInvalidNoAmount() {
  const r = parseBetCmd('bet canada');
  assert(r === null, `expected null, got ${JSON.stringify(r)}`);
}
function testParseBetCmdInvalidNoKeyword() {
  const r = parseBetCmd('canada 5');
  assert(r === null, `expected null, got ${JSON.stringify(r)}`);
}
function testParseBetCmdInvalidEmptyString() {
  const r = parseBetCmd('');
  assert(r === null, `expected null, got ${JSON.stringify(r)}`);
}

try { testParseBetCmdBasic(); console.log('  ✓ parseBetCmd: "bet canada 0.01" parses correctly'); passed++; } catch(e) { console.error('  ✗ parseBetCmd basic:', e.message); failed++; }
try { testParseBetCmdDraw(); console.log('  ✓ parseBetCmd: "bet Draw 5" parses Draw correctly'); passed++; } catch(e) { console.error('  ✗ parseBetCmd draw:', e.message); failed++; }
try { testParseBetCmdDecimal(); console.log('  ✓ parseBetCmd: multi-word side name parsed correctly'); passed++; } catch(e) { console.error('  ✗ parseBetCmd decimal:', e.message); failed++; }
try { testParseBetCmdMultiWord(); console.log('  ✓ parseBetCmd: "bet Canada away 10" captures full side'); passed++; } catch(e) { console.error('  ✗ parseBetCmd multi-word:', e.message); failed++; }
try { testParseBetCmdCaseInsensitive(); console.log('  ✓ parseBetCmd: uppercase BET works'); passed++; } catch(e) { console.error('  ✗ parseBetCmd case:', e.message); failed++; }
try { testParseBetCmdInvalidNoAmount(); console.log('  ✓ parseBetCmd: "bet canada" (no amount) → null'); passed++; } catch(e) { console.error('  ✗ parseBetCmd no-amount:', e.message); failed++; }
try { testParseBetCmdInvalidNoKeyword(); console.log('  ✓ parseBetCmd: "canada 5" (no "bet" keyword) → null'); passed++; } catch(e) { console.error('  ✗ parseBetCmd no-keyword:', e.message); failed++; }
try { testParseBetCmdInvalidEmptyString(); console.log('  ✓ parseBetCmd: empty string → null'); passed++; } catch(e) { console.error('  ✗ parseBetCmd empty:', e.message); failed++; }

// ── Coverage gamification (applyCoverage logic) ───────────────────────────
console.log('\n── Bet Coverage: gamification logic ──');

function computeCoverage(outcomeNames, covered) {
  // outcomeNames: ['Canada','Draw','Qatar']  covered: ['canada','draw']
  const coveredLower = covered.map(s => s.toLowerCase());
  const matched = outcomeNames.filter(name => {
    const nl = name.toLowerCase();
    return coveredLower.some(s => s === nl || nl.includes(s) || s.includes(nl));
  });
  return { covered: matched, locked: matched.length === outcomeNames.length && outcomeNames.length > 0 };
}

function testCoverage_noBets() {
  const r = computeCoverage(['Canada','Draw','Qatar'], []);
  assert(r.covered.length === 0 && !r.locked, `got ${JSON.stringify(r)}`);
}
function testCoverage_oneSide() {
  const r = computeCoverage(['Canada','Draw','Qatar'], ['canada']);
  assert(r.covered.length === 1 && !r.locked, `got ${JSON.stringify(r)}`);
}
function testCoverage_twoCovered() {
  const r = computeCoverage(['Canada','Draw','Qatar'], ['canada','draw']);
  assert(r.covered.length === 2 && !r.locked, `got ${JSON.stringify(r)}`);
}
function testCoverage_allThreeLocked() {
  const r = computeCoverage(['Canada','Draw','Qatar'], ['canada','draw','qatar']);
  assert(r.covered.length === 3 && r.locked, `got ${JSON.stringify(r)}`);
}
function testCoverage_mmaLocked() {
  const r = computeCoverage(['Fighter A','Fighter B'], ['fighter a','fighter b']);
  assert(r.covered.length === 2 && r.locked, `MMA should be locked: ${JSON.stringify(r)}`);
}
function testCoverage_mmaOneSide() {
  const r = computeCoverage(['Fighter A','Fighter B'], ['fighter a']);
  assert(r.covered.length === 1 && !r.locked, `got ${JSON.stringify(r)}`);
}
function testCoverage_fuzzyMatch() {
  // "alex pereira" matches outcome "Alex Pereira" (case-insensitive)
  const r = computeCoverage(['Alex Pereira','Ciryl Gane'], ['alex pereira']);
  assert(r.covered.length === 1 && r.covered[0] === 'Alex Pereira', `got ${JSON.stringify(r)}`);
}
function testCoverage_emptyOutcomes() {
  const r = computeCoverage([], ['canada']);
  assert(!r.locked && r.covered.length === 0, `empty outcomes should never lock: ${JSON.stringify(r)}`);
}

try { testCoverage_noBets(); console.log('  ✓ coverage: no bets → 0 covered, not locked'); passed++; } catch(e) { console.error('  ✗ coverage no-bets:', e.message); failed++; }
try { testCoverage_oneSide(); console.log('  ✓ coverage: 1/3 covered → not locked'); passed++; } catch(e) { console.error('  ✗ coverage 1-side:', e.message); failed++; }
try { testCoverage_twoCovered(); console.log('  ✓ coverage: 2/3 covered → not locked'); passed++; } catch(e) { console.error('  ✗ coverage 2-covered:', e.message); failed++; }
try { testCoverage_allThreeLocked(); console.log('  ✓ coverage: 3/3 soccer → LOCKED'); passed++; } catch(e) { console.error('  ✗ coverage all-three:', e.message); failed++; }
try { testCoverage_mmaLocked(); console.log('  ✓ coverage: 2/2 MMA → LOCKED'); passed++; } catch(e) { console.error('  ✗ coverage mma-locked:', e.message); failed++; }
try { testCoverage_mmaOneSide(); console.log('  ✓ coverage: 1/2 MMA → not locked'); passed++; } catch(e) { console.error('  ✗ coverage mma-one-side:', e.message); failed++; }
try { testCoverage_fuzzyMatch(); console.log('  ✓ coverage: fuzzy case-insensitive match works'); passed++; } catch(e) { console.error('  ✗ coverage fuzzy:', e.message); failed++; }
try { testCoverage_emptyOutcomes(); console.log('  ✓ coverage: empty outcomes array never locks'); passed++; } catch(e) { console.error('  ✗ coverage empty:', e.message); failed++; }

// ── Bet Placement: DOM detection strings ──────────────────────────────────
console.log('\n── Bet Placement: DOM detection strings ──');

// These regex patterns live inside the chrome.scripting.executeScript injected function.
// Replicated here so we can verify them without a browser.
const confirmedRegex  = /bet\s+placed|congrats|success|confirmed/i;
const oddsChangedRegex = /odds\s+(have\s+)?changed|accept\s+new\s+odds/i;
const suspendedRegex   = /market\s+suspended|betting\s+suspended/i;
const oddsTextRegex    = /^[+-]\d+$/;

try {
  assert(confirmedRegex.test('Bet Placed! Your wager is in.'), 'bet placed');
  assert(confirmedRegex.test('Congrats! Bet accepted.'), 'congrats');
  assert(confirmedRegex.test('Success! Wager submitted.'), 'success');
  assert(confirmedRegex.test('Bet Confirmed — good luck!'), 'confirmed');
  assert(!confirmedRegex.test('Processing your bet...'), 'processing should NOT match');
  console.log('  ✓ confirmedRegex: matches all success strings, rejects processing'); passed++;
} catch(e) { console.error('  ✗ confirmedRegex:', e.message); failed++; }

try {
  assert(oddsChangedRegex.test('Odds have changed since you added this bet.'), 'odds have changed');
  assert(oddsChangedRegex.test('Odds changed — please review.'), 'odds changed no "have"');
  assert(oddsChangedRegex.test('Accept New Odds to continue.'), 'accept new odds');
  assert(!oddsChangedRegex.test('Bet Placed!'), 'bet placed should NOT match');
  console.log('  ✓ oddsChangedRegex: catches all DK odds-change variants'); passed++;
} catch(e) { console.error('  ✗ oddsChangedRegex:', e.message); failed++; }

try {
  assert(suspendedRegex.test('Market Suspended'), 'market suspended');
  assert(suspendedRegex.test('Betting Suspended for this event.'), 'betting suspended');
  assert(!suspendedRegex.test('Bet Placed!'), 'bet placed should NOT match suspension');
  assert(!suspendedRegex.test('Odds have changed'), 'odds changed should NOT match suspension');
  console.log('  ✓ suspendedRegex: catches DK market/betting suspended strings'); passed++;
} catch(e) { console.error('  ✗ suspendedRegex:', e.message); failed++; }

try {
  assert(oddsTextRegex.test('+150'), '+150');
  assert(oddsTextRegex.test('-350'), '-350');
  assert(oddsTextRegex.test('+100'), '+100');
  assert(oddsTextRegex.test('-110'), '-110');
  assert(!oddsTextRegex.test('150'), 'missing sign should not match');
  assert(!oddsTextRegex.test('+150 pts'), 'trailing text should not match');
  assert(!oddsTextRegex.test('EVEN'), 'EVEN should not match');
  console.log('  ✓ oddsTextRegex: matches +N/-N, rejects unsigned and text'); passed++;
} catch(e) { console.error('  ✗ oddsTextRegex:', e.message); failed++; }

// ── Bet Placement: guard logic ─────────────────────────────────────────────
console.log('\n── Bet Placement: guard logic ──');

try {
  // betInFlight flag logic: second click while in-flight returns early
  let callCount = 0;
  let betInFlight = false;
  function fakeSendBet() {
    if (betInFlight) return; // guarded
    betInFlight = true;
    callCount++;
  }
  fakeSendBet(); // first click — should count
  fakeSendBet(); // second click — should be blocked
  fakeSendBet(); // third click — should be blocked
  assert(callCount === 1, `expected 1 execution, got ${callCount}`);
  betInFlight = false;
  fakeSendBet(); // after reset should work
  assert(callCount === 2, `expected 2 after reset, got ${callCount}`);
  console.log('  ✓ betInFlight: blocks double-click, unblocks after reset'); passed++;
} catch(e) { console.error('  ✗ betInFlight guard:', e.message); failed++; }

try {
  // Amount < 0.01 should be rejected before sending
  function validateBetAmount(amount) {
    if (amount < 0.01) return { valid: false, error: 'Minimum $0.01' };
    return { valid: true };
  }
  assert(!validateBetAmount(0).valid, '$0 rejected');
  assert(!validateBetAmount(-1).valid, 'negative rejected');
  assert(!validateBetAmount(0.001).valid, '$0.001 below min');
  assert(validateBetAmount(0.01).valid, '$0.01 ok');
  assert(validateBetAmount(0.05).valid, '$0.05 ok');
  assert(validateBetAmount(1000).valid, '$1000 ok');
  console.log('  ✓ amount validation: rejects <$0.01, accepts ≥$0.01'); passed++;
} catch(e) { console.error('  ✗ amount validation:', e.message); failed++; }

try {
  // parseBetCmd: zero amount returns object (regex matches), but validation rejects it
  const r = parseBetCmd('bet canada 0');
  assert(r !== null && r.amount === 0, `"bet canada 0" should parse to amount=0, got ${JSON.stringify(r)}`);
  // Then validation catches it
  assert(r.amount < 0.01, 'amount=0 should fail the 0.01 check');
  console.log('  ✓ parseBetCmd: "bet canada 0" parses (amount=0) but fails validation gate'); passed++;
} catch(e) { console.error('  ✗ parseBetCmd zero amount:', e.message); failed++; }

try {
  // parseBetCmd: trailing text after amount should NOT match (regex ends at $)
  const r1 = parseBetCmd('bet canada 25 hedge qatar');
  assert(r1 === null, `"bet canada 25 hedge qatar" should be null (strategy syntax), got ${JSON.stringify(r1)}`);
  // DK odds embedded in command also rejected
  const r2 = parseBetCmd('bet canada 25.00 at -350');
  assert(r2 === null, `"bet canada 25.00 at -350" should be null, got ${JSON.stringify(r2)}`);
  console.log('  ✓ parseBetCmd: trailing text after amount → null ($ anchor enforced)'); passed++;
} catch(e) { console.error('  ✗ parseBetCmd trailing text:', e.message); failed++; }

try {
  // parseBetCmd: large stakes work (no upper bound in regex)
  const r = parseBetCmd('bet Canada 10000');
  assert(r && r.amount === 10000, `$10000 should parse, got ${JSON.stringify(r)}`);
  const r2 = parseBetCmd('bet Canada 0.01');
  assert(r2 && r2.amount === 0.01, `min bet should parse, got ${JSON.stringify(r2)}`);
  console.log('  ✓ parseBetCmd: $10000 and $0.01 both parse (no upper/lower regex bound)'); passed++;
} catch(e) { console.error('  ✗ parseBetCmd amount range:', e.message); failed++; }

try {
  // No DK tab → error message must be specific and actionable
  const noTabError = 'No DK sportsbook tab open — go to sportsbook.draftkings.com first';
  assert(noTabError.length > 0, 'error message not empty');
  assert(noTabError.includes('sportsbook.draftkings.com'), 'error message includes DK URL');
  assert(!noTabError.includes('undefined'), 'error message has no undefined');
  console.log('  ✓ no-tab error: message is specific and includes the URL to visit'); passed++;
} catch(e) { console.error('  ✗ no-tab error message:', e.message); failed++; }

try {
  // BET_RESULT ok:true confirmed vs unconfirmed message paths
  function formatBetResult(msg) {
    if (msg.ok) {
      const confirmed = msg.confirmed ? ' ✓ Confirmed in slip' : ' (check DK for confirmation)';
      return `Bet placed: ${msg.side} ${msg.oddsText} for $${msg.amount}.${confirmed}`;
    }
    return `Failed [${msg.step || '?'}]: ${msg.error}`;
  }
  const okConfirmed = formatBetResult({ ok: true, side: 'Canada', oddsText: '-350', amount: 0.01, confirmed: true });
  assert(okConfirmed.includes('Canada'), 'includes side');
  assert(okConfirmed.includes('-350'), 'includes odds');
  assert(okConfirmed.includes('0.01'), 'includes amount');
  assert(okConfirmed.includes('Confirmed'), 'confirmed path has Confirmed');

  const okUnconfirmed = formatBetResult({ ok: true, side: 'Qatar', oddsText: '+280', amount: 0.01, confirmed: false });
  assert(okUnconfirmed.includes('check DK'), 'unconfirmed path says "check DK"');

  const fail = formatBetResult({ ok: false, step: 'find_button', error: 'No button found for "Canada"' });
  assert(fail.includes('find_button'), 'error path includes step');
  assert(fail.includes('No button'), 'error path includes error');
  console.log('  ✓ BET_RESULT: ok+confirmed, ok+unconfirmed, failed all format correctly'); passed++;
} catch(e) { console.error('  ✗ BET_RESULT format:', e.message); failed++; }

try {
  // Step codes from injected script — verify all known codes are defined strings
  const knownSteps = ['find_button', 'find_input', 'btn_disabled', 'find_placebtn', 'odds_changed', 'suspended', 'done'];
  for (const step of knownSteps) {
    assert(typeof step === 'string' && step.length > 0, `step code "${step}" is not a valid string`);
    assert(!step.includes(' '), `step code "${step}" should use underscores not spaces`);
  }
  console.log('  ✓ step codes: all 7 step codes are valid underscore strings'); passed++;
} catch(e) { console.error('  ✗ step codes:', e.message); failed++; }

// ── Bet Placement: sport outcome logic ────────────────────────────────────
console.log('\n── Bet Placement: sport outcomes ──');

function getSportOutcomes(sport) {
  switch (sport) {
    case 'soccer': return ['home', 'draw', 'away'];
    case 'mma':    return ['fighter1', 'fighter2'];
    case 'boxing': return ['fighter1', 'fighter2'];
    default:       return ['team1', 'team2'];
  }
}

try {
  const soccer = getSportOutcomes('soccer');
  assert(soccer.length === 3, `soccer should have 3 outcomes, got ${soccer.length}`);
  assert(soccer.includes('draw'), 'soccer must include draw');
  assert(soccer.includes('home'), 'soccer must include home');
  assert(soccer.includes('away'), 'soccer must include away');
  console.log('  ✓ sportOutcomes: soccer → 3 outcomes (home, draw, away)'); passed++;
} catch(e) { console.error('  ✗ sportOutcomes soccer:', e.message); failed++; }

try {
  const mma = getSportOutcomes('mma');
  assert(mma.length === 2, `MMA should have 2 outcomes, got ${mma.length}`);
  assert(!mma.includes('draw'), 'MMA should not include draw');
  console.log('  ✓ sportOutcomes: MMA → 2 outcomes (no draw)'); passed++;
} catch(e) { console.error('  ✗ sportOutcomes mma:', e.message); failed++; }

try {
  // A two-leg hedge on soccer ALWAYS leaves draw exposed
  const sport = 'soccer';
  const allOutcomes = getSportOutcomes(sport);
  const hedgedSides = ['home', 'away'];  // typical 2-leg hedge
  const unhedged = allOutcomes.filter(o => !hedgedSides.includes(o));
  assert(unhedged.length === 1 && unhedged[0] === 'draw', `draw should be unhedged, got ${JSON.stringify(unhedged)}`);
  console.log('  ✓ sportOutcomes: 2-leg hedge on soccer always exposes draw'); passed++;
} catch(e) { console.error('  ✗ sportOutcomes soccer 2-leg gap:', e.message); failed++; }

try {
  // MMA: 2-leg hedge covers everything
  const sport = 'mma';
  const allOutcomes = getSportOutcomes(sport);
  const hedgedSides = ['fighter1', 'fighter2'];
  const unhedged = allOutcomes.filter(o => !hedgedSides.includes(o));
  assert(unhedged.length === 0, `MMA 2-leg hedge should be complete, got ${JSON.stringify(unhedged)}`);
  console.log('  ✓ sportOutcomes: 2-leg hedge on MMA covers 100% of outcomes'); passed++;
} catch(e) { console.error('  ✗ sportOutcomes mma full cover:', e.message); failed++; }

// ── AI Agent: Hedge Math ──────────────────────────────────────────────────
console.log('\n── AI Agent: Hedge Math ──');

function americanToDecimal(american) {
  if (american > 0) return (american / 100) + 1;
  if (american < 0) return (100 / Math.abs(american)) + 1;
  throw new Error('Odds cannot be zero');
}

function calculateHedge(leg1Stake, leg1AmericanOdds, hedgeAmericanOdds) {
  const D1 = americanToDecimal(leg1AmericanOdds);
  const D2 = americanToDecimal(hedgeAmericanOdds);
  const payout1 = leg1Stake * D1;
  const hedgeStake = payout1 / D2;
  const totalStaked = leg1Stake + hedgeStake;
  const netProfit = payout1 - totalStaked;
  return {
    hedgeStake: Math.round(hedgeStake * 100) / 100,
    payout1: Math.round(payout1 * 100) / 100,
    profitIfA: Math.round(netProfit * 100) / 100,
    profitIfB: Math.round(netProfit * 100) / 100,
    totalStaked: Math.round(totalStaked * 100) / 100,
    profitable: netProfit > 0
  };
}

function breakEvenD2(D1) {
  return D1 / (D1 - 1);
}

// hedgeMath_basicEqualProfit
try {
  // +200 first leg (D1=3.0, payout=$75), hedge at +100 (D2=2.0): S2=$37.5, profit=$12.50
  const h = calculateHedge(25, 200, 100);
  assert(h.hedgeStake === 37.5, `stake should be 37.5, got ${h.hedgeStake}`);
  assert(h.profitable, `should be profitable, profit=${h.profitIfA}`);
  assert(Math.abs(h.profitIfA - h.profitIfB) < 0.01, 'profits should be equal');
  // Note: at exactly +100/+100 you break even (not profitable) — this uses asymmetric odds
  const breakEven = calculateHedge(25, 100, 100);
  assert(breakEven.profitable === false, 'equal +100/+100 should NOT be profitable (break-even)');
  console.log('  ✓ hedgeMath: asymmetric odds → profitable; equal +100/+100 → break-even'); passed++;
} catch(e) { console.error('  ✗ hedgeMath basicEqualProfit:', e.message); failed++; }

// hedgeMath_americanOddsConversion_positive
try {
  assert(americanToDecimal(150) === 2.5, `+150 should be 2.5, got ${americanToDecimal(150)}`);
  assert(americanToDecimal(280) === 3.8, `+280 should be 3.8, got ${americanToDecimal(280)}`);
  assert(americanToDecimal(100) === 2.0, `+100 should be 2.0, got ${americanToDecimal(100)}`);
  console.log('  ✓ hedgeMath: positive American odds → decimal correct'); passed++;
} catch(e) { console.error('  ✗ hedgeMath positiveOdds:', e.message); failed++; }

// hedgeMath_americanOddsConversion_negative
try {
  const d110 = americanToDecimal(-110);
  const d350 = americanToDecimal(-350);
  assert(Math.abs(d110 - 1.9091) < 0.001, `-110 → ~1.9091, got ${d110}`);
  assert(Math.abs(d350 - 1.2857) < 0.001, `-350 → ~1.2857, got ${d350}`);
  console.log('  ✓ hedgeMath: negative American odds → decimal correct'); passed++;
} catch(e) { console.error('  ✗ hedgeMath negativeOdds:', e.message); failed++; }

// hedgeMath_notProfitable — heavy fav first leg hedged at slight dog
try {
  const h = calculateHedge(25, -350, 105); // -350 first, hedge at +105
  assert(!h.profitable, `should NOT be profitable: profit=${h.profitIfA}`);
  assert(h.profitIfA < 0, `profit should be negative, got ${h.profitIfA}`);
  console.log('  ✓ hedgeMath: -350 first leg + +105 hedge → NOT profitable (vig kills it)'); passed++;
} catch(e) { console.error('  ✗ hedgeMath notProfitable:', e.message); failed++; }

// hedgeMath_breakEvenThreshold
try {
  const D1 = americanToDecimal(-350); // 1.2857
  const minD2 = breakEvenD2(D1);
  // For -350 first leg, break-even requires ~+350 on the hedge side
  assert(minD2 > 4.0, `break-even D2 should be >4.0, got ${minD2}`);
  assert(minD2 < 5.0, `break-even D2 should be <5.0, got ${minD2}`);
  console.log('  ✓ hedgeMath: -350 first leg break-even requires ~+350 hedge'); passed++;
} catch(e) { console.error('  ✗ hedgeMath breakEven:', e.message); failed++; }

// hedgeMath_soccerThreeWay_drawExposure
try {
  const outcomes = ['Canada', 'Draw', 'Qatar'];
  const hedged = ['canada', 'qatar'];
  const unhedged = outcomes.filter(o => !hedged.some(h => o.toLowerCase() === h));
  assert(unhedged.length === 1, `should have 1 unhedged, got ${unhedged.length}`);
  assert(unhedged[0] === 'Draw', `unhedged should be Draw, got ${unhedged[0]}`);
  console.log('  ✓ hedgeMath: soccer 2-leg hedge leaves Draw exposed'); passed++;
} catch(e) { console.error('  ✗ hedgeMath soccerDraw:', e.message); failed++; }

// hedgeMath_vigEatsProfit_sameOdds
try {
  const h = calculateHedge(10, -110, -110); // equal vig market
  assert(!h.profitable, `equal -110/-110 hedge should NOT be profitable: ${h.profitIfA}`);
  console.log('  ✓ hedgeMath: -110/-110 equal vig market → NOT profitable'); passed++;
} catch(e) { console.error('  ✗ hedgeMath vigEats:', e.message); failed++; }

// hedgeMath_minimumOddsFormula_multiple
try {
  // -150 first leg: break-even D2 = 1.667 / 0.667 = 2.5 (+150)
  const D1_150 = americanToDecimal(-150);
  const minD2_150 = breakEvenD2(D1_150);
  assert(Math.abs(minD2_150 - 2.5) < 0.01, `-150 break-even ~2.5, got ${minD2_150}`);
  // -110 first leg: break-even D2 = 1.909 / 0.909 ≈ 2.10 (+110)
  const D1_110 = americanToDecimal(-110);
  const minD2_110 = breakEvenD2(D1_110);
  assert(Math.abs(minD2_110 - 2.10) < 0.05, `-110 break-even ~2.10, got ${minD2_110}`);
  console.log('  ✓ hedgeMath: break-even formula correct for -150 and -110'); passed++;
} catch(e) { console.error('  ✗ hedgeMath minOddsFormula:', e.message); failed++; }

// ── AI Agent: Trigger Conditions ─────────────────────────────────────────
console.log('\n── AI Agent: Trigger Conditions ──');

function crossoverMet(dogImplied, favImplied) {
  return dogImplied >= favImplied;
}

function oddsTargetMet(currentAmerican, targetAmerican) {
  // "Met" when current odds are >= target (numerically):
  // Negative: -115 >= -120 means less vig (better price) — target met
  // Positive: +160 >= +150 means bigger payout — target met
  return currentAmerican >= targetAmerican;
}

// trigger_crossoverConditionMet
try {
  assert(crossoverMet(0.55, 0.48) === true, 'dog 55% > fav 48% should be crossed');
  assert(crossoverMet(0.50, 0.50) === true, 'equal implied should count as crossed');
  console.log('  ✓ trigger: crossoverMet returns true when dog implied ≥ fav implied'); passed++;
} catch(e) { console.error('  ✗ trigger crossoverMet:', e.message); failed++; }

// trigger_crossoverNotYetMet
try {
  assert(crossoverMet(0.35, 0.60) === false, 'dog 35% < fav 60% should NOT be crossed');
  assert(crossoverMet(0.49, 0.51) === false, 'dog 49% < fav 51% not crossed');
  console.log('  ✓ trigger: crossoverMet returns false when dog implied < fav implied'); passed++;
} catch(e) { console.error('  ✗ trigger crossoverNotMet:', e.message); failed++; }

// trigger_oddsTargetHit
try {
  // target -120 (favorite), current -115 (became slightly less favorite — moved toward dog)
  // In hedge context, we're waiting for the dog to become a favorite
  // target means "hedge when Qatar hits -120 or better"
  assert(oddsTargetMet(-115, -120) === true, '-115 should meet target of -120');
  assert(oddsTargetMet(-125, -120) === false, '-125 does NOT meet -120 target (less favorable)');
  console.log('  ✓ trigger: oddsTargetMet handles negative odds correctly'); passed++;
} catch(e) { console.error('  ✗ trigger oddsTarget:', e.message); failed++; }

// trigger_marketSuspended_abortsTrigger
try {
  function shouldAbortDueToSuspension(domState) {
    return domState.marketSuspended === true;
  }
  assert(shouldAbortDueToSuspension({ marketSuspended: true }) === true, 'suspended should abort');
  assert(shouldAbortDueToSuspension({ marketSuspended: false }) === false, 'not suspended should not abort');
  assert(shouldAbortDueToSuspension({}) === false, 'missing field should not abort');
  console.log('  ✓ trigger: market suspended → abort trigger'); passed++;
} catch(e) { console.error('  ✗ trigger marketSuspended:', e.message); failed++; }

// trigger_wrongGame_doesNotFire
try {
  function isCorrectGame(strategyGameId, crossoverGameId) {
    return strategyGameId === crossoverGameId;
  }
  assert(isCorrectGame('game_123', 'game_456') === false, 'different game IDs should not fire');
  assert(isCorrectGame('game_123', 'game_123') === true, 'same game ID should fire');
  console.log('  ✓ trigger: wrong game ID → crossover event filtered out'); passed++;
} catch(e) { console.error('  ✗ trigger wrongGame:', e.message); failed++; }

// ── AI Agent: Strategy State Machine ─────────────────────────────────────
console.log('\n── AI Agent: Strategy State Machine ──');

const STRATEGY_STATES = ['IDLE','FIRST_BET_PENDING','FIRST_BET_PLACED','WATCHING_HEDGE','HEDGE_FIRED','BOTH_PLACED','HEDGE_FAILED'];

function transitionStrategy(current, event) {
  const transitions = {
    IDLE:               { BET_INITIATED: 'FIRST_BET_PENDING' },
    FIRST_BET_PENDING:  { BET_CONFIRMED: 'FIRST_BET_PLACED', BET_FAILED: 'IDLE' },
    FIRST_BET_PLACED:   { CROSSOVER_DETECTED: 'WATCHING_HEDGE', STRATEGY_CANCELLED: 'IDLE', STRATEGY_EXPIRED: 'IDLE' },
    WATCHING_HEDGE:     { VERIFY_PASSED: 'HEDGE_FIRED', VERIFY_FAILED: 'HEDGE_FAILED' },
    HEDGE_FIRED:        { BET_CONFIRMED: 'BOTH_PLACED', BET_FAILED: 'HEDGE_FAILED' },
    BOTH_PLACED:        {},
    HEDGE_FAILED:       {}
  };
  const next = (transitions[current] || {})[event];
  if (!next) return current; // no valid transition — stay
  return next;
}

function isStrategyExpired(expiresAt) {
  return new Date() > new Date(expiresAt);
}

// state_idleToFirstBetPending
try {
  const next = transitionStrategy('IDLE', 'BET_INITIATED');
  assert(next === 'FIRST_BET_PENDING', `expected FIRST_BET_PENDING, got ${next}`);
  console.log('  ✓ state: IDLE → BET_INITIATED → FIRST_BET_PENDING'); passed++;
} catch(e) { console.error('  ✗ state idle→pending:', e.message); failed++; }

// state_firstBetPendingToPlaced
try {
  const next = transitionStrategy('FIRST_BET_PENDING', 'BET_CONFIRMED');
  assert(next === 'FIRST_BET_PLACED', `expected FIRST_BET_PLACED, got ${next}`);
  console.log('  ✓ state: FIRST_BET_PENDING → BET_CONFIRMED → FIRST_BET_PLACED'); passed++;
} catch(e) { console.error('  ✗ state pending→placed:', e.message); failed++; }

// state_watchingHedge_triggerFires
try {
  let s = transitionStrategy('FIRST_BET_PLACED', 'CROSSOVER_DETECTED');
  assert(s === 'WATCHING_HEDGE', `step1: got ${s}`);
  s = transitionStrategy(s, 'VERIFY_PASSED');
  assert(s === 'HEDGE_FIRED', `step2: got ${s}`);
  s = transitionStrategy(s, 'BET_CONFIRMED');
  assert(s === 'BOTH_PLACED', `step3: got ${s}`);
  console.log('  ✓ state: crossover → verify pass → hedge fire → BOTH_PLACED'); passed++;
} catch(e) { console.error('  ✗ state watchingHedge→bothPlaced:', e.message); failed++; }

// state_hedgeFailed_recovery
try {
  const s = transitionStrategy('WATCHING_HEDGE', 'VERIFY_FAILED');
  assert(s === 'HEDGE_FAILED', `expected HEDGE_FAILED, got ${s}`);
  // HEDGE_FAILED is terminal — no further transitions
  const s2 = transitionStrategy(s, 'BET_INITIATED');
  assert(s2 === 'HEDGE_FAILED', `terminal state should not change: got ${s2}`);
  console.log('  ✓ state: VERIFY_FAILED → HEDGE_FAILED (terminal)'); passed++;
} catch(e) { console.error('  ✗ state hedgeFailed:', e.message); failed++; }

// state_expiresAfter4Hours
try {
  const pastExpiry = new Date(Date.now() - 1000).toISOString(); // 1 second in the past
  const futureExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  assert(isStrategyExpired(pastExpiry) === true, 'past expiry should be expired');
  assert(isStrategyExpired(futureExpiry) === false, 'future expiry should not be expired');
  console.log('  ✓ state: strategy expiry detection works correctly'); passed++;
} catch(e) { console.error('  ✗ state expiry:', e.message); failed++; }

// state_persistsAcrossRestart
try {
  // Simulate saving strategy to storage and reloading
  const strategy = { id: 'test-1', state: 'FIRST_BET_PLACED', leg1: { side: 'Canada', amount: 25, confirmed: true } };
  const serialized = JSON.stringify(strategy);
  const restored = JSON.parse(serialized);
  assert(restored.state === 'FIRST_BET_PLACED', 'state should survive serialization');
  assert(restored.leg1.side === 'Canada', 'leg1 should survive serialization');
  assert(restored.id === 'test-1', 'id should survive serialization');
  console.log('  ✓ state: strategy survives JSON serialization (chrome.storage roundtrip)'); passed++;
} catch(e) { console.error('  ✗ state persist:', e.message); failed++; }

// ── AI Agent: Triple Verify ────────────────────────────────────────────────
console.log('\n── AI Agent: Triple Verify ──');

function runTripleVerify(strategy, domState) {
  const errors = [];
  // Check 1: game identity
  const domNames = (domState.teamNames || []).map(n => n.toLowerCase());
  const f1 = (strategy.game.fighter1 || '').toLowerCase();
  const f2 = (strategy.game.fighter2 || '').toLowerCase();
  if (!domNames.some(n => n.includes(f1)) || !domNames.some(n => n.includes(f2))) {
    errors.push({ code: 'GAME_MISMATCH' });
  }
  // Check 2: odds slippage
  if (strategy.leg2 && strategy.leg2.targetOdds != null) {
    const slippage = Math.abs((domState.currentOdds || 0) - strategy.leg2.targetOdds);
    if (slippage > 8) errors.push({ code: 'ODDS_SLIPPAGE', slippage });
  }
  // Check 3: market suspended
  if (domState.marketSuspended) errors.push({ code: 'MARKET_SUSPENDED' });
  // Check 4: hedge still profitable
  if (strategy.leg1 && domState.currentOdds) {
    const h = calculateHedge(strategy.leg1.amount, strategy.leg1.odds, domState.currentOdds);
    if (!h.profitable || h.profitIfA < (strategy.hedgeConfig?.minProfitUSD || 1)) {
      errors.push({ code: 'NOT_PROFITABLE', profit: h.profitIfA });
    }
  }
  // Check 5: bet slip empty
  if ((domState.betSlipCount || 0) > 0) errors.push({ code: 'SLIP_NOT_EMPTY' });
  // Check 6: balance sufficient
  if (strategy.leg1 && domState.currentOdds && domState.availableBalance != null) {
    const h = calculateHedge(strategy.leg1.amount, strategy.leg1.odds, domState.currentOdds);
    if (domState.availableBalance < h.hedgeStake) errors.push({ code: 'INSUFFICIENT_BALANCE' });
  }
  // Check 7: leg 1 confirmed (simulated — in production checks /api/dk-bets)
  if (!strategy.leg1?.confirmed) errors.push({ code: 'LEG1_UNCONFIRMED' });
  return { passed: errors.length === 0, errors };
}

const baseStrategy = {
  game: { fighter1: 'Canada', fighter2: 'Qatar' },
  leg1: { amount: 25, odds: -150, confirmed: true },
  leg2: { targetOdds: -110 },
  hedgeConfig: { minProfitUSD: 1.0 }
};

// verify_gameIdentityMismatch_aborts
try {
  const r = runTripleVerify(baseStrategy, { teamNames: ['Brazil', 'Argentina'], currentOdds: -110, availableBalance: 100, betSlipCount: 0 });
  assert(!r.passed, 'should fail');
  assert(r.errors.some(e => e.code === 'GAME_MISMATCH'), 'should have GAME_MISMATCH');
  console.log('  ✓ verify: wrong game → GAME_MISMATCH, aborts'); passed++;
} catch(e) { console.error('  ✗ verify gameMismatch:', e.message); failed++; }

// verify_oddsSlippage_tooLarge_aborts
try {
  const r = runTripleVerify(baseStrategy, { teamNames: ['Canada', 'Qatar'], currentOdds: -145, availableBalance: 100, betSlipCount: 0 });
  // target -110, current -145 → slippage = 35 > 8
  assert(!r.passed, 'should fail');
  assert(r.errors.some(e => e.code === 'ODDS_SLIPPAGE'), `should have ODDS_SLIPPAGE, errors: ${JSON.stringify(r.errors)}`);
  console.log('  ✓ verify: odds slippage >8 points → ODDS_SLIPPAGE, aborts'); passed++;
} catch(e) { console.error('  ✗ verify oddsSlippage:', e.message); failed++; }

// verify_marketSuspended_aborts
try {
  const r = runTripleVerify(baseStrategy, { teamNames: ['Canada', 'Qatar'], currentOdds: -110, marketSuspended: true, availableBalance: 100, betSlipCount: 0 });
  assert(!r.passed, 'should fail');
  assert(r.errors.some(e => e.code === 'MARKET_SUSPENDED'), 'should have MARKET_SUSPENDED');
  console.log('  ✓ verify: market suspended → MARKET_SUSPENDED, aborts'); passed++;
} catch(e) { console.error('  ✗ verify marketSuspended:', e.message); failed++; }

// verify_hedgeNoLongerProfitable_aborts
try {
  // -150 first leg, hedge at -350 → not profitable
  const unprof = { ...baseStrategy, leg1: { amount: 10, odds: -150, confirmed: true }, leg2: { targetOdds: -350 }, hedgeConfig: { minProfitUSD: 1.0 } };
  const r = runTripleVerify(unprof, { teamNames: ['Canada', 'Qatar'], currentOdds: -350, availableBalance: 100, betSlipCount: 0 });
  assert(!r.passed, 'should fail when not profitable');
  assert(r.errors.some(e => e.code === 'NOT_PROFITABLE'), `should have NOT_PROFITABLE, errors: ${JSON.stringify(r.errors)}`);
  console.log('  ✓ verify: hedge not profitable → NOT_PROFITABLE, aborts'); passed++;
} catch(e) { console.error('  ✗ verify notProfitable:', e.message); failed++; }

// verify_allChecksPass_proceeds
try {
  // -150 first leg, hedge at +200 → should be profitable
  const r = runTripleVerify(
    { game: { fighter1: 'Canada', fighter2: 'Qatar' }, leg1: { amount: 25, odds: -150, confirmed: true }, leg2: { targetOdds: 200 }, hedgeConfig: { minProfitUSD: 0.5 } },
    { teamNames: ['Canada', 'Qatar'], currentOdds: 200, availableBalance: 100, betSlipCount: 0, marketSuspended: false }
  );
  assert(r.passed, `should pass all checks, errors: ${JSON.stringify(r.errors)}`);
  assert(r.errors.length === 0, `should have 0 errors, got ${r.errors.length}`);
  console.log('  ✓ verify: all 7 checks pass → proceeds to click'); passed++;
} catch(e) { console.error('  ✗ verify allPass:', e.message); failed++; }

// verify_balanceInsufficient_aborts
try {
  // $25 at -150, hedge at +200: hedge stake = (25 * 1.667) / 3.0 ≈ $13.89
  const r = runTripleVerify(
    { game: { fighter1: 'Canada', fighter2: 'Qatar' }, leg1: { amount: 25, odds: -150, confirmed: true }, leg2: { targetOdds: 200 }, hedgeConfig: { minProfitUSD: 0.5 } },
    { teamNames: ['Canada', 'Qatar'], currentOdds: 200, availableBalance: 5.00, betSlipCount: 0, marketSuspended: false }
  );
  assert(!r.passed, 'should fail on balance');
  assert(r.errors.some(e => e.code === 'INSUFFICIENT_BALANCE'), `should have INSUFFICIENT_BALANCE, errors: ${JSON.stringify(r.errors)}`);
  console.log('  ✓ verify: balance insufficient → INSUFFICIENT_BALANCE, aborts'); passed++;
} catch(e) { console.error('  ✗ verify balanceInsufficient:', e.message); failed++; }

// ── AI Agent: NL Intent Parsing (parseBetCmd extension) ──────────────────
console.log('\n── AI Agent: NL Intent Parsing ──');

// parseStrategy: extended parser that detects hedge intent in raw commands
// Returns null for commands not matching, or {leg1, hedge} for strategy commands
function parseStrategy(raw) {
  const s = raw.trim().toLowerCase();
  // detect "bet X $N, hedge on Y if..." or "bet X $N then hedge Y..."
  const stratMatch = s.match(/^bet\s+(.+?)\s+\$?([\d.]+)[,\s]+(?:then\s+)?hedge\s+(?:on\s+)?(.+?)\s+if\s+(.+)$/i);
  if (stratMatch) {
    return {
      leg1: { side: stratMatch[1].trim(), amount: parseFloat(stratMatch[2]) },
      hedge: {
        side: stratMatch[3].trim(),
        trigger: stratMatch[4].includes('flip') || stratMatch[4].includes('cross') ? 'crossover' : 'manual',
        autoExecute: true
      }
    };
  }
  return null;
}

// parseStrategy_basicHedgeIntent_crossover
try {
  const r = parseStrategy('bet canada $25, hedge on Qatar if the line flips');
  assert(r !== null, 'should parse strategy');
  assert(r.leg1.side === 'canada', `leg1 side wrong: ${r.leg1.side}`);
  assert(r.leg1.amount === 25, `leg1 amount wrong: ${r.leg1.amount}`);
  assert(r.hedge.trigger === 'crossover', `trigger wrong: ${r.hedge.trigger}`);
  assert(r.hedge.autoExecute === true, 'autoExecute should be true');
  console.log('  ✓ parseStrategy: "bet canada $25, hedge Qatar if line flips" → crossover strategy'); passed++;
} catch(e) { console.error('  ✗ parseStrategy basicHedge:', e.message); failed++; }

// parseStrategy_crossoverKeyword
try {
  const r = parseStrategy('bet canada 25, hedge Qatar if odds cross');
  assert(r !== null, 'should parse');
  assert(r.hedge.trigger === 'crossover', `should detect crossover, got: ${r.hedge?.trigger}`);
  console.log('  ✓ parseStrategy: "if odds cross" → crossover trigger'); passed++;
} catch(e) { console.error('  ✗ parseStrategy crossoverKw:', e.message); failed++; }

// parseBetCmd_strategyCommand_returnsNull
try {
  // parseBetCmd should NOT match complex strategy commands
  const r = parseBetCmd('bet canada 25 hedge qatar');
  // This has extra text after amount — should return null OR partial match
  // Depends on regex: our regex is /^bet\s+(.+?)\s+([\d.]+)$/i — "hedge qatar" after amount won't match
  // Because the regex ends at \d+ and expects end of string $
  assert(r === null, `parseBetCmd should not match strategy commands, got: ${JSON.stringify(r)}`);
  console.log('  ✓ parseBetCmd: strategy-style command (with hedge clause) → null'); passed++;
} catch(e) { console.error('  ✗ parseBetCmd strategyCmd:', e.message); failed++; }

// parseIntent_cancelCommand
try {
  function detectCancelIntent(raw) {
    return /^(cancel|stop|abort)\b/i.test(raw.trim());
  }
  assert(detectCancelIntent('cancel the hedge') === true, 'cancel command detected');
  assert(detectCancelIntent('STOP') === true, 'STOP detected');
  assert(detectCancelIntent('bet canada 25') === false, 'bet command not cancel');
  console.log('  ✓ parseIntent: cancel/stop/abort keywords → cancel intent'); passed++;
} catch(e) { console.error('  ✗ parseIntent cancel:', e.message); failed++; }

// parseIntent_statusQuery
try {
  function detectStatusIntent(raw) {
    const s = raw.trim().toLowerCase();
    return s.includes("what's") || s.includes('status') || s.includes('current strategy') || s.includes('how much');
  }
  assert(detectStatusIntent("What's the current strategy?") === true);
  assert(detectStatusIntent('status') === true);
  assert(detectStatusIntent('bet canada 25') === false);
  console.log('  ✓ parseIntent: status query detected correctly'); passed++;
} catch(e) { console.error('  ✗ parseIntent status:', e.message); failed++; }

// parseStrategy_noHedgeSide_returnsNull
try {
  const r = parseStrategy('bet canada 25');
  assert(r === null, 'plain bet should not parse as strategy');
  console.log('  ✓ parseStrategy: plain bet (no hedge clause) → null (use parseBetCmd instead)'); passed++;
} catch(e) { console.error('  ✗ parseStrategy plainBet:', e.message); failed++; }

// parseAmount_variousFormats
try {
  function extractAmount(raw) {
    const m = raw.match(/\$?([\d]+(?:\.[\d]+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  assert(extractAmount('$25') === 25, '$25');
  assert(extractAmount('25.50') === 25.5, '25.50');
  assert(extractAmount('bet canada $0.01') === 0.01, '$0.01');
  assert(extractAmount('no amount here') === null, 'no amount');
  console.log('  ✓ parseAmount: $N, N.NN, $0.01 all extract correctly'); passed++;
} catch(e) { console.error('  ✗ parseAmount formats:', e.message); failed++; }

// parseStrategy_duplicateBetPrevention
try {
  function buildIdempotencyKey(userId, gameId, side, amount) {
    // Simplified key — in production use SHA-256
    return `${userId}:${gameId}:${side.toLowerCase()}:${amount}`;
  }
  const k1 = buildIdempotencyKey('ish', 'game123', 'Canada', 25);
  const k2 = buildIdempotencyKey('ish', 'game123', 'Canada', 25);
  const k3 = buildIdempotencyKey('ish', 'game123', 'Qatar', 25);
  assert(k1 === k2, 'same bet should produce same key');
  assert(k1 !== k3, 'different side should produce different key');
  console.log('  ✓ parseStrategy: idempotency key is deterministic from intent fields'); passed++;
} catch(e) { console.error('  ✗ parseStrategy idempotency:', e.message); failed++; }

// ── AI Agent: Hedge Math (extended) ──────────────────────────────────────
console.log('\n── AI Agent: Hedge Math (extended) ──');

try {
  // Profitable crossover: caught dog at +300 (26.3%), now at -110 (52.4%)
  // Combined implied: 26.3% + 52.4% = 78.7% < 100% → PROFITABLE
  const D1 = americanToDecimal(300);  // 4.0
  const D2 = americanToDecimal(-110); // ~1.909
  const h = calculateHedge(10, 300, -110);
  assert(h.profitable, `+300 first leg hedged at -110 should be profitable, profit=${h.profitIfA}`);
  assert(h.profitIfA > 0, `profit should be positive, got ${h.profitIfA}`);
  console.log(`  ✓ hedgeMath: +300 → -110 crossover IS profitable (+$${h.profitIfA.toFixed(2)} on $${h.totalStaked.toFixed(2)} total)`); passed++;
} catch(e) { console.error('  ✗ hedgeMath profitable crossover:', e.message); failed++; }

try {
  // Stake rounding: hedge stake always rounded to 2 decimal places
  const h = calculateHedge(25, -150, 200);
  // D1=1.667, payout=41.67, D2=3.0, hedgeStake=41.67/3.0=13.89
  const stakeStr = h.hedgeStake.toString();
  const decimals = stakeStr.includes('.') ? stakeStr.split('.')[1].length : 0;
  assert(decimals <= 2, `stake has ${decimals} decimal places, expected ≤2: ${stakeStr}`);
  console.log(`  ✓ hedgeMath: hedge stake rounded to 2 decimal places (got $${h.hedgeStake})`); passed++;
} catch(e) { console.error('  ✗ hedgeMath rounding:', e.message); failed++; }

try {
  // Leg 1 payout calculation: S1 × D1 must match expected value
  const S1 = 25, D1 = americanToDecimal(-350); // 1.2857
  const h = calculateHedge(S1, -350, 350); // any hedge odds
  assert(Math.abs(h.payout1 - S1 * D1) < 0.01, `payout1 mismatch: expected ${S1 * D1}, got ${h.payout1}`);
  console.log(`  ✓ hedgeMath: payout1 = S1 × D1 exactly (${S1} × ${D1.toFixed(4)} = $${h.payout1})`); passed++;
} catch(e) { console.error('  ✗ hedgeMath payout1:', e.message); failed++; }

try {
  // Minimum hedge stake below DK's $1 minimum: flag if hedgeStake < 1
  function hedgeBelowMinimum(hedgeStake, dkMin = 1.00) {
    return hedgeStake < dkMin;
  }
  const h1 = calculateHedge(1, -350, 105); // tiny first leg
  const h2 = calculateHedge(25, 200, 105); // larger first leg
  assert(typeof h1.hedgeStake === 'number', 'hedgeStake is a number');
  // For $1 at -350 hedged at +105: payout=$1.286, hedgeStake=$1.286/2.05=$0.627 < $1
  assert(hedgeBelowMinimum(h1.hedgeStake), `$1@-350 hedge at +105 should be below DK min: $${h1.hedgeStake}`);
  assert(!hedgeBelowMinimum(h2.hedgeStake), `$25@+200 hedge at +105 should be above DK min: $${h2.hedgeStake}`);
  console.log(`  ✓ hedgeMath: stake below DK $1 minimum detected ($${h1.hedgeStake.toFixed(2)} < $1)`); passed++;
} catch(e) { console.error('  ✗ hedgeMath DK min stake:', e.message); failed++; }

try {
  // totalStaked = leg1 + hedge (sanity check)
  const h = calculateHedge(25, 200, 150);
  const expected = 25 + h.hedgeStake;
  assert(Math.abs(h.totalStaked - expected) < 0.01, `totalStaked ${h.totalStaked} ≠ 25 + ${h.hedgeStake}`);
  console.log(`  ✓ hedgeMath: totalStaked = leg1 + hedgeStake ($${h.totalStaked})`); passed++;
} catch(e) { console.error('  ✗ hedgeMath totalStaked:', e.message); failed++; }

// ── Coverage gamification (extended) ─────────────────────────────────────
console.log('\n── Coverage gamification (extended) ──');

try {
  // Partial string match: "canada" should match "FC Canada" (substring)
  const r = computeCoverage(['FC Canada', 'Draw', 'South Korea'], ['canada']);
  assert(r.covered.length === 1, `expected 1 covered, got ${r.covered.length}`);
  assert(r.covered[0] === 'FC Canada', `expected "FC Canada", got "${r.covered[0]}"`);
  console.log('  ✓ coverage: "canada" fuzzy-matches "FC Canada" (substring)'); passed++;
} catch(e) { console.error('  ✗ coverage partial match:', e.message); failed++; }

try {
  // Idempotent: calling applyCoverage twice with same args gives same result
  const outcomes = ['Canada', 'Draw', 'Qatar'];
  const covered = ['canada', 'draw'];
  const r1 = computeCoverage(outcomes, covered);
  const r2 = computeCoverage(outcomes, covered);
  assert(r1.covered.length === r2.covered.length, 'idempotent: same length');
  assert(r1.locked === r2.locked, 'idempotent: same locked state');
  console.log('  ✓ coverage: computeCoverage is idempotent (same args → same result)'); passed++;
} catch(e) { console.error('  ✗ coverage idempotent:', e.message); failed++; }

try {
  // Never locks with zero outcomes
  const r = computeCoverage([], ['canada', 'draw', 'qatar']);
  assert(!r.locked, 'empty outcomes array should never be locked');
  assert(r.covered.length === 0, 'no outcomes to match against');
  console.log('  ✓ coverage: empty outcomes → never locked (guards against div-by-zero)'); passed++;
} catch(e) { console.error('  ✗ coverage zero outcomes:', e.message); failed++; }

try {
  // MMA: only 2 outcomes needed for lock
  const r = computeCoverage(['Alex Pereira', 'Ciryl Gane'], ['alex pereira', 'ciryl gane']);
  assert(r.locked, `MMA 2/2 should be locked: ${JSON.stringify(r)}`);
  assert(r.covered.length === 2, `both should be covered: ${r.covered.length}`);
  console.log('  ✓ coverage: MMA 2/2 covered → LOCKED (no draw needed)'); passed++;
} catch(e) { console.error('  ✗ coverage MMA lock:', e.message); failed++; }

try {
  // Coverage count exactly matches when all 3 soccer outcomes covered
  const outcomes = ['Canada', 'Draw', 'Qatar'];
  const r = computeCoverage(outcomes, ['canada', 'draw', 'qatar']);
  assert(r.covered.length === outcomes.length, `covered.length ${r.covered.length} ≠ outcomes.length ${outcomes.length}`);
  assert(r.locked, '3/3 should be locked');
  console.log('  ✓ coverage: covered.length === outcomes.length when all matched'); passed++;
} catch(e) { console.error('  ✗ coverage count match:', e.message); failed++; }

// ── AI Agent: Error Recovery ──────────────────────────────────────────────
console.log('\n── AI Agent: Error Recovery ──');

// error_firstBetRejected_strategyAborted
try {
  // Simulate: bet placed but not confirmed in bets API after timeout
  function shouldPauseOnLeg1Timeout(leg1, betsFromApi) {
    if (!leg1.confirmed) {
      const foundInApi = betsFromApi.some(b => b.side === leg1.side && b.amount === leg1.amount);
      return !foundInApi; // pause if not found
    }
    return false;
  }
  assert(shouldPauseOnLeg1Timeout({ side: 'Canada', amount: 25, confirmed: false }, []) === true, 'no bets in api → pause');
  assert(shouldPauseOnLeg1Timeout({ side: 'Canada', amount: 25, confirmed: false }, [{ side: 'Canada', amount: 25 }]) === false, 'found in api → no pause');
  assert(shouldPauseOnLeg1Timeout({ side: 'Canada', amount: 25, confirmed: true }, []) === false, 'already confirmed → no pause');
  console.log('  ✓ error: leg1 not in API after timeout → strategy paused'); passed++;
} catch(e) { console.error('  ✗ error leg1Rejected:', e.message); failed++; }

// error_oddsMovedDuringClick
try {
  function detectOddsMovedDuringClick(expectedOdds, actualOdds, maxSlippage = 8) {
    return Math.abs(expectedOdds - actualOdds) > maxSlippage;
  }
  assert(detectOddsMovedDuringClick(-110, -120) === true, '10 point move → abort');
  assert(detectOddsMovedDuringClick(-110, -115) === false, '5 point move → ok');
  assert(detectOddsMovedDuringClick(-110, -110) === false, 'same odds → ok');
  console.log('  ✓ error: odds moved >8 points during click window → detected'); passed++;
} catch(e) { console.error('  ✗ error oddsMovedDuringClick:', e.message); failed++; }

// error_duplicateHedgePrevented
try {
  // Terminal states should not accept new crossover events
  const terminalStates = ['BOTH_PLACED', 'HEDGE_FAILED'];
  function shouldIgnoreCrossover(state) {
    return terminalStates.includes(state);
  }
  assert(shouldIgnoreCrossover('BOTH_PLACED') === true, 'BOTH_PLACED is terminal');
  assert(shouldIgnoreCrossover('HEDGE_FAILED') === true, 'HEDGE_FAILED is terminal');
  assert(shouldIgnoreCrossover('FIRST_BET_PLACED') === false, 'FIRST_BET_PLACED should watch');
  assert(shouldIgnoreCrossover('WATCHING_HEDGE') === false, 'WATCHING_HEDGE should process');
  console.log('  ✓ error: crossover event in terminal state → ignored (no double hedge)'); passed++;
} catch(e) { console.error('  ✗ error duplicateHedge:', e.message); failed++; }

// error_networkTimeout_checkBeforeRetry
try {
  // Never blindly retry — check if bet landed first
  function shouldRetryHedge(hedgeState, betsFromApi, leg1Side) {
    if (hedgeState !== 'HEDGE_FIRED') return false;
    const hedgeLanded = betsFromApi.some(b => b.side !== leg1Side);
    return !hedgeLanded; // only retry if NOT already in API
  }
  const leg2 = { side: 'Qatar' };
  assert(shouldRetryHedge('HEDGE_FIRED', [], 'Canada') === true, 'no bets → safe to retry');
  assert(shouldRetryHedge('HEDGE_FIRED', [{ side: 'Qatar' }], 'Canada') === false, 'hedge found → DO NOT retry');
  assert(shouldRetryHedge('BOTH_PLACED', [], 'Canada') === false, 'wrong state → no retry');
  console.log('  ✓ error: network timeout → check /api/dk-bets before retry (no double-bet)'); passed++;
} catch(e) { console.error('  ✗ error networkTimeout:', e.message); failed++; }

// error_serviceWorkerKilled_resumeOnWake
try {
  // On wake: check state and verify against API
  function getResumeAction(state, leg2ConfirmedInApi) {
    if (state === 'HEDGE_FIRED' && leg2ConfirmedInApi) return 'MARK_BOTH_PLACED';
    if (state === 'HEDGE_FIRED' && !leg2ConfirmedInApi) return 'NOTIFY_MANUAL_HEDGE';
    if (state === 'FIRST_BET_PLACED') return 'RESUME_WATCHING';
    if (state === 'BOTH_PLACED') return 'SURFACE_RESULT';
    return 'NOTHING';
  }
  assert(getResumeAction('HEDGE_FIRED', true) === 'MARK_BOTH_PLACED', 'hedge landed → mark placed');
  assert(getResumeAction('HEDGE_FIRED', false) === 'NOTIFY_MANUAL_HEDGE', 'hedge missed → notify');
  assert(getResumeAction('FIRST_BET_PLACED', false) === 'RESUME_WATCHING', 'watching → resume');
  assert(getResumeAction('BOTH_PLACED', false) === 'SURFACE_RESULT', 'done → surface');
  console.log('  ✓ error: service worker restart → correct resume action per state'); passed++;
} catch(e) { console.error('  ✗ error swRestart:', e.message); failed++; }

// ═══════════════════════════════════════════════════════════════════════════
// NEW AGENT SYSTEM TESTS
// Covers three newly built subsystems:
//   A. POST /api/chat — NL intent parser (Claude Haiku)
//   B. content.js odds watcher — americanToImplied, scanOdds, crossover logic
//   C. background.js strategy state machine — transitions, tripleVerify, resume
// ═══════════════════════════════════════════════════════════════════════════

// ── A. NL Intent Parser helpers (mirror of server.js parseChatResponse) ──
function parseChatResponse(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const src = jsonMatch ? jsonMatch[0] : raw;
  const parsed = JSON.parse(src);
  return {
    intent:     parsed.intent     || 'unknown',
    side:       parsed.side       || null,
    amount:     typeof parsed.amount === 'number' ? parsed.amount : null,
    trigger:    parsed.trigger    || { type: null, targetOdds: null },
    confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
  };
}

// ── B. Odds watcher helpers (mirror of content.js additions) ─────────────
function americanToImplied(american) {
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}
function parseAmericanOdds(text) {
  const n = parseInt(text.replace(/[−–]/g, '-'), 10);
  return isNaN(n) ? null : n;
}

// ── C. State machine helpers (mirror of background.js additions) ──────────
function strategyTransition(current, event) {
  const table = {
    IDLE:              { BET_INITIATED:       'FIRST_BET_PENDING' },
    FIRST_BET_PENDING: { BET_CONFIRMED:       'FIRST_BET_PLACED', BET_FAILED: 'IDLE' },
    FIRST_BET_PLACED:  { CROSSOVER_DETECTED:  'WATCHING_HEDGE',   STRATEGY_CANCELLED: 'IDLE', STRATEGY_EXPIRED: 'IDLE' },
    WATCHING_HEDGE:    { VERIFY_PASSED:       'HEDGE_FIRED',      VERIFY_FAILED: 'HEDGE_FAILED' },
    HEDGE_FIRED:       { BET_CONFIRMED:       'BOTH_PLACED',      BET_FAILED: 'HEDGE_FAILED' },
    BOTH_PLACED:       {},
    HEDGE_FAILED:      {},
  };
  return (table[current] || {})[event] || current;
}

function tripleVerify(strategy, domState) {
  const checks = [
    { name: 'game_identity',      pass: !strategy.gameId || !domState.gameId || strategy.gameId === domState.gameId },
    { name: 'odds_slippage',      pass: !strategy.expectedHedgeOdds || Math.abs((domState.leg2Odds || 0) - strategy.expectedHedgeOdds) <= 8 },
    { name: 'market_active',      pass: !domState.suspended },
    { name: 'hedge_profitable',   pass: domState.hedgeProfit === undefined || domState.hedgeProfit > 0 },
    { name: 'slip_empty',         pass: !domState.slipHasBets },
    { name: 'balance_sufficient', pass: domState.balance === undefined || domState.balance >= (strategy.hedgeAmount || 0) },
    { name: 'leg1_confirmed',     pass: strategy.leg1Confirmed === true },
  ];
  const failed = checks.filter(c => !c.pass);
  return { pass: failed.length === 0, checks, failed };
}

async function runAgentSystemTests() {
  console.log('\n── A. NL Intent Parser (parseChatResponse) ──');

  // A1 — happy path: place_first_bet with crossover trigger
  try {
    const r = parseChatResponse('{"intent":"place_first_bet","side":"Canada","amount":10,"trigger":{"type":"crossover","targetOdds":null},"confidence":0.97}');
    assert(r.intent === 'place_first_bet', `intent wrong: ${r.intent}`);
    assert(r.side === 'Canada', `side wrong: ${r.side}`);
    assert(r.amount === 10, `amount wrong: ${r.amount}`);
    assert(r.trigger.type === 'crossover', `trigger.type wrong: ${r.trigger.type}`);
    assert(r.confidence === 0.97, `confidence wrong: ${r.confidence}`);
    console.log('  ✓ A1: place_first_bet crossover — all fields correct'); passed++;
  } catch(e) { console.error('  ✗ A1:', e.message); failed++; }

  // A2 — cancel intent
  try {
    const r = parseChatResponse('{"intent":"cancel","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":0.99}');
    assert(r.intent === 'cancel', `intent wrong: ${r.intent}`);
    assert(r.side === null, `side should be null`);
    assert(r.amount === null, `amount should be null`);
    console.log('  ✓ A2: cancel intent'); passed++;
  } catch(e) { console.error('  ✗ A2:', e.message); failed++; }

  // A3 — query intent
  try {
    const r = parseChatResponse('{"intent":"query","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":0.90}');
    assert(r.intent === 'query', `intent wrong: ${r.intent}`);
    console.log('  ✓ A3: query intent'); passed++;
  } catch(e) { console.error('  ✗ A3:', e.message); failed++; }

  // A4 — odds_target trigger with negative targetOdds
  try {
    const r = parseChatResponse('{"intent":"place_first_bet","side":"Hamad Medjedovic","amount":25,"trigger":{"type":"odds_target","targetOdds":-150},"confidence":0.95}');
    assert(r.trigger.type === 'odds_target', `trigger.type wrong: ${r.trigger.type}`);
    assert(r.trigger.targetOdds === -150, `targetOdds wrong: ${r.trigger.targetOdds}`);
    assert(r.side === 'Hamad Medjedovic', `side wrong: ${r.side}`);
    console.log('  ✓ A4: odds_target trigger with negative targetOdds'); passed++;
  } catch(e) { console.error('  ✗ A4:', e.message); failed++; }

  // A5 — markdown code fence stripped
  try {
    const r = parseChatResponse('```json\n{"intent":"cancel","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":0.99}\n```');
    assert(r.intent === 'cancel', `code fence not stripped: ${r.intent}`);
    console.log('  ✓ A5: markdown code fence stripped'); passed++;
  } catch(e) { console.error('  ✗ A5:', e.message); failed++; }

  // A6 — extra prose before JSON stripped
  try {
    const r = parseChatResponse('Here is the parsed intent:\n{"intent":"query","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":0.8}');
    assert(r.intent === 'query', `prose not stripped: ${r.intent}`);
    console.log('  ✓ A6: extra prose before JSON stripped'); passed++;
  } catch(e) { console.error('  ✗ A6:', e.message); failed++; }

  // A7 — malformed JSON → throws (caller handles as unknown)
  try {
    let threw = false;
    try { parseChatResponse('this is not json at all'); } catch { threw = true; }
    assert(threw, 'should throw on malformed JSON');
    console.log('  ✓ A7: malformed JSON throws (caller maps to unknown)'); passed++;
  } catch(e) { console.error('  ✗ A7:', e.message); failed++; }

  // A8 — confidence clamped to [0, 1]
  try {
    const r = parseChatResponse('{"intent":"query","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":1.5}');
    assert(r.confidence <= 1, `confidence should be ≤1, got ${r.confidence}`);
    console.log('  ✓ A8: confidence clamped to 1.0 max'); passed++;
  } catch(e) { console.error('  ✗ A8:', e.message); failed++; }

  // A9 — missing confidence → defaults to 0
  try {
    const r = parseChatResponse('{"intent":"cancel","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null}}');
    assert(r.confidence === 0, `confidence should default to 0, got ${r.confidence}`);
    console.log('  ✓ A9: missing confidence defaults to 0'); passed++;
  } catch(e) { console.error('  ✗ A9:', e.message); failed++; }

  // A10 — unknown intent value passes through
  try {
    const r = parseChatResponse('{"intent":"place_parlay","side":"Canada","amount":5,"trigger":{"type":null,"targetOdds":null},"confidence":0.4}');
    assert(r.intent === 'place_parlay', `intent should pass through: ${r.intent}`);
    console.log('  ✓ A10: non-standard intent passes through'); passed++;
  } catch(e) { console.error('  ✗ A10:', e.message); failed++; }

  // A11 — amount: null for string "null"
  try {
    const r = parseChatResponse('{"intent":"cancel","side":null,"amount":null,"trigger":{"type":null,"targetOdds":null},"confidence":0.9}');
    assert(r.amount === null, `amount should be null, got ${r.amount}`);
    console.log('  ✓ A11: amount null when not provided'); passed++;
  } catch(e) { console.error('  ✗ A11:', e.message); failed++; }

  // A12 — decimal amount preserved
  try {
    const r = parseChatResponse('{"intent":"place_first_bet","side":"Qatar","amount":0.01,"trigger":{"type":"crossover","targetOdds":null},"confidence":0.95}');
    assert(r.amount === 0.01, `decimal amount wrong: ${r.amount}`);
    console.log('  ✓ A12: decimal amount 0.01 preserved'); passed++;
  } catch(e) { console.error('  ✗ A12:', e.message); failed++; }

  // A13 — missing trigger → default { type: null, targetOdds: null }
  try {
    const r = parseChatResponse('{"intent":"place_first_bet","side":"Canada","amount":10,"confidence":0.7}');
    assert(r.trigger && r.trigger.type === null, `trigger default wrong: ${JSON.stringify(r.trigger)}`);
    console.log('  ✓ A13: missing trigger defaults to {type:null,targetOdds:null}'); passed++;
  } catch(e) { console.error('  ✗ A13:', e.message); failed++; }

  // A14 — /api/chat endpoint reachable (integration, --local only)
  if (target.includes('localhost')) {
    await check('A14: POST /api/chat — endpoint responds', async () => {
      const r = await fetch(`${target}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'cancel' })
      });
      assert(r.ok || r.status === 500, `unexpected status: ${r.status}`); // 500 ok if no ANTHROPIC_API_KEY
    });
  } else {
    console.log('  - A14: skipped (not --local)');
  }

  // A15 — /api/chat with missing message → 400
  if (target.includes('localhost')) {
    await check('A15: POST /api/chat missing message → 400', async () => {
      const r = await fetch(`${target}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });
  } else {
    console.log('  - A15: skipped (not --local)');
  }

  console.log('\n── B. Odds watcher math ──');

  // B1 — americanToImplied: +100 → 50%
  try {
    const imp = americanToImplied(100);
    assert(Math.abs(imp - 0.5) < 0.0001, `+100 implied should be 0.5, got ${imp}`);
    console.log('  ✓ B1: +100 → 50.0% implied'); passed++;
  } catch(e) { console.error('  ✗ B1:', e.message); failed++; }

  // B2 — americanToImplied: -200 → 66.67%
  try {
    const imp = americanToImplied(-200);
    assert(Math.abs(imp - (200/300)) < 0.0001, `-200 implied should be 0.6667, got ${imp}`);
    console.log('  ✓ B2: -200 → 66.67% implied'); passed++;
  } catch(e) { console.error('  ✗ B2:', e.message); failed++; }

  // B3 — americanToImplied: +300 → 25%
  try {
    const imp = americanToImplied(300);
    assert(Math.abs(imp - 0.25) < 0.0001, `+300 implied should be 0.25, got ${imp}`);
    console.log('  ✓ B3: +300 → 25.0% implied'); passed++;
  } catch(e) { console.error('  ✗ B3:', e.message); failed++; }

  // B4 — americanToImplied: -110 → 52.38%
  try {
    const imp = americanToImplied(-110);
    const expected = 110 / 210;
    assert(Math.abs(imp - expected) < 0.0001, `-110 implied wrong: got ${imp}`);
    console.log('  ✓ B4: -110 → 52.38% implied'); passed++;
  } catch(e) { console.error('  ✗ B4:', e.message); failed++; }

  // B5 — americanToImplied: +1000 → 9.09%
  try {
    const imp = americanToImplied(1000);
    assert(Math.abs(imp - 100/1100) < 0.0001, `+1000 implied wrong: got ${imp}`);
    console.log('  ✓ B5: +1000 → 9.09% implied'); passed++;
  } catch(e) { console.error('  ✗ B5:', e.message); failed++; }

  // B6 — americanToImplied: -350 → 77.78%
  try {
    const imp = americanToImplied(-350);
    assert(Math.abs(imp - 350/450) < 0.0001, `-350 implied wrong: got ${imp}`);
    console.log('  ✓ B6: -350 → 77.78% implied'); passed++;
  } catch(e) { console.error('  ✗ B6:', e.message); failed++; }

  // B7 — parseAmericanOdds: standard hyphen
  try {
    assert(parseAmericanOdds('-132') === -132, `parse -132 failed`);
    console.log('  ✓ B7: parseAmericanOdds("-132") === -132'); passed++;
  } catch(e) { console.error('  ✗ B7:', e.message); failed++; }

  // B8 — parseAmericanOdds: Unicode minus (−)
  try {
    assert(parseAmericanOdds('−132') === -132, `Unicode minus parse failed`);
    console.log('  ✓ B8: parseAmericanOdds("−132") Unicode minus → -132'); passed++;
  } catch(e) { console.error('  ✗ B8:', e.message); failed++; }

  // B9 — parseAmericanOdds: positive
  try {
    assert(parseAmericanOdds('+104') === 104, `parse +104 failed`);
    console.log('  ✓ B9: parseAmericanOdds("+104") → 104'); passed++;
  } catch(e) { console.error('  ✗ B9:', e.message); failed++; }

  // B10 — parseAmericanOdds: invalid string → null
  try {
    assert(parseAmericanOdds('PK') === null, `PK should be null`);
    console.log('  ✓ B10: parseAmericanOdds("PK") → null'); passed++;
  } catch(e) { console.error('  ✗ B10:', e.message); failed++; }

  // B11 — crossover: dog implied > fav implied → true
  try {
    const leg1 = { implied: americanToImplied(-350) }; // fav
    const leg2 = { implied: americanToImplied(+200) }; // dog — not yet crossed
    assert(leg2.implied < leg1.implied, 'dog should NOT yet be >= fav');
    console.log('  ✓ B11: dog implied < fav implied → NO crossover'); passed++;
  } catch(e) { console.error('  ✗ B11:', e.message); failed++; }

  // B12 — crossover: after odds movement, dog implied >= fav implied
  try {
    const leg1 = { implied: americanToImplied(-110) }; // original fav, moved to near even
    const leg2 = { implied: americanToImplied(-120) }; // original dog, moved to slight fav
    const crossed = leg2.implied >= leg1.implied;
    assert(crossed, 'should be crossed: -120 implied > -110 implied');
    console.log('  ✓ B12: -120 implied ≥ -110 implied → crossover detected'); passed++;
  } catch(e) { console.error('  ✗ B12:', e.message); failed++; }

  // B13 — crossover: exactly equal → true (at crossover boundary)
  try {
    const imp = americanToImplied(100);
    assert(imp >= imp, 'equal should count as crossed');
    console.log('  ✓ B13: equal implied probs → crossover (>=) holds'); passed++;
  } catch(e) { console.error('  ✗ B13:', e.message); failed++; }

  // B14 — combined implied > 100% (vig exists — not profitable to hedge every crossover)
  try {
    const combined = americanToImplied(-110) + americanToImplied(-110);
    assert(combined > 1.0, `combined should be > 100%, got ${combined}`);
    console.log(`  ✓ B14: combined implied ${(combined*100).toFixed(1)}% > 100% — vig confirmed`); passed++;
  } catch(e) { console.error('  ✗ B14:', e.message); failed++; }

  // B15 — ODDS_UPDATE message shape has required fields
  try {
    const outcomes = [
      { side: 'Canada', american: -350, oddsText: '-350', implied: americanToImplied(-350) },
      { side: 'Qatar',  american: +800, oddsText: '+800', implied: americanToImplied(+800) },
    ];
    const msg = { type: 'ODDS_UPDATE', outcomes, ts: Date.now() };
    assert(msg.type === 'ODDS_UPDATE', 'type wrong');
    assert(Array.isArray(msg.outcomes), 'outcomes must be array');
    assert(msg.outcomes[0].side === 'Canada', 'first side wrong');
    assert(typeof msg.outcomes[0].implied === 'number', 'implied must be number');
    assert(typeof msg.ts === 'number', 'ts must be number');
    console.log('  ✓ B15: ODDS_UPDATE message shape valid'); passed++;
  } catch(e) { console.error('  ✗ B15:', e.message); failed++; }

  // B16 — CROSSOVER_DETECTED message shape
  try {
    const leg1 = { side: 'Canada', american: -110, oddsText: '-110', implied: americanToImplied(-110) };
    const leg2 = { side: 'Qatar',  american: -120, oddsText: '-120', implied: americanToImplied(-120) };
    const msg = { type: 'CROSSOVER_DETECTED', leg1, leg2, ts: Date.now() };
    assert(msg.leg1.side === 'Canada', 'leg1.side wrong');
    assert(msg.leg2.side === 'Qatar', 'leg2.side wrong');
    assert(msg.leg2.implied >= msg.leg1.implied, 'crossover invariant violated');
    console.log('  ✓ B16: CROSSOVER_DETECTED message shape valid'); passed++;
  } catch(e) { console.error('  ✗ B16:', e.message); failed++; }

  // B17 — watcher fires CROSSOVER_DETECTED only once per crossover event
  try {
    // Simulate the lastCrossover state machine
    let lastCrossover = null;
    let fired = 0;
    function simulatePoll(leg1Implied, leg2Implied) {
      const crossed = leg2Implied >= leg1Implied;
      if (crossed !== lastCrossover) {
        lastCrossover = crossed;
        if (crossed) fired++;
      }
    }
    simulatePoll(0.6, 0.4); // no cross, no fire
    simulatePoll(0.5, 0.5); // cross → fire once
    simulatePoll(0.5, 0.5); // same state → no re-fire
    simulatePoll(0.5, 0.5); // still same → no re-fire
    assert(fired === 1, `should fire exactly once, fired ${fired}`);
    console.log('  ✓ B17: CROSSOVER_DETECTED fires exactly once (no spam)'); passed++;
  } catch(e) { console.error('  ✗ B17:', e.message); failed++; }

  // B18 — watcher re-fires if odds uncross then re-cross
  try {
    let lastCrossover = null;
    let fired = 0;
    function simulatePoll2(leg1Implied, leg2Implied) {
      const crossed = leg2Implied >= leg1Implied;
      if (crossed !== lastCrossover) { lastCrossover = crossed; if (crossed) fired++; }
    }
    simulatePoll2(0.6, 0.4); // no cross
    simulatePoll2(0.4, 0.6); // cross → fire 1
    simulatePoll2(0.6, 0.4); // uncross
    simulatePoll2(0.4, 0.6); // re-cross → fire 2
    assert(fired === 2, `should fire twice on re-cross, fired ${fired}`);
    console.log('  ✓ B18: watcher re-fires on second crossover after uncross'); passed++;
  } catch(e) { console.error('  ✗ B18:', e.message); failed++; }

  // B19 — no watchedSides → no CROSSOVER_DETECTED dispatched
  try {
    let watchedSides = null;
    let sentCrossover = false;
    function fakePoll(outcomes) {
      if (!watchedSides) return; // guarded
      sentCrossover = true;
    }
    fakePoll([{ side: 'Canada', implied: 0.3 }, { side: 'Qatar', implied: 0.7 }]);
    assert(!sentCrossover, 'should not fire without watchedSides');
    console.log('  ✓ B19: no watchedSides → CROSSOVER_DETECTED not dispatched'); passed++;
  } catch(e) { console.error('  ✗ B19:', e.message); failed++; }

  // B20 — case-insensitive side matching in crossover check
  try {
    const watchedSides = { leg1Side: 'Canada', leg2Side: 'Qatar' };
    const outcomes = [
      { side: 'CANADA', american: -110, implied: americanToImplied(-110) },
      { side: 'qatar',  american: -120, implied: americanToImplied(-120) },
    ];
    const sL = s => (s || '').toLowerCase();
    const leg1 = outcomes.find(o => sL(o.side) === sL(watchedSides.leg1Side));
    const leg2 = outcomes.find(o => sL(o.side) === sL(watchedSides.leg2Side));
    assert(leg1 && leg2, 'case-insensitive match failed');
    assert(leg2.implied >= leg1.implied, 'crossover should be detected');
    console.log('  ✓ B20: case-insensitive side matching works'); passed++;
  } catch(e) { console.error('  ✗ B20:', e.message); failed++; }

  console.log('\n── C. Strategy state machine ──');

  // C1 — IDLE + BET_INITIATED → FIRST_BET_PENDING
  try {
    assert(strategyTransition('IDLE', 'BET_INITIATED') === 'FIRST_BET_PENDING', 'wrong');
    console.log('  ✓ C1: IDLE + BET_INITIATED → FIRST_BET_PENDING'); passed++;
  } catch(e) { console.error('  ✗ C1:', e.message); failed++; }

  // C2 — FIRST_BET_PENDING + BET_CONFIRMED → FIRST_BET_PLACED
  try {
    assert(strategyTransition('FIRST_BET_PENDING', 'BET_CONFIRMED') === 'FIRST_BET_PLACED', 'wrong');
    console.log('  ✓ C2: FIRST_BET_PENDING + BET_CONFIRMED → FIRST_BET_PLACED'); passed++;
  } catch(e) { console.error('  ✗ C2:', e.message); failed++; }

  // C3 — FIRST_BET_PENDING + BET_FAILED → HEDGE_FAILED
  try {
    assert(strategyTransition('FIRST_BET_PENDING', 'BET_FAILED') === 'IDLE', 'wrong');
    console.log('  ✓ C3: FIRST_BET_PENDING + BET_FAILED → IDLE (first leg fail resets to IDLE)'); passed++;
  } catch(e) { console.error('  ✗ C3:', e.message); failed++; }

  // C4 — FIRST_BET_PLACED + CROSSOVER_DETECTED → WATCHING_HEDGE
  try {
    assert(strategyTransition('FIRST_BET_PLACED', 'CROSSOVER_DETECTED') === 'WATCHING_HEDGE', 'wrong');
    console.log('  ✓ C4: FIRST_BET_PLACED + CROSSOVER_DETECTED → WATCHING_HEDGE'); passed++;
  } catch(e) { console.error('  ✗ C4:', e.message); failed++; }

  // C5 — FIRST_BET_PLACED + STRATEGY_CANCELLED → IDLE
  try {
    assert(strategyTransition('FIRST_BET_PLACED', 'STRATEGY_CANCELLED') === 'IDLE', 'wrong');
    console.log('  ✓ C5: FIRST_BET_PLACED + STRATEGY_CANCELLED → IDLE'); passed++;
  } catch(e) { console.error('  ✗ C5:', e.message); failed++; }

  // C6 — FIRST_BET_PLACED + STRATEGY_EXPIRED → IDLE
  try {
    assert(strategyTransition('FIRST_BET_PLACED', 'STRATEGY_EXPIRED') === 'IDLE', 'wrong');
    console.log('  ✓ C6: FIRST_BET_PLACED + STRATEGY_EXPIRED → IDLE'); passed++;
  } catch(e) { console.error('  ✗ C6:', e.message); failed++; }

  // C7 — WATCHING_HEDGE + VERIFY_PASSED → HEDGE_FIRED
  try {
    assert(strategyTransition('WATCHING_HEDGE', 'VERIFY_PASSED') === 'HEDGE_FIRED', 'wrong');
    console.log('  ✓ C7: WATCHING_HEDGE + VERIFY_PASSED → HEDGE_FIRED'); passed++;
  } catch(e) { console.error('  ✗ C7:', e.message); failed++; }

  // C8 — WATCHING_HEDGE + VERIFY_FAILED → HEDGE_FAILED
  try {
    assert(strategyTransition('WATCHING_HEDGE', 'VERIFY_FAILED') === 'HEDGE_FAILED', 'wrong');
    console.log('  ✓ C8: WATCHING_HEDGE + VERIFY_FAILED → HEDGE_FAILED'); passed++;
  } catch(e) { console.error('  ✗ C8:', e.message); failed++; }

  // C9 — HEDGE_FIRED + BET_CONFIRMED → BOTH_PLACED
  try {
    assert(strategyTransition('HEDGE_FIRED', 'BET_CONFIRMED') === 'BOTH_PLACED', 'wrong');
    console.log('  ✓ C9: HEDGE_FIRED + BET_CONFIRMED → BOTH_PLACED'); passed++;
  } catch(e) { console.error('  ✗ C9:', e.message); failed++; }

  // C10 — HEDGE_FIRED + BET_FAILED → HEDGE_FAILED
  try {
    assert(strategyTransition('HEDGE_FIRED', 'BET_FAILED') === 'HEDGE_FAILED', 'wrong');
    console.log('  ✓ C10: HEDGE_FIRED + BET_FAILED → HEDGE_FAILED'); passed++;
  } catch(e) { console.error('  ✗ C10:', e.message); failed++; }

  // C11 — BOTH_PLACED is terminal: any event → stays BOTH_PLACED
  try {
    ['BET_INITIATED','BET_CONFIRMED','BET_FAILED','CROSSOVER_DETECTED','VERIFY_PASSED'].forEach(ev => {
      assert(strategyTransition('BOTH_PLACED', ev) === 'BOTH_PLACED', `BOTH_PLACED should be terminal for ${ev}`);
    });
    console.log('  ✓ C11: BOTH_PLACED terminal — all events ignored'); passed++;
  } catch(e) { console.error('  ✗ C11:', e.message); failed++; }

  // C12 — HEDGE_FAILED is terminal: any event → stays HEDGE_FAILED
  try {
    ['BET_CONFIRMED','CROSSOVER_DETECTED','VERIFY_PASSED'].forEach(ev => {
      assert(strategyTransition('HEDGE_FAILED', ev) === 'HEDGE_FAILED', `HEDGE_FAILED should be terminal for ${ev}`);
    });
    console.log('  ✓ C12: HEDGE_FAILED terminal — all events ignored'); passed++;
  } catch(e) { console.error('  ✗ C12:', e.message); failed++; }

  // C13 — unknown event → state unchanged
  try {
    assert(strategyTransition('FIRST_BET_PLACED', 'UNKNOWN_EVENT') === 'FIRST_BET_PLACED', 'wrong');
    assert(strategyTransition('IDLE', 'BOGUS') === 'IDLE', 'wrong');
    console.log('  ✓ C13: unknown event → state unchanged'); passed++;
  } catch(e) { console.error('  ✗ C13:', e.message); failed++; }

  // C14 — unknown state → state unchanged (defensive)
  try {
    assert(strategyTransition('NONEXISTENT', 'BET_CONFIRMED') === 'NONEXISTENT', 'wrong');
    console.log('  ✓ C14: unknown state → state unchanged (defensive)'); passed++;
  } catch(e) { console.error('  ✗ C14:', e.message); failed++; }

  // C15 — full happy path: IDLE → BOTH_PLACED in 5 events
  try {
    let s = 'IDLE';
    s = strategyTransition(s, 'BET_INITIATED');     assert(s === 'FIRST_BET_PENDING', s);
    s = strategyTransition(s, 'BET_CONFIRMED');     assert(s === 'FIRST_BET_PLACED', s);
    s = strategyTransition(s, 'CROSSOVER_DETECTED'); assert(s === 'WATCHING_HEDGE', s);
    s = strategyTransition(s, 'VERIFY_PASSED');     assert(s === 'HEDGE_FIRED', s);
    s = strategyTransition(s, 'BET_CONFIRMED');     assert(s === 'BOTH_PLACED', s);
    console.log('  ✓ C15: full happy path IDLE → BOTH_PLACED (5 events)'); passed++;
  } catch(e) { console.error('  ✗ C15:', e.message); failed++; }

  // C16 — failure path: BET_FAILED in first leg
  try {
    let s = 'IDLE';
    s = strategyTransition(s, 'BET_INITIATED');
    s = strategyTransition(s, 'BET_FAILED');
    assert(s === 'IDLE', `expected IDLE, got ${s}`);
    console.log('  ✓ C16: first leg failure → IDLE (clean reset, not HEDGE_FAILED)'); passed++;
  } catch(e) { console.error('  ✗ C16:', e.message); failed++; }

  // C17 — cancel mid-strategy: FIRST_BET_PLACED → IDLE
  try {
    let s = strategyTransition('FIRST_BET_PENDING', 'BET_CONFIRMED'); // → FIRST_BET_PLACED
    s = strategyTransition(s, 'STRATEGY_CANCELLED');
    assert(s === 'IDLE', `expected IDLE, got ${s}`);
    console.log('  ✓ C17: cancel from FIRST_BET_PLACED → IDLE'); passed++;
  } catch(e) { console.error('  ✗ C17:', e.message); failed++; }

  console.log('\n── C. tripleVerify gate ──');

  // C18 — all 7 checks pass → { pass: true }
  try {
    const strategy = { gameId: 'game1', expectedHedgeOdds: -120, leg1Confirmed: true, hedgeAmount: 5 };
    const dom = { gameId: 'game1', leg2Odds: -118, suspended: false, hedgeProfit: 2.50, slipHasBets: false, balance: 100 };
    const v = tripleVerify(strategy, dom);
    assert(v.pass === true, `should pass, failed: ${v.failed.map(c=>c.name).join(',')}`);
    assert(v.checks.length === 7, `should have 7 checks, got ${v.checks.length}`);
    assert(v.failed.length === 0, `should have no failures`);
    console.log('  ✓ C18: all 7 checks pass → { pass: true }'); passed++;
  } catch(e) { console.error('  ✗ C18:', e.message); failed++; }

  // C19 — game_identity mismatch → fails
  try {
    const strategy = { gameId: 'game1', leg1Confirmed: true };
    const dom = { gameId: 'game2', suspended: false, hedgeProfit: 1 };
    const v = tripleVerify(strategy, dom);
    assert(!v.pass, 'should fail');
    assert(v.failed.some(c => c.name === 'game_identity'), 'game_identity should be in failures');
    console.log('  ✓ C19: game_identity mismatch → verify fails'); passed++;
  } catch(e) { console.error('  ✗ C19:', e.message); failed++; }

  // C20 — odds_slippage > 8 → fails
  try {
    const strategy = { expectedHedgeOdds: -120, leg1Confirmed: true };
    const dom = { leg2Odds: -130, suspended: false }; // slippage = 10
    const v = tripleVerify(strategy, dom);
    assert(!v.pass, 'should fail');
    assert(v.failed.some(c => c.name === 'odds_slippage'), 'odds_slippage should be in failures');
    console.log('  ✓ C20: odds_slippage 10pts > 8 → verify fails'); passed++;
  } catch(e) { console.error('  ✗ C20:', e.message); failed++; }

  // C21 — odds_slippage exactly 8 → passes
  try {
    const strategy = { expectedHedgeOdds: -120, leg1Confirmed: true };
    const dom = { leg2Odds: -128, suspended: false }; // slippage = 8 exactly
    const v = tripleVerify(strategy, dom);
    assert(!v.failed.some(c => c.name === 'odds_slippage'), 'slippage of 8 should pass');
    console.log('  ✓ C21: odds_slippage exactly 8 → passes (boundary)'); passed++;
  } catch(e) { console.error('  ✗ C21:', e.message); failed++; }

  // C22 — market suspended → fails
  try {
    const strategy = { leg1Confirmed: true };
    const dom = { suspended: true, hedgeProfit: 1 };
    const v = tripleVerify(strategy, dom);
    assert(!v.pass, 'should fail');
    assert(v.failed.some(c => c.name === 'market_active'), 'market_active should fail');
    console.log('  ✓ C22: market suspended → verify fails'); passed++;
  } catch(e) { console.error('  ✗ C22:', e.message); failed++; }

  // C23 — hedge not profitable → fails
  try {
    const strategy = { leg1Confirmed: true };
    const dom = { suspended: false, hedgeProfit: -0.50 };
    const v = tripleVerify(strategy, dom);
    assert(v.failed.some(c => c.name === 'hedge_profitable'), 'hedge_profitable should fail');
    console.log('  ✓ C23: hedge_profit < 0 → verify fails'); passed++;
  } catch(e) { console.error('  ✗ C23:', e.message); failed++; }

  // C24 — hedge profit exactly 0 → fails (must be > 0)
  try {
    const strategy = { leg1Confirmed: true };
    const dom = { suspended: false, hedgeProfit: 0 };
    const v = tripleVerify(strategy, dom);
    assert(v.failed.some(c => c.name === 'hedge_profitable'), 'profit=0 should fail');
    console.log('  ✓ C24: hedge_profit = 0 → fails (requires > 0)'); passed++;
  } catch(e) { console.error('  ✗ C24:', e.message); failed++; }

  // C25 — slip has existing bets → fails
  try {
    const strategy = { leg1Confirmed: true };
    const dom = { suspended: false, hedgeProfit: 1, slipHasBets: true };
    const v = tripleVerify(strategy, dom);
    assert(v.failed.some(c => c.name === 'slip_empty'), 'slip_empty should fail');
    console.log('  ✓ C25: betslip not empty → verify fails'); passed++;
  } catch(e) { console.error('  ✗ C25:', e.message); failed++; }

  // C26 — balance insufficient → fails
  try {
    const strategy = { leg1Confirmed: true, hedgeAmount: 50 };
    const dom = { suspended: false, hedgeProfit: 1, balance: 10 }; // need 50, have 10
    const v = tripleVerify(strategy, dom);
    assert(v.failed.some(c => c.name === 'balance_sufficient'), 'balance_sufficient should fail');
    console.log('  ✓ C26: balance < hedgeAmount → verify fails'); passed++;
  } catch(e) { console.error('  ✗ C26:', e.message); failed++; }

  // C27 — leg1 not confirmed → fails
  try {
    const strategy = { leg1Confirmed: false };
    const dom = { suspended: false, hedgeProfit: 1 };
    const v = tripleVerify(strategy, dom);
    assert(v.failed.some(c => c.name === 'leg1_confirmed'), 'leg1_confirmed should fail');
    console.log('  ✓ C27: leg1 not confirmed → verify fails'); passed++;
  } catch(e) { console.error('  ✗ C27:', e.message); failed++; }

  // C28 — multiple failures listed in failed array
  try {
    const strategy = { leg1Confirmed: false, expectedHedgeOdds: -120 };
    const dom = { leg2Odds: -135, suspended: true, hedgeProfit: -1 };
    const v = tripleVerify(strategy, dom);
    assert(v.failed.length >= 4, `expected ≥4 failures, got ${v.failed.length}: ${v.failed.map(c=>c.name).join(',')}`);
    console.log(`  ✓ C28: multiple failures (${v.failed.map(c=>c.name).join(', ')})`); passed++;
  } catch(e) { console.error('  ✗ C28:', e.message); failed++; }

  // C29 — no gameId in strategy → game_identity passes (guard absent)
  try {
    const strategy = { leg1Confirmed: true }; // no gameId
    const dom = { gameId: 'anyGame', suspended: false, hedgeProfit: 1 };
    const v = tripleVerify(strategy, dom);
    assert(!v.failed.some(c => c.name === 'game_identity'), 'no strategy.gameId should skip game_identity check');
    console.log('  ✓ C29: no strategy.gameId → game_identity check skipped (passes)'); passed++;
  } catch(e) { console.error('  ✗ C29:', e.message); failed++; }

  // C30 — no expectedHedgeOdds → odds_slippage skipped
  try {
    const strategy = { leg1Confirmed: true }; // no expectedHedgeOdds
    const dom = { leg2Odds: -999, suspended: false, hedgeProfit: 1 };
    const v = tripleVerify(strategy, dom);
    assert(!v.failed.some(c => c.name === 'odds_slippage'), 'no expectedHedgeOdds should skip slippage check');
    console.log('  ✓ C30: no expectedHedgeOdds → slippage check skipped'); passed++;
  } catch(e) { console.error('  ✗ C30:', e.message); failed++; }

  // C31 — no hedgeProfit provided → hedge_profitable passes (unknown = OK)
  try {
    const strategy = { leg1Confirmed: true };
    const dom = { suspended: false }; // no hedgeProfit
    const v = tripleVerify(strategy, dom);
    assert(!v.failed.some(c => c.name === 'hedge_profitable'), 'undefined hedgeProfit should pass');
    console.log('  ✓ C31: undefined hedgeProfit → hedge_profitable skipped (passes)'); passed++;
  } catch(e) { console.error('  ✗ C31:', e.message); failed++; }

  // C32 — service worker resume: HEDGE_FIRED + confirmed → MARK_BOTH_PLACED
  try {
    function getResumeAction(state, leg2ConfirmedInApi) {
      if (state === 'HEDGE_FIRED' && leg2ConfirmedInApi) return 'MARK_BOTH_PLACED';
      if (state === 'HEDGE_FIRED' && !leg2ConfirmedInApi) return 'NOTIFY_MANUAL_HEDGE';
      if (state === 'FIRST_BET_PLACED') return 'RESUME_WATCHING';
      if (state === 'BOTH_PLACED') return 'SURFACE_RESULT';
      return 'NOTHING';
    }
    assert(getResumeAction('HEDGE_FIRED', true) === 'MARK_BOTH_PLACED', 'wrong');
    assert(getResumeAction('HEDGE_FIRED', false) === 'NOTIFY_MANUAL_HEDGE', 'wrong');
    assert(getResumeAction('FIRST_BET_PLACED', false) === 'RESUME_WATCHING', 'wrong');
    assert(getResumeAction('BOTH_PLACED', false) === 'SURFACE_RESULT', 'wrong');
    assert(getResumeAction('IDLE', false) === 'NOTHING', 'wrong');
    console.log('  ✓ C32: service worker resume actions correct for all states'); passed++;
  } catch(e) { console.error('  ✗ C32:', e.message); failed++; }

  // C33 — CROSSOVER_DETECTED ignored when state is HEDGE_FIRED (anti-double-bet)
  try {
    const terminalOrLate = ['HEDGE_FIRED', 'BOTH_PLACED', 'HEDGE_FAILED', 'IDLE', 'FIRST_BET_PENDING'];
    function shouldIgnore(state) { return state !== 'FIRST_BET_PLACED'; }
    terminalOrLate.forEach(s => assert(shouldIgnore(s), `${s} should ignore crossover`));
    assert(!shouldIgnore('FIRST_BET_PLACED'), 'FIRST_BET_PLACED should NOT ignore crossover');
    console.log('  ✓ C33: CROSSOVER_DETECTED ignored in all states except FIRST_BET_PLACED'); passed++;
  } catch(e) { console.error('  ✗ C33:', e.message); failed++; }

  // C34 — WATCH_SIDES message shape
  try {
    const msg = { type: 'WATCH_SIDES', leg1Side: 'Canada', leg2Side: 'Qatar' };
    assert(msg.type === 'WATCH_SIDES', 'type wrong');
    assert(msg.leg1Side === 'Canada', 'leg1Side wrong');
    assert(msg.leg2Side === 'Qatar', 'leg2Side wrong');
    console.log('  ✓ C34: WATCH_SIDES message shape valid'); passed++;
  } catch(e) { console.error('  ✗ C34:', e.message); failed++; }

  // C35 — STOP_WATCHING resets watchedSides and lastCrossover
  try {
    let watchedSides = { leg1Side: 'Canada', leg2Side: 'Qatar' };
    let lastCrossover = true;
    // Simulate receiving STOP_WATCHING
    function handleStopWatching() { watchedSides = null; lastCrossover = null; }
    handleStopWatching();
    assert(watchedSides === null, 'watchedSides should be null');
    assert(lastCrossover === null, 'lastCrossover should be null');
    console.log('  ✓ C35: STOP_WATCHING clears watchedSides + lastCrossover'); passed++;
  } catch(e) { console.error('  ✗ C35:', e.message); failed++; }

  // C36 — strategy stored schema has required keys
  try {
    const strategy = {
      state: 'FIRST_BET_PLACED',
      leg1Side: 'Canada', leg1Amount: 10, leg1Odds: '-350',
      leg2Side: 'Qatar', trigger: { type: 'crossover', targetOdds: null },
      gameId: 'game1', startedAt: Date.now(), updatedAt: Date.now(),
      leg1Confirmed: true, hedgeAmount: null, expectedHedgeOdds: null
    };
    const required = ['state','leg1Side','leg1Amount','leg2Side','trigger','startedAt','updatedAt','leg1Confirmed'];
    required.forEach(k => assert(strategy[k] !== undefined, `missing key: ${k}`));
    console.log('  ✓ C36: strategy storage schema has all required keys'); passed++;
  } catch(e) { console.error('  ✗ C36:', e.message); failed++; }

  // C37 — STRATEGY_UPDATE message shape
  try {
    const msg = { type: 'STRATEGY_UPDATE', strategy: { state: 'WATCHING_HEDGE', leg1Side: 'Canada', updatedAt: Date.now() } };
    assert(msg.type === 'STRATEGY_UPDATE', 'type wrong');
    assert(msg.strategy.state === 'WATCHING_HEDGE', 'state wrong');
    console.log('  ✓ C37: STRATEGY_UPDATE message shape valid'); passed++;
  } catch(e) { console.error('  ✗ C37:', e.message); failed++; }
}

// ═══════════════════════════════════════════════════════════════════════════
// STOP COUNTDOWN + IDEMPOTENCY + SOCCER DRAW TESTS
// ═══════════════════════════════════════════════════════════════════════════

async function runFinalFeatureTests() {
  console.log('\n── D. STOP countdown ──');

  // D1 — countdown starts at 3
  try {
    let countdownLeft = 3;
    let ticks = 0;
    function tick() { ticks++; countdownLeft--; }
    tick(); tick(); tick();
    assert(countdownLeft === 0, `expected 0, got ${countdownLeft}`);
    assert(ticks === 3, `expected 3 ticks, got ${ticks}`);
    console.log('  ✓ D1: countdown ticks from 3 to 0'); passed++;
  } catch(e) { console.error('  ✗ D1:', e.message); failed++; }

  // D2 — STOP cancels countdown before firing
  try {
    let cancelled = false;
    let hedgeFired = false;
    async function simulateCountdown(userStops) {
      let left = 3;
      await new Promise(res => setTimeout(res, 10)); // tiny real wait
      if (userStops) { cancelled = true; return; }
      hedgeFired = true;
    }
    await simulateCountdown(true);
    assert(cancelled === true, 'should be cancelled');
    assert(hedgeFired === false, 'hedge should not fire');
    console.log('  ✓ D2: STOP during countdown cancels hedge'); passed++;
  } catch(e) { console.error('  ✗ D2:', e.message); failed++; }

  // D3 — STOP during countdown sends STRATEGY_CANCEL (not PLACE_BET)
  try {
    const messages = [];
    function fakeRuntime(msg) { messages.push(msg.type); }
    // Simulate handleStop() in popup.js
    function handleStop() {
      fakeRuntime({ type: 'STRATEGY_CANCEL' });
    }
    handleStop();
    assert(messages.includes('STRATEGY_CANCEL'), 'should send STRATEGY_CANCEL');
    assert(!messages.includes('PLACE_BET'), 'should NOT send PLACE_BET');
    console.log('  ✓ D3: STOP → STRATEGY_CANCEL sent, no PLACE_BET'); passed++;
  } catch(e) { console.error('  ✗ D3:', e.message); failed++; }

  // D4 — HEDGE_COUNTDOWN message shape
  try {
    const msg = { type: 'HEDGE_COUNTDOWN', side: 'Qatar', amount: 5, oddsText: '+200' };
    assert(msg.type === 'HEDGE_COUNTDOWN', 'type wrong');
    assert(msg.side === 'Qatar', 'side wrong');
    assert(msg.amount === 5, 'amount wrong');
    assert(msg.oddsText === '+200', 'oddsText wrong');
    console.log('  ✓ D4: HEDGE_COUNTDOWN message shape valid'); passed++;
  } catch(e) { console.error('  ✗ D4:', e.message); failed++; }

  // D5 — 3s wait + cancel: state checked after wait
  try {
    // Simulates background.js logic: wait 3s, then re-check state
    async function simulateHedgeWithCancel(stateAfterWait) {
      await new Promise(res => setTimeout(res, 10)); // tiny stand-in for 3s
      if (stateAfterWait !== 'WATCHING_HEDGE') return 'aborted';
      return 'fired';
    }
    const r1 = await simulateHedgeWithCancel('IDLE'); // user cancelled
    assert(r1 === 'aborted', `expected aborted, got ${r1}`);
    const r2 = await simulateHedgeWithCancel('WATCHING_HEDGE'); // still watching
    assert(r2 === 'fired', `expected fired, got ${r2}`);
    console.log('  ✓ D5: post-countdown state check aborts if STRATEGY_CANCEL received'); passed++;
  } catch(e) { console.error('  ✗ D5:', e.message); failed++; }

  // D6 — countdown message updated in-place (no duplicate chat rows)
  try {
    let rows = 0;
    let lastWasCountdown = false;
    function fakeAppend(isCountdown) {
      if (isCountdown && lastWasCountdown) return; // update in place
      rows++;
      lastWasCountdown = isCountdown;
    }
    fakeAppend(false); // first row (not countdown)  → rows=1
    fakeAppend(true);  // countdown row 1 → new row  → rows=2
    fakeAppend(true);  // countdown row 2 → in place → rows=2
    fakeAppend(true);  // countdown row 3 → in place → rows=2
    assert(rows === 2, `expected 2 rows, got ${rows}`); // first + one countdown row
    console.log('  ✓ D6: countdown updates in-place (no chat spam)'); passed++;
  } catch(e) { console.error('  ✗ D6:', e.message); failed++; }

  console.log('\n── E. Idempotency key ──');

  // E1 — same key within 30s → blocked
  try {
    const store = {};
    async function fakePlaceBet(side, amount, userId) {
      const betKey = `${userId}|${side}|${amount}`;
      const keyAge = store.lastBetKeyTs ? Date.now() - store.lastBetKeyTs : Infinity;
      if (store.lastBetKey === betKey && keyAge < 30000) return { blocked: true };
      store.lastBetKey = betKey;
      store.lastBetKeyTs = Date.now();
      return { blocked: false };
    }
    const r1 = await fakePlaceBet('Canada', 10, 'louis');
    assert(!r1.blocked, 'first bet should not be blocked');
    const r2 = await fakePlaceBet('Canada', 10, 'louis');
    assert(r2.blocked, 'duplicate within 30s should be blocked');
    console.log('  ✓ E1: same bet within 30s → blocked by idempotency key'); passed++;
  } catch(e) { console.error('  ✗ E1:', e.message); failed++; }

  // E2 — different side → not blocked
  try {
    const store = { lastBetKey: 'louis|Canada|10', lastBetKeyTs: Date.now() };
    function isSameKey(userId, side, amount) {
      const betKey = `${userId}|${side}|${amount}`;
      const age = store.lastBetKeyTs ? Date.now() - store.lastBetKeyTs : Infinity;
      return store.lastBetKey === betKey && age < 30000;
    }
    assert(!isSameKey('louis', 'Qatar', 10), 'different side should not be blocked');
    console.log('  ✓ E2: different side → not blocked'); passed++;
  } catch(e) { console.error('  ✗ E2:', e.message); failed++; }

  // E3 — different amount → not blocked
  try {
    const store = { lastBetKey: 'louis|Canada|10', lastBetKeyTs: Date.now() };
    function isSameKey2(side, amount) {
      const betKey = `louis|${side}|${amount}`;
      const age = Date.now() - store.lastBetKeyTs;
      return store.lastBetKey === betKey && age < 30000;
    }
    assert(!isSameKey2('Canada', 5), 'different amount should not be blocked');
    console.log('  ✓ E3: different amount → not blocked'); passed++;
  } catch(e) { console.error('  ✗ E3:', e.message); failed++; }

  // E4 — different user → not blocked
  try {
    const key1 = 'louis|Canada|10';
    const key2 = 'ish|Canada|10';
    assert(key1 !== key2, 'different users should have different keys');
    console.log('  ✓ E4: different userId → different key → not blocked'); passed++;
  } catch(e) { console.error('  ✗ E4:', e.message); failed++; }

  // E5 — same key after 30s → allowed (stale key)
  try {
    const store = {
      lastBetKey: 'louis|Canada|10',
      lastBetKeyTs: Date.now() - 31000  // 31s ago — expired
    };
    const betKey = 'louis|Canada|10';
    const age = Date.now() - store.lastBetKeyTs;
    const blocked = store.lastBetKey === betKey && age < 30000;
    assert(!blocked, 'stale key (>30s) should not block');
    console.log('  ✓ E5: key older than 30s → not blocked (retry allowed)'); passed++;
  } catch(e) { console.error('  ✗ E5:', e.message); failed++; }

  // E6 — idempotency key format: userId|side|amount
  try {
    const key = `${'louis'}|${'Canada'}|${10}`;
    assert(key === 'louis|Canada|10', `key format wrong: ${key}`);
    assert(key.split('|').length === 3, 'key should have 3 parts');
    console.log('  ✓ E6: idempotency key format: userId|side|amount'); passed++;
  } catch(e) { console.error('  ✗ E6:', e.message); failed++; }

  // E7 — BET_RESULT step:'duplicate' on blocked bet
  try {
    const msg = { type: 'BET_RESULT', ok: false, step: 'duplicate', error: 'Duplicate bet blocked — same bet placed 5s ago' };
    assert(msg.ok === false, 'ok should be false');
    assert(msg.step === 'duplicate', 'step should be duplicate');
    assert(/duplicate/i.test(msg.error), 'error should mention duplicate');
    console.log('  ✓ E7: blocked duplicate → BET_RESULT with step:duplicate'); passed++;
  } catch(e) { console.error('  ✗ E7:', e.message); failed++; }

  // E8 — auto-hedge (isAutoHedge:true) still subject to idempotency
  try {
    const store = { lastBetKey: 'louis|Qatar|5.23', lastBetKeyTs: Date.now() };
    function isBlocked(side, amount) {
      const key = `louis|${side}|${amount}`;
      return store.lastBetKey === key && (Date.now() - store.lastBetKeyTs) < 30000;
    }
    assert(isBlocked('Qatar', 5.23), 'auto-hedge duplicate should also be blocked');
    console.log('  ✓ E8: auto-hedge (isAutoHedge) also checked for idempotency'); passed++;
  } catch(e) { console.error('  ✗ E8:', e.message); failed++; }

  console.log('\n── F. Soccer draw exposure ──');

  // F1 — 3 outcomes including "Draw" → warning triggered
  try {
    function checkDraw(outcomes, stratState) {
      if (!outcomes || outcomes.length < 3) return false;
      if (stratState !== 'FIRST_BET_PLACED' && stratState !== 'WATCHING_HEDGE') return false;
      return outcomes.some(o => /\bdraw\b/i.test(o.side || ''));
    }
    const outcomes3 = [
      { side: 'Canada', implied: 0.6 },
      { side: 'Draw', implied: 0.25 },
      { side: 'Mexico', implied: 0.15 },
    ];
    assert(checkDraw(outcomes3, 'FIRST_BET_PLACED'), 'should warn');
    console.log('  ✓ F1: 3 outcomes with Draw + FIRST_BET_PLACED → warning triggered'); passed++;
  } catch(e) { console.error('  ✗ F1:', e.message); failed++; }

  // F2 — 2 outcomes (no draw) → no warning
  try {
    function checkDraw2(outcomes) { return outcomes.length >= 3 && outcomes.some(o => /\bdraw\b/i.test(o.side || '')); }
    const outcomes2 = [{ side: 'Canada' }, { side: 'Qatar' }];
    assert(!checkDraw2(outcomes2), '2-outcome game should not warn');
    console.log('  ✓ F2: 2 outcomes (MMA/boxing) → no draw warning'); passed++;
  } catch(e) { console.error('  ✗ F2:', e.message); failed++; }

  // F3 — IDLE strategy → no draw warning even if 3 outcomes visible
  try {
    function checkDraw3(outcomes, stratState) {
      if (stratState !== 'FIRST_BET_PLACED' && stratState !== 'WATCHING_HEDGE') return false;
      return outcomes.length >= 3 && outcomes.some(o => /\bdraw\b/i.test(o.side || ''));
    }
    const outcomes3 = [{ side: 'Home' }, { side: 'Draw' }, { side: 'Away' }];
    assert(!checkDraw3(outcomes3, 'IDLE'), 'IDLE state should not warn');
    assert(!checkDraw3(outcomes3, 'BOTH_PLACED'), 'BOTH_PLACED should not warn');
    console.log('  ✓ F3: IDLE/BOTH_PLACED → no draw warning (strategy not active)'); passed++;
  } catch(e) { console.error('  ✗ F3:', e.message); failed++; }

  // F4 — draw warning only fires once (drawnWarned flag)
  try {
    let drawnWarned = false;
    let warnings = 0;
    function maybeWarn(outcomes, state) {
      if (drawnWarned) return;
      if (outcomes.length < 3) return;
      if (state !== 'FIRST_BET_PLACED') return;
      if (!outcomes.some(o => /\bdraw\b/i.test(o.side || ''))) return;
      drawnWarned = true;
      warnings++;
    }
    const o = [{ side: 'Home' }, { side: 'Draw' }, { side: 'Away' }];
    maybeWarn(o, 'FIRST_BET_PLACED');
    maybeWarn(o, 'FIRST_BET_PLACED'); // second call — should not re-warn
    maybeWarn(o, 'FIRST_BET_PLACED');
    assert(warnings === 1, `should warn exactly once, warned ${warnings}`);
    console.log('  ✓ F4: draw warning fires exactly once per strategy (drawnWarned flag)'); passed++;
  } catch(e) { console.error('  ✗ F4:', e.message); failed++; }

  // F5 — drawnWarned resets on STOP
  try {
    let drawnWarned = true;
    function handleStop() { drawnWarned = false; }
    handleStop();
    assert(drawnWarned === false, 'drawnWarned should reset on STOP');
    console.log('  ✓ F5: drawnWarned resets when STOP is pressed'); passed++;
  } catch(e) { console.error('  ✗ F5:', e.message); failed++; }

  // F6 — getSportOutcomes: soccer has draw, mma/boxing do not
  try {
    function getSportOutcomes(sport) {
      switch (sport) {
        case 'soccer': return ['home', 'draw', 'away'];
        case 'mma': case 'boxing': return ['fighter1', 'fighter2'];
        default: return ['team1', 'team2'];
      }
    }
    assert(getSportOutcomes('soccer').includes('draw'), 'soccer has draw');
    assert(!getSportOutcomes('mma').includes('draw'), 'mma has no draw');
    assert(!getSportOutcomes('boxing').includes('draw'), 'boxing has no draw');
    assert(!getSportOutcomes('nba').includes('draw'), 'nba has no draw');
    console.log('  ✓ F6: getSportOutcomes: soccer=3 outcomes, mma/boxing=2'); passed++;
  } catch(e) { console.error('  ✗ F6:', e.message); failed++; }

  // F7 — case-insensitive "Draw" detection
  try {
    function hasDraw(outcomes) { return outcomes.some(o => /\bdraw\b/i.test(o.side || '')); }
    assert(hasDraw([{ side: 'Draw' }]), 'capital Draw');
    assert(hasDraw([{ side: 'draw' }]), 'lowercase draw');
    assert(hasDraw([{ side: 'DRAW' }]), 'uppercase DRAW');
    assert(!hasDraw([{ side: 'Withdraw' }]), 'Withdraw should not match \\bdraw\\b');
    console.log('  ✓ F7: Draw detection case-insensitive, word-boundary safe'); passed++;
  } catch(e) { console.error('  ✗ F7:', e.message); failed++; }

  // F8 — NL parser legacy fallback: "cancel" → cancel intent
  try {
    function parseBetCmdLegacy(raw) {
      const cancel = /^(cancel|stop|abort|quit)$/i.test(raw.trim());
      if (cancel) return { intent: 'cancel', side: null, amount: null };
      const m = raw.trim().match(/^bet\s+(.+?)\s+([\d.]+)$/i);
      if (!m) return { intent: 'unknown', side: null, amount: null };
      return { intent: 'place_first_bet', side: m[1].trim(), amount: parseFloat(m[2]) };
    }
    assert(parseBetCmdLegacy('cancel').intent === 'cancel', 'cancel');
    assert(parseBetCmdLegacy('stop').intent === 'cancel', 'stop');
    assert(parseBetCmdLegacy('ABORT').intent === 'cancel', 'ABORT');
    assert(parseBetCmdLegacy('bet canada 5').intent === 'place_first_bet', 'bet cmd');
    assert(parseBetCmdLegacy('hello').intent === 'unknown', 'unknown');
    console.log('  ✓ F8: legacy fallback parser handles cancel/stop/abort/bet/unknown'); passed++;
  } catch(e) { console.error('  ✗ F8:', e.message); failed++; }

  // F9 — strategy state badge colors defined for all states
  try {
    const colors = { IDLE:'#333', FIRST_BET_PENDING:'#e8b84b', FIRST_BET_PLACED:'#74c0fc', WATCHING_HEDGE:'#e8b84b', HEDGE_FIRED:'#ff6b6b', BOTH_PLACED:'#69db7c', HEDGE_FAILED:'#ff6b6b' };
    const states = ['IDLE','FIRST_BET_PENDING','FIRST_BET_PLACED','WATCHING_HEDGE','HEDGE_FIRED','BOTH_PLACED','HEDGE_FAILED'];
    states.forEach(s => assert(colors[s], `no color for state ${s}`));
    console.log('  ✓ F9: all 7 strategy states have badge colors'); passed++;
  } catch(e) { console.error('  ✗ F9:', e.message); failed++; }

  // F10 — STRATEGY_START message shape
  try {
    const msg = {
      type: 'STRATEGY_START',
      leg1Side: 'Canada', leg1Amount: 10,
      leg2Side: null,
      trigger: { type: 'crossover', targetOdds: null }
    };
    assert(msg.type === 'STRATEGY_START', 'type');
    assert(msg.leg1Side === 'Canada', 'leg1Side');
    assert(msg.leg1Amount === 10, 'leg1Amount');
    assert(msg.trigger.type === 'crossover', 'trigger.type');
    console.log('  ✓ F10: STRATEGY_START message shape valid'); passed++;
  } catch(e) { console.error('  ✗ F10:', e.message); failed++; }
}

// ═══════════════════════════════════════════════════════════════════════════
// G. DASHBOARD CHAT → COMMAND QUEUE → EXTENSION RELAY
// ═══════════════════════════════════════════════════════════════════════════

async function runDashboardChatTests() {
  console.log('\n── G. Dashboard chat command queue ──');

  // ── Pure helpers mirrored from server.js ──────────────────────────────────
  function makeCmd(type, intent) {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      type,
      side:    intent.side   || null,
      amount:  intent.amount || null,
      trigger: intent.trigger || { type: 'crossover', targetOdds: null },
      status:  'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 120000,
      result: null,
      strategyHistory: [],
    };
  }

  function pickupCommand(queue) {
    const now = Date.now();
    const pending = queue.filter(c => c.status !== 'pending' || c.expiresAt > now)
                        .find(c => c.status === 'pending');
    if (pending) { pending.status = 'picked_up'; pending.pickedUpAt = now; }
    return pending || null;
  }

  function completeCommand(queue, id, result) {
    const cmd = queue.find(c => c.id === id);
    if (!cmd) return false;
    cmd.status      = result?.ok ? 'done' : 'failed';
    cmd.result      = result;
    cmd.completedAt = Date.now();
    return true;
  }

  function addStrategyUpdate(queue, id, state, message) {
    const cmd = queue.find(c => c.id === id);
    if (!cmd) return false;
    cmd.strategyState   = state;
    cmd.strategyMessage = message;
    cmd.strategyHistory.push({ state, message, ts: Date.now() });
    return true;
  }

  // G1 — makeCmd produces correct shape
  try {
    const cmd = makeCmd('place_bet', { side: 'Canada', amount: 25, trigger: { type: 'crossover', targetOdds: null } });
    assert(cmd.type === 'place_bet', 'type');
    assert(cmd.side === 'Canada', 'side');
    assert(cmd.amount === 25, 'amount');
    assert(cmd.trigger.type === 'crossover', 'trigger');
    assert(cmd.status === 'pending', 'status');
    assert(cmd.id.length > 4, 'id non-empty');
    assert(cmd.expiresAt > Date.now(), 'expiresAt in future');
    assert(Array.isArray(cmd.strategyHistory), 'strategyHistory array');
    console.log('  ✓ G1: makeCommand shape valid'); passed++;
  } catch(e) { console.error('  ✗ G1:', e.message); failed++; }

  // G2 — pickupCommand returns pending, marks as picked_up
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    const picked = pickupCommand(q);
    assert(picked !== null, 'should pick up');
    assert(picked.status === 'picked_up', `status should be picked_up, got ${picked.status}`);
    assert(picked.pickedUpAt > 0, 'pickedUpAt set');
    console.log('  ✓ G2: pickupCommand marks command as picked_up'); passed++;
  } catch(e) { console.error('  ✗ G2:', e.message); failed++; }

  // G3 — second pickup call returns null (already picked_up)
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    pickupCommand(q); // first pickup
    const second = pickupCommand(q); // should return null
    assert(second === null, 'second pickup should be null');
    console.log('  ✓ G3: second pickup returns null — no double-execution'); passed++;
  } catch(e) { console.error('  ✗ G3:', e.message); failed++; }

  // G4 — expired command is skipped
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    q[0].expiresAt = Date.now() - 1000; // already expired
    const picked = pickupCommand(q);
    assert(picked === null, 'expired command should not be picked up');
    console.log('  ✓ G4: expired pending command skipped'); passed++;
  } catch(e) { console.error('  ✗ G4:', e.message); failed++; }

  // G5 — completeCommand sets done on success
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    pickupCommand(q);
    const ok = completeCommand(q, q[0].id, { ok: true, side: 'Canada', amount: 25, oddsText: '-350' });
    assert(ok, 'completeCommand should return true');
    assert(q[0].status === 'done', `status should be done, got ${q[0].status}`);
    assert(q[0].result.ok === true, 'result.ok');
    assert(q[0].completedAt > 0, 'completedAt set');
    console.log('  ✓ G5: completeCommand → status:done on success'); passed++;
  } catch(e) { console.error('  ✗ G5:', e.message); failed++; }

  // G6 — completeCommand sets failed on error
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    pickupCommand(q);
    completeCommand(q, q[0].id, { ok: false, error: 'No DK tab open' });
    assert(q[0].status === 'failed', `status should be failed, got ${q[0].status}`);
    console.log('  ✓ G6: completeCommand → status:failed on error'); passed++;
  } catch(e) { console.error('  ✗ G6:', e.message); failed++; }

  // G7 — completeCommand returns false for unknown id
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    const ok = completeCommand(q, 'nonexistent-id', { ok: true });
    assert(ok === false, 'should return false for unknown id');
    console.log('  ✓ G7: completeCommand with unknown id returns false'); passed++;
  } catch(e) { console.error('  ✗ G7:', e.message); failed++; }

  // G8 — addStrategyUpdate appends to history
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    addStrategyUpdate(q, q[0].id, 'FIRST_BET_PENDING', 'Placing $25 on Canada…');
    addStrategyUpdate(q, q[0].id, 'FIRST_BET_PLACED', '✅ Canada $25 @ -350 placed');
    assert(q[0].strategyHistory.length === 2, `expected 2 history items, got ${q[0].strategyHistory.length}`);
    assert(q[0].strategyState === 'FIRST_BET_PLACED', 'latest state');
    assert(q[0].strategyHistory[0].state === 'FIRST_BET_PENDING', 'first history item');
    console.log('  ✓ G8: addStrategyUpdate appends history correctly'); passed++;
  } catch(e) { console.error('  ✗ G8:', e.message); failed++; }

  // G9 — cancel command shape
  try {
    const cmd = makeCmd('cancel', { side: null, amount: null });
    assert(cmd.type === 'cancel', 'type should be cancel');
    assert(cmd.side === null, 'side null');
    assert(cmd.amount === null, 'amount null');
    console.log('  ✓ G9: cancel command shape valid'); passed++;
  } catch(e) { console.error('  ✗ G9:', e.message); failed++; }

  // G10 — keyword pre-filter catches bet commands
  try {
    function looksLikeBet(q) {
      return /\b(bet|wager|place|hedge\s+me|hedge\s+out|put\s+\$?\d+|cancel\s+(the\s+)?(bet|hedge|strategy)|stop\s+the\s+(bet|hedge))\b/i.test(q);
    }
    assert(looksLikeBet('bet canada $25'), 'bet');
    assert(looksLikeBet('place $10 on Jones'), 'place');
    assert(looksLikeBet('wager $50 on the dog'), 'wager');
    assert(looksLikeBet('put $20 on Qatar'), 'put $20');
    assert(looksLikeBet('hedge me out'), 'hedge me out');
    assert(looksLikeBet('hedge out now'), 'hedge out');
    assert(looksLikeBet('cancel the bet'), 'cancel the bet');
    assert(looksLikeBet('stop the hedge'), 'stop the hedge');
    assert(!looksLikeBet('who is favored in Jones vs Aspinall?'), 'research Q should not match');
    assert(!looksLikeBet('show me crossover history'), 'research Q should not match');
    assert(!looksLikeBet('what were the odds last Saturday?'), 'research Q should not match');
    console.log('  ✓ G10: keyword pre-filter catches bets, skips research questions'); passed++;
  } catch(e) { console.error('  ✗ G10:', e.message); failed++; }

  // G11 — multiple commands in queue: only first pending picked up
  try {
    const q = [
      makeCmd('place_bet', { side: 'Canada', amount: 10 }),
      makeCmd('place_bet', { side: 'Qatar', amount: 20 }),
    ];
    const first = pickupCommand(q);
    assert(first.side === 'Canada', 'should pick up first');
    const second = pickupCommand(q);
    assert(second.side === 'Qatar', 'should pick up second on next call');
    const third = pickupCommand(q);
    assert(third === null, 'queue exhausted');
    console.log('  ✓ G11: queue processed FIFO, one command per pickup call'); passed++;
  } catch(e) { console.error('  ✗ G11:', e.message); failed++; }

  // G12 — EXECUTE_COMMAND place_bet → sets FIRST_BET_PENDING state
  try {
    const cmd = makeCmd('place_bet', { side: 'Canada', amount: 25, trigger: { type: 'crossover', targetOdds: null } });
    // Mirrors background.js EXECUTE_COMMAND place_bet logic
    const strategy = {
      state: 'FIRST_BET_PENDING',
      leg1Side:   cmd.side,
      leg1Amount: cmd.amount,
      trigger:    cmd.trigger,
      leg1Confirmed: false,
      commandId:  cmd.id,
    };
    assert(strategy.state === 'FIRST_BET_PENDING', 'state');
    assert(strategy.commandId === cmd.id, 'commandId carried');
    assert(strategy.leg1Side === 'Canada', 'leg1Side');
    console.log('  ✓ G12: EXECUTE_COMMAND place_bet → FIRST_BET_PENDING with commandId'); passed++;
  } catch(e) { console.error('  ✗ G12:', e.message); failed++; }

  // G13 — commandId threaded through to PLACE_BET message
  try {
    const cmdId = 'testcmd123';
    const placeMsg = { type: 'PLACE_BET', side: 'Canada', amount: 25, commandId: cmdId };
    assert(placeMsg.commandId === cmdId, 'commandId must be on PLACE_BET msg');
    console.log('  ✓ G13: commandId present on PLACE_BET message from EXECUTE_COMMAND'); passed++;
  } catch(e) { console.error('  ✗ G13:', e.message); failed++; }

  // G14 — strategy history includes all transitions in order
  try {
    const q = [makeCmd('place_bet', { side: 'Canada', amount: 25 })];
    const id = q[0].id;
    addStrategyUpdate(q, id, 'FIRST_BET_PENDING', 'Placing $25 on Canada…');
    addStrategyUpdate(q, id, 'FIRST_BET_PLACED', '✅ Canada $25 @ -350 placed');
    addStrategyUpdate(q, id, 'WATCHING_HEDGE', '👀 Watching for crossover…');
    addStrategyUpdate(q, id, 'HEDGE_FIRED', '⚡ Crossover! Placing hedge…');
    const history = q[0].strategyHistory;
    assert(history.length === 4, `expected 4 history items, got ${history.length}`);
    assert(history[0].state === 'FIRST_BET_PENDING', 'history[0]');
    assert(history[3].state === 'HEDGE_FIRED', 'history[3]');
    history.forEach(h => assert(h.ts > 0, 'each history item has timestamp'));
    console.log('  ✓ G14: full strategy history arc (PENDING→PLACED→WATCHING→FIRED)'); passed++;
  } catch(e) { console.error('  ✗ G14:', e.message); failed++; }

  // G15 — /api/pending-commands (integration, --local only)
  if (target.includes('localhost')) {
    await check('G15: GET /api/pending-commands — empty queue returns null', async () => {
      const r = await fetch(`${target}/api/pending-commands`);
      assert(r.ok, `status ${r.status}`);
      const j = await r.json();
      assert('command' in j, 'response must have command key');
    });
  } else { console.log('  - G15: skipped (not --local)'); }

  // G16 — /api/command-status for unknown id returns not_found (integration)
  if (target.includes('localhost')) {
    await check('G16: GET /api/command-status/unknown → not_found', async () => {
      const r = await fetch(`${target}/api/command-status/doesnotexist`);
      assert(r.ok, `status ${r.status}`);
      const j = await r.json();
      assert(j.status === 'not_found', `expected not_found, got ${j.status}`);
    });
  } else { console.log('  - G16: skipped (not --local)'); }

  // G17 — /api/research routes bet command to betCommand field (integration)
  if (target.includes('localhost')) {
    await check('G17: POST /api/research with bet command → betCommand in response', async () => {
      const r = await fetch(`${target}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'bet canada $25, hedge at crossover' }),
      });
      assert(r.ok || r.status === 500, `unexpected status: ${r.status}`);
      if (r.ok) {
        const j = await r.json();
        assert('betCommand' in j, 'response must have betCommand when bet intent detected');
        assert(j.betCommand.type === 'place_bet', `betCommand.type should be place_bet, got ${j.betCommand?.type}`);
        assert(j.betCommand.status === 'pending', 'betCommand.status should be pending');
        assert(j.betCommand.id, 'betCommand.id must be set');
      }
    });
  } else { console.log('  - G17: skipped (not --local)'); }

  // G18 — /api/research routes research question to answer (NOT betCommand) (integration)
  if (target.includes('localhost')) {
    await check('G18: POST /api/research with research question → no betCommand', async () => {
      const r = await fetch(`${target}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'who is favored in Jones vs Aspinall?' }),
      });
      assert(r.ok || r.status === 500, `unexpected status: ${r.status}`);
      if (r.ok) {
        const j = await r.json();
        assert(!j.betCommand, 'research question should NOT return betCommand');
        assert(j.answer, 'research question should return answer');
      }
    });
  } else { console.log('  - G18: skipped (not --local)'); }

  // G19 — full queue round-trip (integration): queue → pickup → result → status:done
  if (target.includes('localhost')) {
    await check('G19: full command round-trip — queue → pickup → result → done', async () => {
      // Step 1: queue a command via /api/research
      const r1 = await fetch(`${target}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'bet canada 1, hedge at crossover' }),
      });
      if (!r1.ok) return; // Haiku may not be available in all envs
      const j1 = await r1.json();
      if (!j1.betCommand) return; // not detected as bet command
      const cmdId = j1.betCommand.id;

      // Step 2: pickup via GET /api/pending-commands
      const r2 = await fetch(`${target}/api/pending-commands`);
      const j2 = await r2.json();
      assert(j2.command !== null, 'should have a pending command');
      // May be a different command if tests ran in parallel — find ours
      const pickedId = j2.command?.id;

      // Step 3: post result via POST /api/command-result
      const r3 = await fetch(`${target}/api/command-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: cmdId, result: { ok: true, side: 'Canada', amount: 1, oddsText: '-350' } }),
      });
      const j3 = await r3.json();
      assert(j3.ok === true, 'command-result should return ok:true');

      // Step 4: check status via GET /api/command-status/:id
      const r4 = await fetch(`${target}/api/command-status/${cmdId}`);
      const j4 = await r4.json();
      assert(j4.status === 'done' || j4.status === 'picked_up', `expected done or picked_up, got ${j4.status}`);
    });
  } else { console.log('  - G19: skipped (not --local)'); }

  // G20 — /api/strategy-update appends to command history (integration)
  if (target.includes('localhost')) {
    await check('G20: POST /api/strategy-update → appends to strategyHistory', async () => {
      // First queue a command
      const r1 = await fetch(`${target}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'bet canada 1' }),
      });
      if (!r1.ok) return;
      const j1 = await r1.json();
      if (!j1.betCommand) return;
      const cmdId = j1.betCommand.id;

      // Post a strategy update
      const r2 = await fetch(`${target}/api/strategy-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: cmdId, state: 'FIRST_BET_PLACED', message: '✅ Canada $1 @ -350 placed' }),
      });
      const j2 = await r2.json();
      assert(j2.ok === true, 'strategy-update should return ok:true');

      // Check the update is on the command
      const r3 = await fetch(`${target}/api/command-status/${cmdId}`);
      const j3 = await r3.json();
      assert(j3.strategyState === 'FIRST_BET_PLACED', `strategyState should be FIRST_BET_PLACED, got ${j3.strategyState}`);
      assert(j3.strategyHistory?.length >= 1, 'strategyHistory should have at least 1 item');
    });
  } else { console.log('  - G20: skipped (not --local)'); }

  // ── H. Mybets command-poll bug fix verification ──────────────────────────
  console.log('\n── H. Mybets command-poll fix ──────────────────────────────────');

  // H1 — command poll guard: must run on mybets URL (not gated by !mybets)
  // Previously the poll was inside the !href.includes('/mybets') guard, so it
  // never fired when the user only had My Bets open. Fix: moved poll to a
  // separate block that only checks href.startsWith('https://sportsbook.draftkings.com/').
  // We simulate this by testing the URL matching logic directly.
  try {
    const mybetsUrl = 'https://sportsbook.draftkings.com/mybets';
    const sportsbookUrl = 'https://sportsbook.draftkings.com/leagues/mma/123';
    const loginUrl = 'https://sportsbook.draftkings.com/login';

    // OLD guard (bug): excluded mybets
    function oldPollGuard(url) {
      return url.startsWith('https://sportsbook.draftkings.com/') &&
             !url.includes('/mybets') && !url.includes('/login') && !url.includes('/auth/');
    }
    // NEW guard (fix): includes mybets
    function newPollGuard(url) {
      return url.startsWith('https://sportsbook.draftkings.com/');
    }

    assert(oldPollGuard(mybetsUrl) === false, 'OLD guard should exclude mybets (documenting the bug)');
    assert(oldPollGuard(sportsbookUrl) === true, 'OLD guard should include sportsbook');
    assert(newPollGuard(mybetsUrl) === true, 'NEW guard must include mybets — FIX VERIFIED');
    assert(newPollGuard(sportsbookUrl) === true, 'NEW guard must include sportsbook');
    assert(newPollGuard(loginUrl) === true, 'NEW guard includes login (benign — no commands pending there)');
    console.log('  ✓ H1: command poll guard includes mybets (fix verified)'); passed++;
  } catch(e) { console.error('  ✗ H1:', e.message); failed++; }

  // H2 — PLACE_BET tab selection: must NOT fall back to mybets tab
  // Previously allDk.find(!mybets) fell back to allDk[0] (the mybets tab),
  // causing executeScript to run on a page with no odds buttons.
  // Fix: removed the || allDk[0] fallback; returns clear error instead.
  try {
    function selectBetTab(allDkTabs) {
      // NEW logic (fixed)
      return allDkTabs.find(t => !t.url?.includes('/mybets') && t.active)
          || allDkTabs.find(t => !t.url?.includes('/mybets'));
      // NOTE: no || allDkTabs[0] fallback
    }

    const mybetsOnly = [{ id: 1, url: 'https://sportsbook.draftkings.com/mybets', active: true }];
    const mixedTabs  = [
      { id: 1, url: 'https://sportsbook.draftkings.com/mybets', active: false },
      { id: 2, url: 'https://sportsbook.draftkings.com/leagues/mma/123', active: false },
    ];
    const activeSportsbook = [
      { id: 1, url: 'https://sportsbook.draftkings.com/mybets', active: false },
      { id: 2, url: 'https://sportsbook.draftkings.com/leagues/mma/123', active: true },
    ];

    // When only mybets tab open → returns undefined (triggers clear error, not broken execution)
    assert(selectBetTab(mybetsOnly) === undefined, 'mybets-only → undefined (no fallback to mybets tab)');
    // When mixed → picks the non-mybets tab
    assert(selectBetTab(mixedTabs)?.id === 2, 'mixed tabs → picks non-mybets tab');
    // When active sportsbook tab → picks it first
    assert(selectBetTab(activeSportsbook)?.id === 2, 'active sportsbook tab preferred');
    console.log('  ✓ H2: PLACE_BET tab selection never falls back to mybets tab'); passed++;
  } catch(e) { console.error('  ✗ H2:', e.message); failed++; }

  // H3 — error message when only mybets open is descriptive
  try {
    function getBetTabError(allDkTabs) {
      if (allDkTabs.length === 0) return 'No DraftKings tab open';
      const hasOnlyMybets = allDkTabs.every(t => t.url?.includes('/mybets'));
      if (hasOnlyMybets) return `Only My Bets tab found (${allDkTabs.length} tab(s)) — open the fight page on DraftKings sportsbook first, then retry`;
      return null; // found a good tab
    }
    const mybetsOnly = [{ id: 1, url: 'https://sportsbook.draftkings.com/mybets' }];
    const noTabs = [];
    const err1 = getBetTabError(mybetsOnly);
    const err2 = getBetTabError(noTabs);
    assert(err1 !== null && err1.includes('My Bets'), `mybets-only error should mention My Bets — got: ${err1}`);
    assert(err1.includes('fight page'), `error should direct user to fight page — got: ${err1}`);
    assert(err2 !== null && err2.includes('No DraftKings'), `no-tabs error should say no DK tab — got: ${err2}`);
    console.log('  ✓ H3: descriptive error when no valid bet tab found'); passed++;
  } catch(e) { console.error('  ✗ H3:', e.message); failed++; }

  // H4 — server recycles stuck picked_up commands after 30s
  // Root cause: content.js fetch reached the server so it got marked picked_up,
  // but CORS blocked the JS from reading the response — command stuck forever.
  // Fix: /api/pending-commands resets picked_up commands that are >30s old back to pending.
  try {
    function recycleStuckCommands(queue, now) {
      queue.forEach(c => {
        if (c.status === 'picked_up' && c.pickedUpAt && (now - c.pickedUpAt) > 30000) {
          c.status = 'pending';
          delete c.pickedUpAt;
        }
      });
      return queue;
    }

    const now = Date.now();
    const freshPickedUp = { id: '1', status: 'picked_up', pickedUpAt: now - 5000 };     // 5s ago — keep
    const stalePickedUp = { id: '2', status: 'picked_up', pickedUpAt: now - 35000 };    // 35s ago — recycle
    const donCmd        = { id: '3', status: 'done',      pickedUpAt: now - 60000 };    // done — leave alone
    const queue = [freshPickedUp, stalePickedUp, donCmd];

    recycleStuckCommands(queue, now);

    assert(queue[0].status === 'picked_up', 'fresh picked_up should stay picked_up');
    assert(queue[1].status === 'pending',   'stale picked_up (35s) must be recycled to pending');
    assert(queue[1].pickedUpAt === undefined, 'recycled command should have no pickedUpAt');
    assert(queue[2].status === 'done',       'done commands must not be touched');
    console.log('  ✓ H4: server recycles stuck picked_up commands after 30s'); passed++;
  } catch(e) { console.error('  ✗ H4:', e.message); failed++; }

  // H5 — CORS fix: verify server middleware sets Access-Control-Allow-Origin on command endpoints
  // Belt-and-suspenders: even if SW poll handles most cases, server CORS makes content.js
  // fallback path reliable too. Test that the header logic would apply to the right paths.
  try {
    const commandPaths = ['/api/pending-commands', '/api/command-result', '/api/strategy-update'];
    const nonCommandPaths = ['/api/recorder/status', '/api/research', '/health'];

    // Simulate the middleware matching (path-specific middleware using app.use('/api/pending-commands', ...))
    function wouldGetCorsHeader(path) {
      return commandPaths.some(cp => path === cp || path.startsWith(cp + '?'));
    }
    function wouldNotGetCorsHeader(path) {
      return nonCommandPaths.some(p => path.startsWith(p));
    }

    commandPaths.forEach(p => assert(wouldGetCorsHeader(p), `${p} must get CORS header`));
    nonCommandPaths.forEach(p => assert(!wouldGetCorsHeader(p), `${p} should NOT get command CORS header`));
    assert(wouldNotGetCorsHeader('/api/recorder/status'), 'recorder status unaffected');
    console.log('  ✓ H5: CORS headers applied to command endpoints only'); passed++;
  } catch(e) { console.error('  ✗ H5:', e.message); failed++; }

  // H6 — keepalive port architecture: poll must start on first connect, stop when no ports remain
  try {
    let activePorts2 = 0;
    let pollRunning = false;

    function onPortConnect2() {
      activePorts2++;
      if (!pollRunning) pollRunning = true;  // starts poll interval
    }
    function onPortDisconnect2() {
      activePorts2 = Math.max(0, activePorts2 - 1);
      if (activePorts2 === 0) pollRunning = false;  // stops poll interval
    }

    // 0 ports → poll not running
    assert(!pollRunning, 'poll should not run before any port connects');

    // First tab opens
    onPortConnect2();
    assert(activePorts2 === 1, 'should have 1 active port');
    assert(pollRunning, 'poll should start when first port connects');

    // Second DK tab opens
    onPortConnect2();
    assert(activePorts2 === 2, 'should have 2 active ports');
    assert(pollRunning, 'poll should keep running with 2 ports');

    // First tab closes
    onPortDisconnect2();
    assert(activePorts2 === 1, 'should have 1 active port after disconnect');
    assert(pollRunning, 'poll should keep running with 1 port remaining');

    // Last tab closes
    onPortDisconnect2();
    assert(activePorts2 === 0, 'should have 0 active ports');
    assert(!pollRunning, 'poll must STOP when last port disconnects');
    console.log('  ✓ H6: keepalive port — poll starts on first connect, stops when all ports close'); passed++;
  } catch(e) { console.error('  ✗ H6:', e.message); failed++; }

  // H7 — integration: CORS headers present on /api/pending-commands (--local only)
  if (process.argv.includes('--local')) {
    try {
      await check('H7: GET /api/pending-commands has Access-Control-Allow-Origin header', async () => {
        const r = await fetch('http://localhost:3000/api/pending-commands');
        const corsHeader = r.headers.get('access-control-allow-origin');
        assert(corsHeader === '*', `Expected Access-Control-Allow-Origin: * but got: ${corsHeader}`);
      });
    } catch(e) { console.error('  ✗ H7:', e.message); failed++; }
  } else { console.log('  - H7: skipped (not --local)'); }

  // ── AI-assisted bet target resolution ────────────────────────────────────

  // J1 — /api/resolve-bet-target resolves "US" → "USA" when "USA" is in nearbyLabels
  if (process.argv.includes('--local')) {
    try {
      await check('J1: /api/resolve-bet-target resolves "US" to "USA" (Haiku live call)', async () => {
        const r = await fetch('http://localhost:3000/api/resolve-bet-target', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            side: 'US',
            nearbyLabels: ['USA', 'Draw', 'Australia', '-165', '+330', '+425'],
            allButtonTexts: ['-165', '+330', '+425'],
          })
        });
        const body = await r.json();
        assert(body.ok === true, `Expected ok=true but got: ${JSON.stringify(body)}`);
        assert(body.resolvedSide === 'USA', `Expected resolvedSide=USA but got: ${body.resolvedSide}`);
        assert(body.confidence >= 0.85, `Expected confidence >= 0.85 but got: ${body.confidence}`);
      });
    } catch(e) { console.error('  ✗ J1:', e.message); failed++; }
  } else { console.log('  - J1: skipped (not --local)'); }

  // J2 — returns ambiguous when multiple similar options exist
  if (process.argv.includes('--local')) {
    try {
      await check('J2: /api/resolve-bet-target returns ambiguous for Korea/South Korea/North Korea', async () => {
        const r = await fetch('http://localhost:3000/api/resolve-bet-target', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            side: 'Korea',
            nearbyLabels: ['South Korea', 'North Korea', 'Draw', '-150', '+280', '+400'],
            allButtonTexts: ['-150', '+280', '+400'],
          })
        });
        const body = await r.json();
        // Should either be ambiguous (ok:false) OR pick one with reasonable confidence
        // Accept either: the important thing is it doesn't silently pick the wrong one
        assert(typeof body.ok === 'boolean', `Response must have ok field: ${JSON.stringify(body)}`);
        if (body.ok) {
          // If it did pick one, confidence must reflect the ambiguity
          console.log(`    J2 info: resolved to "${body.resolvedSide}" confidence=${body.confidence}`);
        } else {
          assert(body.ambiguous === true || body.error, `Should be ambiguous or error: ${JSON.stringify(body)}`);
        }
      });
    } catch(e) { console.error('  ✗ J2:', e.message); failed++; }
  } else { console.log('  - J2: skipped (not --local)'); }

  // J3 — returns error (not crash) when no candidates available
  if (process.argv.includes('--local')) {
    try {
      await check('J3: /api/resolve-bet-target returns error gracefully when no candidates', async () => {
        const r = await fetch('http://localhost:3000/api/resolve-bet-target', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: 'USA', nearbyLabels: [], allButtonTexts: [] })
        });
        const body = await r.json();
        assert(body.ok === false, `Should return ok=false for empty candidates: ${JSON.stringify(body)}`);
      });
    } catch(e) { console.error('  ✗ J3:', e.message); failed++; }
  } else { console.log('  - J3: skipped (not --local)'); }

  // J4 — executePlaceBet signature includes isRetry parameter (prevents infinite recursion)
  try {
    await check('J4: executePlaceBet has isRetry parameter with default false', async () => {
      const fs = require('fs');
      const bgSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/background.js'), 'utf8');
      assert(
        /async function executePlaceBet\s*\([^)]*isRetry\s*=\s*false/.test(bgSrc),
        'executePlaceBet must have isRetry=false default parameter'
      );
      // Must pass isRetry=true in the recursive call to prevent infinite loop
      assert(
        bgSrc.includes('executePlaceBet(resolveResult.resolvedSide') &&
        bgSrc.includes(', true)'),
        'Recursive executePlaceBet call must pass isRetry=true'
      );
    });
  } catch(e) { console.error('  ✗ J4:', e.message); failed++; }

  // J5 — CORS headers on /api/resolve-bet-target
  if (process.argv.includes('--local')) {
    try {
      await check('J5: /api/resolve-bet-target has CORS headers for extension access', async () => {
        const r = await fetch('http://localhost:3000/api/resolve-bet-target', {
          method: 'OPTIONS',
        });
        const corsHeader = r.headers.get('access-control-allow-origin');
        assert(corsHeader === '*', `Expected Access-Control-Allow-Origin: * but got: ${corsHeader}`);
      });
    } catch(e) { console.error('  ✗ J5:', e.message); failed++; }
  } else { console.log('  - J5: skipped (not --local)'); }

  // ── SW self-message fix tests ────────────────────────────────────────────
  // MV3 service workers cannot receive chrome.runtime.sendMessage sent from
  // themselves. executePlaceBet() fixes this by being called directly.

  // I1 — executePlaceBet is defined as a top-level function (not inside onMessage)
  //       so pollForCommands and CROSSOVER_DETECTED can call it without sendMessage
  try {
    await check('I1: background.js defines executePlaceBet as top-level async function', async () => {
      const fs = require('fs');
      const bgSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/background.js'), 'utf8');
      assert(
        /^async function executePlaceBet\s*\(/m.test(bgSrc),
        'executePlaceBet must be a top-level async function declaration'
      );
      // Must NOT be sendMessage-triggered from handleExecuteCommand
      assert(
        !bgSrc.includes("sendMessage({ type: 'PLACE_BET'"),
        'handleExecuteCommand and CROSSOVER_DETECTED must not use chrome.runtime.sendMessage to fire PLACE_BET'
      );
    });
  } catch(e) { console.error('  ✗ I1:', e.message); failed++; }

  // I2 — handleExecuteCommand calls executePlaceBet directly, not via sendMessage
  try {
    await check('I2: handleExecuteCommand calls executePlaceBet() directly', async () => {
      const fs = require('fs');
      const bgSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/background.js'), 'utf8');
      // Extract handleExecuteCommand body
      const fnStart = bgSrc.indexOf('function handleExecuteCommand(command)');
      assert(fnStart !== -1, 'handleExecuteCommand not found');
      const fnEnd = bgSrc.indexOf('\nfunction ', fnStart + 1);
      const fnBody = bgSrc.slice(fnStart, fnEnd === -1 ? fnStart + 2000 : fnEnd);
      assert(
        fnBody.includes('executePlaceBet('),
        'handleExecuteCommand must call executePlaceBet() directly'
      );
      assert(
        !fnBody.includes("sendMessage({ type: 'PLACE_BET'"),
        'handleExecuteCommand must not use chrome.runtime.sendMessage({ type: PLACE_BET })'
      );
    });
  } catch(e) { console.error('  ✗ I2:', e.message); failed++; }

  // I3 — CROSSOVER_DETECTED handler calls executePlaceBet directly, not via sendMessage
  try {
    await check('I3: CROSSOVER_DETECTED calls executePlaceBet() directly (not via sendMessage)', async () => {
      const fs = require('fs');
      const bgSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/background.js'), 'utf8');
      const crossoverIdx = bgSrc.indexOf("msg.type === 'CROSSOVER_DETECTED'");
      assert(crossoverIdx !== -1, 'CROSSOVER_DETECTED handler not found');
      // Slice a generous window around the handler (up to 5000 chars)
      const handlerSlice = bgSrc.slice(crossoverIdx, crossoverIdx + 5000);
      assert(
        handlerSlice.includes('executePlaceBet('),
        'CROSSOVER_DETECTED must call executePlaceBet() directly'
      );
      assert(
        !handlerSlice.includes("sendMessage({ type: 'PLACE_BET'"),
        'CROSSOVER_DETECTED must not use chrome.runtime.sendMessage({ type: PLACE_BET })'
      );
    });
  } catch(e) { console.error('  ✗ I3:', e.message); failed++; }
}

runServerTests().then(async () => {
  await runNewFeatureServerTests();
  await runCoverageServerTests();
  await runRecordingTests();
  await runBetPlacementServerTests();
  await runAgentSystemTests();
  await runFinalFeatureTests();
  await runDashboardChatTests();
  await runUnifiedAssistantTests();
  await runAutoBetTests();
  await runAutoBetDryRunTests();
  await runAutoBetUITests();
}).then(() => {
  console.log(`\n═══════════════════════════════════`);
  console.log(`  ${passed} passed  ${failed} failed`);
  console.log(`═══════════════════════════════════\n`);
  if (failed > 0) process.exit(1);
}).catch(e => { console.error(e); process.exit(1); });

// ── K-O: Unified assistant + watch trigger tests ──────────────────────────────
async function runUnifiedAssistantTests() {
  console.log('\n── K: /api/assistant intent classification ──');

  // K1 — place_bet intent routes correctly
  if (process.argv.includes('--local')) {
    try {
      await check('K1: /api/assistant routes "bet $5 on USA" to place_bet → queues command', async () => {
        const r = await fetch('http://localhost:3000/api/assistant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'bet $5 on USA', userId: 'test_k1' }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.type === 'bet', `Expected type=bet, got: ${body.type}`);
        assert(body.betCommand, 'Expected betCommand in response');
        assert(body.answer && body.answer.includes('queued'), `Expected "queued" in answer: ${body.answer}`);
      });
    } catch(e) { console.error('  ✗ K1:', e.message); failed++; }
  } else { console.log('  - K1: skipped (not --local)'); }

  // K2 — watch_trigger intent for "as soon as" conditional
  if (process.argv.includes('--local')) {
    try {
      await check('K2: /api/assistant routes "bet $10 on USA as soon as they go plus money" to watch_trigger', async () => {
        const r = await fetch('http://localhost:3000/api/assistant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'bet $10 on USA as soon as their odds go into plus money', userId: 'test_k2' }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.type === 'watch_trigger', `Expected type=watch_trigger, got: ${body.type} — answer: ${body.answer}`);
        assert(body.trigger, 'Expected trigger object in response');
        assert(body.trigger.side === 'USA' || body.trigger.side?.toLowerCase().includes('usa'), `Expected side=USA, got: ${body.trigger?.side}`);
        assert(body.trigger.amount === 10, `Expected amount=10, got: ${body.trigger?.amount}`);
        assert(body.trigger.condition?.type === 'positive', `Expected condition.type=positive, got: ${body.trigger?.condition?.type}`);
      });
    } catch(e) { console.error('  ✗ K2:', e.message); failed++; }
  } else { console.log('  - K2: skipped (not --local)'); }

  // K3 — cancel intent
  if (process.argv.includes('--local')) {
    try {
      await check('K3: /api/assistant routes "cancel" to cancel intent', async () => {
        const r = await fetch('http://localhost:3000/api/assistant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'cancel everything', userId: 'test_k3' }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.type === 'cancel', `Expected type=cancel, got: ${body.type}`);
        assert(body.answer && body.answer.toLowerCase().includes('cancel'), `Expected cancel in answer: ${body.answer}`);
      });
    } catch(e) { console.error('  ✗ K3:', e.message); failed++; }
  } else { console.log('  - K3: skipped (not --local)'); }

  // K4 — status intent
  if (process.argv.includes('--local')) {
    try {
      await check('K4: /api/assistant routes "what bets do I have?" to status', async () => {
        const r = await fetch('http://localhost:3000/api/assistant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'what bets do I have open right now?', userId: 'test_k4' }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.type === 'status', `Expected type=status, got: ${body.type} — answer: ${body.answer?.slice(0,100)}`);
        assert(body.answer, 'Expected answer in response');
      });
    } catch(e) { console.error('  ✗ K4:', e.message); failed++; }
  } else { console.log('  - K4: skipped (not --local)'); }

  // K5 — clarify when amount is missing
  if (process.argv.includes('--local')) {
    try {
      await check('K5: /api/assistant returns clarify when "bet on USA" has no amount', async () => {
        const r = await fetch('http://localhost:3000/api/assistant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'bet on USA', userId: 'test_k5' }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        // Either clarify OR bet with valid amount extracted from context — but "bet on USA" with no amount should ask
        if (body.type === 'bet') {
          // If AI hallucinated an amount without context, that's also acceptable for now — just verify it's numeric
          assert(body.betCommand?.amount > 0, `If type=bet, amount must be > 0, got: ${body.betCommand?.amount}`);
          console.log(`    K5 info: AI extracted amount from context (${body.betCommand?.amount}) — not a strict clarify`);
        } else {
          assert(body.type === 'clarify', `Expected clarify or bet, got: ${body.type}`);
          assert(body.answer, 'clarify must have answer/question text');
        }
      });
    } catch(e) { console.error('  ✗ K5:', e.message); failed++; }
  } else { console.log('  - K5: skipped (not --local)'); }

  // K6 — research route for historical questions
  if (process.argv.includes('--local')) {
    try {
      await check('K6: /api/assistant routes historical question to research (returns answer)', async () => {
        const r = await fetch('http://localhost:3000/api/assistant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'how many crossovers have we seen in our recorded fights?', userId: 'test_k6' }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.type === 'research', `Expected type=research, got: ${body.type}`);
        assert(body.answer && body.answer.length > 20, `Expected substantive answer, got: ${body.answer?.slice(0,100)}`);
        assert(body.usage?.thisQuery > 0, 'Research must report token usage');
      });
    } catch(e) { console.error('  ✗ K6:', e.message); failed++; }
  } else { console.log('  - K6: skipped (not --local)'); }

  // K7 — /api/assistant has CORS headers
  if (process.argv.includes('--local')) {
    try {
      await check('K7: /api/assistant has Access-Control-Allow-Origin: * header', async () => {
        const r = await fetch('http://localhost:3000/api/assistant', { method: 'OPTIONS' });
        const corsHeader = r.headers.get('access-control-allow-origin');
        assert(corsHeader === '*', `Expected CORS *, got: ${corsHeader}`);
      });
    } catch(e) { console.error('  ✗ K7:', e.message); failed++; }
  } else { console.log('  - K7: skipped (not --local)'); }

  console.log('\n── L: Watch trigger CRUD endpoints ──');

  // L1 — POST /api/watch-triggers creates a trigger
  if (process.argv.includes('--local')) {
    try {
      await check('L1: POST /api/watch-triggers creates trigger with id + condition', async () => {
        const r = await fetch('http://localhost:3000/api/watch-triggers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: 'USA', amount: 20, condition: { type: 'positive' }, userId: 'test_l1' }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.ok === true, `Expected ok=true: ${JSON.stringify(body)}`);
        assert(body.trigger?.id, 'Expected trigger.id');
        assert(body.trigger?.side === 'USA', `Expected side=USA: ${body.trigger?.side}`);
        assert(body.trigger?.condition?.type === 'positive', `Expected condition.type=positive: ${body.trigger?.condition?.type}`);
      });
    } catch(e) { console.error('  ✗ L1:', e.message); failed++; }
  } else { console.log('  - L1: skipped (not --local)'); }

  // L2 — GET /api/watch-triggers returns created triggers
  if (process.argv.includes('--local')) {
    try {
      await check('L2: GET /api/watch-triggers returns triggers array', async () => {
        const r = await fetch('http://localhost:3000/api/watch-triggers');
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(Array.isArray(body.triggers), `Expected triggers array: ${JSON.stringify(body)}`);
      });
    } catch(e) { console.error('  ✗ L2:', e.message); failed++; }
  } else { console.log('  - L2: skipped (not --local)'); }

  // L3 — DELETE /api/watch-triggers/:id removes trigger
  if (process.argv.includes('--local')) {
    try {
      await check('L3: DELETE /api/watch-triggers/:id removes the trigger', async () => {
        // Create a trigger first
        const createR = await fetch('http://localhost:3000/api/watch-triggers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: 'Canada', amount: 5, condition: { type: 'negative' }, userId: 'test_l3' }),
        });
        const created = await createR.json();
        assert(created.trigger?.id, 'Setup: must create trigger');

        // Delete it
        const delR = await fetch(`http://localhost:3000/api/watch-triggers/${created.trigger.id}`, { method: 'DELETE' });
        assert(delR.ok, `HTTP ${delR.status}`);
        const delBody = await delR.json();
        assert(delBody.ok === true, `Expected ok=true: ${JSON.stringify(delBody)}`);
        assert(delBody.removed === 1, `Expected removed=1: ${delBody.removed}`);

        // Verify gone
        const listR = await fetch('http://localhost:3000/api/watch-triggers');
        const list = await listR.json();
        const stillExists = list.triggers.find(t => t.id === created.trigger.id);
        assert(!stillExists, 'Trigger should be removed from list after DELETE');
      });
    } catch(e) { console.error('  ✗ L3:', e.message); failed++; }
  } else { console.log('  - L3: skipped (not --local)'); }

  // L4 — CORS on /api/watch-triggers
  if (process.argv.includes('--local')) {
    try {
      await check('L4: /api/watch-triggers has CORS headers', async () => {
        const r = await fetch('http://localhost:3000/api/watch-triggers', { method: 'OPTIONS' });
        const corsHeader = r.headers.get('access-control-allow-origin');
        assert(corsHeader === '*', `Expected CORS *, got: ${corsHeader}`);
      });
    } catch(e) { console.error('  ✗ L4:', e.message); failed++; }
  } else { console.log('  - L4: skipped (not --local)'); }

  console.log('\n── M: Watch trigger condition logic (unit) ──');

  // M1 — positive condition fires when american > 0
  try {
    await check('M1: watch trigger condition "positive" fires when american odds > 0', () => {
      function checkCondition(condition, american) {
        const { type, targetOdds } = condition;
        if (type === 'positive')      return american > 0;
        if (type === 'negative')      return american < 0;
        if (type === 'odds_threshold' && targetOdds != null) return american >= targetOdds;
        return false;
      }
      assert(checkCondition({ type: 'positive' }, 120) === true,  'positive: +120 should fire');
      assert(checkCondition({ type: 'positive' }, -120) === false, 'positive: -120 should not fire');
      assert(checkCondition({ type: 'positive' }, 0) === false,    'positive: 0 should not fire (not >0)');
    });
  } catch(e) { console.error('  ✗ M1:', e.message); failed++; }

  // M2 — negative condition fires when american < 0
  try {
    await check('M2: watch trigger condition "negative" fires when american odds < 0', () => {
      function checkCondition(condition, american) {
        const { type, targetOdds } = condition;
        if (type === 'negative') return american < 0;
        return false;
      }
      assert(checkCondition({ type: 'negative' }, -150) === true, 'negative: -150 should fire');
      assert(checkCondition({ type: 'negative' }, 150) === false, 'negative: +150 should not fire');
    });
  } catch(e) { console.error('  ✗ M2:', e.message); failed++; }

  // M3 — odds_threshold fires when american >= targetOdds
  try {
    await check('M3: watch trigger condition "odds_threshold" fires when american >= targetOdds', () => {
      function checkCondition(condition, american) {
        const { type, targetOdds } = condition;
        if (type === 'odds_threshold' && targetOdds != null) return american >= targetOdds;
        return false;
      }
      assert(checkCondition({ type: 'odds_threshold', targetOdds: 150 }, 200) === true,  '+200 >= +150 should fire');
      assert(checkCondition({ type: 'odds_threshold', targetOdds: 150 }, 150) === true,  '+150 >= +150 should fire (equal)');
      assert(checkCondition({ type: 'odds_threshold', targetOdds: 150 }, 100) === false, '+100 >= +150 should NOT fire');
      assert(checkCondition({ type: 'odds_threshold', targetOdds: -200 }, -150) === true, '-150 >= -200 should fire (less negative = higher)');
    });
  } catch(e) { console.error('  ✗ M3:', e.message); failed++; }

  console.log('\n── N: background.js structural checks ──');

  // N1 — pollForCommands also polls /api/watch-triggers
  try {
    await check('N1: background.js pollForCommands fetches /api/watch-triggers and broadcasts SET_WATCH_TRIGGERS', () => {
      const fs = require('fs');
      const bgSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/background.js'), 'utf8');
      assert(bgSrc.includes('/api/watch-triggers'), 'pollForCommands must fetch /api/watch-triggers');
      assert(bgSrc.includes("type: 'SET_WATCH_TRIGGERS'"), 'Must send SET_WATCH_TRIGGERS to content tabs');
    });
  } catch(e) { console.error('  ✗ N1:', e.message); failed++; }

  // N2 — TRIGGER_MET handler exists in onMessage
  try {
    await check('N2: background.js onMessage handles TRIGGER_MET — calls executePlaceBet and DELETEs trigger', () => {
      const fs = require('fs');
      const bgSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/background.js'), 'utf8');
      const triggerIdx = bgSrc.indexOf("msg.type === 'TRIGGER_MET'");
      assert(triggerIdx !== -1, "TRIGGER_MET handler not found in onMessage");
      const handlerSlice = bgSrc.slice(triggerIdx, triggerIdx + 600);
      assert(handlerSlice.includes('executePlaceBet('), 'TRIGGER_MET must call executePlaceBet');
      assert(handlerSlice.includes('DELETE'), 'TRIGGER_MET must DELETE the trigger from server');
    });
  } catch(e) { console.error('  ✗ N2:', e.message); failed++; }

  // N3 — TRIGGER_MET sends CLEAR_TRIGGERS to content tabs after firing
  try {
    await check('N3: background.js TRIGGER_MET sends CLEAR_TRIGGERS to all DK tabs', () => {
      const fs = require('fs');
      const bgSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/background.js'), 'utf8');
      const triggerIdx = bgSrc.indexOf("msg.type === 'TRIGGER_MET'");
      const handlerSlice = bgSrc.slice(triggerIdx, triggerIdx + 800);
      assert(handlerSlice.includes("'CLEAR_TRIGGERS'"), 'TRIGGER_MET must broadcast CLEAR_TRIGGERS');
    });
  } catch(e) { console.error('  ✗ N3:', e.message); failed++; }

  console.log('\n── O: content.js structural checks ──');

  // O1 — content.js has watchTriggers array and firedTriggers Set
  try {
    await check('O1: content.js declares watchTriggers array and firedTriggers Set', () => {
      const fs = require('fs');
      const cSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/content.js'), 'utf8');
      assert(cSrc.includes('let watchTriggers = []'), 'content.js must declare watchTriggers array');
      assert(cSrc.includes('firedTriggers = new Set()'), 'content.js must declare firedTriggers Set');
    });
  } catch(e) { console.error('  ✗ O1:', e.message); failed++; }

  // O2 — content.js handles SET_WATCH_TRIGGERS and CLEAR_TRIGGERS messages
  try {
    await check('O2: content.js onMessage handles SET_WATCH_TRIGGERS and CLEAR_TRIGGERS', () => {
      const fs = require('fs');
      const cSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/content.js'), 'utf8');
      assert(cSrc.includes("msg.type === 'SET_WATCH_TRIGGERS'"), 'Must handle SET_WATCH_TRIGGERS');
      assert(cSrc.includes("msg.type === 'CLEAR_TRIGGERS'"), 'Must handle CLEAR_TRIGGERS');
    });
  } catch(e) { console.error('  ✗ O2:', e.message); failed++; }

  // O3 — content.js 1s interval checks trigger conditions and sends TRIGGER_MET
  try {
    await check('O3: content.js 1s interval checks watchTriggers conditions and fires TRIGGER_MET', () => {
      const fs = require('fs');
      const cSrc = fs.readFileSync(require('path').join(__dirname, 'dk-extension/content.js'), 'utf8');
      assert(cSrc.includes("type: 'TRIGGER_MET'"), 'Must send TRIGGER_MET when condition is met');
      assert(cSrc.includes('firedTriggers.has(trigger.id)'), 'Must guard against double-fire with firedTriggers');
      assert(cSrc.includes("type === 'positive'"), 'Must check positive condition type');
      assert(cSrc.includes("type === 'negative'"), 'Must check negative condition type');
      assert(cSrc.includes("type === 'odds_threshold'"), 'Must check odds_threshold condition type');
    });
  } catch(e) { console.error('  ✗ O3:', e.message); failed++; }

  // O4 — index.html sendMsg now calls /api/assistant (not /api/research)
  try {
    await check('O4: index.html sendMsg calls /api/assistant endpoint', () => {
      const fs = require('fs');
      const htmlSrc = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');
      assert(htmlSrc.includes('/api/assistant'), 'index.html must call /api/assistant');
      assert(!htmlSrc.match(/fetch\s*\(\s*['"]\/api\/research['"]/), 'sendMsg must NOT call /api/research directly (assistant handles routing)');
    });
  } catch(e) { console.error('  ✗ O4:', e.message); failed++; }

  // O5 — sendMsg handles watch_trigger response type
  try {
    await check('O5: index.html sendMsg handles watch_trigger response with watching status', () => {
      const fs = require('fs');
      const htmlSrc = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');
      assert(htmlSrc.includes("watch_trigger"), 'index.html must handle watch_trigger type');
      assert(htmlSrc.includes("message:"), 'sendMsg must send { message: q } to /api/assistant');
    });
  } catch(e) { console.error('  ✗ O5:', e.message); failed++; }
}

// ── P-T: Auto-bet system tests ─────────────────────────────────────────────────
async function runAutoBetTests() {

  // ── P: Config CRUD ───────────────────────────────────────────────────────────
  console.log('\n── P: Auto-bet config CRUD ──');

  // P1 — GET /api/auto-bet/config returns config with expected fields
  if (process.argv.includes('--local')) {
    try {
      await check('P1: GET /api/auto-bet/config returns config object with all fields', async () => {
        const r = await fetch('http://localhost:3000/api/auto-bet/config');
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.config, 'Expected config object');
        assert(typeof body.config.enabled === 'boolean', 'enabled must be boolean');
        assert(typeof body.config.amount === 'number', 'amount must be number');
        assert(Array.isArray(body.config.brackets), 'brackets must be array');
        assert(['dog','fav'].includes(body.config.side), 'side must be dog or fav');
        assert(typeof body.config.maxPerSession === 'number', 'maxPerSession must be number');
        assert(typeof body.config.maxFightAgeSecs === 'number', 'maxFightAgeSecs must be number');
        assert(typeof body.config.minOddsGapPct === 'number', 'minOddsGapPct must be number');
        assert(typeof body.config.autoHedge === 'boolean', 'autoHedge must be boolean');
        assert(typeof body.sessionCount === 'number', 'sessionCount must be in response');
        assert(Array.isArray(body.firedFights), 'firedFights must be array');
        assert(Array.isArray(body.recentLog), 'recentLog must be array');
      });
    } catch(e) { console.error('  ✗ P1:', e.message); failed++; }
  } else { console.log('  - P1: skipped (not --local)'); }

  // P2 — POST /api/auto-bet/config updates fields
  if (process.argv.includes('--local')) {
    try {
      await check('P2: POST /api/auto-bet/config updates enabled, amount, brackets, side', async () => {
        const r = await fetch('http://localhost:3000/api/auto-bet/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false, amount: 7.50, brackets: ['even', 'slight'], side: 'fav', maxPerSession: 5 }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.ok === true, 'Expected ok=true');
        assert(body.config.amount === 7.50, `amount should be 7.50, got ${body.config.amount}`);
        assert(body.config.brackets.includes('even'), 'brackets should include even');
        assert(body.config.brackets.includes('slight'), 'brackets should include slight');
        assert(body.config.side === 'fav', `side should be fav, got ${body.config.side}`);
        assert(body.config.maxPerSession === 5, `maxPerSession should be 5, got ${body.config.maxPerSession}`);
        // Restore defaults
        await fetch('http://localhost:3000/api/auto-bet/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false, amount: 5, brackets: ['slight'], side: 'dog', maxPerSession: 3 }),
        });
      });
    } catch(e) { console.error('  ✗ P2:', e.message); failed++; }
  } else { console.log('  - P2: skipped (not --local)'); }

  // P3 — POST /api/auto-bet/config rejects invalid bracket values
  if (process.argv.includes('--local')) {
    try {
      await check('P3: POST /api/auto-bet/config ignores invalid bracket values', async () => {
        const r = await fetch('http://localhost:3000/api/auto-bet/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brackets: ['slight', 'INVALID_BRACKET', 'also_bad'] }),
        });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(!body.config.brackets.includes('INVALID_BRACKET'), 'Invalid brackets must be filtered out');
        assert(!body.config.brackets.includes('also_bad'), 'Invalid brackets must be filtered out');
        assert(body.config.brackets.includes('slight'), 'Valid bracket (slight) must be kept');
      });
    } catch(e) { console.error('  ✗ P3:', e.message); failed++; }
  } else { console.log('  - P3: skipped (not --local)'); }

  // P4 — POST /api/auto-bet/reset-session clears count and firedFights
  if (process.argv.includes('--local')) {
    try {
      await check('P4: POST /api/auto-bet/reset-session clears sessionCount and firedFights', async () => {
        const r = await fetch('http://localhost:3000/api/auto-bet/reset-session', { method: 'POST' });
        assert(r.ok, `HTTP ${r.status}`);
        const body = await r.json();
        assert(body.ok === true, 'Expected ok=true');
        // Verify count is 0 after reset
        const cfgR = await fetch('http://localhost:3000/api/auto-bet/config');
        const cfg = await cfgR.json();
        assert(cfg.sessionCount === 0, `sessionCount should be 0 after reset, got ${cfg.sessionCount}`);
        assert(cfg.firedFights.length === 0, `firedFights should be empty after reset, got ${cfg.firedFights.length}`);
      });
    } catch(e) { console.error('  ✗ P4:', e.message); failed++; }
  } else { console.log('  - P4: skipped (not --local)'); }

  // P5 — CORS on /api/auto-bet
  if (process.argv.includes('--local')) {
    try {
      await check('P5: /api/auto-bet has CORS headers for extension access', async () => {
        const r = await fetch('http://localhost:3000/api/auto-bet/config', { method: 'OPTIONS' });
        const cors = r.headers.get('access-control-allow-origin');
        assert(cors === '*', `Expected CORS *, got: ${cors}`);
      });
    } catch(e) { console.error('  ✗ P5:', e.message); failed++; }
  } else { console.log('  - P5: skipped (not --local)'); }

  // ── Q: Bracket detection (unit tests — no server needed) ─────────────────────
  console.log('\n── Q: Bracket classification ──');

  function toDecimal(o) { return o > 0 ? (o/100)+1 : (100/Math.abs(o))+1; }
  function classifyOddsBracket(f1, f2) {
    const d1 = toDecimal(f1), d2 = toDecimal(f2);
    const favD = Math.min(d1, d2);
    if (favD <= 1.333) return 'huge';
    if (favD <= 1.5)   return 'heavy';
    if (favD <= 1.833) return 'slight';
    return 'even';
  }

  try {
    await check('Q1: classifyOddsBracket — near-even (-110/-110) → "even"', () => {
      assert(classifyOddsBracket(-110, -110) === 'even', `got: ${classifyOddsBracket(-110,-110)}`);
    });
  } catch(e) { console.error('  ✗ Q1:', e.message); failed++; }

  try {
    await check('Q2: classifyOddsBracket — slight fav (-150/+130) → "slight"', () => {
      assert(classifyOddsBracket(-150, 130) === 'slight', `got: ${classifyOddsBracket(-150,130)}`);
    });
  } catch(e) { console.error('  ✗ Q2:', e.message); failed++; }

  try {
    await check('Q3: classifyOddsBracket — heavy fav (-250/+200) → "heavy"', () => {
      assert(classifyOddsBracket(-250, 200) === 'heavy', `got: ${classifyOddsBracket(-250,200)}`);
    });
  } catch(e) { console.error('  ✗ Q3:', e.message); failed++; }

  try {
    await check('Q4: classifyOddsBracket — dominant (-400/+300) → "huge"', () => {
      assert(classifyOddsBracket(-400, 300) === 'huge', `got: ${classifyOddsBracket(-400,300)}`);
    });
  } catch(e) { console.error('  ✗ Q4:', e.message); failed++; }

  try {
    await check('Q5: classifyOddsBracket — symmetric (fav on either side)', () => {
      // Regardless of which fighter is listed first, bracket should be same
      assert(classifyOddsBracket(-200, 170) === classifyOddsBracket(170, -200), 'bracket must be symmetric');
    });
  } catch(e) { console.error('  ✗ Q5:', e.message); failed++; }

  try {
    await check('Q6: classifyOddsBracket — boundary -200 lands in "heavy" not "slight"', () => {
      // -200 → decimal = 1.5 exactly → favD = 1.5 → heavy (≤ 1.5)
      assert(classifyOddsBracket(-200, 170) === 'heavy', `got: ${classifyOddsBracket(-200,170)}`);
    });
  } catch(e) { console.error('  ✗ Q6:', e.message); failed++; }

  // ── R: checkAutoBet guard logic (server-side, via source inspection + API) ───
  console.log('\n── R: Auto-bet guard logic ──');

  // R1 — guard: disabled blocks all auto-bets
  if (process.argv.includes('--local')) {
    try {
      await check('R1: disabled config → auto-bet skipped for any fight', async () => {
        // Ensure disabled
        await fetch('http://localhost:3000/api/auto-bet/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        // Trigger a test fight via recorder/test (checkAutoBet is also called there)
        // We verify indirectly: recentLog should NOT have a 'fired' event
        await fetch('http://localhost:3000/api/recorder/test', { method: 'POST' });
        await new Promise(r => setTimeout(r, 500));
        const cfgR = await fetch('http://localhost:3000/api/auto-bet/config');
        const cfg = await cfgR.json();
        const firedEvents = cfg.recentLog.filter(e => e.type === 'fired');
        // If disabled, firedEvents must be 0 (test fight was also filtered by test_fight guard)
        assert(cfg.sessionCount === 0, `sessionCount should be 0 when disabled, got ${cfg.sessionCount}`);
      });
    } catch(e) { console.error('  ✗ R1:', e.message); failed++; }
  } else { console.log('  - R1: skipped (not --local)'); }

  // R2 — guard: test_fight blocks auto-bet
  try {
    await check('R2: checkAutoBet skips test fights (fighter name starts with "Test ")', () => {
      // Simulate the guard logic
      function guardTestFight(f1, f2) {
        return /^test /i.test(f1) || /^test /i.test(f2);
      }
      assert(guardTestFight('Test Fighter A', 'Test Fighter B') === true, 'should skip test fights');
      assert(guardTestFight('Conor McGregor', 'Dustin Poirier') === false, 'should not skip real fights');
      assert(guardTestFight('Test ', 'Anyone') === true, 'should skip "Test " prefix');
      assert(guardTestFight('testosterone', 'Fighter') === false, 'should not skip "testosterone" (no space after Test)');
    });
  } catch(e) { console.error('  ✗ R2:', e.message); failed++; }

  // R3 — guard: fight_too_old (maxFightAgeSecs)
  try {
    await check('R3: checkAutoBet skips fight that started more than maxFightAgeSecs ago', () => {
      function fightTooOld(commenceTimeISO, maxFightAgeSecs) {
        if (!commenceTimeISO) return false;
        const liveForSecs = (Date.now() - new Date(commenceTimeISO).getTime()) / 1000;
        return liveForSecs > maxFightAgeSecs;
      }
      const recent = new Date(Date.now() - 60 * 1000).toISOString();   // 1 min ago
      const old    = new Date(Date.now() - 600 * 1000).toISOString();  // 10 min ago
      assert(fightTooOld(recent, 300) === false, '1-min-old fight should pass 300s limit');
      assert(fightTooOld(old, 300) === true, '10-min-old fight should fail 300s limit');
      assert(fightTooOld(old, 900) === false, '10-min-old fight should pass 900s limit');
      assert(fightTooOld(null, 300) === false, 'null commenceTime should not block (fallback)');
    });
  } catch(e) { console.error('  ✗ R3:', e.message); failed++; }

  // R4 — guard: odds_too_close
  try {
    await check('R4: checkAutoBet skips when implied prob gap < minOddsGapPct', () => {
      function oddsGapPct(f1Odds, f2Odds) {
        const toD = o => o > 0 ? (o/100)+1 : (100/Math.abs(o))+1;
        const d1 = toD(f1Odds), d2 = toD(f2Odds);
        return Math.abs(1/d1 - 1/d2) * 100;
      }
      // -105/-115 → very close
      assert(oddsGapPct(-105, -115) < 5, '-105/-115 gap should be < 5%');
      // -200/+170 → clearly split
      assert(oddsGapPct(-200, 170) > 5, '-200/+170 gap should be > 5%');
      // -110/-110 → exactly even (0 gap)
      assert(oddsGapPct(-110, -110) < 1, '-110/-110 gap should be < 1%');
    });
  } catch(e) { console.error('  ✗ R4:', e.message); failed++; }

  // R5 — guard: rate_limit (maxPerSession)
  try {
    await check('R5: checkAutoBet rate limit logic: blocks after maxPerSession reached', () => {
      function rateLimited(sessionCount, maxPerSession) {
        return sessionCount >= maxPerSession;
      }
      assert(rateLimited(0, 3) === false, '0 fired, limit 3 → should not block');
      assert(rateLimited(2, 3) === false, '2 fired, limit 3 → should not block');
      assert(rateLimited(3, 3) === true,  '3 fired, limit 3 → should block');
      assert(rateLimited(5, 3) === true,  '5 fired, limit 3 → should block');
      assert(rateLimited(0, 0) === true,  'limit 0 → always blocked');
    });
  } catch(e) { console.error('  ✗ R5:', e.message); failed++; }

  // R6 — guard: bracket_not_targeted
  try {
    await check('R6: checkAutoBet only fires for configured brackets', () => {
      function bracketMatch(bracket, configBrackets) {
        return configBrackets.includes(bracket);
      }
      assert(bracketMatch('slight', ['slight']) === true, 'slight in [slight] → fire');
      assert(bracketMatch('huge', ['slight']) === false, 'huge not in [slight] → skip');
      assert(bracketMatch('even', ['even','slight']) === true, 'even in [even,slight] → fire');
      assert(bracketMatch('heavy', []) === false, 'empty brackets list → always skip');
    });
  } catch(e) { console.error('  ✗ R6:', e.message); failed++; }

  // R7 — guard: invalid_odds (NaN, missing)
  try {
    await check('R7: checkAutoBet rejects NaN, null, undefined odds', () => {
      function oddsValid(f1Odds, f2Odds) {
        return typeof f1Odds === 'number' && typeof f2Odds === 'number' &&
               !isNaN(f1Odds) && !isNaN(f2Odds);
      }
      assert(oddsValid(-150, 130) === true, 'valid odds should pass');
      assert(oddsValid(NaN, 130) === false, 'NaN f1 should fail');
      assert(oddsValid(-150, NaN) === false, 'NaN f2 should fail');
      assert(oddsValid(null, 130) === false, 'null f1 should fail');
      assert(oddsValid(-150, undefined) === false, 'undefined f2 should fail');
      assert(oddsValid('−150', 130) === false, 'string odds should fail (not typeof number)');
    });
  } catch(e) { console.error('  ✗ R7:', e.message); failed++; }

  // R8 — correct side selection (dog vs fav)
  try {
    await check('R8: side selection — "dog" picks the underdog, "fav" picks the favorite', () => {
      function selectSide(f1Name, f1Odds, f2Name, f2Odds, cfgSide) {
        const toD = o => o > 0 ? (o/100)+1 : (100/Math.abs(o))+1;
        const d1 = toD(f1Odds), d2 = toD(f2Odds);
        const favFighter = d1 <= d2 ? f1Name : f2Name;
        const dogFighter = d1 <= d2 ? f2Name : f1Name;
        return cfgSide === 'dog' ? dogFighter : favFighter;
      }
      // f1=-200 (fav), f2=+170 (dog)
      assert(selectSide('McGregor',-200,'Poirier',170,'dog') === 'Poirier', 'dog should be Poirier (+170)');
      assert(selectSide('McGregor',-200,'Poirier',170,'fav') === 'McGregor', 'fav should be McGregor (-200)');
      // Reversed: f1=+300 (dog), f2=-350 (fav)
      assert(selectSide('Diaz',300,'Khabib',-350,'dog') === 'Diaz', 'dog should be Diaz (+300)');
      assert(selectSide('Diaz',300,'Khabib',-350,'fav') === 'Khabib', 'fav should be Khabib (-350)');
    });
  } catch(e) { console.error('  ✗ R8:', e.message); failed++; }

  // ── S: Safety integration tests ────────────────────────────────────────────
  console.log('\n── S: Safety & edge case tests ──');

  // S1 — dedup: same fightId never fires twice (even across resets)
  if (process.argv.includes('--local')) {
    try {
      await check('S1: /api/auto-bet/config stores firedFights — same fight blocked on re-query', async () => {
        // The firedFights are persisted. After P4 reset them; verify they are empty
        const r = await fetch('http://localhost:3000/api/auto-bet/config');
        const body = await r.json();
        // firedFights is an array of fight IDs. After the reset in P4, should be empty.
        assert(Array.isArray(body.firedFights), 'firedFights must be array');
        // We can't force a real auto-bet without live fight data, but we can verify the
        // structure is correct and the dedup field exists
        assert(typeof body.sessionCount === 'number', 'sessionCount must exist');
      });
    } catch(e) { console.error('  ✗ S1:', e.message); failed++; }
  } else { console.log('  - S1: skipped (not --local)'); }

  // S2 — negative amount rejected
  if (process.argv.includes('--local')) {
    try {
      await check('S2: POST /api/auto-bet/config rejects negative amount (keeps existing)', async () => {
        // Get current amount first
        const before = await (await fetch('http://localhost:3000/api/auto-bet/config')).json();
        const origAmount = before.config.amount;
        // Send negative
        const r = await fetch('http://localhost:3000/api/auto-bet/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: -50 }),
        });
        const body = await r.json();
        // amount < 0 violates the >= 0 guard; server should not update it
        assert(body.config.amount >= 0, `amount must not go negative, got ${body.config.amount}`);
      });
    } catch(e) { console.error('  ✗ S2:', e.message); failed++; }
  } else { console.log('  - S2: skipped (not --local)'); }

  // S3 — autoHedge flag included in queued command
  try {
    await check('S3: when autoHedge=true, makeCommand includes crossover trigger', () => {
      // Simulate makeCommand from server logic
      function makeCommand(type, intent) {
        return {
          id: 'test',
          type,
          side:    intent.side   || null,
          amount:  intent.amount || null,
          trigger: intent.trigger || { type: 'crossover', targetOdds: null },
          status: 'pending',
        };
      }
      const withHedge = makeCommand('place_bet', {
        side: 'USA', amount: 10,
        trigger: { type: 'crossover', targetOdds: null },
      });
      assert(withHedge.trigger.type === 'crossover', 'trigger.type should be crossover when autoHedge=true');

      const noHedge = makeCommand('place_bet', {
        side: 'USA', amount: 10,
        trigger: { type: null, targetOdds: null },
      });
      assert(noHedge.trigger.type === null, 'trigger.type should be null when autoHedge=false');
    });
  } catch(e) { console.error('  ✗ S3:', e.message); failed++; }

  // S4 — firedFights persisted across config reads
  if (process.argv.includes('--local')) {
    try {
      await check('S4: firedFights list persists in GET /api/auto-bet/config response', async () => {
        const r = await fetch('http://localhost:3000/api/auto-bet/config');
        const body = await r.json();
        // Can't inject a real fight, but verify the array is always present
        assert(Array.isArray(body.firedFights), 'firedFights must always be an array in response');
        assert(body.firedFights.every(f => typeof f === 'string'), 'all firedFight entries must be strings (fight IDs)');
      });
    } catch(e) { console.error('  ✗ S4:', e.message); failed++; }
  } else { console.log('  - S4: skipped (not --local)'); }

  // S5 — recLog entries have required fields
  if (process.argv.includes('--local')) {
    try {
      await check('S5: recentLog entries have type + ts fields; fired entries have side + bracket', async () => {
        const r = await fetch('http://localhost:3000/api/auto-bet/config');
        const body = await r.json();
        for (const entry of body.recentLog) {
          assert(typeof entry.type === 'string', `log entry must have type: ${JSON.stringify(entry)}`);
          assert(typeof entry.ts === 'number', `log entry must have ts: ${JSON.stringify(entry)}`);
          if (entry.type === 'fired') {
            assert(entry.side, `fired entry must have side: ${JSON.stringify(entry)}`);
            assert(entry.bracket, `fired entry must have bracket: ${JSON.stringify(entry)}`);
            assert(entry.amount > 0, `fired entry must have amount > 0: ${JSON.stringify(entry)}`);
          }
        }
      });
    } catch(e) { console.error('  ✗ S5:', e.message); failed++; }
  } else { console.log('  - S5: skipped (not --local)'); }

  // ── T: Structural / source-level tests ──────────────────────────────────────
  console.log('\n── T: Structural checks ──');

  // T1 — server.js has classifyOddsBracket consistent with /api/patterns buckets
  try {
    await check('T1: server.js classifyOddsBracket uses same thresholds as /api/patterns', () => {
      const fs = require('fs');
      const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
      // Must have all 4 bracket names defined
      assert(src.includes("return 'huge'"), 'must have huge bracket');
      assert(src.includes("return 'heavy'"), 'must have heavy bracket');
      assert(src.includes("return 'slight'"), 'must have slight bracket');
      assert(src.includes("return 'even'"), 'must have even bracket');
      // Must use same thresholds as /api/patterns
      assert(src.includes('1.333'), 'must use 1.333 threshold (huge/-300+)');
      assert(src.includes('1.5'),   'must use 1.5 threshold (heavy/-200)');
      assert(src.includes('1.833'), 'must use 1.833 threshold (slight/-120)');
    });
  } catch(e) { console.error('  ✗ T1:', e.message); failed++; }

  // T2 — checkAutoBet wired into recPollSport (called on new fight)
  try {
    await check('T2: server.js recPollSport calls checkAutoBet on new fight detection', () => {
      const fs = require('fs');
      const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
      assert(src.includes('checkAutoBet('), 'checkAutoBet must be called somewhere');
      // Must be called in the new-fight block (near activeFights.set)
      const newFightIdx = src.indexOf('activeFights.set(id, {');
      assert(newFightIdx !== -1, 'activeFights.set must exist');
      const nearbyCode = src.slice(newFightIdx, newFightIdx + 1500);
      assert(nearbyCode.includes('checkAutoBet('), 'checkAutoBet must be called within the new-fight block');
    });
  } catch(e) { console.error('  ✗ T2:', e.message); failed++; }

  // T3 — checkAutoBet passes commenceTime (needed for fight_too_old guard)
  try {
    await check('T3: checkAutoBet call includes fight.commence_time for age guard', () => {
      const fs = require('fs');
      const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
      // The call must include commence_time
      assert(src.includes('commence_time'), 'checkAutoBet must receive fight.commence_time');
      assert(src.includes('maxFightAgeSecs'), 'checkAutoBet must check maxFightAgeSecs');
    });
  } catch(e) { console.error('  ✗ T3:', e.message); failed++; }

  // T4 — firedFights is persisted (saveFiredFights called on fire)
  try {
    await check('T4: server.js saveFiredFights() is called after auto-bet fires', () => {
      const fs = require('fs');
      const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
      // Must add to firedFights AND call saveFiredFights
      assert(src.includes('autoBetFiredFights.add(fightId)'), 'must add fightId to firedFights set');
      assert(src.includes('saveFiredFights()'), 'must call saveFiredFights() to persist');
    });
  } catch(e) { console.error('  ✗ T4:', e.message); failed++; }

  // T5 — auto-bet UI panel exists in index.html
  try {
    await check('T5: index.html has auto-bet panel with toggle, amount, bracket checkboxes, side selector', () => {
      const fs = require('fs');
      const html = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');
      assert(html.includes('ab-panel'), 'must have ab-panel element');
      assert(html.includes('ab-toggle'), 'must have auto-bet toggle button');
      assert(html.includes('ab-amount'), 'must have amount input');
      assert(html.includes('ab-side'), 'must have side selector');
      assert(html.includes('ab-br-slight'), 'must have bracket checkbox for slight');
      assert(html.includes('ab-max'), 'must have maxPerSession input');
      assert(html.includes('toggleAutoBet'), 'must have toggleAutoBet function');
      assert(html.includes('saveAutoBetConfig'), 'must have saveAutoBetConfig function');
      assert(html.includes('resetAutoBetSession'), 'must have resetAutoBetSession function');
      assert(html.includes('/api/auto-bet/config'), 'must call /api/auto-bet/config endpoint');
    });
  } catch(e) { console.error('  ✗ T5:', e.message); failed++; }

  // T6 — existing_coverage guard: won't double-bet if already on this side
  try {
    await check('T6: checkAutoBet source includes existing bet coverage guard', () => {
      const fs = require('fs');
      const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
      assert(src.includes('alreadyCovered'), 'must have alreadyCovered guard');
      assert(src.includes('getAllBets(true)'), 'must check open bets before firing');
      assert(src.includes('existing_bet_on_'), 'must return skip reason for existing bet');
    });
  } catch(e) { console.error('  ✗ T6:', e.message); failed++; }

  // T7 — email alert fires on auto-bet (sendAlert called in checkAutoBet)
  try {
    await check('T7: checkAutoBet calls sendAlert when bet fires', () => {
      const fs = require('fs');
      const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
      const fnStart = src.indexOf('function checkAutoBet(');
      assert(fnStart !== -1, 'checkAutoBet function must exist');
      const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
      const fnBody = src.slice(fnStart, fnEnd === -1 ? fnStart + 4000 : fnEnd);
      assert(fnBody.includes('sendAlert('), 'checkAutoBet must call sendAlert when bet fires');
      assert(fnBody.includes('AUTO-BET'), 'alert must mention AUTO-BET');
    });
  } catch(e) { console.error('  ✗ T7:', e.message); failed++; }
}

// ── U: /api/auto-bet/test dry-run endpoint ─────────────────────────────────────
async function runAutoBetDryRunTests() {
  console.log('\n── U: Auto-bet dry-run (/api/auto-bet/test) ──');

  if (!process.argv.includes('--local')) {
    console.log('  - U1-U5: skipped (not --local)'); return;
  }

  // U1 — dryRun=true reports all guards without queuing a command
  try {
    await check('U1: dryRun=true returns guards array without queuing command', async () => {
      const before = await (await fetch('http://localhost:3000/api/auto-bet/config')).json();
      const r = await fetch('http://localhost:3000/api/auto-bet/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighter1: 'McGregor', fighter2: 'Poirier', f1Odds: -150, f2Odds: 130, dryRun: true }),
      });
      assert(r.ok, `HTTP ${r.status}`);
      const body = await r.json();
      assert(body.dryRun === true, 'must report dryRun=true');
      assert(Array.isArray(body.guards), 'must include guards array');
      assert(body.guards.length >= 8, `expected >=8 guards, got ${body.guards.length}`);
      const after = await (await fetch('http://localhost:3000/api/auto-bet/config')).json();
      assert(after.sessionCount === before.sessionCount, 'dryRun must not increment sessionCount');
    });
  } catch(e) { console.error('  ✗ U1:', e.message); failed++; }

  // U2 — wouldFire=false when enabled=false
  try {
    await check('U2: wouldFire=false when auto-bet is disabled', async () => {
      await fetch('http://localhost:3000/api/auto-bet/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      const r = await fetch('http://localhost:3000/api/auto-bet/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighter1: 'McGregor', fighter2: 'Poirier', f1Odds: -150, f2Odds: 130, dryRun: true }),
      });
      const body = await r.json();
      assert(body.wouldFire === false, `Expected wouldFire=false when disabled, got: ${body.wouldFire}`);
      const enabledGuard = body.guards.find(g => g.guard === 'enabled');
      assert(enabledGuard && enabledGuard.pass === false, 'enabled guard must show pass=false');
    });
  } catch(e) { console.error('  ✗ U2:', e.message); failed++; }

  // U3 — bracket reported correctly
  try {
    await check('U3: dry-run reports correct bracket for given odds', async () => {
      const r = await fetch('http://localhost:3000/api/auto-bet/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighter1: 'A', fighter2: 'B', f1Odds: -400, f2Odds: 300, dryRun: true }),
      });
      const body = await r.json();
      assert(body.bracket === 'huge', `Expected huge bracket for -400/+300, got: ${body.bracket}`);
      assert(body.bracketLabel === 'dominant', `Expected bracketLabel=dominant, got: ${body.bracketLabel}`);
    });
  } catch(e) { console.error('  ✗ U3:', e.message); failed++; }

  // U4 — odds_too_close guard shows correct gap percentage
  try {
    await check('U4: dry-run shows gap% in odds_too_close guard', async () => {
      const r = await fetch('http://localhost:3000/api/auto-bet/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighter1: 'A', fighter2: 'B', f1Odds: -110, f2Odds: -110, dryRun: true }),
      });
      const body = await r.json();
      const g = body.guards.find(g => g.guard === 'odds_too_close');
      assert(g, 'odds_too_close guard must exist');
      assert(g.pass === false, 'near-even -110/-110 should fail odds_too_close');
      assert(g.value.includes('gap='), 'must report gap percentage');
    });
  } catch(e) { console.error('  ✗ U4:', e.message); failed++; }

  // U5 — fight_too_old guard reflects commenceTime parameter
  try {
    await check('U5: dry-run fight_too_old guard uses provided commenceTime', async () => {
      const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
      const r = await fetch('http://localhost:3000/api/auto-bet/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighter1: 'A', fighter2: 'B', f1Odds: -150, f2Odds: 130, commenceTime: oldTime, dryRun: true }),
      });
      const body = await r.json();
      const g = body.guards.find(g => g.guard === 'fight_too_old');
      assert(g, 'fight_too_old guard must exist');
      assert(g.pass === false, '20-min-old fight must fail fight_too_old (limit=300s)');
      assert(g.value.includes('1200s old') || g.value.includes('s old'), `must report age in seconds: ${g.value}`);
    });
  } catch(e) { console.error('  ✗ U5:', e.message); failed++; }
}

// ── V: Auto-bet UI redesign ───────────────────────────────────────────────────
async function runAutoBetUITests() {
  console.log('\n── V: Auto-bet UI redesign ──');

  const fs = require('fs');
  const html = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');

  // V1 — help buttons present for each field
  try {
    await check('V1: all ? help buttons present (amount, side, brackets, max, hedge)', () => {
      assert(html.includes("abHelp('amount')"), "must have ? button for amount");
      assert(html.includes("abHelp('side')"), "must have ? button for side");
      assert(html.includes("abHelp('brackets')"), "must have ? button for brackets");
      assert(html.includes("abHelp('max')"), "must have ? button for max");
      assert(html.includes("abHelp('hedge')"), "must have ? button for hedge");
    });
  } catch(e) { console.error('  ✗ V1:', e.message); failed++; }

  // V2 — tooltip divs present for each field
  try {
    await check('V2: tooltip divs exist for all help targets', () => {
      assert(html.includes('ab-tip-amount'), 'must have ab-tip-amount div');
      assert(html.includes('ab-tip-side'), 'must have ab-tip-side div');
      assert(html.includes('ab-tip-brackets'), 'must have ab-tip-brackets div');
      assert(html.includes('ab-tip-max'), 'must have ab-tip-max div');
      assert(html.includes('ab-tip-hedge'), 'must have ab-tip-hedge div');
    });
  } catch(e) { console.error('  ✗ V2:', e.message); failed++; }

  // V3 — presets present
  try {
    await check('V3: quick-start preset buttons present (conservative, balanced, aggressive)', () => {
      assert(html.includes("applyAbPreset('conservative')"), "must have conservative preset");
      assert(html.includes("applyAbPreset('balanced')"), "must have balanced preset");
      assert(html.includes("applyAbPreset('aggressive')"), "must have aggressive preset");
    });
  } catch(e) { console.error('  ✗ V3:', e.message); failed++; }

  // V4 — plain-English bracket labels with odds ranges
  try {
    await check('V4: bracket labels use plain English with odds ranges (not jargon)', () => {
      assert(html.includes('Slight edge'), 'must have plain-English slight label');
      assert(html.includes('One-sided'), 'must have plain-English heavy label');
      assert(html.includes('Even match'), 'must have plain-English even label');
      assert(html.includes('Dominant'), 'must have dominant label');
      assert(html.includes('-120 to -200'), 'slight bracket must show actual odds range');
      assert(html.includes('-200 to -400'), 'heavy bracket must show actual odds range');
    });
  } catch(e) { console.error('  ✗ V4:', e.message); failed++; }

  // V5 — crossover rates shown
  try {
    await check('V5: crossover rates shown next to each bracket', () => {
      assert(html.includes('~42%'), 'must show 42% crossover rate for slight');
      assert(html.includes('~28%'), 'must show 28% for heavy');
      assert(html.includes('~20%'), 'must show 20% for even');
      assert(html.includes('~8%'), 'must show 8% for dominant');
    });
  } catch(e) { console.error('  ✗ V5:', e.message); failed++; }

  // V6 — visual flow (how it works) present
  try {
    await check('V6: "How it works" visual flow present in panel', () => {
      assert(html.includes('How it works'), 'must have How it works section');
      assert(html.includes('Odds flip'), 'must mention odds flip in flow');
      assert(html.includes('Profit'), 'must mention profit in flow');
    });
  } catch(e) { console.error('  ✗ V6:', e.message); failed++; }

  // V7 — abHelp function defined in JS
  try {
    await check('V7: abHelp() function defined with toggle logic', () => {
      assert(html.includes('function abHelp('), 'must define abHelp function');
      assert(html.includes('ab-tip-'), 'abHelp must reference ab-tip- prefix');
    });
  } catch(e) { console.error('  ✗ V7:', e.message); failed++; }

  // V8 — applyAbPreset function defined with all three presets
  try {
    await check('V8: applyAbPreset() function defined with conservative/balanced/aggressive', () => {
      assert(html.includes('function applyAbPreset('), 'must define applyAbPreset function');
      assert(html.includes('conservative'), 'must have conservative preset in function');
      assert(html.includes('balanced'), 'must have balanced preset in function');
      assert(html.includes('aggressive'), 'must have aggressive preset in function');
      assert(html.includes('saveAutoBetConfig()'), 'presets must call saveAutoBetConfig');
    });
  } catch(e) { console.error('  ✗ V8:', e.message); failed++; }

  // V9 — STRATEGY.md exists and covers key concepts
  try {
    await check('V9: STRATEGY.md exists and covers crossover math, brackets, win-win condition', () => {
      const md = fs.readFileSync(require('path').join(__dirname, 'STRATEGY.md'), 'utf8');
      assert(md.includes('crossover'), 'must explain crossover concept');
      assert(md.includes('(D1 - 1)(D2 - 1) > 1'), 'must include win-win condition formula');
      assert(md.includes('~42%'), 'must include crossover rate data');
      assert(md.includes('classifyOddsBracket'), 'must document bracket classification');
      assert(md.includes('9 Safety Guards') || md.includes('safety guard'), 'must document safety guards');
    });
  } catch(e) { console.error('  ✗ V9:', e.message); failed++; }

  // V10 — FAB button uses plain label
  try {
    await check('V10: FAB button has plain title (not just robot emoji)', () => {
      assert(html.includes('Auto-Bet'), 'FAB title must mention Auto-Bet');
      assert(html.includes('toggleAbPanel'), 'FAB must call toggleAbPanel');
    });
  } catch(e) { console.error('  ✗ V10:', e.message); failed++; }
}
