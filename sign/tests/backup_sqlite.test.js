'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { createBackup, verifyBackup, findSqliteFiles } = require('../scripts/backup_sqlite');

test('createBackup hot-copies storage SQLite databases and recovery assets', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-'));
  const storage = path.join(root, 'passport_review_workbench', 'storage');
  await fsp.mkdir(storage, { recursive: true });

  for (const dbName of ['workbench.sqlite', 'monthly.sqlite', 'workbench_v2.db']) {
    await createTinyDatabase(path.join(storage, dbName));
  }

  await fsp.mkdir(path.join(storage, 'backups', 'batches'), { recursive: true });
  await fsp.writeFile(path.join(storage, 'backups', 'batches', 'batch_a.json'), '{"id":"batch_a"}');
  await fsp.mkdir(path.join(storage, 'batches', 'batch_a'), { recursive: true });
  await fsp.writeFile(path.join(storage, 'batches', 'batch_a', 'source.txt'), 'source image placeholder');
  await fsp.mkdir(path.join(storage, 'customer_library'), { recursive: true });
  await fsp.writeFile(path.join(storage, 'customer_library', 'customer.txt'), 'customer asset');
  await fsp.mkdir(path.join(storage, 'monthly-exports'), { recursive: true });
  await fsp.writeFile(path.join(storage, 'monthly-exports', 'export.xlsx'), 'xlsx placeholder');
  await fsp.mkdir(path.join(storage, 'tmp_uploads'), { recursive: true });
  await fsp.writeFile(path.join(storage, 'tmp_uploads', 'ignore.tmp'), 'transient');

  const result = await createBackup({
    sourceRoot: root,
    targetRoot: path.join(root, 'backup-target'),
    retain: 5,
    now: () => new Date(2026, 4, 12, 4, 5, 6),
  });

  assert.match(result.backupDir, /20260512-040506$/);
  assert.equal(result.manifest.sqlite.length, 3);
  assert.ok(result.manifest.sqlite.every((entry) => entry.integrityCheck === 'ok'));
  assert.ok(fs.existsSync(path.join(result.backupDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(result.backupDir, 'files', 'passport_review_workbench', 'storage', 'backups', 'batches', 'batch_a.json')));
  assert.ok(fs.existsSync(path.join(result.backupDir, 'files', 'passport_review_workbench', 'storage', 'batches', 'batch_a', 'source.txt')));
  assert.equal(fs.existsSync(path.join(result.backupDir, 'files', 'passport_review_workbench', 'storage', 'tmp_uploads', 'ignore.tmp')), false);

  const verified = await verifyBackup({ backupDir: result.backupDir });
  assert.equal(verified.sqliteCount, 3);
  assert.ok(verified.fileCount >= 3);
});

test('verifyBackup rejects a corrupted SQLite backup', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-corrupt-'));
  const storage = path.join(root, 'passport_review_workbench', 'storage');
  await fsp.mkdir(storage, { recursive: true });
  await createTinyDatabase(path.join(storage, 'workbench.sqlite'));

  const result = await createBackup({
    sourceRoot: root,
    targetRoot: path.join(root, 'backup-target'),
    now: () => new Date(2026, 4, 12, 4, 5, 6),
  });
  const backupDb = path.join(result.backupDir, result.manifest.sqlite[0].backupPath);
  await fsp.writeFile(backupDb, 'not a sqlite database');

  await assert.rejects(
    () => verifyBackup({ backupDir: result.backupDir }),
    /sha256 mismatch|file is not a database|database disk image is malformed/
  );
});

test('findSqliteFiles finds only top-level DBs and never descends into the huge asset dirs', async () => {
  // 回归:2026-07-05 起夜间备份连崩,根因是 findSqliteFiles 遍历了 40 万+ 文件的
  // customer_library/batches,老 walkFiles 用 push(...spread) 撞上 V8 实参上限而爆栈。
  // 现在必须只扫 storage 顶层、跳过这些巨型目录;顺带确认埋在里面的诱饵库不会被收进来。
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sqlite-skip-'));
  const storage = path.join(root, 'passport_review_workbench', 'storage');
  await fsp.mkdir(storage, { recursive: true });

  await createTinyDatabase(path.join(storage, 'workbench.sqlite'));
  await createTinyDatabase(path.join(storage, 'monthly.sqlite'));

  // 埋在巨型资源目录深处的诱饵库:绝不能被 findSqliteFiles 找到(否则=又在遍历那棵树)。
  for (const sub of ['customer_library', 'batches', 'monthly-exports']) {
    const deep = path.join(storage, sub, 'a', 'b', 'c');
    await fsp.mkdir(deep, { recursive: true });
    await createTinyDatabase(path.join(deep, 'decoy.sqlite'));
  }

  const found = await findSqliteFiles(root);
  const names = found.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ['monthly.sqlite', 'workbench.sqlite']);
  assert.ok(!found.some((f) => f.includes('decoy')), '不得钻进 customer_library/batches 等巨型目录');
});

async function createTinyDatabase(filename) {
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT);');
  await db.run('INSERT INTO sample (value) VALUES (?)', 'ok');
  await db.close();
}
