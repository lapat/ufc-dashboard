'use strict';
/**
 * tests/12_test_tag_api_integration.js — Live HTTP Integration Test Suite
 *
 * Boots the Express server on an ephemeral port and tests all tag endpoints,
 * dynamic crossover payloads, and HTML serving.
 */

const assert = require('assert');
const http = require('http');
const app = require('../server');

console.log('>>> RUNNING: tests/12_test_tag_api_integration.js');

let server;
const PORT = 5988;

function req(path, options = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;
    const headers = Object.assign({}, options.headers || {});
    if (bodyStr && !headers['Content-Length']) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method: options.method || 'GET',
      headers
    };

    const r = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });

    r.on('error', reject);
    if (bodyStr) {
      r.write(bodyStr);
    }
    r.end();
  });
}

function test(name, fn) {
  return fn()
    .then(() => console.log(`  ✓ ${name}`))
    .catch(err => {
      console.error(`  ✗ ${name}`);
      console.error(err);
      if (server) server.close();
      process.exit(1);
    });
}

(async () => {
  server = app.listen(PORT);
  await new Promise(r => server.on('listening', r));
  console.log(`  Test server listening on port ${PORT}`);

  try {
    await test('GET /api/fighter-tags returns seeded data for Piera Rodriguez', async () => {
      const res = await req('/api/fighter-tags?name=Piera+Rodriguez');
      assert.strictEqual(res.status, 200);
      assert.ok(res.json);
      assert.ok(res.json.tags.includes('striking_power'));
      assert.strictEqual(res.json.isRawDog, true);
    });

    await test('GET /api/fighter-tags/all returns tags map and full catalog', async () => {
      const res = await req('/api/fighter-tags/all');
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.tags);
      assert.ok(Array.isArray(res.json.catalog));
      assert.strictEqual(res.json.catalog.length, 9);
    });

    await test('POST /api/fighter-tags/toggle toggles a tag atomically', async () => {
      const res1 = await req('/api/fighter-tags/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { name: 'Integration Test Fighter', tagId: 'sub_threat' }
      });
      assert.strictEqual(res1.status, 200);
      assert.ok(res1.json.updated.tags.includes('sub_threat'));

      const res2 = await req('/api/fighter-tags/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { name: 'Integration Test Fighter', tagId: 'sub_threat' }
      });
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.json.updated.tags.includes('sub_threat'), false);
    });

    await test('POST /api/fighter-tags/rawdog toggles Raw Dog status', async () => {
      // Ensure starting from isRawDog = false
      await req('/api/fighter-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { name: 'Integration Test Fighter', tagsData: { tags: [], isRawDog: false } }
      });

      const res = await req('/api/fighter-tags/rawdog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { name: 'Integration Test Fighter' }
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.updated);
      assert.strictEqual(res.json.updated.isRawDog, true);
    });

    await test('GET /api/fighter-stats calculates taggedCrossover with Ish tags', async () => {
      const res = await req('/api/fighter-stats?f1=Piera+Rodriguez&f2=Talita+Alencar&o1=-150&o2=130');
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.f1);
      assert.ok(res.json.f2);
      assert.ok(res.json.f1.tags);
      assert.ok(res.json.f2.tags);
      assert.ok(res.json.taggedCrossover);
      assert.ok(typeof res.json.taggedCrossover.taggedCrossoverPct === 'number');
      assert.ok(Array.isArray(res.json.taggedCrossover.catalysts));
    });

    await test('GET /api/rerun-tag-analysis executes historical scan and returns metrics', async () => {
      const res = await req('/api/rerun-tag-analysis');
      assert.strictEqual(res.status, 200);
      assert.ok(typeof res.json.totalAnalyzed === 'number');
      assert.ok(res.json.totalAnalyzed > 0);
      assert.ok(typeof res.json.taggedFightsCount === 'number');
      assert.ok(Array.isArray(res.json.taggedMatches));
    });

    await test('GET / serves HTML with Ish tag panels and 1-click toggles', async () => {
      const res = await req('/');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes('nw-tag-panels'));
      assert.ok(res.body.includes('nw-f1-rawdog-btn'));
      assert.ok(res.body.includes('nw-f2-rawdog-btn'));
      assert.ok(res.body.includes('toggleFighterTag'));
    });

    await test('GET /patterns serves HTML with Ish Tag Backtest section', async () => {
      const res = await req('/patterns');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes('Ish\'s Stylistic Tagging & Crossover Engine'));
      assert.ok(res.body.includes('btn-rerun-tag-analysis'));
    });

    console.log('====================================================');
    console.log('  ALL 12_test_tag_api_integration.js TESTS PASSED! ');
    console.log('====================================================');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 100);
  } finally {
    if (server) server.close();
  }
})();
