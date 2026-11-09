'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createStageJobRepository } = require('../../repositories/stage_job_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createStageRetryService } = require('../../services/monthly/stage_retry_service');
const { runStageWithLock } = require('../../lib/monthly_pipeline/stage_lock');
const { registerStageRoutes } = require('../../routes/monthly/stage_routes');
const {
  createPipelineLockService,
  recoverOrphanLocks,
} = require('../../services/monthly/pipeline_lock_service');

const WS = 'demo-2026-05';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-pipeline-lock-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const stageJobRepo = createStageJobRepository({ db });
  const pipelineLockService = createPipelineLockService({ db });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'acceptance' });

  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });

  return {
    db,
    stageJobRepo,
    pipelineLockService,
    workspaceService,
  };
}

async function setupStageApp(t) {
  const ctx = setup(t);
  const app = express();
  app.use(express.json());

  let billMatchRuns = 0;
  registerStageRoutes({
    app,
    guards: { intake: [] },
    deps: {
      workspaceService: ctx.workspaceService,
      stageJobRepo: ctx.stageJobRepo,
      pipelineLockService: ctx.pipelineLockService,
      storeBillRepo: { countByWorkspace: () => 1 },
      billMatchService: {
        async run() {
          billMatchRuns += 1;
          return { matched: 0, scanned: 0 };
        },
      },
    },
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());

  return {
    ...ctx,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getBillMatchRuns: () => billMatchRuns,
  };
}

test('A4: single stage can acquire, release, and acquire again', (t) => {
  const { pipelineLockService } = setup(t);

  const first = pipelineLockService.acquirePipelineLock({
    workspaceKey: WS,
    stage: 'merge',
    jobId: 1,
    operator: 'acceptance',
  });
  assert.equal(first.acquired, true);
  assert.equal(pipelineLockService.releasePipelineLock({ workspaceKey: WS }).released, true);

  const second = pipelineLockService.acquirePipelineLock({
    workspaceKey: WS,
    stage: 'merge',
    jobId: 2,
    operator: 'acceptance',
  });
  assert.equal(second.acquired, true);
  assert.equal(second.jobId, 2);
});

test('A4: pipeline lock rejects a different stage on the same workspace', (t) => {
  const { pipelineLockService } = setup(t);
  pipelineLockService.acquirePipelineLock({
    workspaceKey: WS,
    stage: 'merge',
    jobId: 11,
    operator: 'acceptance',
  });

  assert.throws(() => {
    pipelineLockService.acquirePipelineLock({
      workspaceKey: WS,
      stage: 'bill_match',
      jobId: 12,
      operator: 'acceptance',
    });
  }, (error) => {
    assert.equal(error.code, 'PIPELINE_LOCKED');
    assert.equal(error.runningStage, 'merge');
    assert.equal(error.runningJobId, 11);
    return true;
  });
});

test('A4: HTTP stage endpoint returns 423 when another stage owns the workspace lock', async (t) => {
  const { baseUrl, db, getBillMatchRuns } = await setupStageApp(t);
  db.prepare(`
    INSERT INTO pipeline_lock (workspace_key, stage, job_id, acquired_at, acquired_by)
    VALUES (?, 'merge', 123, ?, 'acceptance')
  `).run(WS, new Date().toISOString());

  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stages/bill-match`, {
    method: 'POST',
  });
  const body = await res.json();

  assert.equal(res.status, 423);
  assert.equal(body.error, 'pipeline_locked');
  assert.equal(body.code, 'PIPELINE_LOCKED');
  assert.equal(body.runningStage, 'merge');
  assert.equal(body.runningJobId, 123);
  assert.match(body.message, /merge/);
  assert.equal(getBillMatchRuns(), 0);
});

test('A4: recoverOrphanLocks clears startup leftovers', (t) => {
  const { db } = setup(t);
  db.prepare(`
    INSERT INTO pipeline_lock (workspace_key, stage, job_id, acquired_at, acquired_by)
    VALUES (?, 'merge', 5, ?, 'acceptance')
  `).run(WS, new Date().toISOString());

  const cleared = recoverOrphanLocks(db);
  assert.equal(cleared, 1);
  const row = db.prepare('SELECT * FROM pipeline_lock WHERE workspace_key = ?').get(WS);
  assert.equal(row, undefined);
});

test('A4: failed stage releases the pipeline lock in finally', async (t) => {
  const { stageJobRepo, pipelineLockService } = setup(t);

  await assert.rejects(() => runStageWithLock({
    stageJobRepo,
    pipelineLockService,
    workspaceKey: WS,
    stage: 'merge',
    operator: 'acceptance',
    run: async () => {
      throw new Error('boom');
    },
  }), /boom/);

  const next = pipelineLockService.acquirePipelineLock({
    workspaceKey: WS,
    stage: 'bill_match',
    jobId: 55,
    operator: 'acceptance',
  });
  assert.equal(next.acquired, true);
});

test('A4: releasing an empty lock is idempotent', (t) => {
  const { pipelineLockService } = setup(t);

  pipelineLockService.acquirePipelineLock({
    workspaceKey: WS,
    stage: 'merge',
    jobId: 7,
    operator: 'acceptance',
  });
  assert.deepEqual(pipelineLockService.releasePipelineLock({ workspaceKey: WS }), { released: true });
  assert.deepEqual(
    pipelineLockService.releasePipelineLock({ workspaceKey: WS }),
    { released: false, reason: 'no_active_lock' }
  );
});

test('A4: stage retry respects the workspace pipeline lock', async (t) => {
  const { db, stageJobRepo, pipelineLockService } = setup(t);
  let billMatchRuns = 0;
  pipelineLockService.acquirePipelineLock({
    workspaceKey: WS,
    stage: 'merge',
    jobId: 99,
    operator: 'acceptance',
  });

  const { job } = stageJobRepo.createStageJob({
    workspaceKey: WS,
    stage: 'bill_match',
    operator: 'acceptance',
    startedAt: minutesAgo(10),
  });
  stageJobRepo.finish({
    id: job.id,
    status: 'failed',
    errorMessage: 'temporary upstream error',
    finishedAt: minutesAgo(5),
  });

  const retryService = createStageRetryService({
    stageJobRepo,
    billMatchService: {
      async run() {
        billMatchRuns += 1;
        return { matched: 1 };
      },
    },
    db,
    pipelineLockService,
  });

  await retryService.checkAndRetry();

  const after = stageJobRepo.findById({ id: job.id });
  assert.equal(billMatchRuns, 0);
  assert.equal(after.status, 'failed');
  assert.match(after.errorMessage, /pipeline_locked/);
  assert.equal(retryService.getRetryCount(job.id), 1);
  assert.equal(
    retryService.getRetryHistory({ workspaceKey: WS, stage: 'bill_match' })[0].result,
    'failed'
  );
});

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}
