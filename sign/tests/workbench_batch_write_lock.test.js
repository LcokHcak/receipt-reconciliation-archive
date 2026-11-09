const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BatchWriteTimeoutError,
  createWorkbenchBatchRepository,
} = require('../repositories/workbench_batch_repository');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRepository({ logger } = {}) {
  return createWorkbenchBatchRepository({
    batchesRoot: 'unused',
    normalizeBatch: (batch) => batch,
    summarizeBatch: (batch) => batch,
    logger,
  });
}

test('withBatchWrite serializes actions for the same batch id', async () => {
  const repository = createRepository();
  const gate = deferred();
  const order = [];

  const first = repository.withBatchWrite('batch_1', async () => {
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
    return 'first';
  }, { label: 'first' });
  const second = repository.withBatchWrite('batch_1', async () => {
    order.push('second:start');
    return 'second';
  }, { label: 'second' });

  try {
    await delay(0);
    assert.deepEqual(order, ['first:start']);

    gate.resolve();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  } finally {
    gate.resolve();
  }
});

test('withBatchWrite rejects with BatchWriteTimeoutError when an action times out', async () => {
  const errors = [];
  const repository = createRepository({
    logger: {
      warn() {},
      error(msg, fields) {
        errors.push({ msg, fields });
      },
    },
  });

  await assert.rejects(
    repository.withBatchWrite('batch_timeout', () => new Promise(() => {}), {
      label: 'stuckAction',
      timeoutMs: 10,
    }),
    (error) => {
      assert.ok(error instanceof BatchWriteTimeoutError);
      assert.equal(error.code, 'BATCH_WRITE_TIMEOUT');
      assert.equal(error.batchId, 'batch_timeout');
      assert.equal(error.label, 'stuckAction');
      assert.equal(error.timeoutMs, 10);
      assert.equal(typeof error.waitedMs, 'number');
      assert.equal(typeof error.queueDepth, 'number');
      assert.match(error.message, /batch_timeout/);
      assert.match(error.message, /stuckAction/);
      return true;
    }
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].msg, 'batch_write_timeout');
  assert.equal(errors[0].fields.batchId, 'batch_timeout');
  assert.equal(errors[0].fields.label, 'stuckAction');
});

test('withBatchWrite lets the next action continue after a timed out slot', async () => {
  const repository = createRepository({
    logger: { warn() {}, error() {} },
  });

  const first = repository.withBatchWrite('batch_timeout_chain', () => new Promise(() => {}), {
    label: 'stuckAction',
    timeoutMs: 10,
  });
  const second = repository.withBatchWrite('batch_timeout_chain', async () => 'after-timeout', {
    label: 'afterTimeout',
    timeoutMs: 100,
  });

  await assert.rejects(first, BatchWriteTimeoutError);
  assert.equal(await second, 'after-timeout');
});

test('withBatchWrite emits a slow acquire warning when queue wait exceeds threshold', async () => {
  const warnings = [];
  const repository = createRepository({
    logger: {
      warn(msg, fields) {
        warnings.push({ msg, fields });
      },
      error() {},
    },
  });

  const first = repository.withBatchWrite('batch_warn', async () => {
    await delay(20);
  }, { label: 'first' });
  const second = repository.withBatchWrite('batch_warn', async () => 'second', {
    label: 'second',
    acquireWarnMs: 1,
  });

  await Promise.all([first, second]);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, 'batch_write_slow_acquire');
  assert.equal(warnings[0].fields.batchId, 'batch_warn');
  assert.equal(warnings[0].fields.label, 'second');
  assert.ok(warnings[0].fields.waitedMs >= 1);
});

test('getQueueMetrics reports depth, oldest label, and oldest age', async () => {
  const repository = createRepository();
  const gate = deferred();

  const first = repository.withBatchWrite('batch_metrics', async () => {
    await gate.promise;
  }, { label: 'metricFirst' });
  const second = repository.withBatchWrite('batch_metrics', async () => 'done', {
    label: 'metricSecond',
  });

  await Promise.resolve();
  const metrics = repository.getQueueMetrics();

  assert.equal(metrics.totalQueues, 1);
  assert.equal(metrics.maxDepth, 2);
  assert.deepEqual(metrics.perBatch.map((entry) => ({
    batchId: entry.batchId,
    depth: entry.depth,
    oldestLabel: entry.oldestLabel,
  })), [{
    batchId: 'batch_metrics',
    depth: 2,
    oldestLabel: 'metricFirst',
  }]);
  assert.equal(typeof metrics.perBatch[0].oldestAgeMs, 'number');

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(repository.getQueueMetrics(), {
    totalQueues: 0,
    maxDepth: 0,
    perBatch: [],
  });
});

test('withBatchWrite defaults the metrics label to unknown', async () => {
  const repository = createRepository();

  const oldestLabel = await repository.withBatchWrite('batch_default_label', async () => (
    repository.getQueueMetrics().perBatch[0].oldestLabel
  ));

  assert.equal(oldestLabel, 'unknown');
});
