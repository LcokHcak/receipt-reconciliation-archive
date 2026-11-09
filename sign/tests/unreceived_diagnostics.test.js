'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { diagnoseCrossMonth, summarize } = require('../scripts/oneoff/diagnose_cross_month_tickets');
const { measureUnreceived } = require('../scripts/oneoff/measure_unreceived_page');

const MIGRATIONS = path.join(__dirname, '..', 'lib', 'storage', 'migrations');
const WS = '2026-07';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());
  return db;
}

function addJob(db, { id, jobType }) {
  db.prepare(
    "INSERT INTO import_job (id, workspace_key, job_type, source_file, status, started_at) VALUES (?, ?, ?, 'f', 'done', 't')",
  ).run(id, WS, jobType);
}

let hashSeq = 0;
function addBill(db, { purchaseDate, receiptNo, passportNo = 'P', name = 'N', txn = null, jobId }) {
  hashSeq += 1;
  db.prepare(`
    INSERT INTO store_bill (workspace_key, purchase_date, receipt_no, passport_no, name, transaction_type, net_usd, import_job_id, is_detail_sheet, row_hash, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, 100, ?, 0, ?, 't')
  `).run(WS, purchaseDate, receiptNo, passportNo, name, txn, jobId, `h${hashSeq}`);
}

test('L18 诊断 diagnoseCrossMonth:数出 earlier(购买月<账期月)行/票号,排除非 SMG/退货', (t) => {
  const db = setup(t);
  addJob(db, { id: 1, jobType: 'smg_ledger' });
  addJob(db, { id: 2, jobType: 'store_bill' }); // 非 SMG,应被排除
  // SMG(job 1)sale:
  addBill(db, { purchaseDate: '2026-06-15', receiptNo: 'R1', jobId: 1 }); // earlier
  addBill(db, { purchaseDate: '2026-06-15', receiptNo: 'R2', jobId: 1 }); // earlier
  addBill(db, { purchaseDate: '2026-06-20', receiptNo: 'R1', jobId: 1 }); // earlier(票号 R1 重复)
  addBill(db, { purchaseDate: '2026-07-10', receiptNo: 'R3', jobId: 1 }); // 同月
  addBill(db, { purchaseDate: '2026-08-05', receiptNo: 'R4', jobId: 1 }); // later
  addBill(db, { purchaseDate: '2026-06-01', receiptNo: 'R5', jobId: 1, txn: 'return' }); // 退货,排除
  addBill(db, { purchaseDate: '2026-06-15', receiptNo: 'R6', jobId: 2 }); // 非 SMG job,排除

  const rows = diagnoseCrossMonth(db);
  assert.equal(rows.length, 1, '只有 1 个 SMG 工作区');
  const r = rows[0];
  assert.equal(r.ws, WS);
  assert.equal(r.month, '2026-07');
  assert.equal(r.total, 5, 'SMG sale 行数(退货/非SMG 排除)');
  assert.equal(r.earlier, 3, '购买月<账期月的行(3 行 6 月票)');
  assert.equal(r.later, 1, '购买月>账期月的行(1 行 8 月票)');
  assert.equal(r.earlierReceipts, 2, '跨月 earlier 的不同票号数(R1、R2,R1 去重)');

  const s = summarize(rows);
  assert.equal(s.totalEarlier, 3);
  assert.equal(s.totalEarlierReceipts, 2);
});

test('L18 诊断:无 SMG 导入的库 → 空结果(不炸)', (t) => {
  const db = setup(t);
  assert.deepEqual(diagnoseCrossMonth(db), []);
  assert.equal(summarize([]).workspaces, 0);
});

test('L103 诊断 measureUnreceived:bill 行=按票聚合数、ledger 行=有票号台账数(计时字段在位)', (t) => {
  const db = setup(t);
  addJob(db, { id: 1, jobType: 'smg_ledger' });
  // 同一票(P1/N1/R1)两行 → GROUP BY 聚合成 1 未收行;另一票 1 行 → 共 2 未收行
  addBill(db, { purchaseDate: '2026-07-01', receiptNo: 'R1', passportNo: 'P1', name: 'N1', jobId: 1 });
  addBill(db, { purchaseDate: '2026-07-02', receiptNo: 'R1', passportNo: 'P1', name: 'N1', jobId: 1 });
  addBill(db, { purchaseDate: '2026-07-03', receiptNo: 'R2', passportNo: 'P2', name: 'N2', jobId: 1 });
  // 台账:2 行有票号(算已收键)+ 1 行空票号(不算)
  const daily = createDailyReceiptRepository({ db });
  daily.insertMany([
    { workspaceKey: WS, receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-01', rowHash: 'd1', importedAt: 't', sourceType: 'imported' },
    { workspaceKey: WS, receiptNo: 'R9', shop: 'S', purchaseDate: '2026-07-02', rowHash: 'd2', importedAt: 't', sourceType: 'imported' },
    { workspaceKey: WS, receiptNo: '', shop: 'S', purchaseDate: '2026-07-03', rowHash: 'd3', importedAt: 't', sourceType: 'imported' },
  ]);

  const rows = measureUnreceived(db);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.billRows, 2, '未收行=按 (passport,name,receipt) 聚合的 SMG 票数');
  assert.equal(r.ledgerRows, 2, '已收键=有票号的台账行(空票号不算)');
  assert.equal(typeof r.totalMs, 'number', '合计耗时字段在位');
  assert.equal(typeof r.approxUnreceivedBytes, 'number', '响应体积估算字段在位');
});
