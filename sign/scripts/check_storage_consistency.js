#!/usr/bin/env node

/**
 * Check data consistency between SQLite and JSON backups
 *
 * This script:
 * 1. Reads data from SQLite
 * 2. Reads data from JSON backups
 * 3. Compares and reports discrepancies
 */

const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const DB_PATH = path.join(STORAGE_DIR, 'workbench_v2.db');
const BACKUP_DIR = path.join(STORAGE_DIR, 'backups');

/**
 * Check if database exists
 */
async function checkDatabaseExists() {
  try {
    await fs.access(DB_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all batches from SQLite
 */
async function getBatchesFromDB(db) {
  const batches = await db.all('SELECT * FROM batches');
  const batchesWithTasks = [];

  for (const batch of batches) {
    const tasks = await db.all('SELECT * FROM tasks WHERE batch_id = ?', [batch.id]);
    batchesWithTasks.push({
      ...batch,
      tasks,
    });
  }

  return batchesWithTasks;
}

/**
 * Get all batches from JSON backups
 */
async function getBatchesFromJSON() {
  const batchesDir = path.join(BACKUP_DIR, 'batches');

  try {
    const files = await fs.readdir(batchesDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    const batches = [];
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(batchesDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const batch = JSON.parse(content);
        batches.push(batch);
      } catch (error) {
        console.error(`Failed to read ${file}:`, error.message);
      }
    }

    return batches;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Compare batches
 */
function compareBatches(dbBatches, jsonBatches) {
  const issues = [];

  // Create maps for easy lookup
  const dbMap = new Map(dbBatches.map(b => [b.id, b]));
  const jsonMap = new Map(jsonBatches.map(b => [b.id, b]));

  // Check for batches in DB but not in JSON
  for (const [id, batch] of dbMap) {
    if (!jsonMap.has(id)) {
      issues.push({
        type: 'missing_json_backup',
        batchId: id,
        batchName: batch.name,
        message: `Batch ${id} exists in DB but has no JSON backup`,
      });
    }
  }

  // Check for batches in JSON but not in DB
  for (const [id, batch] of jsonMap) {
    if (!dbMap.has(id)) {
      issues.push({
        type: 'missing_db_record',
        batchId: id,
        batchName: batch.name,
        message: `Batch ${id} exists in JSON but not in DB`,
      });
    }
  }

  // Check for task count mismatches
  for (const [id, dbBatch] of dbMap) {
    const jsonBatch = jsonMap.get(id);
    if (jsonBatch) {
      const dbTaskCount = dbBatch.tasks.length;
      const jsonTaskCount = jsonBatch.tasks ? jsonBatch.tasks.length : 0;

      if (dbTaskCount !== jsonTaskCount) {
        issues.push({
          type: 'task_count_mismatch',
          batchId: id,
          batchName: dbBatch.name,
          dbCount: dbTaskCount,
          jsonCount: jsonTaskCount,
          message: `Batch ${id} has ${dbTaskCount} tasks in DB but ${jsonTaskCount} in JSON`,
        });
      }
    }
  }

  return issues;
}

/**
 * Main check function
 */
async function checkConsistency() {
  console.log('[Consistency Check] Starting...');
  console.log('[Consistency Check] Database:', DB_PATH);
  console.log('[Consistency Check] Backup dir:', BACKUP_DIR);

  // 1. Check if database exists
  const dbExists = await checkDatabaseExists();
  if (!dbExists) {
    console.error('[Consistency Check] ✗ Database does not exist');
    console.log('[Consistency Check] Run migration first: npm run migrate');
    return;
  }

  // 2. Open database
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  // 3. Get data from both sources
  console.log('[Consistency Check] Reading from SQLite...');
  const dbBatches = await getBatchesFromDB(db);

  console.log('[Consistency Check] Reading from JSON backups...');
  const jsonBatches = await getBatchesFromJSON();

  console.log(`[Consistency Check] Found ${dbBatches.length} batches in DB`);
  console.log(`[Consistency Check] Found ${jsonBatches.length} batches in JSON`);

  // 4. Compare
  const issues = compareBatches(dbBatches, jsonBatches);

  // 5. Report
  console.log('\n[Consistency Check] Results:');
  if (issues.length === 0) {
    console.log('  ✓ No issues found - data is consistent!');
  } else {
    console.log(`  ✗ Found ${issues.length} issues:\n`);

    const byType = {};
    for (const issue of issues) {
      if (!byType[issue.type]) {
        byType[issue.type] = [];
      }
      byType[issue.type].push(issue);
    }

    for (const [type, typeIssues] of Object.entries(byType)) {
      console.log(`  ${type}: ${typeIssues.length} issues`);
      for (const issue of typeIssues.slice(0, 5)) {
        console.log(`    - ${issue.message}`);
      }
      if (typeIssues.length > 5) {
        console.log(`    ... and ${typeIssues.length - 5} more`);
      }
      console.log('');
    }
  }

  // 6. Statistics
  const totalTasks = dbBatches.reduce((sum, b) => sum + b.tasks.length, 0);
  console.log('[Consistency Check] Statistics:');
  console.log(`  Total batches: ${dbBatches.length}`);
  console.log(`  Total tasks: ${totalTasks}`);
  console.log(`  Issues found: ${issues.length}`);

  await db.close();

  return issues.length === 0;
}

// Run check
if (require.main === module) {
  checkConsistency()
    .then((success) => {
      console.log('\n[Consistency Check] Done');
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('[Consistency Check] Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { checkConsistency };
