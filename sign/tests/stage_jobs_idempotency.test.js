'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createStageJobRepository } = require('../repositories/stage_job_repository');

const WORKSPACE_KEY = '2026-05';
const STAGE = 'bill_match';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-job-idempotency-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createStageJobRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });
  return { db, repo };
}

test('createStageJob reuses an active job for the same idempotencyKey', (t) => {
  const { repo } = setup(t);

  const first = repo.createStageJob({
    workspaceKey: WORKSPACE_KEY,
    stage: STAGE,
    operator: 'finance',
    idempotencyKey: 'click-1',
  });
  const second = repo.createStageJob({
    workspaceKey: WORKSPACE_KEY,
    stage: STAGE,
    operator: 'finance',
    idempotencyKey: 'click-1',
  });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(repo.listRecent({ workspaceKey: WORKSPACE_KEY, stage: STAGE, limit: 10 }).length, 1);
});

test('createStageJob allows retry with the same idempotencyKey after failure', (t) => {
  const { repo } = setup(t);
  const first = repo.createStageJob({
    workspaceKey: WORKSPACE_KEY,
    stage: STAGE,
    idempotencyKey: 'retry-after-fail',
  });
  repo.finish({ id: first.job.id, status: 'failed', errorMessage: 'boom' });

  const second = repo.createStageJob({
    workspaceKey: WORKSPACE_KEY,
    stage: STAGE,
    idempotencyKey: 'retry-after-fail',
  });

  assert.equal(second.reused, false);
  assert.notEqual(second.job.id, first.job.id);
  assert.equal(second.job.status, 'running');
});

test('createStageJob keeps legacy no-idempotency behavior', (t) => {
  const { repo } = setup(t);
  const first = repo.createStageJob({ workspaceKey: WORKSPACE_KEY, stage: STAGE });
  repo.finish({ id: first.job.id, status: 'succeeded', stats: { matched: 1 } });
  const second = repo.createStageJob({ workspaceKey: WORKSPACE_KEY, stage: STAGE });

  assert.equal(first.reused, false);
  assert.equal(second.reused, false);
  assert.notEqual(second.job.id, first.job.id);
});

test('stage_job migration adds idempotency_key column and active partial index', (t) => {
  const { db } = setup(t);
  const columns = db.prepare("PRAGMA table_info('stage_job')").all().map((row) => row.name);
  assert.ok(columns.includes('idempotency_key'));
  const index = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_stage_jobs_active_idempotency'`
  ).get();
  assert.match(index.sql, /WHERE idempotency_key IS NOT NULL AND status IN \('running','succeeded'\)/);
});
