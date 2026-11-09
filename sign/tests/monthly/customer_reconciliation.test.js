'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createImportJobRepository } = require('../../repositories/import_job_repository');
const { createCustomerReconciliationService } = require('../../services/monthly/customer_reconciliation_service');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-05';

// 未收=SMG总账口径(2026-07-22 拍板):store_bill 未收行必须挂 smg_ledger job,
// billUnreceivedStmt 才认。makeCtx 建一个 smg job,bill() 默认挂它。
let smgJobId = null;

function makeCtx() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES ('${WS}', 2026, 5, 'open', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
  `);
  const storeBillRepo = createStoreBillRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  smgJobId = importJobRepo.create({
    workspaceKey: WS, jobType: 'smg_ledger', sourceFile: 'SMG总账.xlsx', operator: 'op',
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  const service = createCustomerReconciliationService({ db });
  return { db, storeBillRepo, importJobRepo, service, smgJobId };
}

let dailySeq = 0;
function insertDaily(db, { passportNo, name, receiptNo, tourNo = 'T001', agent = 'AG', folder = '乐天首尔', tourMatchStatus = 'matched' }) {
  dailySeq += 1;
  // 账单核对/未收只看团号匹配通过(matched)的行,默认 matched 反映真实流程。
  db.prepare(`
    INSERT INTO daily_receipt_export
      (workspace_key, passport_no, name, receipt_no, tour_no, agent, mode_folder, tour_match_status, row_hash, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(WS, passportNo, name, receiptNo, tourNo, agent, folder, tourMatchStatus, `d${dailySeq}`, '2026-05-11T00:00:00.000Z');
}

function bill({ passportNo, name, receiptNo, family = '乐天首尔', hash, importJobId }) {
  return {
    workspaceKey: WS, storeFamily: family, name, passportNo, receiptNo,
    tourNo: 'T001', purchaseDate: '2026-05-10', isDetailSheet: true,
    rowHash: hash, importedAt: '2026-05-11T00:00:00.000Z',
    // 未收=SMG总账口径:默认挂当前 smg job;个别测试可显式传 importJobId(如店家账单 job 验证被排除)
    importJobId: importJobId !== undefined ? importJobId : smgJobId,
  };
}

test('客户台账 3 张 / 账单 2 张 → mismatch,missing_in_bill 列出缺的第 3 张', () => {
  const { db, storeBillRepo, service } = makeCtx();
  for (const r of ['R1', 'R2', 'R3']) insertDaily(db, { passportNo: 'P1', name: 'A', receiptNo: r });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'A', receiptNo: 'R1', hash: 'a' }),
    bill({ passportNo: 'P1', name: 'A', receiptNo: 'R2', hash: 'b' }),
  ]);
  const diff = service.getCustomerDiff(WS);
  assert.equal(diff.length, 1);
  const row = diff[0];
  assert.equal(row.status, 'mismatch');
  assert.equal(row.dailyCount, 3);
  assert.equal(row.billCount, 2);
  assert.deepEqual(row.missingInBill, ['R3'], 'R3 台账有账单无 → 小票无账单(非未收)');
  assert.deepEqual(row.missingInDaily, []);
});

test('⭐未收单源=SMG总账(2026-07-22拍板):同票两源不翻倍/店家账单-only票不入未收', () => {
  const { storeBillRepo, importJobRepo, service } = makeCtx();
  const storeBillJobId = importJobRepo.create({
    workspaceKey: WS, jobType: 'store_bill', sourceFile: '乐天账单.xlsx', operator: 'op',
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  storeBillRepo.insertMany([
    // 同一票 R1:SMG行($100)+ 店家账单行($100)。旧 SQL 跨源 SUM=200(翻倍);新口径只算 SMG=100。
    { ...bill({ passportNo: 'P1', name: 'A', receiptNo: 'R1', hash: 'smg1' }), netUsd: 100 },
    { ...bill({ passportNo: 'P1', name: 'A', receiptNo: 'R1', hash: 'sb1', importJobId: storeBillJobId }), netUsd: 100 },
    // 店家账单-only 票 R2:不该进未收(月度对账才管它)
    { ...bill({ passportNo: 'P2', name: 'B', receiptNo: 'R2', hash: 'sb2', importJobId: storeBillJobId }), netUsd: 50 },
  ]);
  const rows = service.listUnreceived(WS);
  assert.equal(rows.length, 1, '店家账单-only 票不入未收(两套对账逻辑)');
  assert.equal(rows[0].receipt_no, 'R1');
  assert.equal(rows[0].net_usd, 100, '同票两源只算 SMG,不翻倍成 200');
});

test('未收=SMG:工作区只有店家账单(无SMG导入)→ 未收为空(拍板接受)', () => {
  const { storeBillRepo, importJobRepo, service } = makeCtx();
  const storeBillJobId = importJobRepo.create({
    workspaceKey: WS, jobType: 'store_bill', sourceFile: '乐天账单.xlsx', operator: 'op',
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  storeBillRepo.insertMany([
    { ...bill({ passportNo: 'P9', name: 'Z', receiptNo: 'RX', hash: 'sbx', importJobId: storeBillJobId }), netUsd: 300 },
  ]);
  assert.equal(service.listUnreceived(WS).length, 0, '没导 SMG 总账 → 未收为空');
});

test('账单多出一张 → missing_in_daily 列出', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertDaily(db, { passportNo: 'P2', name: 'B', receiptNo: 'R1' });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P2', name: 'B', receiptNo: 'R1', hash: 'a' }),
    bill({ passportNo: 'P2', name: 'B', receiptNo: 'R9', hash: 'b' }),
  ]);
  const row = service.getCustomerDiff(WS)[0];
  assert.equal(row.status, 'mismatch');
  assert.deepEqual(row.missingInDaily, ['R9']);
  assert.deepEqual(row.missingInBill, []);
});

test('张数相同且小票号一致 → match', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertDaily(db, { passportNo: 'P3', name: 'C', receiptNo: 'R1' });
  insertDaily(db, { passportNo: 'P3', name: 'C', receiptNo: 'R2' });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P3', name: 'C', receiptNo: 'R1', hash: 'a' }),
    bill({ passportNo: 'P3', name: 'C', receiptNo: 'R2', hash: 'b' }),
  ]);
  const row = service.getCustomerDiff(WS)[0];
  assert.equal(row.status, 'match');
  assert.equal(row.dailyCount, 2);
  assert.equal(row.billCount, 2);
});

test('同小票多商品行账单 → 账单 distinct receipt 计数不被商品行放大', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertDaily(db, { passportNo: 'P4', name: 'D', receiptNo: 'R1' });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P4', name: 'D', receiptNo: 'R1', hash: 'a' }),
    bill({ passportNo: 'P4', name: 'D', receiptNo: 'R1', hash: 'b' }),
    bill({ passportNo: 'P4', name: 'D', receiptNo: 'R1', hash: 'c' }),
  ]);
  const row = service.getCustomerDiff(WS)[0];
  assert.equal(row.billCount, 1, '3 商品行同小票 → distinct 1 张');
  assert.equal(row.status, 'match');
});

test('getMismatches 只返回不一致的客户', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertDaily(db, { passportNo: 'P5', name: 'E', receiptNo: 'R1' });
  storeBillRepo.insertMany([bill({ passportNo: 'P5', name: 'E', receiptNo: 'R1', hash: 'a' })]);
  insertDaily(db, { passportNo: 'P6', name: 'F', receiptNo: 'R1' });
  insertDaily(db, { passportNo: 'P6', name: 'F', receiptNo: 'R2' });
  storeBillRepo.insertMany([bill({ passportNo: 'P6', name: 'F', receiptNo: 'R1', hash: 'b' })]);
  const mismatches = service.getMismatches(WS);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].name, 'F');
});

test('小票号大小写/空格不一致 → 归一化后视为同一张,不误报未收', () => {
  const { db, storeBillRepo, service } = makeCtx();
  // 台账 'ab 123 '(尾空格 + 中间空格),账单 'AB123'(大写无空格)→ 同一张
  insertDaily(db, { passportNo: 'P9', name: 'han snow', receiptNo: 'ab 123 ' });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P9', name: 'HAN SNOW', receiptNo: 'AB 123', hash: 'a' }),
  ]);
  const row = service.getCustomerDiff(WS)[0];
  assert.equal(row.status, 'match', '大小写/空格差异不应判为不一致');
  assert.equal(row.dailyCount, 1);
  assert.equal(row.billCount, 1);
  assert.deepEqual(row.missingInBill, []);
  assert.deepEqual(row.missingInDaily, []);
});

test('listUnreceived 行级返回账单有台账无(客户该补交),台账已收/大小写变体均排除', () => {
  const { db, storeBillRepo, service } = makeCtx();
  // 口径(2026-06-03 统一): 未收 = 账单有、台账无。
  // 台账 3 张: R1, R2, 'ab 123 '(与账单 'AB 123' 归一化同张)。
  insertDaily(db, { passportNo: 'P1', name: 'A', receiptNo: 'R1' });
  insertDaily(db, { passportNo: 'P1', name: 'A', receiptNo: 'R2' });
  insertDaily(db, { passportNo: 'P9', name: 'han snow', receiptNo: 'ab 123 ' });
  storeBillRepo.insertMany([
    // R1 账单+台账都有 → 已收,非未收
    bill({ passportNo: 'P1', name: 'A', receiptNo: 'R1', hash: 'a' }),
    // 'AB 123' 与台账 'ab 123 ' 归一化同张 → 已收,非未收
    bill({ passportNo: 'P9', name: 'HAN SNOW', receiptNo: 'AB 123', hash: 'b' }),
    // ORPH 账单有、台账无 → 未收(客户该补交)
    bill({ passportNo: 'PZ', name: 'GHOST', receiptNo: 'ORPH', hash: 'c' }),
  ]);
  // R2 台账有、账单无 → 归「小票无账单」,不在未收
  const rows = service.listUnreceived(WS);
  assert.equal(rows.length, 1, '只剩 ORPH 一张未收(账单有台账无)');
  assert.equal(rows[0].receipt_no, 'ORPH');
  assert.equal(rows[0].passport_no, 'PZ');
});

test('卡在团号阶段的行(非 matched)不算未收、不进对账', () => {
  const { db, service } = makeCtx();
  // 一张团号匹配通过 + 有账单 → 不是未收;一张日期越界(待补救)且无账单 → 不该被当未收
  insertDaily(db, { passportNo: 'PX', name: 'X', receiptNo: 'OK1', tourMatchStatus: 'matched' });
  insertDaily(db, { passportNo: 'PY', name: 'Y', receiptNo: 'BLOCKED1', tourMatchStatus: 'date_out_of_window' });
  // 没有任何账单 → 若不过滤,两张都会被算未收
  const rows = service.listUnreceived(WS);
  const blocked = rows.find((r) => r.receipt_no === 'BLOCKED1');
  assert.equal(blocked, undefined, '日期越界(待补救)的行不应出现在未收');
  const diff = service.getCustomerDiff(WS);
  assert.equal(diff.some((r) => r.name === 'Y'), false, '待补救行不进账单核对');
});

test('folder 过滤只对账该业务桶', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertDaily(db, { passportNo: 'P7', name: 'G', receiptNo: 'R1', folder: '乐天首尔' });
  insertDaily(db, { passportNo: 'P8', name: 'H', receiptNo: 'R2', folder: '爱宝客' });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P7', name: 'G', receiptNo: 'R1', family: '乐天首尔', hash: 'a' }),
  ]);
  const seoul = service.getCustomerDiff(WS, { folder: '乐天首尔' });
  assert.equal(seoul.length, 1);
  assert.equal(seoul[0].name, 'G');
  assert.equal(seoul[0].status, 'match');
});

test('本月账单只有退货行(跨月退货)→ 台账小票仍算「小票无账单」,不被退货行掩盖', () => {
  const { db, storeBillRepo, service } = makeCtx();
  // 台账收了 R1;本月账单里 R1 只有退货行(售出行在上月账单)
  insertDaily(db, { passportNo: 'P1', name: 'A', receiptNo: 'R1' });
  storeBillRepo.insertMany([
    { ...bill({ passportNo: 'P1', name: 'A', receiptNo: 'R1', hash: 'rf' }), transactionType: 'refund' },
  ]);
  const diff = service.getCustomerDiff(WS);
  assert.equal(diff.length, 1);
  // 退货行不算"账单出现过":匹配管线 sale-only,该票本月算不出返点 → 必须暴露而非静默
  assert.deepEqual(diff[0].missingInBill, ['R1'], '退货行不掩盖小票无账单');
});

test('listUnreceivedByCustomer 与 listUnreceived 完全同源(账单核对未收tab对齐未收清单页)', () => {
  const { db, storeBillRepo, service } = makeCtx();
  // 同一客户 P1 两张未收(O1,O2) + 另一客户 PZ 一张未收(O3),共 3 张、2 位客户
  insertDaily(db, { passportNo: 'P1', name: 'A', receiptNo: 'R1' }); // 已收,不算未收
  storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'A', receiptNo: 'R1', hash: 'a' }),
    bill({ passportNo: 'P1', name: 'A', receiptNo: 'O1', hash: 'b' }),
    bill({ passportNo: 'P1', name: 'A', receiptNo: 'O2', hash: 'c' }),
    bill({ passportNo: 'PZ', name: 'GHOST', receiptNo: 'O3', hash: 'd' }),
  ]);
  const flat = service.listUnreceived(WS);
  const grouped = service.listUnreceivedByCustomer(WS);
  // receiptTotal 必须 == 未收清单页逐张行数(口径一一对应,杜绝 13594 vs 3835)
  assert.equal(grouped.receiptTotal, flat.length, 'receiptTotal=未收小票总张数');
  assert.equal(grouped.receiptTotal, 3);
  assert.equal(grouped.rows.length, 2, '2 位客户');
  const p1 = grouped.rows.find((r) => r.passportNo === 'P1');
  assert.deepEqual(p1.missingInDaily, ['O1', 'O2'], '同客户的多张未收归并到一行');
  // 跨所有客户行的未收小票数之和 == receiptTotal == 逐张口径
  const sum = grouped.rows.reduce((n, r) => n + r.missingInDaily.length, 0);
  assert.equal(sum, flat.length);
});
