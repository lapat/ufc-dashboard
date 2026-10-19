'use strict';
// test_backup.js — exercises the GitHub backup + overwrite guard against REAL GitHub.
// Run: GITHUB_TOKEN=$(gh auth token) node test_backup.js
// Uses a throwaway DATA_DIR under the OS temp dir; never touches the real historical_data.
// Pushes ONE test file to the backup branch and deletes it again at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-test-'));
process.env.DATA_DIR = sandbox;
if (!process.env.GITHUB_TOKEN) { console.error('GITHUB_TOKEN required'); process.exit(1); }

const re = require('./record_engine');
const hist = path.join(sandbox, 'historical_data');
fs.mkdirSync(hist, { recursive: true });

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '-', e.message); process.exitCode = 1; }
};

(async () => {
  console.log('── backup + overwrite guard (real GitHub) ──');
  const testName = `zz_backup_test_${Date.now()}.json`;
  const testRepoPath = `historical_data/${testName}`;

  await check('GitHub access check passes with the token', async () => {
    const r = await re.checkGitHubAccess();
    assert.ok(r.ok, `access failed: ${r.reason}`);
  });

  await check('toRepoPath maps volume files to historical_data/… and rejects others', () => {
    assert.strictEqual(re.toRepoPath(path.join(hist, 'a.json')), 'historical_data/a.json');
    assert.strictEqual(re.toRepoPath(path.join(hist, 'soccer_epl', 'b.json')), 'historical_data/soccer_epl/b.json');
    assert.strictEqual(re.toRepoPath(path.join(sandbox, 'other.json')), null);
  });

  await check('recSaveRecord never shrinks an existing bigger recording', () => {
    const id = 'guard_test_fight';
    const big = { oddsHistory: Array.from({ length: 50 }, (_, i) => ({ timestamp: new Date(i).toISOString(), fighter1: { name: 'A', numericOdds: i }, fighter2: { name: 'B', numericOdds: -i } })), meta: { sport: 'mma_mixed_martial_arts', fighter1: 'A', fighter2: 'B', startTime: new Date().toISOString() } };
    const small = { ...big, oddsHistory: big.oddsHistory.slice(0, 5) };
    const r1 = re.recSaveRecord(id, big);
    assert.ok(r1.saved);
    const r2 = re.recSaveRecord(id, small);
    assert.ok(r2.saved);
    assert.notStrictEqual(r2.filePath, r1.filePath, 'smaller save must not replace the bigger file');
    assert.strictEqual(JSON.parse(fs.readFileSync(r1.filePath, 'utf8')).dataPoints, 50, 'bigger file must be intact');
    assert.strictEqual(JSON.parse(fs.readFileSync(r2.filePath, 'utf8')).dataPoints, 5);
  });

  await check('recSaveRecord overwrites when the new recording is at least as big', () => {
    const id = 'grow_test_fight';
    const mk = n => ({ oddsHistory: Array.from({ length: n }, (_, i) => ({ timestamp: new Date(i).toISOString(), fighter1: { name: 'A', numericOdds: i }, fighter2: { name: 'B', numericOdds: -i } })), meta: { sport: 'mma_mixed_martial_arts', fighter1: 'A', fighter2: 'B', startTime: new Date().toISOString() } });
    const r1 = re.recSaveRecord(id, mk(3));
    const r2 = re.recSaveRecord(id, mk(7));
    assert.strictEqual(r2.filePath, r1.filePath);
    assert.strictEqual(JSON.parse(fs.readFileSync(r1.filePath, 'utf8')).dataPoints, 7);
  });

  await check('a new local file is backed up to data-backup and verified on GitHub', async () => {
    fs.writeFileSync(path.join(hist, testName), JSON.stringify({ fightId: 'zz', dataPoints: 1, oddsHistory: [{}] }));
    await re.pushFightToGitHub(path.join(hist, testName));
    assert.ok(!(re.backupStats.lastError && re.backupStats.lastError.includes(testName)), String(re.backupStats.lastError));
    const r = await re.checkGitHubAccess();
    assert.ok(r.ok);
    const { execFileSync } = require('child_process');
    const out = execFileSync('gh', ['api', `repos/lapat/ufc-dashboard/contents/${testRepoPath}?ref=data-backup`, '--jq', '.name']).toString().trim();
    assert.strictEqual(out, testName);
  });

  await check('pushing a file that already exists remotely does not overwrite it', async () => {
    const before = re.backupStats.skippedExisting;
    await re.pushFightToGitHub(path.join(hist, testName));
    assert.ok(re.backupStats.skippedExisting > before, 'second push should be skipped as existing');
  });

  // Guard-test files were only for the overwrite checks; keep them out of the reconcile below.
  for (const f of ['guard_test_fight.json','grow_test_fight.json']) for (const g of fs.readdirSync(hist)) if (g.startsWith(f.replace('.json',''))) fs.rmSync(path.join(hist,g));

  await check('reconcile is idempotent: a second run pushes nothing new for files already remote', async () => {
    const r = await re.reconcileBackups();
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.failed, 0);
    assert.ok(r.localFiles >= 1);
  });

  // Cleanup: remove the single test file from the backup branch.
  try {
    const { execFileSync } = require('child_process');
    const sha = execFileSync('gh', ['api', `repos/lapat/ufc-dashboard/contents/${testRepoPath}?ref=data-backup`, '--jq', '.sha']).toString().trim();
    execFileSync('gh', ['api', '-X', 'DELETE', `repos/lapat/ufc-dashboard/contents/${testRepoPath}`, '-f', `sha=${sha}`, '-f', 'message=[test] remove backup test file', '-f', 'branch=data-backup'], { stdio: 'ignore' });
    console.log('  (cleanup: removed test file from data-backup)');
  } catch (e) { console.log('  (cleanup failed, remove manually:', testRepoPath, ')'); }

  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
  process.exit(process.exitCode || 0);
})();
