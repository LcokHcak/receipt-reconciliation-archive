'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-01';

function setup() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES ('${WS}', 2026, 1, 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  const repo = createDailyReceiptRepository({ db });
  return { db, repo };
}

function insertDaily(db, { id, receiptNo, tourNo = 'T1' }) {
  db.prepare(`
    INSERT INTO daily_receipt_export (id, workspace_key, receipt_no, tour_no, name, passport_no,
      tour_match_status, row_hash, imported_at)
    VALUES (?, ?, ?, ?, 'A', 'P1', 'date_out_of_window', ?, '2026-01-02T00:00:00.000Z')
  `).run(id, WS, receiptNo, tourNo, `h${id}`);
}

function seedDependents(db, { dailyId, receiptNo }) {
  db.prepare(`INSERT INTO pending_review (workspace_key, source_table, source_id, reason_type, status, created_at)
              VALUES (?, 'daily_receipt_export', ?, 'date_out_of_window', 'open', '2026-01-02T00:00:00.000Z')`)
    .run(WS, dailyId);
  db.prepare(`INSERT INTO error_record (workspace_key, error_type, receipt_no, status, detected_at)
              VALUES (?, 'TM_DATE_OUT_OF_WINDOW', ?, 'open', '2026-01-02T00:00:00.000Z')`)
    .run(WS, receiptNo);
  db.prepare(`INSERT INTO match_badcase (workspace_key, stage, kind, snapshot, source_table, source_id, daily_receipt_id, receipt_no, created_at)
              VALUES (?, 'tour_match', 'date_out_of_window', '{}', 'daily_receipt_export', ?, ?, ?, '2026-01-02T00:00:00.000Z')`)
    .run(WS, dailyId, dailyId, receiptNo);
  db.prepare(`INSERT INTO bill_match_log (workspace_key, daily_receipt_id, match_priority, match_status, matched_at)
              VALUES (?, ?, 1, 'unmatched', '2026-01-02T00:00:00.000Z')`)
    .run(WS, dailyId);
  db.prepare(`INSERT INTO monthly_data (workspace_key, mode_folder, daily_receipt_id, receipt_no, row_hash, created_at, updated_at)
              VALUES (?, '乐天首尔', ?, ?, ?, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`)
    .run(WS, dailyId, receiptNo, `md${dailyId}`);
}

const count = (db, sql, ...a) => Number(db.prepare(sql).get(...a).c);

test('删台账行 → 级联清 pending_review/error_record/match_badcase/bill_match_log/monthly_data', () => {
  const { db, repo } = setup();
  insertDaily(db, { id: 1, receiptNo: 'R1' });
  seedDependents(db, { dailyId: 1, receiptNo: 'R1' });

  // 删前都在
  assert.equal(count(db, 'SELECT COUNT(*) c FROM pending_review WHERE workspace_key=?', WS), 1);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM error_record WHERE workspace_key=?', WS), 1);

  const deleted = repo.deleteLedgerRow({ workspaceKey: WS, id: 1 });
  assert.equal(deleted, 1);

  // 删后全清
  assert.equal(count(db, 'SELECT COUNT(*) c FROM daily_receipt_export WHERE workspace_key=?', WS), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM pending_review WHERE workspace_key=?', WS), 0, 'pending_review 应被清');
  assert.equal(count(db, 'SELECT COUNT(*) c FROM error_record WHERE workspace_key=?', WS), 0, 'TM error_record 应被清');
  assert.equal(count(db, 'SELECT COUNT(*) c FROM match_badcase WHERE workspace_key=?', WS), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM bill_match_log WHERE workspace_key=?', WS), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM monthly_data WHERE workspace_key=?', WS), 0);
});

test('同票多行:删一行不误删 error_record(还有别的台账行用该 receipt_no)', () => {
  const { db, repo } = setup();
  insertDaily(db, { id: 1, receiptNo: 'R1' });
  insertDaily(db, { id: 2, receiptNo: 'R1' });
  seedDependents(db, { dailyId: 1, receiptNo: 'R1' });

  repo.deleteLedgerRow({ workspaceKey: WS, id: 1 });
  // 还有 id=2 也是 R1 → TM error_record 不该被删
  assert.equal(count(db, 'SELECT COUNT(*) c FROM error_record WHERE workspace_key=?', WS), 1, '同票还有残留台账,不清 error');

  repo.deleteLedgerRow({ workspaceKey: WS, id: 2 });
  // R1 已无台账 → error_record 清掉
  assert.equal(count(db, 'SELECT COUNT(*) c FROM error_record WHERE workspace_key=?', WS), 0);
});

test('deleteMany 也级联', () => {
  const { db, repo } = setup();
  insertDaily(db, { id: 1, receiptNo: 'R1' });
  insertDaily(db, { id: 2, receiptNo: 'R2' });
  seedDependents(db, { dailyId: 1, receiptNo: 'R1' });
  seedDependents(db, { dailyId: 2, receiptNo: 'R2' });

  const deleted = repo.deleteMany({ workspaceKey: WS, ids: [1, 2] });
  assert.equal(deleted, 2);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM pending_review WHERE workspace_key=?', WS), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM error_record WHERE workspace_key=?', WS), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM monthly_data WHERE workspace_key=?', WS), 0);
});

// B3(2026-07-16 同步一致性审计):field_conflict 挂 store_bill 名下(dailyReceiptId 在 detail 里),
// 删台账行必须把它一并关闭(resolution=daily_row_deleted),否则永久卡 open。
test('删台账行 → store_bill 侧 field_conflict 待审被关闭(不再永久卡 open)', () => {
  const { db, repo } = setup();
  insertDaily(db, { id: 93, receiptNo: 'R-B3' });
  db.prepare(`INSERT INTO pending_review (workspace_key, source_table, source_id, reason_type, detail, status, created_at)
              VALUES (?, 'store_bill', 777, 'field_conflict', ?, 'open', '2026-01-02T00:00:00.000Z')`)
    .run(WS, JSON.stringify({ dailyReceiptId: 93, conflicts: [{ field: 'tourNo' }] }));

  repo.deleteMany({ workspaceKey: WS, ids: [93] });

  const row = db.prepare('SELECT status, resolution FROM pending_review WHERE source_table = ?').get('store_bill');
  assert.equal(row.status, 'resolved', '删行后 store_bill 侧待审必须关闭');
  assert.equal(row.resolution, 'daily_row_deleted');
  db.close();
});
