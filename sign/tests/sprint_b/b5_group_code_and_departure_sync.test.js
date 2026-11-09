'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createAuditLogRepository } = require('../../repositories/audit_log_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createDepartureSyncAuditRepository } = require('../../repositories/departure_sync_audit_repository');
const { createErrorRecordRepository } = require('../../repositories/error_record_repository');
const { createGroupCodeRepository } = require('../../repositories/group_code_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createStageJobRepository } = require('../../repositories/stage_job_repository');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createPipelineLockService } = require('../../services/monthly/pipeline_lock_service');
const { createCrossCheckService } = require('../../services/monthly/cross_check_service');
const { createErrorDetectionService } = require('../../services/monthly/error_detection_service');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createMonthlyRoutes } = require('../../routes/monthly_routes');

const WS = 'demo-2026-01';
const WS_OTHER = 'demo-2026-02';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-monthly-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repos = {
    db,
    groupCodeRepo: createGroupCodeRepository({ db }),
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    storeBillRepo: createStoreBillRepository({ db }),
    errorRecordRepo: createErrorRecordRepository({ db }),
    departureSyncAuditRepo: createDepartureSyncAuditRepository({ db }),
    auditLogRepo: createAuditLogRepository({ db }),
    workspaceRepo: createMonthlyWorkspaceRepository({ db }),
    stageJobRepo: createStageJobRepository({ db }),
    pipelineLockService: createPipelineLockService({ db }),
  };
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo: repos.workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'test' });
  workspaceService.open({ workspaceKey: WS_OTHER, operator: 'test' });
  const crossCheckService = createCrossCheckService({
    storeBillRepo: repos.storeBillRepo,
    dailyReceiptRepo: repos.dailyReceiptRepo,
    errorRecordRepo: repos.errorRecordRepo,
    departureSyncAuditRepo: repos.departureSyncAuditRepo,
    auditLogRepo: repos.auditLogRepo,
  });
  const errorDetectionService = createErrorDetectionService({
    storeBillRepo: repos.storeBillRepo,
    errorRecordRepo: repos.errorRecordRepo,
    groupCodeRepo: repos.groupCodeRepo,
    crossCheckService,
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...repos, workspaceService, crossCheckService, errorDetectionService };
}

test('B5 t1: findByTour returns the latest group_code version', (t) => {
  const { groupCodeRepo } = setup(t);
  groupCodeRepo.insertMany([
    groupCode({ tourNo: 'T001', agent: 'OLD', importedAt: '2026-01-01T00:00:00.000Z', rowHash: 'gc-old' }),
    groupCode({ tourNo: 'T001', agent: 'NEW', importedAt: '2026-01-02T00:00:00.000Z', rowHash: 'gc-new' }),
  ]);

  const rows = groupCodeRepo.findByTour({ workspaceKey: WS, tourNo: 'T001' });

  assert.equal(rows[0].agent, 'NEW');
});

test('B5 t2: listAllVersionsByTour returns all group_code versions newest first', (t) => {
  const { groupCodeRepo } = setup(t);
  groupCodeRepo.insertMany([
    groupCode({ tourNo: 'T001', agent: 'OLD', importedAt: '2026-01-01T00:00:00.000Z', rowHash: 'gc-old' }),
    groupCode({ tourNo: 'T001', agent: 'NEW', importedAt: '2026-01-02T00:00:00.000Z', rowHash: 'gc-new' }),
  ]);

  const rows = groupCodeRepo.listAllVersionsByTour({ workspaceKey: WS, tourNo: 'T001' });

  assert.deepEqual(rows.map((r) => r.agent), ['NEW', 'OLD']);
});

test('B5 t3: different tour_no versions do not affect each other', (t) => {
  const { groupCodeRepo } = setup(t);
  groupCodeRepo.insertMany([
    groupCode({ tourNo: 'T001', agent: 'T1-OLD', importedAt: '2026-01-01T00:00:00.000Z', rowHash: 't1-old' }),
    groupCode({ tourNo: 'T001', agent: 'T1-NEW', importedAt: '2026-01-03T00:00:00.000Z', rowHash: 't1-new' }),
    groupCode({ tourNo: 'T002', agent: 'T2-ONLY', importedAt: '2026-01-02T00:00:00.000Z', rowHash: 't2-only' }),
  ]);

  assert.equal(groupCodeRepo.findByTour({ workspaceKey: WS, tourNo: 'T001' })[0].agent, 'T1-NEW');
  assert.equal(groupCodeRepo.findByTour({ workspaceKey: WS, tourNo: 'T002' })[0].agent, 'T2-ONLY');
});

test('B5 t4a: daily older than store_bill is synced to bill latest with audit_log', (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([dailyRow({ departureDate: '2026-01-15', rowHash: 'daily-old' })]);
  ctx.storeBillRepo.insertMany([billRow({ departureDate: '2026-01-20', rowHash: 'bill-new' })]);

  const result = ctx.crossCheckService.run({ workspaceKey: WS, triggeredBy: 'tester' });

  assert.equal(result.rewritten, 1);
  assert.equal(ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0].departureDate, '2026-01-20');
  const audit = listAudit(ctx.auditLogRepo)[0];
  assertAuditDetails(audit, {
    from: '2026-01-15',
    to: '2026-01-20',
    sourceTable: 'daily_receipt_export',
    triggerTable: 'store_bill',
  });
});

test('B5 t4b: store_bill older than daily is synced to daily latest with audit_log', (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([dailyRow({ departureDate: '2026-01-25', rowHash: 'daily-new' })]);
  ctx.storeBillRepo.insertMany([billRow({ departureDate: '2026-01-20', rowHash: 'bill-old' })]);

  const result = ctx.crossCheckService.run({ workspaceKey: WS, triggeredBy: 'tester' });

  assert.equal(result.rewritten, 1);
  assert.equal(ctx.storeBillRepo.iterateDetail(WS)[0].departureDate, '2026-01-25');
  const audit = listAudit(ctx.auditLogRepo)[0];
  assertAuditDetails(audit, {
    from: '2026-01-20',
    to: '2026-01-25',
    sourceTable: 'store_bill',
    triggerTable: 'daily_receipt_export',
  });
});

test('B5 t5: null departure on one side is filled from the other side', (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([dailyRow({ departureDate: null, rowHash: 'daily-null' })]);
  ctx.storeBillRepo.insertMany([billRow({ departureDate: '2026-01-20', rowHash: 'bill-date' })]);

  ctx.crossCheckService.run({ workspaceKey: WS });

  assert.equal(ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0].departureDate, '2026-01-20');
});

test('B5 t6: both sides null keeps rows unchanged and writes no audit_log', (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([dailyRow({ departureDate: null, rowHash: 'daily-null' })]);
  ctx.storeBillRepo.insertMany([billRow({ departureDate: null, rowHash: 'bill-null' })]);

  const result = ctx.crossCheckService.run({ workspaceKey: WS });

  assert.equal(result.rewritten, 0);
  assert.equal(listAudit(ctx.auditLogRepo).length, 0);
});

test('B5 t7: departure sync is scoped to one workspace', (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([
    dailyRow({ workspaceKey: WS, departureDate: '2026-01-15', rowHash: 'daily-a' }),
    dailyRow({ workspaceKey: WS_OTHER, departureDate: '2026-02-15', rowHash: 'daily-b' }),
  ]);
  ctx.storeBillRepo.insertMany([
    billRow({ workspaceKey: WS, departureDate: '2026-01-20', rowHash: 'bill-a' }),
    billRow({ workspaceKey: WS_OTHER, departureDate: '2026-02-28', rowHash: 'bill-b' }),
  ]);

  ctx.crossCheckService.run({ workspaceKey: WS });

  assert.equal(ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0].departureDate, '2026-01-20');
  assert.equal(ctx.dailyReceiptRepo._listAll({ workspaceKey: WS_OTHER })[0].departureDate, '2026-02-15');
});

test('B5 t8: audit_log details include operator-readable before/after and row source', (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([dailyRow({ departureDate: '2026-01-15', rowHash: 'daily-old' })]);
  ctx.storeBillRepo.insertMany([billRow({ departureDate: '2026-01-20', rowHash: 'bill-new' })]);

  ctx.crossCheckService.run({ workspaceKey: WS, triggeredBy: 'tester' });

  const details = listAudit(ctx.auditLogRepo)[0].details;
  assert.equal(details.from, '2026-01-15');
  assert.equal(details.to, '2026-01-20');
  assert.equal(details.passport_no, 'EM1234567');
  assert.equal(details.source_table, 'daily_receipt_export');
  assert.ok(details.source_id);
  assert.equal(details.trigger_table, 'store_bill');
  assert.ok(details.trigger_id);
});

test('B5 t9: multiple daily rows for the same passport all sync to the max date', (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([
    dailyRow({ receiptNo: 'D1', departureDate: '2026-01-10', rowHash: 'daily-1' }),
    dailyRow({ receiptNo: 'D2', departureDate: '2026-01-15', rowHash: 'daily-2' }),
    dailyRow({ receiptNo: 'D3', departureDate: null, rowHash: 'daily-3' }),
  ]);
  ctx.storeBillRepo.insertMany([billRow({ departureDate: '2026-01-20', rowHash: 'bill-max' })]);

  const result = ctx.crossCheckService.run({ workspaceKey: WS, triggeredBy: 'tester' });

  assert.equal(result.rewritten, 3);
  assert.deepEqual(
    ctx.dailyReceiptRepo._listAll({ workspaceKey: WS }).map((r) => r.departureDate),
    ['2026-01-20', '2026-01-20', '2026-01-20']
  );
  assert.equal(listAudit(ctx.auditLogRepo).length, 3);
});

test('B5 t10: cross-check route respects workspace pipeline lock', async (t) => {
  const ctx = setup(t);
  ctx.pipelineLockService.acquirePipelineLock({
    workspaceKey: WS,
    stage: 'merge',
    jobId: 999,
    operator: 'tester',
  });

  const app = express();
  app.use(express.json());
  createMonthlyRoutes({
    workspaceService: ctx.workspaceService,
    importService: fakeImportService(),
    errorDetectionService: ctx.errorDetectionService,
    crossCheckService: ctx.crossCheckService,
    departureSyncAuditRepo: ctx.departureSyncAuditRepo,
    stageJobRepo: ctx.stageJobRepo,
    pipelineLockService: ctx.pipelineLockService,
    upload: { single: () => (_req, _res, next) => next() },
  }).register(app, null);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/monthly/workspaces/${WS}/cross-check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ withDepartureSync: true }),
  });
  const body = await res.json();

  assert.equal(res.status, 423);
  assert.equal(body.code, 'PIPELINE_LOCKED');
  assert.equal(body.runningStage, 'merge');
});

function groupCode(overrides = {}) {
  return {
    workspaceKey: WS,
    tourNo: 'T001',
    mode: '乐天SG-本司',
    modeNormalized: 'SG',
    agent: 'AGENT',
    applyDate: '2026-01-01',
    endDate: '2026-01-31',
    rowHash: 'gc-default',
    importedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function dailyRow(overrides = {}) {
  return {
    workspaceKey: WS,
    receiptNo: 'D100',
    tourNo: 'T001',
    name: 'ZHANG SAN',
    passportNo: 'EM1234567',
    shop: 'THE SHILLA',
    purchaseDate: '2026-01-10',
    departureDate: '2026-01-15',
    rowHash: 'daily-default',
    importedAt: '2026-01-10T00:00:00.000Z',
    ...overrides,
  };
}

function billRow(overrides = {}) {
  return {
    workspaceKey: WS,
    storeFamily: 'THE SHILLA',
    mode: '乐天SG-本司',
    modeNormalized: 'SG',
    tourNo: 'T001',
    purchaseDate: '2026-01-10',
    departureDate: '2026-01-20',
    name: 'ZHANG SAN',
    passportNo: 'EM1234567',
    receiptNo: 'B100',
    sourceFile: 'bill.xlsx',
    sourceSheet: '明细',
    sourceRow: 1,
    isDetailSheet: true,
    rowHash: 'bill-default',
    importedAt: '2026-01-10T00:00:00.000Z',
    ...overrides,
  };
}

function listAudit(auditLogRepo) {
  return auditLogRepo.list({ workspaceKey: WS, action: 'cross_check_departure_sync', limit: 100 });
}

function assertAuditDetails(row, expected) {
  assert.equal(row.resourceType, expected.sourceTable);
  const details = row.details;
  assert.equal(details.from, expected.from);
  assert.equal(details.to, expected.to);
  assert.equal(details.passport_no, 'EM1234567');
  assert.equal(details.source_table, expected.sourceTable);
  assert.equal(details.trigger_table, expected.triggerTable);
}

function fakeImportService() {
  return {
    importGroupCode: async () => ({}),
    importStoreBill: async () => ({}),
    importMissingReceipt: async () => ({}),
  };
}
