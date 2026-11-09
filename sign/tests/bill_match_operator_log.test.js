'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createStageLogService } = require('../services/monthly/stage_log_service');

function createMemoryStageLog() {
  const lines = [];
  return {
    lines,
    service: {
      createRunLog() {
        return {
          writeLine(line = '') {
            lines.push(String(line));
          },
          writeJson(label, payload) {
            lines.push(`${label}: ${JSON.stringify(payload, null, 2)}`);
          },
          finish({ result }) {
            if (result) lines.push(`最终统计: ${JSON.stringify(result, null, 2)}`);
            return { logFile: 'memory.log', logPath: 'memory.log' };
          },
        };
      },
    },
  };
}

function createServiceHarness({ dailyRows, bills }) {
  const stage = createMemoryStageLog();
  const billMatchRows = [];
  const pendingRows = [];
  const statusUpdates = [];

  const service = createBillMatchService({
    storeBillRepo: {
      iterateDetail() {
        return bills;
      },
    },
    dailyReceiptRepo: {
      _listAll() {
        return dailyRows;
      },
      _applyBillMatchBatch(rows) {
        statusUpdates.push(...rows);
      },
      updateBillMatch(row) {
        statusUpdates.push(row);
      },
    },
    billMatchLogRepo: {
      insertMany(rows) {
        billMatchRows.push(...rows);
        return { inserted: rows.length };
      },
    },
    pendingReviewRepo: {
      insertMany(rows) {
        pendingRows.push(...rows);
        return { inserted: rows.length };
      },
    },
  });

  return { service, stage, billMatchRows, pendingRows, statusUpdates };
}

function postedDaily(overrides = {}) {
  return {
    id: 101,
    workspaceKey: '2026-01',
    ledgerStatus: 'posted',
    tourMatchStatus: 'matched',
    receiptNo: '0326163500229',
    tourNo: '71993',
    name: 'BAI RUIYAN',
    passportNo: 'EM9314578',
    purchaseDate: '2026-01-24',
    departureDate: '2026-01-26',
    shop: 'THE SHILLA',
    branch: 'JEJU',
    modeNormalized: 'V',
    ...overrides,
  };
}

function storeBill(overrides = {}) {
  return {
    id: 501,
    workspaceKey: '2026-01',
    isDetailSheet: true,
    sourceSheet: '明细',
    sourceRow: 12,
    receiptNo: '0326163500229',
    tourNo: '71993',
    name: 'BAI RUIYAN',
    fullName: 'BAI RUIYAN',
    passportNo: 'EM9314578',
    purchaseDate: '2026-01-24',
    departureDate: '2026-01-26',
    storeFamily: 'THE SHILLA',
    storeBranch: 'JEJU',
    modeNormalized: 'V',
    ...overrides,
  };
}

test('账单匹配日志使用操作员能看懂的字段比对口径', async () => {
  const { service, stage } = createServiceHarness({
    dailyRows: [postedDaily()],
    bills: [storeBill()],
  });

  await service.run({
    workspaceKey: '2026-01',
    stageJobId: 'job-log-test',
    stageLogService: stage.service,
  });

  const text = stage.lines.join('\n');
  assert.match(text, /这个日志什么时候用/);
  assert.match(text, /账单Excel字段【小票号】=0326163500229；台账字段【小票号】=0326163500229；结果：一致/);
  assert.match(text, /使用规则：P1 小票号一致/);
  assert.match(text, /数据去向：本条进入【正式月度数据】/);
  assert.match(text, /最终统计[\s\S]*"匹配成功进入正式月度数据"/);
  assert.doesNotMatch(text, /结果:\s*matched|dailyReceiptId=|matchKey|receipt=/);
});

test('账单字段冲突日志说明冲突字段和人工确认去向', async () => {
  const { service, stage } = createServiceHarness({
    dailyRows: [postedDaily()],
    bills: [storeBill({ passportNo: 'CONFLICT-PASSPORT' })],
  });

  await service.run({
    workspaceKey: '2026-01',
    stageJobId: 'job-log-conflict',
    stageLogService: stage.service,
  });

  const text = stage.lines.join('\n');
  assert.match(text, /字段【护照号】不一致：账单Excel=CONFLICT-PASSPORT；台账=EM9314578/);
  assert.match(text, /数据去向：本条进入【人工确认表】/);
  assert.doesNotMatch(text, /field|dailyValue|billValue|pending_review/);
});

test('落盘阶段日志使用中文结束和统计标签', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-log-cn-'));
  const service = createStageLogService({ exportRoot: dir });
  const log = service.createRunLog({
    workspaceKey: '2026-01',
    stage: 'bill_match',
    stageJobId: 'cn-label',
    startedAt: '2026-05-17T00:00:00.000Z',
  });

  const meta = log.finish({
    finishedAt: '2026-05-17T00:00:01.000Z',
    result: { 匹配成功进入正式月度数据: 1 },
  });
  const text = fs.readFileSync(meta.logPath, 'utf8');

  assert.match(text, /结束时间：2026-05-17T00:00:01.000Z/);
  assert.match(text, /最终统计[\s\S]*匹配成功进入正式月度数据/);
  assert.doesNotMatch(text, /鏈|缁|閿|宸ヤ綔/);
});

test('阶段汇总日志把内部阶段名显示成中文操作名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-summary-cn-'));
  const service = createStageLogService({ exportRoot: dir });
  const meta = service.writeStageSummary({
    workspaceKey: '2026-01',
    stage: 'import_store_bill',
    startedAt: '2026-05-17T00:00:00.000Z',
    operator: 'tester',
    result: { 按钮: '选择店铺账单', 导入账单明细: 20 },
  });

  const text = fs.readFileSync(meta.logPath, 'utf8');
  assert.match(text, /阶段：导入店铺账单/);
  assert.doesNotMatch(text, /阶段：import_store_bill/);
});
