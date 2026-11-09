'use strict';

// 团号模式新口径(2026-06):千问收票只有 团号+品牌(无免税分店、无返点模式),
// 团号模式必须来自团号表(group_code_multisheet 抽 gc.mode)。tour_match 用 gc.mode 写 modeRaw,
// 不自动归桶 → 进「模式归类」面板由操作员手动选桶。
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

// 千问收票:有团号、品牌(乐天),但 branch / modeRaw 都空(千问不识别分店/返点)
function insertQwenReceipt(repo, tourNo) {
  repo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-' + tourNo, tourNo, agent: '张三',
    shop: '乐天', branch: '', modeRaw: '', netKrw: 1000000,
    purchaseDate: '2026-02-10', name: 'WANG', passportNo: 'P1',
    rowHash: 'h-' + tourNo, importedAt: 't', sourceType: 'imported',
    ledgerStatus: 'posted', tourMatchStatus: 'pending',
  }]);
}

function runTour(d) {
  const svc = createTourMatchService({
    dailyReceiptRepo: d.dailyReceiptRepo, groupCodeRepo: d.groupCodeRepo,
    pendingReviewRepo: d.pendingReviewRepo, errorRecordRepo: d.errorRecordRepo,
  });
  return svc.run({ workspaceKey: WS });
}

test('团号表带模式 → 千问收票(无分店)的 modeRaw 来自团号表,不是收票乱拼', async (t) => {
  const d = setup(); t.after(() => d.db.close());
  insertQwenReceipt(d.dailyReceiptRepo, '26800251');
  // group_code_multisheet 抽出:团号 + 干净渠道模式(乐天釜山)
  d.groupCodeRepo.insertMany([{ workspaceKey: WS, tourNo: '26800251', mode: '乐天釜山', agent: null, rowHash: 'g1', importedAt: 't' }]);

  await runTour(d);
  const row = d.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  // 关键:即使收票没分店/返点,modeRaw 用团号表给的干净模式,而不是退化成 "乐天··"(收票组合)
  assert.equal(row.modeRaw, '乐天釜山', 'modeRaw 来自团号表 gc.mode');
  // 乐天釜山 不在 7 枚举(带-本司) → 不自动归桶 → 待操作员在「模式归类」面板手动选桶
  assert.equal(row.tourMatchStatus, 'skipped_mode_not_required', '不自动归桶,待操作员手动选');
  assert.equal(d.pendingReviewRepo.countOpen(WS), 0, '不产生待补救(模式待归类不是错误)');
});

test('团号表没收录该团号 → tour_not_found(进收票台账待操作员补,符合"团号表没有的存着处理")', async (t) => {
  const d = setup(); t.after(() => d.db.close());
  insertQwenReceipt(d.dailyReceiptRepo, '71990'); // 济州那种团号表没登记的
  // group_code 里没有 71990
  const stats = await runTour(d);
  const row = d.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  assert.equal(row.tourMatchStatus, 'tour_not_found', '团号表没有 → tour_not_found,收票仍在台账');
  assert.ok(stats.tourNotFound >= 1, '统计到 tour_not_found');
});
