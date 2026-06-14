#!/usr/bin/env node
// test_benchmark.js — Regression guard: prediction accuracy must not drop vs baseline.
//
// Run with: node test_benchmark.js
// Fails (exit 1) if win rate or ROI drops more than 3 ppts vs the saved baseline.
// Save a new baseline after intentional improvements: node backtest.js --save-baseline
'use strict';
const { execSync } = require('child_process');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); passed++; }
  catch(e) { console.error('  ✗', name + ':', e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('\n── Prediction benchmark regression check ──\n');
console.log('  Running leave-one-out backtest (no Claude, no HTTP)…\n');

let output = '';
try {
  output = execSync('node backtest.js --check', { encoding: 'utf8', timeout: 120000 });
} catch (e) {
  output = e.stdout || '';
  // If --check exits with code 1, it means regression detected → fail the test
  console.error(output);
  console.error(e.stderr || '');
  console.error('\n  ✗ Benchmark check: REGRESSION DETECTED — accuracy dropped vs baseline');
  console.log('\n═══════════════════════════════════');
  console.log('  0 passed  1 failed');
  console.log('═══════════════════════════════════\n');
  process.exit(1);
}

check('backtest completed without regression', () => {
  assert(output.includes('Benchmark passed'), 'missing pass confirmation in output:\n' + output);
});

check('win rate is reported', () => {
  assert(/Win rate.*\d+%/.test(output), output.slice(-300));
});

check('ROI is reported', () => {
  assert(/ROI.*[\d.]+/.test(output), output.slice(-300));
});

check('baseline comparison shown', () => {
  assert(output.includes('Baseline') && output.includes('Current'), output.slice(-400));
});

console.log('\n' + output.split('\n').filter(l => l.includes('─') || l.includes('Baseline') || l.includes('Current') || l.includes('Delta') || l.includes('passed')).join('\n'));

console.log('\n═══════════════════════════════════');
console.log(' ', passed, 'passed ', failed, 'failed');
console.log('═══════════════════════════════════\n');
if (failed > 0) process.exit(1);
