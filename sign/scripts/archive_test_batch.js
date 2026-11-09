#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage', 'workbench_v2.db');
const DEFAULT_BACKUP_BATCHES_DIR = path.join(
  PROJECT_ROOT,
  'passport_review_workbench',
  'storage',
  'backups',
  'batches'
);
const DEFAULT_ARCHIVE_ROOT = path.join(
  PROJECT_ROOT,
  'passport_review_workbench',
  'storage',
  'archives',
  'test-batches'
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readJsonBackupInfo(jsonBackupPath) {
  try {
    const content = await fs.readFile(jsonBackupPath);
    return {
      existed: true,
      path: jsonBackupPath,
      bytes: content.length,
      sha256: sha256(content),
      contentBase64: content.length <= 5 * 1024 * 1024 ? content.toString('base64') : null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        existed: false,
        path: jsonBackupPath,
        bytes: 0,
        sha256: null,
        contentBase64: null,
      };
    }
    throw error;
  }
}

async function archiveBatch({
  batchId,
  dbPath = DEFAULT_DB_PATH,
  backupBatchesDir = DEFAULT_BACKUP_BATCHES_DIR,
  archiveRoot = DEFAULT_ARCHIVE_ROOT,
  reason = '',
  dryRun = false,
  now = () => new Date(),
} = {}) {
  const normalizedBatchId = String(batchId || '').trim();
  if (!normalizedBatchId) {
    throw new Error('batchId is required');
  }
  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason) {
    throw new Error('reason is required');
  }

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  try {
    const batch = await db.get('SELECT * FROM batches WHERE id = ?', normalizedBatchId);
    if (!batch) {
      throw new Error(`batch not found: ${normalizedBatchId}`);
    }
    const tasks = await db.all('SELECT * FROM tasks WHERE batch_id = ? ORDER BY id', normalizedBatchId);
    const jsonBackupPath = path.join(backupBatchesDir, `${normalizedBatchId}.json`);
    const jsonBackup = await readJsonBackupInfo(jsonBackupPath);
    const archivePath = path.join(archiveRoot, `${normalizedBatchId}-${stamp(now())}.json`);

    const archive = {
      archivedAt: now().toISOString(),
      reason: normalizedReason,
      source: {
        dbPath,
        backupBatchesDir,
      },
      batch,
      tasks,
      jsonBackup,
      dryRun,
    };

    if (dryRun) {
      return {
        archivePath,
        deletedTasks: 0,
        deletedBatches: 0,
        dryRun: true,
        taskCount: tasks.length,
      };
    }

    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, JSON.stringify(archive, null, 2));

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const taskResult = await db.run('DELETE FROM tasks WHERE batch_id = ?', normalizedBatchId);
      const batchResult = await db.run('DELETE FROM batches WHERE id = ?', normalizedBatchId);
      await db.exec('COMMIT');

      if (jsonBackup.existed) {
        await fs.rm(jsonBackupPath, { force: true });
      }

      return {
        archivePath,
        deletedTasks: taskResult.changes || 0,
        deletedBatches: batchResult.changes || 0,
        dryRun: false,
        taskCount: tasks.length,
      };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    await db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const batchId = args['batch-id'] || args.batchId || args.id;
  const reason = args.reason;
  const dryRun = Boolean(args['dry-run']);
  const confirmed = Boolean(args.confirm);

  if (!dryRun && !confirmed) {
    console.error('Refusing to delete without --confirm. Use --dry-run to preview.');
    process.exit(2);
  }

  const result = await archiveBatch({
    batchId,
    reason,
    dryRun,
    dbPath: args.db ? path.resolve(args.db) : DEFAULT_DB_PATH,
    backupBatchesDir: args['backup-batches-dir']
      ? path.resolve(args['backup-batches-dir'])
      : DEFAULT_BACKUP_BATCHES_DIR,
    archiveRoot: args['archive-root'] ? path.resolve(args['archive-root']) : DEFAULT_ARCHIVE_ROOT,
  });

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    lvl: 'info',
    msg: dryRun ? 'test_batch_archive_preview' : 'test_batch_archived',
    ...result,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      lvl: 'error',
      msg: 'test_batch_archive_failed',
      err: error?.message || String(error),
    }));
    process.exit(1);
  });
}

module.exports = {
  archiveBatch,
  parseArgs,
};
