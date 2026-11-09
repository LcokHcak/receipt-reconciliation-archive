'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { archiveBatch } = require('../scripts/archive_test_batch');

test('archiveBatch writes an audit archive and removes the confirmed test batch', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-batch-'));
  const dbPath = path.join(tmp, 'workbench_v2.db');
  const backupBatchesDir = path.join(tmp, 'backups', 'batches');
  const archiveRoot = path.join(tmp, 'archives');
  await fs.mkdir(backupBatchesDir, { recursive: true });

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE batches (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at TEXT,
      updated_at TEXT,
      status TEXT,
      metadata TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      source_key TEXT,
      status TEXT
    );
  `);
  await db.run(
    'INSERT INTO batches (id, name, created_at, updated_at, status, metadata) VALUES (?, ?, ?, ?, ?, ?)',
    ['batch_test_dirty', 'stress import test', '2026-05-05T00:00:00.000Z', '2026-05-05T01:00:00.000Z', 'completed', '{}']
  );
  await db.run(
    'INSERT INTO tasks (id, batch_id, source_key, status) VALUES (?, ?, ?, ?)',
    ['task_1', 'batch_test_dirty', 'a.jpg', 'completed']
  );
  await db.run(
    'INSERT INTO tasks (id, batch_id, source_key, status) VALUES (?, ?, ?, ?)',
    ['task_2', 'batch_test_dirty', 'b.jpg', 'completed']
  );
  await db.close();

  const corruptBackup = path.join(backupBatchesDir, 'batch_test_dirty.json');
  await fs.writeFile(corruptBackup, '');

  const result = await archiveBatch({
    batchId: 'batch_test_dirty',
    dbPath,
    backupBatchesDir,
    archiveRoot,
    reason: 'confirmed historical stress-test data',
    now: () => new Date(2026, 4, 12, 4, 5, 6),
  });

  assert.equal(result.deletedTasks, 2);
  assert.equal(result.deletedBatches, 1);
  assert.match(result.archivePath, /batch_test_dirty-20260512-040506\.json$/);

  const archived = JSON.parse(await fs.readFile(result.archivePath, 'utf8'));
  assert.equal(archived.reason, 'confirmed historical stress-test data');
  assert.equal(archived.batch.id, 'batch_test_dirty');
  assert.equal(archived.tasks.length, 2);
  assert.equal(archived.jsonBackup.existed, true);
  assert.equal(archived.jsonBackup.bytes, 0);

  await assert.rejects(fs.access(corruptBackup), /ENOENT/);

  const checkDb = await open({ filename: dbPath, driver: sqlite3.Database });
  const remainingBatch = await checkDb.get('SELECT COUNT(*) AS count FROM batches WHERE id = ?', 'batch_test_dirty');
  const remainingTasks = await checkDb.get('SELECT COUNT(*) AS count FROM tasks WHERE batch_id = ?', 'batch_test_dirty');
  await checkDb.close();

  assert.equal(remainingBatch.count, 0);
  assert.equal(remainingTasks.count, 0);
});
