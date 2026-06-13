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
    // Inject a mock settled bet via dk-sync
    await post('/api/dk-sync', {
      url: 'wss://test',
      data: { result: { initial: { bets: [
        { betId: 'open-1', receiptId: 'open-1', status: 'Unsettled', settlementStatus: 'Open', stake: 10, potentialReturns: 15, placementDate: new Date().toISOString(), displayOdds: '+150', selections: [{ selectionDisplayName: 'Fighter A', marketDisplayName: 'Moneyline', displayOdds: '+150' }] },
        { betId: 'won-1', receiptId: 'won-1', status: 'Settled', settlementStatus: 'Won', stake: 10, potentialReturns: 15, returns: 15, placementDate: new Date().toISOString(), displayOdds: '+150', selections: [{ selectionDisplayName: 'Fighter B', marketDisplayName: 'Moneyline', displayOdds: '+150' }] },
      ] } } },
      ts: Date.now()
    });
    const open = await get('/api/dk-bets');
    const all = await get('/api/dk-bets?all=1');
    assert(open.length < all.length, `open (${open.length}) should be fewer than all (${all.length})`);
    assert(open.every(b => b.status === 'Open'), 'all open bets should have status Open');
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

// ── Main ───────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════');
console.log('  BET BOT TEST SUITE');
console.log('═══════════════════════════════════');

console.log('\n── Unit Tests ──');
try { testOddsParsing(); console.log('  ✓ odds parsing (unicode minus)'); passed++; } catch(e) { console.error('  ✗ odds parsing:', e.message); failed++; }
try { testBetParsing(); console.log('  ✓ bet parsing (settlementStatus → Open)'); passed++; } catch(e) { console.error('  ✗ bet parsing:', e.message); failed++; }

runServerTests().then(() => {
  console.log(`\n═══════════════════════════════════`);
  console.log(`  ${passed} passed  ${failed} failed`);
  console.log(`═══════════════════════════════════\n`);
  if (failed > 0) process.exit(1);
}).catch(e => { console.error(e); process.exit(1); });
