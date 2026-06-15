#!/usr/bin/env node
// Test Betfair Exchange API connection and find MMA/UFC markets.
// Usage: node test_betfair.js
// Requires in .env: BETFAIR_USERNAME, BETFAIR_PASSWORD, BETFAIR_APP_KEY

require('dotenv').config();
const https = require('https');

const USERNAME = process.env.BETFAIR_USERNAME;
const PASSWORD = process.env.BETFAIR_PASSWORD;
const APP_KEY  = process.env.BETFAIR_APP_KEY;

if (!USERNAME || !PASSWORD || !APP_KEY) {
  console.error('Set BETFAIR_USERNAME, BETFAIR_PASSWORD, BETFAIR_APP_KEY in .env');
  process.exit(1);
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login() {
  console.log('1. Logging in...');
  const params = `username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;
  const res = await request({
    hostname: 'identitysso-cert.betfair.com',
    path: '/api/login',
    method: 'POST',
    headers: {
      'X-Application': APP_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
  }, params);

  if (res.body.status !== 'SUCCESS') {
    // Try the non-cert endpoint (for accounts without cert-based login)
    console.log('   Trying standard login endpoint...');
    const res2 = await request({
      hostname: 'identitysso.betfair.com',
      path: '/api/login',
      method: 'POST',
      headers: {
        'X-Application': APP_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
    }, params);

    if (res2.body.status !== 'SUCCESS') {
      console.error('   Login failed:', JSON.stringify(res2.body));
      process.exit(1);
    }
    console.log('   Login OK (standard endpoint)');
    return res2.body.token;
  }

  console.log('   Login OK (cert endpoint)');
  return res.body.token;
}

async function betting(sessionToken, method, params) {
  const body = JSON.stringify(params);
  const res = await request({
    hostname: 'api.betfair.com',
    path: `/exchange/betting/rest/v1.0/${method}/`,
    method: 'POST',
    headers: {
      'X-Authentication': sessionToken,
      'X-Application': APP_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }, body);
  return res.body;
}

async function main() {
  const token = await login();

  // 2. List event types to confirm MMA is available
  console.log('\n2. Checking event types...');
  const eventTypes = await betting(token, 'listEventTypes', { filter: {} });
  const mma = (eventTypes || []).find(e => e.eventType?.name?.toLowerCase().includes('mma') || e.eventType?.name?.toLowerCase().includes('mixed'));
  if (mma) {
    console.log(`   Found MMA: ${JSON.stringify(mma.eventType)}`);
  } else {
    console.log('   MMA not found in top-level event types. Available:');
    (eventTypes || []).slice(0, 10).forEach(e => console.log(`   - ${e.eventType?.name} (id: ${e.eventType?.id})`));
  }

  // 3. Search for UFC events specifically
  console.log('\n3. Searching for UFC events...');
  const events = await betting(token, 'listEvents', {
    filter: {
      textQuery: 'UFC',
    },
  });
  if (events?.length) {
    console.log(`   Found ${events.length} UFC events:`);
    events.slice(0, 5).forEach(e => console.log(`   - ${e.event?.name} | ${e.event?.openDate}`));
  } else {
    console.log('   No UFC events found with textQuery=UFC');
  }

  // 4. Try MMA markets broadly
  console.log('\n4. Searching for MMA markets...');
  const markets = await betting(token, 'listMarketCatalogue', {
    filter: {
      textQuery: 'MMA',
      inPlayOnly: false,
    },
    maxResults: 10,
    marketProjection: ['EVENT', 'MARKET_START_TIME'],
  });
  if (markets?.length) {
    console.log(`   Found ${markets.length} MMA markets:`);
    markets.forEach(m => console.log(`   - [${m.marketId}] ${m.marketName} | event: ${m.event?.name} | starts: ${m.marketStartTime}`));
  } else {
    console.log('   No MMA markets found');
    console.log('   Raw response:', JSON.stringify(markets));
  }

  console.log('\nDone. If you see markets above, Betfair is working.');
  console.log('Next step: request the Live App Key (£299) for real-time streaming during fights.');
}

main().catch(e => { console.error(e); process.exit(1); });
