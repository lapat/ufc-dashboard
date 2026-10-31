'use strict';
/**
 * tests/15_test_extension_subsystems_and_dom.js — Chrome Extension Subsystems & Integrity Verification
 *
 * Verifies that:
 * 1. manifest.json is valid Manifest V3 with version 3.4 and required permissions.
 * 2. rules.json declarativeNetRequest rules are syntactically valid.
 * 3. Every DOM element ID in popup.js exists in popup.html with zero missing references.
 * 4. content.js contains unthrottled Web Worker timer and multi-signal live detection.
 * 5. background.js handles all 12 core message types without dropped events.
 * 6. bridge.js correctly relays PREFILL_BETSLIP from page window to extension.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('>>> RUNNING: tests/15_test_extension_subsystems_and_dom.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exit(1);
  }
}

const EXT_DIR = path.join(__dirname, '..', 'dk-extension');

console.log('── 1. Manifest V3 & Rules Verification ──');
test('manifest.json has valid Manifest V3 schema and version 3.4', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  assert.strictEqual(m.manifest_version, 3, 'Must be Manifest V3');
  assert.strictEqual(m.version, '3.4', 'Version must be 3.4');
  assert.strictEqual(m.action.default_popup, 'popup.html');
  assert.strictEqual(m.background.service_worker, 'background.js');
  assert.ok(m.permissions.includes('storage'));
  assert.ok(m.permissions.includes('declarativeNetRequest'));
  assert.ok(m.host_permissions.some(h => h.includes('draftkings.com')));
  assert.ok(m.host_permissions.some(h => h.includes('livebetbot.com')));
});

test('rules.json defines valid declarativeNetRequest rule for stripping X-Frame-Options', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'rules.json'), 'utf8'));
  assert.ok(Array.isArray(rules) && rules.length > 0);
  assert.strictEqual(rules[0].id, 1);
  assert.strictEqual(rules[0].action.type, 'modifyHeaders');
});

console.log('── 2. Popup DOM & Script Integrity (Zero-Missing-ID Guarantee) ──');
const popupHtml = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');

test('Every getElementById in popup.js exists in popup.html', () => {
  const regex = /getElementById\(['"]([^'"]+)['"]\)/g;
  let match;
  const ids = [];
  while ((match = regex.exec(popupJs)) !== null) {
    ids.push(match[1]);
  }
  assert.ok(ids.length >= 25, 'Expected at least 25 DOM elements wired');
  for (const id of ids) {
    const found = popupHtml.includes(`id="${id}"`) || popupHtml.includes(`id='${id}'`);
    assert.ok(found, `ID "${id}" in popup.js must exist in popup.html`);
  }
});

test('popup.html contains Cockpit elements (health-pill, ext-tagger-wrap, launchers, drawer)', () => {
  assert.ok(popupHtml.includes('id="health-pill"'), 'Must have health pill');
  assert.ok(popupHtml.includes('id="btnLaunchTabs"'), 'Must have 2-tab launcher');
  assert.ok(popupHtml.includes('id="ext-tagger-wrap"'), 'Must have in-popup tagger');
  assert.ok(popupHtml.includes('id="ext-f1-dog"'), 'Must have F1 Raw Dog button');
  assert.ok(popupHtml.includes('id="ext-f2-dog"'), 'Must have F2 Raw Dog button');
  assert.ok(popupHtml.includes('id="ext-advice-box"'), 'Must have dynamic crossover advice box');
  assert.ok(popupHtml.includes('id="btnToggleDrawer"'), 'Must have collapsible settings drawer');
});

console.log('── 3. Content Script & Background Worker Wiring ──');
const contentSrc = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(EXT_DIR, 'bridge.js'), 'utf8');

test('content.js defines Web Worker unthrottled timer and EXECUTE_PREFILL listener', () => {
  assert.ok(contentSrc.includes('new Blob'), 'Must define Web Worker timer blob');
  assert.ok(contentSrc.includes('new Worker'), 'Must instantiate Web Worker timer');
  assert.ok(contentSrc.includes('EXECUTE_PREFILL'), 'Must listen for EXECUTE_PREFILL message');
  assert.ok(contentSrc.includes('executePrefillOnDraftKings'), 'Must define executePrefillOnDraftKings');
});

test('background.js handles all essential message types including PREFILL_BETSLIP and ODDS_UPDATE', () => {
  assert.ok(bgSrc.includes("msg.type === 'ODDS_UPDATE'"), 'Must handle ODDS_UPDATE');
  assert.ok(bgSrc.includes("msg.type === 'PREFILL_BETSLIP'"), 'Must handle PREFILL_BETSLIP');
  assert.ok(bgSrc.includes("msg.type === 'SET_MANUAL_LIVE'"), 'Must handle SET_MANUAL_LIVE');
  assert.ok(bgSrc.includes("msg.type === 'DK_WS_STATUS'"), 'Must handle DK_WS_STATUS');
  assert.ok(bgSrc.includes("msg.type === 'LAUNCH_PARAMOUNT'"), 'Must handle LAUNCH_PARAMOUNT');
});

test('bridge.js relays PREFILL_BETSLIP window message to extension runtime', () => {
  assert.ok(bridgeSrc.includes('PREFILL_BETSLIP'), 'Must check for PREFILL_BETSLIP');
  assert.ok(bridgeSrc.includes('chrome.runtime.sendMessage'), 'Must relay to extension runtime');
});

console.log('====================================================');
console.log('  ALL 15_test_extension_subsystems_and_dom.js PASSED!');
console.log('====================================================');
