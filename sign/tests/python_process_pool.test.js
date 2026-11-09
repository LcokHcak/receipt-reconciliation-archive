const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPythonProcessPool,
  destroyPythonPool,
  getPythonPool,
} = require('../lib/python_process_pool');

function createFakeWorkerFactory() {
  let nextId = 1;
  const created = [];

  return {
    created,
    createWorker() {
      const worker = {
        id: nextId++,
        executed: 0,
        destroyed: false,
        async ping() {
          return !worker.destroyed;
        },
        async execute(scriptPath, args = []) {
          worker.executed += 1;
          if (scriptPath === 'fail.py') {
            const error = new Error('Python process failed with exit code 7');
            error.code = 7;
            error.stdout = 'partial output';
            error.stderr = 'boom';
            throw error;
          }
          return {
            code: 0,
            stdout: JSON.stringify({
              workerId: worker.id,
              scriptPath,
              args,
            }),
            stderr: '',
          };
        },
        async destroy() {
          worker.destroyed = true;
        },
      };
      created.push(worker);
      return worker;
    },
  };
}

test('Python process pool reuses workers across 50 concurrent tasks', async () => {
  const factory = createFakeWorkerFactory();
  const pool = createPythonProcessPool({
    min: 1,
    max: 5,
    createWorker: factory.createWorker,
  });

  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) => pool.execute('echo.py', [String(index)]))
  );

  const workerIds = new Set(results.map((result) => JSON.parse(result.stdout).workerId));
  assert.equal(factory.created.length <= 5, true);
  assert.equal(workerIds.size <= 5, true);
  assert.equal(1 - (factory.created.length / results.length) > 0.8, true);
  assert.equal(
    factory.created.reduce((sum, worker) => sum + worker.executed, 0),
    50
  );

  await pool.destroy();
  assert.equal(factory.created.every((worker) => worker.destroyed), true);
});

test('Python process pool releases a healthy worker after script failure', async () => {
  const factory = createFakeWorkerFactory();
  const pool = createPythonProcessPool({
    min: 1,
    max: 1,
    createWorker: factory.createWorker,
  });

  await assert.rejects(
    pool.execute('fail.py'),
    (error) => {
      assert.equal(error.stderr, 'boom');
      assert.equal(error.stdout, 'partial output');
      return /exit code 7/.test(error.message);
    }
  );

  const result = await pool.execute('ok.py', ['after-failure']);
  assert.equal(JSON.parse(result.stdout).args[0], 'after-failure');
  assert.equal(factory.created.length, 1);
  assert.equal(factory.created[0].executed, 2);

  await pool.destroy();
});

test('default Python pools are isolated by python executable', async () => {
  const first = getPythonPool({ pythonExe: 'python-a.exe', createWorker: createFakeWorkerFactory().createWorker });
  const second = getPythonPool({ pythonExe: 'python-b.exe', createWorker: createFakeWorkerFactory().createWorker });

  assert.notEqual(first, second);
  assert.equal(first.pythonExe, 'python-a.exe');
  assert.equal(second.pythonExe, 'python-b.exe');

  await destroyPythonPool();
});
