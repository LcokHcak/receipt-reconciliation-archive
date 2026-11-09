'use strict';

/**
 * B2 未收补录:从账单反向补台账。验证
 *  - 字段全部来自账单真实数据(姓名/护照/小票/团号/日期/金额),sourceType=bill_backfill
 *  - posted + tour matched(有意绕过团号校验,操作人负责)
 *  - rowHash 防重(重复补录 skip)
 *  - 补录后该小票从 listUnreceived 自然消失(台账已收)
 *  - 纯补录客户被交付侧跳过 PDF/客户文件夹(allBackfill 判定用 trace_daily_source_type)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const {
  createUnreceivedBackfillService,
} = require('../services/monthly/unreceived_backfill_service');
const {
  createCustomerReconciliationService,
} = require('../services/monthly/customer_reconciliation_service');

const WS = '2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const storeBillRepo = createStoreBillRepository({ db });
  // 未收=SMG总账口径:store_bill 未收行挂 smg_ledger job,listUnreceived 才认。
  smgJobId = createImportJobRepository({ db }).create({
    workspaceKey: WS, jobType: 'smg_ledger', sourceFile: 'SMG总账.xlsx', operator: 'op', startedAt: 't',
  });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const recon = createCustomerReconciliationService({ db });
  const svc = createUnreceivedBackfillService({ db, dailyReceiptRepo });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return { db, storeBillRepo, dailyReceiptRepo, recon, svc };
}

let smgJobId = null;
function seedBill(repo, extras = {}) {
  repo.insertMany([{
    workspaceKey: WS,
    storeFamily: 'THE SHILLA',
    mode: '济州新罗V团',
    receiptNo: '0326152400379',
    tourNo: '71992',
    name: 'ZHU X',
    passportNo: 'EH1234567',
    purchaseDate: '2026-01-24',
    departureDate: '2026-01-25',
    netKrw: 1778232,
    netUsd: 1211,
    grossKrw: 1872210,
    isDetailSheet: true,
    rowHash: 'b-backfill-1',
    importedAt: 't',
    importJobId: smgJobId, // 未收=SMG总账口径
    ...extras,
  }]);
}

test('backfill creates ledger row from bill with real fields and removes it from unreceived', async (t) => {
  const s = setup(t);
  seedBill(s.storeBillRepo);

  assert.equal(s.recon.listUnreceived(WS).length, 1, '补录前是未收');

  const result = await s.svc.backfill({
    workspaceKey: WS,
    items: [{ passportNo: 'EH1234567', name: 'ZHU X', receiptNo: '0326152400379' }],
    operator: 'tester',
  });
  assert.equal(result.backfilled, 1);
  assert.equal(result.notFound.length, 0);

  const rows = s.dailyReceiptRepo._listAll({ workspaceKey: WS });
  assert.equal(rows.length, 1);
  const row = s.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: rows[0].id });
  assert.equal(row.name, 'ZHU X');
  assert.equal(row.passportNo, 'EH1234567');
  assert.equal(row.receiptNo, '0326152400379');
  assert.equal(row.tourNo, '71992');
  assert.equal(row.purchaseDate, '2026-01-24');
  assert.equal(row.sourceType, 'bill_backfill');
  assert.equal(row.ledgerStatus, 'posted');
  assert.equal(row.tourMatchStatus, 'matched');
  assert.equal(row.modeFolder, '济州新罗V团');

  assert.equal(s.recon.listUnreceived(WS).length, 0, '补录后台账已收,不再是未收');
});

test('backfill is idempotent via rowHash and reports notFound', async (t) => {
  const s = setup(t);
  seedBill(s.storeBillRepo);

  const first = await s.svc.backfill({
    workspaceKey: WS,
    items: [{ passportNo: 'EH1234567', name: 'ZHU X', receiptNo: '0326152400379' }],
  });
  assert.equal(first.backfilled, 1);

  const second = await s.svc.backfill({
    workspaceKey: WS,
    items: [
      { passportNo: 'EH1234567', name: 'ZHU X', receiptNo: '0326152400379' },
      { passportNo: 'NOPE', name: 'GHOST', receiptNo: '9999999999' },
    ],
  });
  assert.equal(second.backfilled, 0, '同小票重复补录被 rowHash 防重 skip');
  assert.equal(second.skipped, 1);
  assert.equal(second.notFound.length, 1, '账单里不存在的项进 notFound');

  assert.equal(s.dailyReceiptRepo._listAll({ workspaceKey: WS }).length, 1, '台账仍只有一行');
});

test('backfill runs billMatchService automatically when injected', async (t) => {
  const s = setup(t);
  seedBill(s.storeBillRepo);
  const calls = [];
  const svc = createUnreceivedBackfillService({
    db: s.db,
    dailyReceiptRepo: s.dailyReceiptRepo,
    billMatchService: { async run(args) { calls.push(args); return { matched: 1 }; } },
  });
  const result = await svc.backfill({
    workspaceKey: WS,
    items: [{ passportNo: 'EH1234567', name: 'ZHU X', receiptNo: '0326152400379' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspaceKey, WS);
  assert.deepEqual(result.billMatch, { matched: 1 });
});

test('delivery export skips pure-backfill customers (no PDF / no data package)', () => {
  // 交付侧判定使用 listEligibleRows 的 trace_daily_source_type 列;
  // 这里断言查询列与跳过逻辑存在(集成行为由 final_delivery 测试套覆盖)。
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'monthly', 'final_delivery_export_service.js'),
    'utf8'
  );
  assert.match(src, /d\.source_type AS trace_daily_source_type/);
  assert.match(src, /trace_daily_source_type === 'bill_backfill'/);
  assert.match(src, /backfill_customer_skipped/);
});
