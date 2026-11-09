'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createFinalDeliveryExportService } = require('../../services/monthly/final_delivery_export_service');

const WORKSPACE_KEY = '2026-05';

test('改造H: 客户 PDF 中文化 + 注册 CJK 字体 + 签字位置', async (t) => {
  const { db, dir } = setupDb();
  try {
    insertMonthlyRow(db, {
      rowHash: 'h1',
      modeFolder: '乐天首尔',
      name: 'HAN SNOW',
      passportNo: 'M12345678',
      receiptNo: '90176326000330',
      tourNo: 'T001',
      purchaseDate: '2026-05-12',
      departureDate: '2026-05-20',
      customerRebateKrw: 1234567,
      customerRebateUsd: 102.34,
    });

    const service = createFinalDeliveryExportService({ db });
    const outputDir = path.join(dir, 'delivery');
    const result = await service.run({ workspaceKey: WORKSPACE_KEY, outputDir, operator: 'tester' });

    // 1 个合格客户 → 1 份 PDF
    assert.equal(result.customerPdfs.length, 1);
    const pdfPath = result.customerPdfs[0].path;
    const pdfBytes = fs.readFileSync(pdfPath);
    assert.equal(pdfBytes.subarray(0, 4).toString('utf8'), '%PDF');

    // #8 页序守卫:第1页=收款凭证(竖版),第2页=小票明细(横版,运营要求明细放第二页)
    const mediaBoxes = [...pdfBytes.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
      .map((m) => ({ w: parseFloat(m[1]), h: parseFloat(m[2]) }));
    assert.ok(mediaBoxes.length >= 2, 'PDF 至少 2 页');
    assert.ok(mediaBoxes[0].h > mediaBoxes[0].w, '第1页(收款凭证)应为竖版');
    assert.ok(mediaBoxes[1].w > mediaBoxes[1].h, '第2页(小票明细)应为横版');

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    const fontMissing = manifest.warnings.some((w) => w.type === 'cjk_font_missing');
    if (fontMissing) {
      // 本机未安装 CJK 字体(如 CI runner);生产服务器有 /opt/sign-data/fonts 已验证。
      // 字体嵌入是环境能力,本机无字体时跳过该断言,不阻断 CI(PDF 生成本身已验证)。
      t.diagnostic('本机无 CJK 字体,跳过字体注册/嵌入断言(生产服务器有字体)');
      return;
    }
    // 有字体的环境(本机/服务器):字体应注册成功 + PDF 嵌入字体子集
    const fontFailed = manifest.warnings.filter((w) => w.type === 'cjk_font_register_failed');
    assert.equal(fontFailed.length, 0, '有字体环境应注册成功');
    const pdfText = pdfBytes.toString('latin1');
    assert.ok(/FontFile2|FontFile/.test(pdfText), 'PDF 应嵌入字体子集');
  } finally {
    cleanup(db, dir);
  }
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g19-pdf-cn-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  db.prepare(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES (?, 2026, 5, 'open', ?, ?)
  `).run(WORKSPACE_KEY, new Date().toISOString(), new Date().toISOString());
  return { db, dir };
}

function insertMonthlyRow(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    workspaceKey: WORKSPACE_KEY,
    modeFolder: '乐天首尔',
    isUnmatched: false,
    dailyReceiptId: 1,
    storeBillId: 11,
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

function cleanup(db, dir) {
  try { db.close?.(); } catch { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}
