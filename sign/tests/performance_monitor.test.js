const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PerformanceMonitor,
  createPerformanceMonitor,
} = require('../lib/performance_monitor');

test('PerformanceMonitor records and logs completed timings above the threshold', () => {
  const logs = [];
  let now = 100;
  const monitor = new PerformanceMonitor({
    logger: (message) => logs.push(message),
    now: () => now,
    slowThresholdMs: 25,
  });

  monitor.start('api.state');
  now = 140;
  const duration = monitor.end('api.state', { batchCount: 50 });

  assert.equal(duration, 40);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[perf\] api\.state: 40ms/);
  assert.match(logs[0], /batchCount=50/);
  assert.deepEqual(monitor.getActiveLabels(), []);
});

test('PerformanceMonitor warns when a timing crosses the slow threshold', () => {
  const logs = [];
  const warnings = [];
  let now = 1000;
  const monitor = new PerformanceMonitor({
    logger: (message) => logs.push(message),
    warnLogger: (message) => warnings.push(message),
    now: () => now,
    slowThresholdMs: 25,
    slowWarningThresholdMs: 1000,
  });

  monitor.start('batch.ocr');
  now = 2500;
  const duration = monitor.end('batch.ocr', { taskCount: 300 });

  assert.equal(duration, 1500);
  assert.equal(logs.length, 1);
  assert.deepEqual(warnings, ['[perf] SLOW batch.ocr: 1500ms taskCount=300']);
});

test('PerformanceMonitor skips logs below threshold and can measure sync actions', () => {
  const logs = [];
  let now = 0;
  const monitor = new PerformanceMonitor({
    logger: (message) => logs.push(message),
    now: () => now,
    slowThresholdMs: 100,
  });

  const result = monitor.measureSync('fast.path', () => {
    now = 10;
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.deepEqual(logs, []);
});

test('PerformanceMonitor measures async actions and clears active labels after failure', async () => {
  const logs = [];
  let now = 200;
  const monitor = new PerformanceMonitor({
    logger: (message) => logs.push(message),
    now: () => now,
    slowThresholdMs: 10,
  });

  await assert.rejects(
    monitor.measure('async.ocr', async () => {
      now = 235;
      throw new Error('ocr unavailable');
    }),
    /ocr unavailable/
  );

  assert.deepEqual(monitor.getActiveLabels(), []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[perf\] async\.ocr: 35ms/);
}
);

test('createPerformanceMonitor honors disabled configuration', () => {
  const monitor = createPerformanceMonitor({ enabled: false });

  monitor.start('disabled.path');

  assert.equal(monitor.end('disabled.path'), 0);
  assert.deepEqual(monitor.getActiveLabels(), []);
});
