'use strict';

// 2026-06-13 字段冲突孤儿根因修复:首页/交付检查的「活跃待审」计数对 field_conflict
// 加活校验——若引用的台账行 conflict_fields 已清空且 bill_match_status='matched'
// (冲突已在别处改对、记录没人关),这条 open pending 立即不再算阻塞,无需重跑。
// 服务器实测:旧谓词=2、新谓词=0(2 条陈旧字段冲突孤儿)。
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-01';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  return { db, dailyReceiptRepo, pendingReviewRepo };
}

function insertDaily(dailyReceiptRepo, { conflictFields, billMatchStatus }) {
  dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-1', shop: 'THE SHILLA', purchaseDate: '2026-01-15',
    name: 'BI JIANPING', passportNo: 'EQ2342222', rowHash: 'h1', importedAt: '2026-01-01T00:00:00.000Z',
    sourceType: 'imported', ledgerStatus: 'posted', tourMatchStatus: 'matched',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  dailyReceiptRepo.updateBillMatch({
    id: row.id, workspaceKey: WS, billMatchStatus, billMatchPriority: null, conflictFields,
  });
  return row;
}

function insertFieldConflictPending(pendingReviewRepo, dailyId) {
  pendingReviewRepo.insertMany([{
    workspaceKey: WS, sourceTable: 'store_bill', sourceId: 5743, reasonType: 'field_conflict',
    status: 'open', createdAt: '2026-01-02T00:00:00.000Z',
    detail: { dailyReceiptId: dailyId, conflicts: [{ field: 'name', dailyValue: 'BI JIANPING', billValue: 'BTJIANPING' }] },
  }]);
}

test('已解决的字段冲突(台账conflict_fields清空+matched)不再计入活跃阻塞', (t) => {
  const { dailyReceiptRepo, pendingReviewRepo } = setup(t);
  // 台账冲突已改好:conflict_fields=null, bill_match_status=matched
  const daily = insertDaily(dailyReceiptRepo, { conflictFields: null, billMatchStatus: 'matched' });
  insertFieldConflictPending(pendingReviewRepo, daily.id);

  assert.equal(pendingReviewRepo.countOpen(WS), 0, '孤儿字段冲突应被活校验排除(阻塞归零)');
  // byReason 也不应再报这条(首页 deriveAlerts 不虚高)
  const byReason = pendingReviewRepo.countByReason(WS);
  assert.equal(byReason.find((r) => r.reason === 'field_conflict'), undefined);
});

test('真实存在的字段冲突(台账conflict_fields非空)仍计入阻塞,不被误杀', (t) => {
  const { dailyReceiptRepo, pendingReviewRepo } = setup(t);
  // 活冲突:bill_match 把 conflict_fields 写在台账上、状态 pending_review
  const daily = insertDaily(dailyReceiptRepo, { conflictFields: ['name'], billMatchStatus: 'pending_review' });
  insertFieldConflictPending(pendingReviewRepo, daily.id);

  assert.equal(pendingReviewRepo.countOpen(WS), 1, '活字段冲突必须仍算阻塞');
  assert.equal(pendingReviewRepo.list({ workspaceKey: WS, limit: 10 }).length, 1);
});
