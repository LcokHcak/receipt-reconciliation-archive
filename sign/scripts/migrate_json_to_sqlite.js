#!/usr/bin/env node

/**
 * Migrate existing JSON batch data to SQLite database
 *
 * This script:
 * 1. Reads all existing JSON batch files
 * 2. Imports them into SQLite database
 * 3. Verifies data integrity
 * 4. Creates JSON backups in new format
 */

const fs = require('fs').promises;
const path = require('path');
const { initializeDatabase } = require('../lib/storage/database');
const { createStorageTransaction } = require('../lib/storage/storage_transaction');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
const OLD_BATCHES_DIR = path.join(STORAGE_DIR, 'batches');
const NEW_DB_PATH = path.join(STORAGE_DIR, 'workbench_v2.db');
const BACKUP_DIR = path.join(STORAGE_DIR, 'backups');

/**
 * Read all JSON batch files
 */
async function readExistingBatches() {
  try {
    const entries = await fs.readdir(OLD_BATCHES_DIR, { withFileTypes: true });
    const batchDirs = entries.filter(e => e.isDirectory());

    console.log(`[Migration] Found ${batchDirs.length} batch directories`);

    const batches = [];
    let skippedCount = 0;

    for (const dir of batchDirs) {
      try {
        const batchJsonPath = path.join(OLD_BATCHES_DIR, dir.name, 'batch.json');
        const content = await fs.readFile(batchJsonPath, 'utf8');
        const batch = JSON.parse(content);
        batches.push(batch);
      } catch (error) {
        if (error.code === 'ENOENT') {
          skippedCount++;
          console.log(`[Migration] Skipped ${dir.name} (no batch.json)`);
        } else {
          console.error(`[Migration] Failed to read ${dir.name}:`, error.message);
        }
      }
    }

    console.log(`[Migration] Found ${batches.length} valid batches, skipped ${skippedCount}`);
    return batches;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[Migration] No existing batches directory found');
      return [];
    }
    throw error;
  }
}

/**
 * Import a batch into SQLite
 */
async function importBatch(db, batch) {
  const {
    id,
    name,
    createdAt,
    updatedAt,
    machineState = 'pending',
    tasks = [],
    sourceGroups = [],
    recognitionProgress = {},
    ...metadata
  } = batch;

  // Insert batch
  await db.run(
    `INSERT OR REPLACE INTO batches (id, name, created_at, updated_at, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      createdAt || new Date().toISOString(),
      updatedAt || new Date().toISOString(),
      machineState,
      JSON.stringify({ sourceGroups, recognitionProgress, ...metadata }),
    ]
  );

  // Insert tasks
  let insertedCount = 0;
  let errorCount = 0;

  for (const task of tasks) {
    try {
      const {
        id: taskId,
        sourceKey,
        docTypeAuto,
        docTypeFinal,
        docTypeConfidence,
        machineState: taskStatus = 'pending',
        processResult,
        averageOcrScore,
        needsReview = false,
        reviewReasons = [],
        createdAt: taskCreatedAt,
        updatedAt: taskUpdatedAt,
        // Passport fields
        extractedNameAuto,
        extractedNameFinal,
        chineseNameAuto,
        passportNoAuto,
        passportNoFinal,
        // Receipt fields
        receiptStoreAuto,
        receiptStoreFinal,
        receiptNoAuto,
        receiptNoFinal,
        groupNoAuto,
        groupNoFinal,
        purchaseDateAuto,
        purchaseDateFinal,
        departureDateAuto,
        departureDateFinal,
        receiptAmountAuto,
        receiptDateAuto,
        flightNoAuto,
        // OCR data
        ocrText,
        ocrPreview,
        ocrError,
        lineCount,
        // Signature
        signatureRegionPath,
        finalSignaturePath,
        signatureStyle,
        signatureSource,
        // Other fields
        ...taskMetadata
      } = task;

      // Build fields JSON
      const fields = {};
      if (docTypeFinal === 'passport' || docTypeAuto === 'passport') {
        fields.extractedNameAuto = extractedNameAuto;
        fields.extractedNameFinal = extractedNameFinal;
        fields.chineseNameAuto = chineseNameAuto;
        fields.passportNoAuto = passportNoAuto;
        fields.passportNoFinal = passportNoFinal;
      } else if (docTypeFinal === 'receipt' || docTypeAuto === 'receipt') {
        fields.receiptStoreAuto = receiptStoreAuto;
        fields.receiptStoreFinal = receiptStoreFinal;
        fields.receiptNoAuto = receiptNoAuto;
        fields.receiptNoFinal = receiptNoFinal;
        fields.groupNoAuto = groupNoAuto;
        fields.groupNoFinal = groupNoFinal;
        fields.purchaseDateAuto = purchaseDateAuto;
        fields.purchaseDateFinal = purchaseDateFinal;
        fields.departureDateAuto = departureDateAuto;
        fields.departureDateFinal = departureDateFinal;
        fields.receiptAmountAuto = receiptAmountAuto;
        fields.receiptDateAuto = receiptDateAuto;
        fields.flightNoAuto = flightNoAuto;
      }

      // Build OCR result JSON
      const ocrResult = {
        text: ocrText,
        preview: ocrPreview,
        error: ocrError,
        lineCount,
        averageScore: averageOcrScore,
      };

      // Build signature JSON
      const signature = {
        regionPath: signatureRegionPath,
        finalPath: finalSignaturePath,
        style: signatureStyle,
        source: signatureSource,
      };

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
          sourceKey,
          docTypeFinal || docTypeAuto,
          docTypeAuto,
          docTypeFinal,
          docTypeConfidence,
          taskStatus,
          processResult,
          averageOcrScore,
          needsReview ? 1 : 0,
          JSON.stringify(reviewReasons),
          taskCreatedAt || new Date().toISOString(),
          taskUpdatedAt || new Date().toISOString(),
          JSON.stringify(fields),
          JSON.stringify(ocrResult),
          JSON.stringify({}), // classification - empty for now
          JSON.stringify(signature),
          JSON.stringify(taskMetadata),
        ]
      );

      insertedCount++;
    } catch (error) {
      errorCount++;
      console.error(`[Migration] Failed to insert task ${task.id}:`, error.message);
    }
  }

  if (errorCount > 0) {
    console.warn(`[Migration] Warning: ${errorCount} tasks failed to insert`);
  }

  return insertedCount;
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('[Migration] Starting migration...');
  console.log('[Migration] Old batches dir:', OLD_BATCHES_DIR);
  console.log('[Migration] New database:', NEW_DB_PATH);
  console.log('[Migration] Backup dir:', BACKUP_DIR);

  // 1. Read existing batches
  const batches = await readExistingBatches();
  if (batches.length === 0) {
    console.log('[Migration] No batches to migrate');
    return;
  }

  // 2. Initialize new database
  console.log('[Migration] Initializing database...');
  const db = await initializeDatabase(NEW_DB_PATH);

  // 3. Create storage transaction manager
  const storage = createStorageTransaction(db, BACKUP_DIR);

  // 4. Import batches
  let totalTasks = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const batch of batches) {
    try {
      console.log(`[Migration] Importing batch: ${batch.name || batch.id}`);

      const taskCount = await storage.execute(
        async (db) => importBatch(db, batch),
        {
          type: 'batches',
          id: batch.id,
          content: batch,
        }
      );

      totalTasks += taskCount;
      successCount++;
      console.log(`[Migration] ✓ Imported ${taskCount} tasks`);
    } catch (error) {
      errorCount++;
      console.error(`[Migration] ✗ Failed to import batch ${batch.id}:`, error.message);
    }
  }

  // 5. Summary
  console.log('\n[Migration] Summary:');
  console.log(`  Total batches: ${batches.length}`);
  console.log(`  Successful: ${successCount}`);
  console.log(`  Failed: ${errorCount}`);
  console.log(`  Total tasks: ${totalTasks}`);

  // 6. Verify
  const batchCount = await db.get('SELECT COUNT(*) as count FROM batches');
  const taskCount = await db.get('SELECT COUNT(*) as count FROM tasks');

  console.log('\n[Migration] Verification:');
  console.log(`  Batches in DB: ${batchCount.count}`);
  console.log(`  Tasks in DB: ${taskCount.count}`);

  if (batchCount.count === successCount && taskCount.count === totalTasks) {
    console.log('\n[Migration] ✓ Migration completed successfully!');
  } else {
    console.log('\n[Migration] ⚠ Migration completed with discrepancies');
  }

  await db.close();
}

// Run migration
if (require.main === module) {
  migrate()
    .then(() => {
      console.log('[Migration] Done');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[Migration] Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { migrate };
