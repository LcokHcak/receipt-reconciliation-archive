'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createStageLogService } = require('../services/monthly/stage_log_service');

async function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `sprint2-svc-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    return await fn(db);
  } finally {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${tmp}-wal`, { force: true });
      fs.rmSync(`${tmp}-shm`, { force: true });
    } catch {
      // intentional: best-effort cleanup
    }
  }
}

test('tour_match_service — happy path fills mode_folder + marks matched', async () => {
  await withDb(async (db) => {
    const groupCodeRepo = createGroupCodeRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });

    groupCodeRepo.insertMany([{
      workspaceKey: '2026-01',
      tourNo: '71993',
      mode: '乐天SG-本司',
      modeNormalized: 'SG',
      agent: '梓陌',
      applyDate: '2026-01-10',
      endDate: '2026-01-20',
      rowHash: 'gc1',
      importedAt: 't',
    }]);

    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01',
      receiptNo: 'R1', name: 'A', passportNo: 'P1',
      tourNo: '71993', agent: '梓陌', modeRaw: '乐天SG-本司',
      shop: '乐天免税店', branch: '首尔本店',
      purchaseDate: '2026-01-14',
      rowHash: 'd1', importedAt: 't',
    }]);

    const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
    const result = await svc.run({ workspaceKey: '2026-01' });

    assert.equal(result.scanned, 1);
    assert.equal(result.matched, 1);
    assert.equal(result.tourNotFound, 0);
    assert.equal(result.agentMismatch, 0);

    const byMode = dailyReceiptRepo.countByMode('2026-01');
    assert.equal(byMode[0].folder, '乐天首尔');
    assert.equal(byMode[0].n, 1);
    assert.equal(pendingReviewRepo.countOpen('2026-01'), 0);
  });
});

test('bill_match_service writes an operator-readable matching trace log', async () => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-stage-log-'));
  try {
    await withDb(async (db) => {
      const storeBillRepo = createStoreBillRepository({ db });
      const dailyReceiptRepo = createDailyReceiptRepository({ db });
      const billMatchLogRepo = createBillMatchLogRepository({ db });
      const pendingReviewRepo = createPendingReviewRepository({ db });
      const stageLogService = createStageLogService({ exportRoot });

      storeBillRepo.insertMany([{
        workspaceKey: '2026-01', storeFamily: 'LOTTE',
        receiptNo: 'R100', tourNo: '71993',
        name: 'LI MING', passportNo: 'P1',
        purchaseDate: '2026-01-14',
        isDetailSheet: true,
        rowHash: 'b-log-1', importedAt: 't',
      }]);
      dailyReceiptRepo.insertMany([{
        workspaceKey: '2026-01', receiptNo: 'R100', tourNo: '71993',
        name: 'LI MING', passportNo: 'P1',
        shop: 'LOTTE', purchaseDate: '2026-01-14',
        rowHash: 'd-log-1', importedAt: 't',
        ledgerStatus: 'posted', tourMatchStatus: 'matched',
      }]);

      const svc = createBillMatchService({
        storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
      });
      const result = await svc.run({
        workspaceKey: '2026-01',
        stageJobId: 77,
        stageLogService,
      });

      assert.ok(result.logFile, 'result should include a downloadable log filename');
      const logPath = path.join(exportRoot, '2026-01', 'logs', result.logFile);
      assert.equal(fs.existsSync(logPath), true);
      const text = fs.readFileSync(logPath, 'utf8');
      assert.match(text, /账单匹配核对日志/);
      assert.match(text, /这个日志什么时候用/);
      assert.match(text, /P1 小票号一致/);
      assert.match(text, /R100/);
      assert.match(text, /处理结果：匹配成功/);
      assert.match(text, /数据去向：本条进入【正式月度数据】/);
      assert.match(text, /账单Excel字段【小票号】=R100；台账字段【小票号】=R100；结果：一致/);
      assert.doesNotMatch(text, /结果:\s*matched|dailyReceiptId=|receipt=/);
    });
  } finally {
    fs.rmSync(exportRoot, { recursive: true, force: true });
  }
});

test('tour_match_service — agent mismatch → pending_review', async () => {
  await withDb(async (db) => {
    const groupCodeRepo = createGroupCodeRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });

    groupCodeRepo.insertMany([{
      workspaceKey: '2026-01', tourNo: '71993', mode: '乐天SG-本司',
      modeNormalized: 'SG', agent: '梓陌',
      applyDate: '2026-01-10', endDate: '2026-01-20',
      rowHash: 'gc2', importedAt: 't',
    }]);
    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01',
      receiptNo: 'R1', name: 'A', passportNo: 'P1',
      tourNo: '71993', agent: '张三',
      shop: '乐天免税店', branch: '首尔本店',
      purchaseDate: '2026-01-14', rowHash: 'd2', importedAt: 't',
    }]);

    const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
    const result = await svc.run({ workspaceKey: '2026-01' });

    assert.equal(result.agentMismatch, 1);
    assert.equal(pendingReviewRepo.countOpen('2026-01'), 1);
    const reasons = pendingReviewRepo.countByReason('2026-01');
    assert.equal(reasons[0].reason, 'agent_mismatch');
  });
});

test('tour_match_service — tour_not_found marks row + writes error', async () => {
  await withDb(async (db) => {
    const groupCodeRepo = createGroupCodeRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const errorRecordRepo = createErrorRecordRepository({ db });

    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01',
      receiptNo: 'R1', name: 'A', passportNo: 'P1',
      tourNo: '99999', agent: '梓陌',
      shop: '乐天免税店',
      purchaseDate: '2026-01-14', rowHash: 'd3', importedAt: 't',
    }]);

    const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
    const result = await svc.run({ workspaceKey: '2026-01' });
    assert.equal(result.tourNotFound, 1);
    assert.equal(result.matched, 0);
  });
});

test('bill_match_service — P1 match with no conflicts → matched + log', async () => {
  await withDb(async (db) => {
    const storeBillRepo = createStoreBillRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });

    storeBillRepo.insertMany([{
      workspaceKey: '2026-01', storeFamily: '乐天免税店',
      receiptNo: 'R100', tourNo: '71993',
      name: 'LI MING', passportNo: 'P1',
      purchaseDate: '2026-01-14',
      isDetailSheet: true,
      rowHash: 'b1', importedAt: 't',
    }]);
    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01', receiptNo: 'R100', tourNo: '71993',
      name: 'LI MING', passportNo: 'P1',
      shop: '乐天免税店', purchaseDate: '2026-01-14',
      rowHash: 'd100', importedAt: 't',
      ledgerStatus: 'posted', tourMatchStatus: 'matched',
    }]);

    const svc = createBillMatchService({
      storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
    });
    const result = await svc.run({ workspaceKey: '2026-01' });
    assert.equal(result.matched, 1);
    assert.equal(result.conflicts, 0);
    assert.equal(billMatchLogRepo.countByWorkspace('2026-01'), 1);
    assert.equal(pendingReviewRepo.countOpen('2026-01'), 0);

    const byStatus = billMatchLogRepo.countByStatus('2026-01');
    assert.equal(byStatus[0].status, 'matched');
    assert.equal(byStatus[0].priority, 1);
  });
});

test('bill_match_service — mismatched tour on the same receipt → field_conflict', async () => {
  await withDb(async (db) => {
    const storeBillRepo = createStoreBillRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });

    storeBillRepo.insertMany([{
      workspaceKey: '2026-01', storeFamily: '乐天免税店',
      receiptNo: 'R200', tourNo: '71994',
      name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-14',
      isDetailSheet: true, rowHash: 'b2', importedAt: 't',
    }]);
    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01', receiptNo: 'R200', tourNo: '71993',
      name: 'LI MING', passportNo: 'P1',
      shop: '乐天免税店', purchaseDate: '2026-01-14',
      rowHash: 'd200', importedAt: 't',
      ledgerStatus: 'posted', tourMatchStatus: 'matched',
    }]);

    const svc = createBillMatchService({
      storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
    });
    const result = await svc.run({ workspaceKey: '2026-01' });
    assert.equal(result.matched, 0);
    assert.equal(result.conflicts, 1);
    assert.equal(pendingReviewRepo.countOpen('2026-01'), 1);

    const reasons = pendingReviewRepo.countByReason('2026-01');
    assert.equal(reasons[0].reason, 'field_conflict');
  });
});

test('bill_match_service — ambiguous P1 match → pending_review + ambiguous counter', async () => {
  await withDb(async (db) => {
    const storeBillRepo = createStoreBillRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });

    storeBillRepo.insertMany([{
      workspaceKey: '2026-01', storeFamily: '乐天免税店',
      receiptNo: 'R300', tourNo: '71993',
      name: 'LI MING', purchaseDate: '2026-01-14',
      isDetailSheet: true, rowHash: 'b3', importedAt: 't',
    }]);
    dailyReceiptRepo.insertMany([
      {
        workspaceKey: '2026-01', receiptNo: 'R300', name: 'A',
        shop: '乐天免税店', purchaseDate: '2026-01-14',
        rowHash: 'd301', importedAt: 't',
        ledgerStatus: 'posted', tourMatchStatus: 'matched',
      },
      {
        workspaceKey: '2026-01', receiptNo: 'R300', name: 'B',
        shop: '乐天免税店', purchaseDate: '2026-01-14',
        rowHash: 'd302', importedAt: 't',
        ledgerStatus: 'posted', tourMatchStatus: 'matched',
      },
    ]);

    const svc = createBillMatchService({
      storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
    });
    const result = await svc.run({ workspaceKey: '2026-01' });
    assert.equal(result.ambiguous, 1);
    assert.equal(result.matched, 0);
    assert.equal(pendingReviewRepo.countOpen('2026-01'), 1);
  });
});

test('bill_match_service — unmatched bill → unmatched counter + log', async () => {
  await withDb(async (db) => {
    const storeBillRepo = createStoreBillRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });

    storeBillRepo.insertMany([{
      workspaceKey: '2026-01', storeFamily: '乐天免税店',
      receiptNo: 'R400', tourNo: '71000',
      name: 'Z', passportNo: 'PX', purchaseDate: '2026-01-14',
      isDetailSheet: true, rowHash: 'b4', importedAt: 't',
    }]);
    // empty daily — nothing to match
    const svc = createBillMatchService({
      storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
    });
    const result = await svc.run({ workspaceKey: '2026-01' });
    assert.equal(result.unmatched, 1);
    assert.equal(result.matched, 0);
  });
});
