'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createDepartureSyncAuditRepository } = require('../repositories/departure_sync_audit_repository');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createStageJobRepository } = require('../repositories/stage_job_repository');
const { createMatchBadcaseRepository } = require('../repositories/match_badcase_repository');
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createErrorDetectionService } = require('../services/monthly/error_detection_service');
const { createCrossCheckService } = require('../services/monthly/cross_check_service');
const { createBatchOperationsService } = require('../services/monthly/batch_operations_service');
const { createMonthlyRoutes } = require('../routes/monthly_routes');

const WORKSPACE_KEY = '2099-01';

function createAuth(role = 'admin') {
  return {
    authenticateToken(req, _res, next) {
      req.user = { username: `${role}_operator`, role };
      next();
    },
    requireRole(...roles) {
      return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        next();
      };
    },
  };
}

async function setup(t, { role = 'admin' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-operator-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });

  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
  const receivedReceiptRepo = createReceivedReceiptRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const stageJobRepo = createStageJobRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });

  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: 'test' });

  const importService = createImportService({
    importJobRepo,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
    receivedReceiptRepo,
    dailyReceiptRepo,
  });
  const crossCheckService = createCrossCheckService({
    storeBillRepo,
    errorRecordRepo,
    departureSyncAuditRepo,
  });
  const errorDetectionService = createErrorDetectionService({
    storeBillRepo,
    errorRecordRepo,
    groupCodeRepo,
    crossCheckService,
  });
  const batchOperationsService = createBatchOperationsService({
    dailyReceiptRepo,
    storeBillRepo,
    groupCodeRepo,
    missingReceiptRepo,
    receivedReceiptRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
  });
  const routes = createMonthlyRoutes({
    workspaceService,
    importService,
    errorDetectionService,
    crossCheckService,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
    errorRecordRepo,
    importJobRepo,
    departureSyncAuditRepo,
    receivedReceiptRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    monthlyDataRepo,
    stageJobRepo,
    matchBadcaseRepo,
    batchOperationsService,
    exportRoot: path.join(dir, 'exports'),
    upload: { single: () => (_req, _res, next) => next() },
  });

  const app = express();
  app.use(express.json());
  routes.register(app, createAuth(role));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    server.close();
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });

  return {
    baseUrl,
    repos: {
      groupCodeRepo,
      storeBillRepo,
      missingReceiptRepo,
      receivedReceiptRepo,
      dailyReceiptRepo,
    },
  };
}

test('operator can delete wrong-month imported rows across all import tables', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const importedAt = '2099-01-02T00:00:00.000Z';

  repos.groupCodeRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    tourNo: 'T-WRONG',
    mode: 'SG',
    modeNormalized: 'SG',
    rowHash: 'gc-wrong-1',
    importedAt,
  }]);
  repos.storeBillRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    storeFamily: 'THE SHILLA',
    receiptNo: 'B-WRONG',
    tourNo: 'T-WRONG',
    name: 'BILL WRONG',
    passportNo: 'P-WRONG',
    purchaseDate: '2099-01-02',
    isDetailSheet: true,
    rowHash: 'bill-wrong-1',
    importedAt,
  }]);
  repos.dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'D-WRONG',
    tourNo: 'T-WRONG',
    name: 'DAILY WRONG',
    passportNo: 'P-WRONG',
    purchaseDate: '2099-01-02',
    rowHash: 'daily-wrong-1',
    importedAt,
  }]);
  repos.receivedReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    workerName: 'worker',
    workerNo: '01',
    receiptNo: 'R-WRONG',
    tourNo: 'T-WRONG',
    name: 'RECEIVED WRONG',
    passportNo: 'P-WRONG',
    rowHash: 'received-wrong-1',
    importedAt,
  }]);
  repos.missingReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'M-WRONG',
    tourNo: 'T-WRONG',
    brand: 'brand',
    rowHash: 'missing-wrong-1',
    importedAt,
  }]);

  const [group] = repos.groupCodeRepo.list({ workspaceKey: WORKSPACE_KEY });
  const [bill] = repos.storeBillRepo.list({ workspaceKey: WORKSPACE_KEY });
  const [daily] = repos.dailyReceiptRepo.listLedger({ workspaceKey: WORKSPACE_KEY });
  const [received] = repos.receivedReceiptRepo.list({ workspaceKey: WORKSPACE_KEY });
  const [missing] = repos.missingReceiptRepo.list({ workspaceKey: WORKSPACE_KEY });

  for (const [route, id] of [
    ['delete-group-codes', group.id],
    ['delete-bill', bill.id],
    ['delete-daily', daily.id],
    ['delete-received-receipts', received.id],
    ['delete-missing', missing.id],
  ]) {
    const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/batch/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    assert.equal(res.status, 200, `${route} should succeed`);
    const body = await res.json();
    assert.equal(body.affected, 1, `${route} should delete one row`);
  }

  assert.equal(repos.groupCodeRepo.countByWorkspace(WORKSPACE_KEY), 0);
  assert.equal(repos.storeBillRepo.countByWorkspace(WORKSPACE_KEY), 0);
  assert.equal(repos.dailyReceiptRepo.countByWorkspace(WORKSPACE_KEY), 0);
  assert.equal(repos.receivedReceiptRepo.countByWorkspace(WORKSPACE_KEY), 0);
  assert.equal(repos.missingReceiptRepo.countByWorkspace(WORKSPACE_KEY), 0);
});

test('reviewer cannot call unscoped monthly bulk operation routes', async (t) => {
  const { baseUrl } = await setup(t, { role: 'reviewer' });
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/batch/update-daily`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [1], updates: { tourNo: 'T-1' } }),
  });
  assert.equal(res.status, 403);
});

test('publishing endpoint is removed and editing keeps posted ledger state', async (t) => {
  const { baseUrl, repos } = await setup(t);
  repos.dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'POSTED-1',
    tourNo: 'T-POSTED',
    name: 'POSTED ROW',
    passportNo: 'P-POSTED',
    purchaseDate: '2099-01-02',
    ledgerStatus: 'ready_to_post',
    rowHash: 'posted-row-1',
    importedAt: '2099-01-02T00:00:00.000Z',
  }]);
  const [row] = repos.dailyReceiptRepo.listLedger({ workspaceKey: WORKSPACE_KEY });

  const publishRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [row.id] }),
  });
  assert.equal(publishRes.status, 410);
  assert.equal(repos.dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: row.id }).ledgerStatus, 'ready_to_post');

  const patchRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    // 团号过中央口径(保字母/剥非字母数字):用真实字母团号形态断言保真
    body: JSON.stringify({ tourNo: '26V00042' }),
  });
  assert.equal(patchRes.status, 200);
  const body = await patchRes.json();
  assert.equal(body.row.ledgerStatus, 'ready_to_post');
  assert.equal(body.row.tourNo, '26V00042');
  assert.equal(body.row.postedAt, '2099-01-02T00:00:00.000Z');
});

// F12(2026-07-18 设计):无 confirm 手改踩日期窗 → date_out_of_window 只写不锁;
// 只有 manualRemedyConfirm(人工背书)才把 tour_match_status 锁进 manual_locked_fields。
// 修复前状态列跟着 manualLock 一起上锁:换表 reset 裸 SQL 打回 pending 后,
// tour_match 重跑 filterStageUpdates 跳过锁列 → 行永久卡 pending,从补救台消失。
test('F12:无confirm手改踩日期窗不锁状态列,reset后tour_match能写回;confirm才锁', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const lockedOf = (id) => {
    const raw = repos.dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id }).manualLockedFields;
    return raw ? JSON.parse(raw) : [];
  };
  repos.groupCodeRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    tourNo: '26107001',
    mode: '乐天SG',
    modeNormalized: 'SG',
    applyDate: '2099-01-05',
    endDate: '2099-01-10',
    rowHash: 'gc-f12-1',
    importedAt: '2099-01-02T00:00:00.000Z',
  }]);
  repos.dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'F12-1',
    tourNo: '26107001',
    name: 'F12 ROW',
    passportNo: 'P-F12',
    purchaseDate: '2099-01-07',
    sourceBatchId: 'batch_f12',
    rowHash: 'daily-f12-1',
    importedAt: '2099-01-02T00:00:00.000Z',
  }]);
  const [row] = repos.dailyReceiptRepo.listLedger({ workspaceKey: WORKSPACE_KEY });

  // ① 无 confirm 手改日期到窗外 → 状态翻 date_out_of_window,但状态列不进锁(purchase_date 进)
  const res1 = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purchaseDate: '2099-01-20' }),
  });
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.row.tourMatchStatus, 'date_out_of_window', '踩窗如实标状态(补救台可见)');
  assert.ok(lockedOf(row.id).includes('purchase_date'), '手改的字段照常上锁');
  assert.ok(!lockedOf(row.id).includes('tour_match_status'), '状态列不许锁——锁了就是永久 pending 病根');

  // ② 换表 reset(裸 SQL 打回 pending)→ tour_match 重跑必须能写回状态(修复前被锁列跳过卡死)
  const reset = repos.dailyReceiptRepo.resetTourMatchForRematch({ workspaceKey: WORKSPACE_KEY, batchId: 'batch_f12' });
  assert.equal(reset, 1);
  const rerun = repos.dailyReceiptRepo.updateTourMatch({
    id: row.id, workspaceKey: WORKSPACE_KEY, modeFolder: '乐天首尔', modeRaw: '乐天SG', tourMatchStatus: 'matched',
  });
  assert.equal(rerun.changes, 1, 'tour_match 重跑必须能写回(行不再永久卡 pending)');
  assert.deepEqual(rerun.skippedDueToManualLock, [], '状态/模式列都不该被锁跳过');

  // ③ manualRemedyConfirm(人工背书)→ 状态 matched 且 tour_match_status 上锁(F6 抗重结算的标记)
  const res3 = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modeRaw: '乐天SG', manualRemedyConfirm: true }),
  });
  assert.equal(res3.status, 200);
  const body3 = await res3.json();
  assert.equal(body3.row.tourMatchStatus, 'matched');
  assert.ok(lockedOf(row.id).includes('tour_match_status'), '人工背书才锁状态列(重结算保护靠它识别)');
});

// F12 边界:行先被人工背书(状态列已锁),之后无 confirm 手改踩日期窗——
// 咨询性状态写尊重既有锁,不把人工结论降级回 date_out_of_window。
test('F12:已人工背书的行,无confirm手改踩窗不降级人工结论', async (t) => {
  const { baseUrl, repos } = await setup(t);
  repos.groupCodeRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    tourNo: '26107002',
    mode: '乐天SG',
    modeNormalized: 'SG',
    applyDate: '2099-01-05',
    endDate: '2099-01-10',
    rowHash: 'gc-f12-2',
    importedAt: '2099-01-02T00:00:00.000Z',
  }]);
  repos.dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'F12-2',
    tourNo: '26107002',
    name: 'F12 ROW2',
    passportNo: 'P-F12B',
    purchaseDate: '2099-01-07',
    rowHash: 'daily-f12-2',
    importedAt: '2099-01-02T00:00:00.000Z',
  }]);
  const [row] = repos.dailyReceiptRepo.listLedger({ workspaceKey: WORKSPACE_KEY });

  const confirmRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modeRaw: '乐天SG', manualRemedyConfirm: true }),
  });
  assert.equal(confirmRes.status, 200);

  const editRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purchaseDate: '2099-01-20' }),
  });
  assert.equal(editRes.status, 200);
  const editBody = await editRes.json();
  // 咨询状态被锁跳过 ≠ 无事发生:响应必须打信号,"日期出窗但状态仍 matched"才可排查(复核MEDIUM)
  assert.equal(editBody.dateWindowConflictIgnored, true, '被锁吞掉的咨询状态写必须在响应里可观测');
  const after = repos.dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: row.id });
  assert.equal(after.tourMatchStatus, 'matched', '人工背书的结论不被咨询性状态覆盖');
  assert.equal(after.purchaseDate, '2099-01-20', '日期本身照常改(留痕上锁)');
});

// 台账侧订正断口(审计MEDIUM):普通改团号后 matched 行不重算模式/桶。修:改团号(非背书)且行当前
// matched 且状态列未被人工锁 → 重置 tour_match_status='pending' 让新团号重查表出新模式。
test('普通改团号(matched非背书)→ tour_match_status 重置 pending;背书确认(matched)不重置', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const fetchRow = (id) => repos.dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id });
  const patch = (id, body) => fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${id}/fields`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  repos.dailyReceiptRepo.insertMany([
    { workspaceKey: WORKSPACE_KEY, receiptNo: 'RM-A', tourNo: 'OLDA', name: 'A', passportNo: 'PA', purchaseDate: '2099-01-10', tourMatchStatus: 'matched', modeRaw: '旧', modeFolder: '旧桶', ledgerStatus: 'posted', rowHash: 'rm-a', importedAt: '2099-01-02T00:00:00.000Z' },
    { workspaceKey: WORKSPACE_KEY, receiptNo: 'RM-B', tourNo: 'OLDB', name: 'B', passportNo: 'PB', purchaseDate: '2099-01-10', tourMatchStatus: 'matched', modeRaw: '旧', modeFolder: '旧桶', ledgerStatus: 'posted', rowHash: 'rm-b', importedAt: '2099-01-02T00:00:00.000Z' },
  ]);
  const rows = repos.dailyReceiptRepo.listLedger({ workspaceKey: WORKSPACE_KEY });
  const a = rows.find((r) => (r.receiptNo || r.receipt_no) === 'RM-A');
  const b = rows.find((r) => (r.receiptNo || r.receipt_no) === 'RM-B');

  // A:普通改团号 → 状态回 pending(此前滞留 matched+旧模式,tour_match 只扫 pending 永不重算)
  assert.equal((await patch(a.id, { tourNo: 'NEWA' })).status, 200);
  assert.equal(fetchRow(a.id).tourNo, 'NEWA', '团号已改');
  assert.equal(fetchRow(a.id).tourMatchStatus, 'pending', '普通改团号→重置 pending 重查表出新模式');

  // B:manualRemedyConfirm(人工背书)→ 状态直标 matched,不走 pending 重置(F6 抗重结算标记)
  assert.equal((await patch(b.id, { tourNo: 'NEWB', manualRemedyConfirm: true })).status, 200);
  assert.equal(fetchRow(b.id).tourMatchStatus, 'matched', '人工背书确认→matched,不重置');
});
