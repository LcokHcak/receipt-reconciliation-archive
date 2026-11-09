'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createReceivedReceiptExportService } = require('../services/monthly/received_receipt_export_service');
const { FONT, COLORS } = require('../lib/excel_style');

async function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `received-export-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    return await fn(db);
  } finally {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${tmp}-wal`, { force: true });
      fs.rmSync(`${tmp}-shm`, { force: true });
    } catch {
      // intentional: best-effort cleanup
    }
  }
}

test('received receipt export uses customer agent and writes owner from processing operator', async () => {
  await withDb(async (db) => {
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-05',
      sourceCustomerId: 'CL20260516-001', // 上传那天 = 2026-05-16(KST 建档日)
      receiptDate: '2026-05-20', // 审核通过/结算当天(≠上传那天)——新口径不再采用它
      agent: '阿海',
      purchaseDate: '2026-01-12',
      receiptNo: '2126113001739',
      tourNo: '32028',
      name: 'BAI XUE',
      passportNo: 'EF7053101',
      departureDate: '2026-01-15',
      modeRaw: '爱宝客pkg-本司',
      remark: '白雪',
      modifiedBy: 'reviewer1',
      agentId: 7,
      agentCode: '9号',
      sourceType: 'workbench',
      rowHash: 'daily-1',
      importedAt: '2026-05-16T07:00:00.000Z',
    }, {
      // 「不用记」行:台账保留,但导出出口按 isNoRecordMode 剔除,不进任何 sheet。
      workspaceKey: '2026-05',
      sourceCustomerId: 'CL20260517-002',
      receiptDate: '2026-05-21',
      agent: '阿海',
      purchaseDate: '2026-01-13',
      receiptNo: '2126113001740',
      tourNo: '32029',
      name: 'LI LEI',
      passportNo: 'EF7053102',
      departureDate: '2026-01-16',
      modeRaw: '爱宝客pkg-本司不用记',
      remark: '不用记的票',
      modifiedBy: 'reviewer1',
      agentId: 7,
      agentCode: '9号',
      sourceType: 'workbench',
      rowHash: 'daily-2',
      importedAt: '2026-05-17T07:00:00.000Z',
    }]);

    const outputDir = path.join(os.tmpdir(), `received-export-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const service = createReceivedReceiptExportService({
      db,
      userService: {
        async listUsers() {
          return [{
            id: 7,
            username: 'reviewer1',
            display_name: '审核员小王',
            agent_code: '9号',
            is_active: 1,
          }];
        },
      },
    });

    try {
      const result = await service.run({ workspaceKey: '2026-05', outputDir, operator: 'finance1' });
      assert.equal(path.basename(result.outputPath), '2026-05_收票汇总.xlsx');
      // 「不用记」行被出口过滤:落库 2 行,导出只剩 1 行。
      assert.equal(result.totalRows, 1);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(result.outputPath);
      const info = workbook.getWorksheet('生成说明');
      assert.ok(info, 'generation note sheet should exist');
      const infoText = [];
      info.eachRow((row) => infoText.push(row.values.slice(1).join('|')));
      assert.ok(infoText.some((line) => line.includes('生成人|finance1')));
      assert.ok(infoText.some((line) => line.includes('字段口径说明')));
      assert.ok(infoText.some((line) => line.includes('系统台账ID')));
      // 数据行数反映过滤后的导出行集(1 行,不含不用记行)。
      assert.ok(infoText.some((line) => line.includes('数据行数|1')));

      const sheet = workbook.getWorksheet('9号 审核员小王');
      assert.ok(sheet, 'employee sheet should exist');
      assert.equal(sheet.getRow(1).getCell(13).value, '系统台账ID');
      assert.equal(sheet.getRow(1).getCell(14).value, '来源文件');
      assert.equal(sheet.getRow(1).getCell(15).value, '来源工作表');
      assert.equal(sheet.getRow(1).getCell(16).value, '来源行号');
      const row = sheet.getRow(2);

      // 收票日期 = 上传那天(CL20260516-001 → 2026-05-16),而非审核通过日 receiptDate=2026-05-20。
      assert.equal(row.getCell(1).value, '2026-05-16');
      assert.equal(row.getCell(2).value, '阿海');
      assert.equal(row.getCell(3).value, '2026-01-12');
      assert.equal(row.getCell(10).value, '审核员小王');
      assert.equal(row.getCell(13).value, 1);

      // 不用记行(id=2, 小票号 2126113001740)不进 sheet:只有一条数据行。
      assert.equal(sheet.getRow(3).getCell(13).value, null);
      const receiptNos = [];
      sheet.eachRow((r, n) => { if (n > 1) receiptNos.push(r.getCell(4).value); });
      assert.deepEqual(receiptNos, ['2126113001739']);

      // —— 统一表格样式断言(仅视觉层;上面所有值断言均保留)——
      const headerCell = sheet.getRow(1).getCell(1);
      assert.equal(headerCell.fill.fgColor.argb, COLORS.headerBg, '表头深蓝灰底色');
      assert.equal(headerCell.font.name, FONT, '表头微软雅黑');
      assert.equal(headerCell.font.color.argb, COLORS.headerFont, '表头白字');
      assert.equal(sheet.getRow(2).getCell(1).font.name, FONT, '正文微软雅黑');
      assert.ok(sheet.views && sheet.views[0] && sheet.views[0].state === 'frozen', '冻结表头');
      assert.equal(sheet.views[0].ySplit, 1, '冻结首行');
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
