'use strict';
/**
 * tests/11_test_fighter_tags.js — Comprehensive Test Suite for Ish's Fighter Tagging & Crossover Engine
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getTags, setTags, toggleTag, toggleRawDog, getAllTags, _norm, TAG_CATALOG } = require('../fighter_tag_engine');
const { calculateTaggedCrossover, BASE_CROSSOVER_RATE } = require('../tag_crossover_engine');
const { runTagBacktest } = require('../analysis/rerun_tag_backtest');

console.log('>>> RUNNING: tests/11_test_fighter_tags.js');

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

console.log('── 1. Name Normalization & Tag Catalog ──');
test('Normalizes accents, diacritics, punctuation and spaces', () => {
  assert.strictEqual(_norm('Piera Rodríguez'), 'pierarodriguez');
  assert.strictEqual(_norm('Talita Alencar '), 'talitaalencar');
  assert.strictEqual(_norm("Sean O'Malley"), 'seanomalley');
  assert.strictEqual(_norm('Jiri Procházka'), 'jiriprochazka');
});

test('Tag catalog contains all of Ish\'s requested stylistic tags', () => {
  const ids = TAG_CATALOG.map(t => t.id);
  assert.ok(ids.includes('heavy_wrestler'));
  assert.ok(ids.includes('takedown_defense'));
  assert.ok(ids.includes('striking_power'));
  assert.ok(ids.includes('efficient_striker'));
  assert.ok(ids.includes('older'));
  assert.ok(ids.includes('size_advantage'));
  assert.ok(ids.includes('sub_threat'));
  assert.ok(ids.includes('cardio_machine'));
  assert.ok(ids.includes('gas_tank_risk'));
});

console.log('── 2. Initial Seeds from Ish Phone Call ──');
test('Piera Rodriguez seeded with striking power and Raw Dog status', () => {
  const piera = getTags('Piera Rodriguez');
  assert.ok(piera.tags.includes('striking_power'));
  assert.ok(piera.tags.includes('efficient_striker'));
  assert.strictEqual(piera.isRawDog, true);
});

test('Talita Alencar seeded with heavy wrestler, older, and size advantage', () => {
  const talita = getTags('Talita Alencar');
  assert.ok(talita.tags.includes('heavy_wrestler'));
  assert.ok(talita.tags.includes('older'));
  assert.ok(talita.tags.includes('size_advantage'));
  assert.strictEqual(talita.isRawDog, false);
});

console.log('── 3. Tag Mutation & Toggle Handlers ──');
test('setTags updates fighter tags and persists', () => {
  setTags('Test Fighter', {
    tags: ['heavy_wrestler', 'cardio_machine'],
    isRawDog: true,
    notes: 'Elite wrestler'
  });
  const t = getTags('Test Fighter');
  assert.deepStrictEqual(t.tags, ['heavy_wrestler', 'cardio_machine']);
  assert.strictEqual(t.isRawDog, true);
  assert.strictEqual(t.notes, 'Elite wrestler');
});

test('toggleTag adds tag when absent and removes when present', () => {
  toggleTag('Test Fighter', 'older');
  let t = getTags('Test Fighter');
  assert.ok(t.tags.includes('older'));

  toggleTag('Test Fighter', 'older');
  t = getTags('Test Fighter');
  assert.strictEqual(t.tags.includes('older'), false);
});

test('toggleRawDog toggles subjective Raw Dog status', () => {
  toggleRawDog('Test Fighter');
  let t = getTags('Test Fighter');
  assert.strictEqual(t.isRawDog, false);

  toggleRawDog('Test Fighter');
  t = getTags('Test Fighter');
  assert.strictEqual(t.isRawDog, true);
});

console.log('── 4. Tagged Crossover Calculation & Catalyst Math ──');
test('Base rate returned when neither fighter has tags', () => {
  const res = calculateTaggedCrossover(-150, 130, { tags: [] }, { tags: [] });
  assert.strictEqual(res.taggedCrossoverPct, 41.5);
  assert.strictEqual(res.delta, 0);
  assert.strictEqual(res.catalysts.length, 0);
});

test('Favorite Age Cliff increases crossover probability to 47.6%', () => {
  // F1 (-180 Fav) is older, F2 (+150 Dog) has no tags
  const res = calculateTaggedCrossover(-180, 150, { tags: ['older'] }, { tags: [] });
  assert.strictEqual(res.taggedCrossoverPct, 47.6);
  assert.ok(res.catalysts.some(c => c.includes('Fav Age Cliff')));
});

test('Underdog Size Advantage increases crossover probability to 48.3%', () => {
  // F1 (-180 Fav), F2 (+150 Dog) has size advantage
  const res = calculateTaggedCrossover(-180, 150, { tags: [] }, { tags: ['size_advantage'] });
  assert.strictEqual(res.taggedCrossoverPct, 48.3);
  assert.ok(res.catalysts.some(c => c.includes('Dog Size Advantage')));
});

test('Underdog Defense vs Favorite Power triggers 61.5% line-flip rate', () => {
  // F1 (-180 Fav) has striking_power, F2 (+150 Dog) has takedown_defense
  const res = calculateTaggedCrossover(-180, 150, { tags: ['striking_power'] }, { tags: ['takedown_defense'] });
  assert.strictEqual(res.taggedCrossoverPct, 61.5);
  assert.ok(res.catalysts.some(c => c.includes('Dog Defense vs Fav Power')));
  assert.ok(res.advice.includes('High Crossover Potential'));
});

test('Multi-Catalyst Stack activates when 2+ catalysts present (62.5%)', () => {
  // F1 (-180 Fav) has older & striking_power, F2 (+150 Dog) has size_advantage & takedown_defense
  const res = calculateTaggedCrossover(-180, 150, { tags: ['older', 'striking_power'] }, { tags: ['size_advantage', 'takedown_defense'] });
  assert.strictEqual(res.taggedCrossoverPct, 62.5);
  assert.ok(res.catalysts.some(c => c.includes('Multi-Catalyst Stack')));
});

test('Grappler Suppression Trap suppresses crossover probability to 34.8%', () => {
  // F1 (-200 Fav) is heavy_wrestler, F2 (+165 Dog) lacks takedown_defense
  const res = calculateTaggedCrossover(-200, 165, { tags: ['heavy_wrestler'] }, { tags: ['efficient_striker'] });
  assert.strictEqual(res.taggedCrossoverPct, 34.8);
  assert.ok(res.warnings.some(w => w.includes('Grappler Suppression Trap')));
  assert.ok(res.advice.includes('Crossover Suppressed'));
});

test('Raw Dog status on underdog is captured and surfaces in catalyst badges', () => {
  const res = calculateTaggedCrossover(-150, 130, { tags: [] }, { tags: [], isRawDog: true }, 'Fav', 'Dog');
  assert.strictEqual(res.dogIsRawDog, true);
  assert.ok(res.catalysts.some(c => c.includes('Raw Dog Pick')));
});

console.log('── 5. Historical Backtest & Rerun Analysis ──');
test('runTagBacktest scans dataset and evaluates tagged fighters', () => {
  const bt = runTagBacktest();
  assert.ok(typeof bt.totalAnalyzed === 'number');
  assert.ok(bt.totalAnalyzed > 0, 'Expected positive count of historical fights');
  assert.ok(typeof bt.taggedFightsCount === 'number');
  assert.ok(bt.taggedFightsCount >= 2, 'Expected seeded fighters (Piera & Talita) in dataset');
  assert.ok(Array.isArray(bt.taggedMatches));
  assert.ok(bt.taggedMatches.some(m => m.f1.includes('Piera') || m.f2.includes('Piera')));
  assert.ok(bt.taggedMatches.some(m => m.f1.includes('Talita') || m.f2.includes('Talita')));
});

console.log('====================================================');
console.log('  ALL 11_test_fighter_tags.js TESTS PASSED CLEANLY! ');
console.log('====================================================');
