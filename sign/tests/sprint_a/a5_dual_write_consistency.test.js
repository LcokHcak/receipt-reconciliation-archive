'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createWorkbenchBatchRepository } = require('../../repositories/workbench_batch_repository');
const { createWorkbenchSqliteRepository } = require('../../repositories/workbench_sqlite_repository');
const { createWorkbenchSqliteSyncService } = require('../../services/workbench_sqlite_sync_service');
const { createWorkbenchWriteService } = require('../../services/workbench_write');

const BATCH_ID = 'batch_a5_consistency';

function setup(t, { taskCount = 1, sqliteSyncWrapper = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-dual-write-'));
  const batchesRoot = path.join(root, 'batches');
  const dbPath = path.join(root, 'workbench.sqlite');
  fs.mkdirSync(batchesRoot, { recursive: true });

  const sqliteRepository = createWorkbenchSqliteRepository({ dbPath });
  const realSyncService = createWorkbenchSqliteSyncService({ sqliteRepository });
  const sqliteSyncService = sqliteSyncWrapper
    ? sqliteSyncWrapper(realSyncService)
    : realSyncService;
  const batchRepository = createWorkbenchBatchRepository({
    batchesRoot,
    normalizeBatch: normalizeBatchForTest,
    summarizeBatch: summarizeBatchForTest,
    sqliteSyncService,
    logger: { warn() {}, error() {} },
  });
  const service = createWorkbenchWriteService({
    defaultScenario: 'FullProcess',
    nowStamp: () => '20260522010101',
    withBatchWrite: batchRepository.withBatchWrite,
    hasBatch: batchRepository.hasBatch,
    loadBatch: batchRepository.loadBatch,
    saveBatchAsync: batchRepository.saveBatchAsync,
    summarizeBatch: summarizeBatchForTest,
    buildBatchSkeleton: buildBatchSkeletonForTest,
    batchSubdirs: batchRepository.batchSubdirs,
    createManualTaskFromFactory: createPassportTask,
    createManualReceiptTaskFromSource: () => createPassportTask('manual_receipt'),
    normalizeFieldValue: (value) => String(value || '').trim(),
    resolveTask: (batch, taskId) => batch.tasks.find((task) => task.id === taskId) || null,
    normalizeTask: (task) => ({ ...task }),
    normalizeDocType: (value) => String(value || 'passport').trim() || 'passport',
    clearTaskSignatureArtifacts: () => {},
    clearEditableFieldsForDocTypeSwitch: (_task, docTypeFinal) => ({ docTypeFinal }),
    markClassificationConfirmed: (task) => { task.classificationConfirmed = true; },
    didEditableWorkflowChange: () => true,
    syncWebsiteSignatureAfterFieldChange: () => false,
    websiteSignatureSource: 'website',
    removeFileIfExists: () => {},
    resolveBatchRelativePath: (_batchId, relativePath) => relativePath,
    recoverCompletedStateAfterManualReview: () => {},
    recalcTask: (task) => { task.processResult = 'ready'; },
    touchTask: (task) => { task.updatedAt = new Date().toISOString(); },
    workbenchGroupApprovalService: null,
    removeTaskArtifacts: () => {},
    clearActiveBatch: () => {},
    removeBatchProjection: () => {},
    removeBatchDirectory: batchRepository.removeBatchDirectory,
    getWebsiteSignatureEligibilityIssue: () => '',
    isEligibleForWebsiteGeneration: () => false,
    createSignatureJob: () => ({}),
    signatureSiteWorker: { async queueJob() { return { queued: false, state: 'disabled' }; } },
    clearWebsiteFinalSignatureAsset: () => {},
    manualSignatureSource: 'manual',
    restoreAutomaticSignatureState: () => {},
    batchDir: batchRepository.batchDir,
    applyComputedFields: (_batch, task) => ({
      id: task.id,
      extractedNameFinal: task.extractedNameFinal,
      passportNoFinal: task.passportNoFinal,
      reviewNote: task.reviewNote,
    }),
  });

  t.after(() => {
    try { sqliteRepository.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });

  return {
    root,
    dbPath,
    batchesRoot,
    batchRepository,
    service,
    seedBatch: () => seedBatch(batchRepository, createBatch(taskCount)),
  };
}

test('A5: concurrent workbench writes keep JSON source and SQLite projection consistent', async (t) => {
  const ctx = setup(t, { taskCount: 100 });
  await ctx.seedBatch();

  const updates = Array.from({ length: 100 }, (_, index) => {
    const taskNo = index + 1;
    return ctx.service.updateTask({
      batchId: BATCH_ID,
      taskId: taskId(taskNo),
      body: {
        extractedNameFinal: `PASSENGER ${String(taskNo).padStart(3, '0')}`,
        passportNoFinal: `E${String(taskNo).padStart(8, '0')}`,
        reviewNote: `update-${taskNo}`,
      },
    });
  });

  const responses = await Promise.all(updates);
  await drainBatchWrites(ctx.batchRepository);

  assert.equal(responses.every((response) => response.status === 200), true);
  assert.equal(readJsonBatch(ctx.batchRepository).tasks.length, 100);
  assert.equal(sqlCount(ctx.dbPath, 'source_image'), 100);

  for (const taskNo of [1, 7, 42, 88, 100]) {
    assertTaskProjectionEqualsJson(ctx, taskId(taskNo));
  }
});

test('A5: SQLite projection failure does not block JSON source or request success', async (t) => {
  let failProjection = false;
  const ctx = setup(t, {
    taskCount: 1,
    sqliteSyncWrapper: (realSyncService) => ({
      ...realSyncService,
      syncBatch(batch) {
        if (failProjection) throw new Error('projection unavailable');
        return realSyncService.syncBatch(batch);
      },
    }),
  });
  await ctx.seedBatch();
  failProjection = true;

  const response = await withSuppressedConsoleError(() => ctx.service.updateTask({
    batchId: BATCH_ID,
    taskId: taskId(1),
    body: {
      extractedNameFinal: 'JSON ONLY',
      passportNoFinal: 'E99999999',
      reviewNote: 'sqlite failed',
    },
  }));
  await drainBatchWrites(ctx.batchRepository);

  const jsonTask = readJsonTask(ctx.batchRepository, taskId(1));
  const sqliteTask = readPassportProjection(ctx.dbPath, taskId(1));
  assert.equal(response.status, 200);
  assert.equal(jsonTask.extractedNameFinal, 'JSON ONLY');
  assert.equal(jsonTask.passportNoFinal, 'E99999999');
  assert.notEqual(sqliteTask.english_name, jsonTask.extractedNameFinal);
  assert.notEqual(sqliteTask.passport_no, jsonTask.passportNoFinal);
});

test('A5: per-batch write queue preserves final update order in JSON and SQLite', async (t) => {
  const ctx = setup(t, { taskCount: 1 });
  await ctx.seedBatch();

  for (let version = 1; version <= 10; version += 1) {
    const response = await ctx.service.updateTask({
      batchId: BATCH_ID,
      taskId: taskId(1),
      body: {
        extractedNameFinal: `ORDER ${version}`,
        passportNoFinal: `E7777777${version}`,
        reviewNote: `version-${version}`,
      },
    });
    assert.equal(response.status, 200);
  }
  await drainBatchWrites(ctx.batchRepository);

  const jsonTask = readJsonTask(ctx.batchRepository, taskId(1));
  const sqliteTask = readPassportProjection(ctx.dbPath, taskId(1));
  assert.equal(jsonTask.passportNoFinal, 'E777777710');
  assert.equal(jsonTask.reviewNote, 'version-10');
  assert.equal(sqliteTask.passport_no, 'E777777710');
});

test('A5: shutdown pending_batch_writes drain waits for queued JSON and SQLite writes', async (t) => {
  const ctx = setup(t, { taskCount: 50 });
  await ctx.seedBatch();

  const updates = Array.from({ length: 50 }, (_, index) => {
    const taskNo = index + 1;
    return ctx.service.updateTask({
      batchId: BATCH_ID,
      taskId: taskId(taskNo),
      body: {
        extractedNameFinal: `DRAIN ${String(taskNo).padStart(3, '0')}`,
        passportNoFinal: `E8${String(taskNo).padStart(7, '0')}`,
        reviewNote: `drain-${taskNo}`,
      },
    });
  });

  await drainPendingBatchWritesLikeShutdown(ctx.batchRepository);
  const responses = await Promise.all(updates);

  assert.equal(responses.every((response) => response.status === 200), true);
  assert.equal(readJsonBatch(ctx.batchRepository).tasks.length, 50);
  assert.equal(sqlCount(ctx.dbPath, 'source_image'), 50);
  for (const taskNo of [1, 25, 50]) {
    assertTaskProjectionEqualsJson(ctx, taskId(taskNo));
  }
});

async function seedBatch(batchRepository, batch) {
  fs.mkdirSync(batchRepository.batchDir(batch.id), { recursive: true });
  await batchRepository.saveBatchAsync(batch);
}

function createBatch(taskCount) {
  return {
    id: BATCH_ID,
    name: 'A5 Consistency Batch',
    scenario: 'FullProcess',
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    machineState: 'completed',
    sourceGroups: [],
    tasks: Array.from({ length: taskCount }, (_, index) => createPassportTask(taskId(index + 1))),
  };
}

function createPassportTask(id) {
  return {
    id,
    docTypeFinal: 'passport',
    extractedNameFinal: `INITIAL ${id}`,
    passportNoFinal: `E0${String(id).replace(/\D/g, '').padStart(7, '0').slice(-7)}`,
    chineseNameFinal: '',
    departureDateFinal: '',
    groupNoFinal: '',
    reviewNote: '',
    machineState: 'completed',
    processResult: 'ready',
    sourceType: 'uploaded',
    sourceImagePath: `source/${id}.jpg`,
    sourceGroupKey: 'group_a5',
    sourceGroupLabel: 'A5 GROUP',
    classificationConfirmed: true,
    signatureJobStatus: 'disabled',
    finalSignaturePath: '',
    finalSignatureSource: '',
    reviewed: false,
    reviewedAt: '',
    rephotoRequested: false,
  };
}

function taskId(index) {
  return `task_${String(index).padStart(3, '0')}`;
}

function normalizeBatchForTest(batch) {
  return {
    ...batch,
    sourceGroups: Array.isArray(batch.sourceGroups) ? batch.sourceGroups : [],
    tasks: Array.isArray(batch.tasks) ? batch.tasks : [],
  };
}

function summarizeBatchForTest(batch) {
  return {
    id: batch.id,
    name: batch.name,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    taskCount: batch.tasks.length,
  };
}

function buildBatchSkeletonForTest(batchId, name, scenario) {
  return {
    id: batchId,
    name,
    scenario,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    machineState: 'completed',
    sourceGroups: [],
    tasks: [],
  };
}

function readJsonBatch(batchRepository) {
  return JSON.parse(fs.readFileSync(batchRepository.batchJsonPath(BATCH_ID), 'utf8'));
}

function readJsonTask(batchRepository, id) {
  return readJsonBatch(batchRepository).tasks.find((task) => task.id === id);
}

function readPassportProjection(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT legacy_task_id, english_name, passport_no
      FROM passport_record
      WHERE batch_id = ? AND legacy_task_id = ?
    `).get(BATCH_ID, id);
  } finally {
    db.close();
  }
}

function sqlCount(dbPath, table) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT COUNT(1) AS count FROM ${table} WHERE batch_id = ?`).get(BATCH_ID).count;
  } finally {
    db.close();
  }
}

function assertTaskProjectionEqualsJson(ctx, id) {
  const jsonTask = readJsonTask(ctx.batchRepository, id);
  const sqliteTask = readPassportProjection(ctx.dbPath, id);
  assert.equal(sqliteTask.english_name, jsonTask.extractedNameFinal);
  assert.equal(sqliteTask.passport_no, jsonTask.passportNoFinal);
}

async function drainBatchWrites(batchRepository) {
  await Promise.allSettled(batchRepository.getPendingBatchWrites());
}

async function drainPendingBatchWritesLikeShutdown(batchRepository) {
  const pendingWrites = batchRepository.getPendingBatchWrites();
  if (pendingWrites.length > 0) {
    await Promise.allSettled(pendingWrites);
  }
}

async function withSuppressedConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}
