#!/usr/bin/env node

/**
 * Restore SQLite database from JSON backups
 *
 * This script:
 * 1. Reads all JSON backup files
 * 2. Rebuilds SQLite database from scratch
 * 3. Verifies data integrity
 *
 * Use this when SQLite database is corrupted or lost
 */

const fs = require('fs').promises;
const path = require('path');
const { initializeDatabase } = require('../lib/storage/database');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const DB_PATH = path.join(STORAGE_DIR, 'workbench_v2.db');
const BACKUP_DIR = path.join(STORAGE_DIR, 'backups');

/**
 * Read all JSON backups
 */
async function readAllBackups() {
  const batchesDir = path.join(BACKUP_DIR, 'batches');

  try {
    const files = await fs.readdir(batchesDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    console.log(`[Restore] Found ${jsonFiles.length} backup files`);

    const batches = [];
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(batchesDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const batch = JSON.parse(content);
        batches.push(batch);
      } catch (error) {
        console.error(`[Restore] Failed to read ${file}:`, error.message);
      }
    }

    return batches;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('[Restore] ✗ Backup directory not found');
      return [];
    }
    throw error;
  }
}

/**
 * Restore a batch to SQLite
 */
async function restoreBatch(db, batch) {
  const {
    id,
    name,
    created_at,
    updated_at,
    status = 'pending',
    tasks = [],
    metadata = {},
  } = batch;

  // Insert batch
  await db.run(
    `INSERT OR REPLACE INTO batches (id, name, created_at, updated_at, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      created_at || new Date().toISOString(),
      updated_at || new Date().toISOString(),
      status,
      JSON.stringify(metadata),
    ]
  );

  // Insert tasks
  for (const task of tasks) {
    const {
      id: taskId,
      source_key,
      doc_type,
      doc_type_auto,
      doc_type_final,
      doc_type_confidence,
      status: taskStatus = 'pending',
      process_result,
      confidence,
      needs_review = false,
      review_reasons = [],
      created_at: taskCreatedAt,
      updated_at: taskUpdatedAt,
      fields = {},
      ocr_result = {},
      classification = {},
      signature = {},
      metadata: taskMetadata = {},
    } = task;

    await db.run(
      `INSERT OR REPLACE INTO tasks (
        id, batch_id, source_key, doc_type, doc_type_auto, doc_type_final,
        doc_type_confidence, status, process_result, confidence, needs_review,
        review_reasons, created_at, updated_at, fields, ocr_result,
        classification, signature, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        id, // batch_id
        source_key,
        doc_type || doc_type_final,
        doc_type_auto,
        doc_type_final,
        doc_type_confidence,
        taskStatus,
        process_result,
        confidence,
        needs_review ? 1 : 0,
        JSON.stringify(review_reasons),
        taskCreatedAt || new Date().toISOString(),
        taskUpdatedAt || new Date().toISOString(),
        JSON.stringify(fields),
        JSON.stringify(ocr_result),
        JSON.stringify(classification),
        JSON.stringify(signature),
        JSON.stringify(taskMetadata),
      ]
    );
  }

  return tasks.length;
}

/**
 * Main restore function
 */
async function restore(options = {}) {
  const { force = false } = options;

  console.log('[Restore] Starting restore from JSON backups...');
  console.log('[Restore] Database:', DB_PATH);
  console.log('[Restore] Backup dir:', BACKUP_DIR);

  // 1. Check if database exists
  try {
    await fs.access(DB_PATH);
    if (!force) {
      console.error('[Restore] ✗ Database already exists');
      console.log('[Restore] Use --force to overwrite existing database');
      return false;
    }
    console.log('[Restore] Removing existing database...');
    await fs.unlink(DB_PATH);
  } catch {
    // Database doesn't exist, continue
  }

  // 2. Read backups
  const batches = await readAllBackups();
  if (batches.length === 0) {
    console.error('[Restore] ✗ No backups found');
    return false;
  }

  // 3. Initialize new database
  console.log('[Restore] Initializing database...');
  const db = await initializeDatabase(DB_PATH);

  // 4. Restore batches
  let totalTasks = 0;
  let successCount = 0;
  let errorCount = 0;

  await db.run('BEGIN TRANSACTION');

  try {
    for (const batch of batches) {
      try {
        console.log(`[Restore] Restoring batch: ${batch.name || batch.id}`);
        const taskCount = await restoreBatch(db, batch);
        totalTasks += taskCount;
        successCount++;
        console.log(`[Restore] ✓ Restored ${taskCount} tasks`);
      } catch (error) {
        errorCount++;
        console.error(`[Restore] ✗ Failed to restore batch ${batch.id}:`, error.message);
      }
    }

    await db.run('COMMIT');
  } catch (error) {
    await db.run('ROLLBACK');
    throw error;
  }

  // 5. Summary
  console.log('\n[Restore] Summary:');
  console.log(`  Total batches: ${batches.length}`);
  console.log(`  Successful: ${successCount}`);
  console.log(`  Failed: ${errorCount}`);
  console.log(`  Total tasks: ${totalTasks}`);

  // 6. Verify
  const batchCount = await db.get('SELECT COUNT(*) as count FROM batches');
  const taskCount = await db.get('SELECT COUNT(*) as count FROM tasks');

  console.log('\n[Restore] Verification:');
  console.log(`  Batches in DB: ${batchCount.count}`);
  console.log(`  Tasks in DB: ${taskCount.count}`);

  await db.close();

  if (batchCount.count === successCount && taskCount.count === totalTasks) {
    console.log('\n[Restore] ✓ Restore completed successfully!');
    return true;
  } else {
    console.log('\n[Restore] ⚠ Restore completed with discrepancies');
    return false;
  }
}

// Run restore
if (require.main === module) {
  const force = process.argv.includes('--force');

  restore({ force })
    .then((success) => {
      console.log('[Restore] Done');
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('[Restore] Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { restore };
