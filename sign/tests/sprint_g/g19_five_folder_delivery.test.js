'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createImportJobRepository } = require('../../repositories/import_job_repository');
const { createFinalDeliveryExportService } = require('../../services/monthly/final_delivery_export_service');

// 未收=SMG总账口径(2026-07-22 拍板):store_bill 未收行必须挂 smg_ledger job。
let smgJobId = null;

const WORKSPACE_KEY = '2026-05';

test('改造G: 最终交付包按 5 文件夹平铺 + manifest directoryMapping', async () => {
  const { db, dir } = setupDb();
  try {
    insertMonthlyRow(db, { rowHash: 'e1', receiptNo: 'RC-1', customerRebateKrw: 25000, customerRebateUsd: 20 });
    // 未收口径(2026-06-03 统一) = 账单有台账无: 账单一张 RC-9 无对应台账 → 1 张未收
    insertBill(db, { name: 'BAI XUE', passportNo: 'EP6274602', receiptNo: 'RC-9' });

    const service = createFinalDeliveryExportService({ db });
    const outputDir = path.join(dir, 'delivery');
    const result = await service.run({ workspaceKey: WORKSPACE_KEY, outputDir, operator: 'tester' });

    const pkg = result.outputDir;
    // 5 文件夹平铺
    assert.ok(fs.existsSync(path.join(pkg, '2_收票汇总')), '2_收票汇总 应存在');
    assert.ok(fs.existsSync(path.join(pkg, '4_最终数据')), '4_最终数据 应存在');
    assert.ok(fs.existsSync(path.join(pkg, '5_未收-用来补齐部分')), '5_未收 应存在');
    assert.ok(fs.existsSync(path.join(pkg, '客户PDF')), '客户PDF 应存在');
    assert.ok(fs.existsSync(path.join(pkg, '客户数据包')), '客户数据包 应存在');
    // 旧的 01_月度数据 / 02_收据单 / 03_客户PDF 不再出现
    assert.equal(fs.existsSync(path.join(pkg, '01_月度数据')), false);
    assert.equal(fs.existsSync(path.join(pkg, '02_收据单')), false);

    // 4_最终数据 下有按桶命名的最终数据 xlsx
    assert.ok(fs.existsSync(path.join(pkg, '4_最终数据', '乐天首尔-最终数据.xlsx')));

    // 5_未收 下有未收清单 + 4 团模板
    assert.ok(fs.existsSync(path.join(pkg, '5_未收-用来补齐部分', '未收清单.xlsx')));
    assert.equal(result.files.filter((f) => f.kind === 'second_round_template').length, 4);

    // manifest directoryMapping
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.ok(manifest.directoryMapping, 'manifest 应含 directoryMapping');
    assert.equal(manifest.directoryMapping.mapping['4.最终数据√/'], '4_最终数据/');
    assert.equal(manifest.directoryMapping.mapping['5.未收-用来补齐部分/'], '5_未收-用来补齐部分/');
    assert.equal(manifest.unreceivedRows, 1);

    // ⭐ 2026-08-01:上面那几条 existsSync 只查「目录在不在」——
    // 而这 5 个目录是 run() 开头**无条件 ensureDir** 出来的空壳。
    // 变异验证过:把「2_收票汇总」那个子导出整个打断(它的异常被外层 try/catch
    // 吞成一条 manifest warning),该文件夹产出 0 个文件,而这个测试**照样绿**。
    // 交付包发出去,收件方打开是个空文件夹 —— 没有任何防线。
    // 所以补两条:目录里得真有东西,而且不许有被静默吞掉的 warning。
    const mustHaveFiles = ['2_收票汇总', '4_最终数据', '5_未收-用来补齐部分', '客户PDF', '客户数据包'];
    for (const d of mustHaveFiles) {
      const entries = fs.readdirSync(path.join(pkg, d));
      assert.ok(entries.length > 0,
        `${d}/ 是空的 —— 目录建出来了但没产出任何文件。`
        + '子导出失败会被外层 try/catch 吞成 manifest warning,只查 existsSync 抓不到');
    }

    // 子导出失败是**静默**的(吞成 warning),所以必须显式检查这份名单。
    // 不是"warning 一条都不许有"——有些 warning 是正常的业务提示(缺图/缺字体);
    // 这里只拦"某个子导出整个炸了"这一类。
    const fatalWarnings = (manifest.warnings || []).filter((w) => {
      const t = String(w?.type || w || '');
      return /failed|error|exception/i.test(t);
    });
    assert.deepEqual(fatalWarnings, [],
      `manifest 里有子导出失败的 warning:${JSON.stringify(fatalWarnings)} —— `
      + '它被 try/catch 吞了,不看这里就永远发现不了');
  } finally {
    cleanup(db, dir);
  }
});

test('阻塞项明细和处理入口在最终核对页(2026-06-11 从交付页移入)', () => {
  const view = fs.readFileSync(
    path.join(__dirname, '../../frontend/src/views/v2/DeliveryCheckView.vue'),
    'utf8'
  );
  assert.match(view, /pendingReasonItems/);
  assert.match(view, /blockingDetails/);
  assert.match(view, /warningDetails/);
  assert.match(view, /待人工确认来源/);
  assert.match(view, /警告项说明/);
  assert.match(view, /unreceived_rows_excluded/);
  assert.match(view, /pendingReasonTarget/);
  assert.match(view, /daily\/remedy/);
  assert.match(view, /bill-review/);
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g19-5folder-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  db.prepare(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES (?, 2026, 5, 'open', ?, ?)
  `).run(WORKSPACE_KEY, new Date().toISOString(), new Date().toISOString());
  smgJobId = createImportJobRepository({ db }).create({
    workspaceKey: WORKSPACE_KEY, jobType: 'smg_ledger', sourceFile: 'SMG总账.xlsx', operator: 'op',
    startedAt: new Date().toISOString(),
  });
  return { db, dir };
}

function insertMonthlyRow(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    workspaceKey: WORKSPACE_KEY,
    modeFolder: '乐天首尔',
    isUnmatched: false,
    dailyReceiptId: 1,
    storeBillId: 1,
    rowHash: `row-${Math.random()}`,
    name: 'HAN SNOW',
    passportNo: 'M12345678',
    purchaseDate: '2026-05-12',
    departureDate: '2026-05-20',
    receiptNo: 'R001',
    tourNo: 'T001',
    netKrw: 1000000,
    netUsd: 800,
    customerRebateKrw: 1000,
    customerRebateUsd: 1.25,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO monthly_data (
      workspace_key, mode_folder, is_unmatched, daily_receipt_id, store_bill_id,
      name, passport_no, purchase_date, departure_date, receipt_no, tour_no,
      net_krw, net_usd, customer_rebate_krw, customer_rebate_usd,
      row_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.workspaceKey,
    row.modeFolder,
    row.isUnmatched ? 1 : 0,
    row.dailyReceiptId,
    row.storeBillId,
    row.name,
    row.passportNo,
    row.purchaseDate,
    row.departureDate,
    row.receiptNo,
    row.tourNo,
    row.netKrw,
    row.netUsd,
    row.customerRebateKrw,
    row.customerRebateUsd,
    row.rowHash,
    now,
    now
  );
}

function _insertDaily(db, overrides = {}) { // 备用夹具(当前用 insertBill 族),_=有意保留未用
  const now = new Date().toISOString();
  const row = {
    modeFolder: '乐天首尔', modeRaw: 'LOTTE', tourNo: 'T001', purchaseDate: '2026-05-12',
    name: 'HAN SNOW', passportNo: 'M12345678', receiptNo: 'R001', brand: 'BRAND',
    netUsd: 800, agent: 'A1', rowHash: `daily-${Math.random()}`,
    tourMatchStatus: 'matched',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO daily_receipt_export (
      workspace_key, mode_folder, mode_raw, tour_no, purchase_date,
      name, passport_no, receipt_no, brand, net_usd, agent,
      tour_match_status, row_hash, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE_KEY, row.modeFolder, row.modeRaw, row.tourNo, row.purchaseDate,
    row.name, row.passportNo, row.receiptNo, row.brand, row.netUsd, row.agent,
    row.tourMatchStatus, row.rowHash, now
  );
}

function insertBill(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    storeFamily: '乐天首尔', name: 'HAN SNOW', passportNo: 'M12345678',
    receiptNo: 'R001', tourNo: 'T001', purchaseDate: '2026-05-12', netUsd: 800,
    hash: `bill-${Math.random()}`,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO store_bill (
      workspace_key, store_family, name, passport_no, receipt_no,
      tour_no, purchase_date, net_usd, row_hash, imported_at, import_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE_KEY, row.storeFamily, row.name, row.passportNo, row.receiptNo,
    row.tourNo, row.purchaseDate, row.netUsd, row.hash, now,
    row.importJobId !== undefined ? row.importJobId : smgJobId
  );
}

function cleanup(db, dir) {
  try { db.close?.(); } catch { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}
