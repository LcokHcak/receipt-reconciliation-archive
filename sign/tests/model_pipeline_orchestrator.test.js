const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createModelPipelineOrchestrator,
  normalizeStageTimings,
  recordStageTiming,
} = require('../lib/model_pipeline_orchestrator');

test('runStage records elapsed time and returns action result', async () => {
  const ticks = [100, 145];
  const orchestrator = createModelPipelineOrchestrator({
    nowMs: () => ticks.shift(),
  });
  const progress = {};

  const result = await orchestrator.runStage(progress, 'ocr', async () => ({ ok: true }));

  assert.deepEqual(result, { ok: true });
  assert.equal(progress.currentStage, '');
  assert.equal(progress.lastCompletedStage, 'ocr');
  assert.deepEqual(progress.stageTimings.ocr, {
    runs: 1,
    totalMs: 45,
    lastMs: 45,
    failedRuns: 0,
  });
});

test('runStage records failed stage and rethrows the error', async () => {
  const ticks = [200, 260];
  const orchestrator = createModelPipelineOrchestrator({
    nowMs: () => ticks.shift(),
  });
  const progress = {};
  const failure = new Error('model unavailable');

  await assert.rejects(
    () => orchestrator.runStage(progress, 'classification', async () => {
      throw failure;
    }),
    failure
  );

  assert.equal(progress.currentStage, 'classification');
  assert.equal(progress.failedStage, 'classification');
  assert.equal(progress.lastStageError, 'model unavailable');
  assert.deepEqual(progress.stageTimings.classification, {
    runs: 1,
    totalMs: 60,
    lastMs: 60,
    failedRuns: 1,
  });
});

test('recordStageTiming accumulates repeat stage runs', () => {
  const progress = {
    stageTimings: {
      ocr: {
        runs: 1,
        totalMs: 30,
        lastMs: 30,
        failedRuns: 0,
      },
    },
  };

  recordStageTiming(progress, 'ocr', 20);

  assert.deepEqual(progress.stageTimings.ocr, {
    runs: 2,
    totalMs: 50,
    lastMs: 20,
    failedRuns: 0,
  });
});

test('runPersistedStage delegates begin and finish hooks', async () => {
  const ticks = [300, 330];
  const orchestrator = createModelPipelineOrchestrator({
    nowMs: () => ticks.shift(),
  });
  const calls = [];

  const result = await orchestrator.runPersistedStage({
    stageName: 'apply_results',
    begin: async (stageName) => calls.push(['begin', stageName]),
    action: async () => 'done',
    finish: async (payload) => calls.push(['finish', payload]),
  });

  assert.equal(result, 'done');
  assert.equal(calls[0][0], 'begin');
  assert.equal(calls[0][1], 'apply_results');
  assert.deepEqual(calls[1], [
    'finish',
    {
      stageName: 'apply_results',
      elapsedMs: 30,
      error: null,
    },
  ]);
});

test('normalizeStageTimings drops invalid stage names and clamps invalid numbers', () => {
  assert.deepEqual(
    normalizeStageTimings({
      ocr: { runs: 2, totalMs: 80, lastMs: 40, failedRuns: 1 },
      '': { runs: 1 },
      classification: { runs: -1, totalMs: 'bad', lastMs: 8 },
    }),
    {
      ocr: { runs: 2, totalMs: 80, lastMs: 40, failedRuns: 1 },
      classification: { runs: 0, totalMs: 0, lastMs: 8, failedRuns: 0 },
    }
  );
});
