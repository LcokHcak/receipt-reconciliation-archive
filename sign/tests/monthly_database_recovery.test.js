'use strict';

/**
 * Tests crash-recovery + busy_timeout behavior of openMonthlyDatabase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createStageJobRepository } = require('../repositories/stage_job_repository');

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-db-'));
  const dbPath = path.join(dir, 'monthly.sqlite');
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });
  return dbPath;
}

test('openMonthlyDatabase recovers orphan running stage_job rows on boot', (t) => {
  const dbPath = tmpDb(t);

  // Boot 1: open DB, simulate a crash by leaving a running stage_job
  let db = openMonthlyDatabase({ dbPath });
  const repo1 = createStageJobRepository({ db });
  const job = repo1.acquire({ workspaceKey: '2026-01', stage: 'tour_match' });
  assert.equal(job.status, 'running');
  // Simulate process exit without finish()
  db.close();

  // Boot 2: reopen, recovery should fire
  db = openMonthlyDatabase({ dbPath });
  const repo2 = createStageJobRepository({ db });
  const after = repo2.findById({ id: job.id });
  assert.equal(after.status, 'cancelled');
  assert.match(after.errorMessage, /recovered_from_crash_on_boot/);

  // Now a new acquire should succeed (lock no longer held)
  const fresh = repo2.acquire({ workspaceKey: '2026-01', stage: 'tour_match' });
  assert.equal(fresh.status, 'running');
  assert.notEqual(fresh.id, job.id);

  db.close();
});

test('openMonthlyDatabase sets busy_timeout', (t) => {
  const dbPath = tmpDb(t);
  const db = openMonthlyDatabase({ dbPath });
  const row = db.prepare('PRAGMA busy_timeout').get();
  assert.equal(row.timeout, 5000);
  db.close();
});

test('openMonthlyDatabase recovery is idempotent when there is nothing to recover', (t) => {
  const dbPath = tmpDb(t);
  const db = openMonthlyDatabase({ dbPath });
  // schema is fresh, no running rows — call open again to confirm no error
  db.close();
  const db2 = openMonthlyDatabase({ dbPath });
  const repo = createStageJobRepository({ db: db2 });
  const recent = repo.listRecent({ workspaceKey: '2026-01', limit: 5 });
  assert.equal(recent.length, 0);
  db2.close();
});
