'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createTourMatchService } = require('../services/monthly/tour_match_service');

const WS = '2026-02';

function setup() {
  const db = openMonthlyDatabase({ dbPath: ':memory:' });
  db.prepare(`INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
              VALUES (?, 2026, 2, 'open', ?, ?)`).run(WS, 't', 't');
  return {
    db,
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    groupCodeRepo: createGroupCodeRepository({ db }),
    pendingReviewRepo: createPendingReviewRepository({ db }),
    errorRecordRepo: createErrorRecordRepository({ db }),
  };
}

// 一张收票:团号 T1,代理「张三」,店铺=乐天/分店=乐天釜山/模式=SG → 桶应是乐天釜山。
function insertReceipt(repo, overrides = {}) {
  repo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-1', tourNo: 'T1', agent: '张三',
    shop: '乐天', branch: '乐天釜山', modeRaw: 'SG', netKrw: 1000000,
    purchaseDate: '2026-02-10', name: 'WANG', passportNo: 'P1',
    rowHash: 'h1', importedAt: 't', sourceType: 'imported',
    ledgerStatus: 'posted', tourMatchStatus: 'pending', ...overrides,
  }]);
  return repo._listAll({ workspaceKey: WS })[0];
}

function runTour(deps) {
  const svc = createTourMatchService({
    dailyReceiptRepo: deps.dailyReceiptRepo, groupCodeRepo: deps.groupCodeRepo,
    pendingReviewRepo: deps.pendingReviewRepo, errorRecordRepo: deps.errorRecordRepo,
  });
  return svc.run({ workspaceKey: WS });
}

test('代理不校验(团号表无代理,新格式):团号找到→桶来自收票组合,不会错配', async (t) => {
  const d = setup(); t.after(() => d.db.close());
  insertReceipt(d.dailyReceiptRepo);
  // 新格式团号表:只有团号,代理留空 → tour_match 不做代理校验
  d.groupCodeRepo.insertMany([{ workspaceKey: WS, tourNo: 'T1', mode: null, agent: null, rowHash: 'g1', importedAt: 't' }]);

  await runTour(d);
  const row = d.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  // 团号找到、未被代理拦;模式 = 收票自带的组合(店铺·分店·返点模式),与团号/团号表代理无关
  assert.equal(row.tourMatchStatus, 'skipped_mode_not_required', '团号找到、不因代理被打回(待操作员归桶)');
  assert.equal(row.modeRaw, '乐天·乐天釜山·SG', '模式=收票组合,桶信号来自收票本身,不会被错配');
  assert.equal(d.pendingReviewRepo.countOpen(WS), 0, '不产生代理待补救');
});

test('代理校验开启(团号表代理与收票不符):打回待补救,不静默错配', async (t) => {
  const d = setup(); t.after(() => d.db.close());
  insertReceipt(d.dailyReceiptRepo);
  // 团号表里 T1 登记的代理是「李四」≠ 收票「张三」
  d.groupCodeRepo.insertMany([{ workspaceKey: WS, tourNo: 'T1', mode: null, agent: '李四', rowHash: 'g1', importedAt: 't' }]);

  const stats = await runTour(d);
  const row = d.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  assert.equal(row.tourMatchStatus, 'agent_mismatch', '代理不符→打回待补救,不静默放过');
  assert.ok(stats.agentMismatch >= 1, '统计到 agent_mismatch');
  assert.ok(d.pendingReviewRepo.countOpen(WS) >= 1, '产生代理待补救项');
});

test('关键:错团号匹配上别的团也不会错桶(桶来自收票,非匹配到的团)', async (t) => {
  const d = setup(); t.after(() => d.db.close());
  // 收票本是乐天釜山SG,但团号填成了存在的 T2(属别的代理)。不校验代理 → 匹配上 T2。
  insertReceipt(d.dailyReceiptRepo, { tourNo: 'T2' });
  d.groupCodeRepo.insertMany([{ workspaceKey: WS, tourNo: 'T2', mode: null, agent: null, rowHash: 'g2', importedAt: 't' }]);
  await runTour(d);
  const row = d.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  // 即便匹配到的是"别的团",桶/模式仍由收票自身决定 → 钱不会进错桶
  assert.equal(row.modeRaw, '乐天·乐天釜山·SG', '桶信号仍来自收票,错团不致错桶');
});
