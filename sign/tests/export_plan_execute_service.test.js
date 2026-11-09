'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createExportPlanExecuteService } = require('../services/export_plan_execute_service');

const DSL_PLAN = Object.freeze({
  planLabel: '按团号整理',
  scope: { modes: [] },
  levels: [{ template: '{groupNo}' }],
  naming: { template: '{name}_{docLabel}{i}' },
  includes: ['receipt'],
  emptyPolicy: 'block_prefix',
});

function makeBatchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'r1.jpg'), 'img1');
  fs.writeFileSync(path.join(dir, 'r2.jpg'), 'img2');
  return dir;
}

test('DSL 落盘:staging 拷贝按 destPath 结构;zipFn 注桩;返回下载名与统计', async (t) => {
  const dir = makeBatchDir(t);
  let zipped = null;
  const service = createExportPlanExecuteService({
    resolveBatchRelativePath: (batchId, rel) => path.join(dir, rel),
    zipFn: async (zipPath, srcRelDir, cwd) => {
      zipped = { zipPath, srcRelDir, cwd };
      fs.writeFileSync(zipPath, 'ZIP'); // 桩:产出占位 zip
      return { ok: true };
    },
  });
  const batch = {
    id: 'b1',
    tasks: [
      { id: 't1', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '26140001', extractedNameFinal: 'ZHANG SAN', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r1.jpg' },
      { id: 't2', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '26140001', extractedNameFinal: 'ZHANG SAN', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r2.jpg' },
    ],
  };
  const result = await service.executeDslPlan({ plan: DSL_PLAN, batch });
  assert.ok(result.downloadName.endsWith('.zip'));
  assert.equal(result.stats.files, 2);
  // staging 里文件按计划路径落位
  const staged = path.join(zipped.cwd, zipped.srcRelDir, '26140001');
  const names = fs.readdirSync(staged).sort();
  assert.deepEqual(names, ['ZHANG SAN_小票1.jpg', 'ZHANG SAN_小票2.jpg']);
  assert.equal(fs.readFileSync(path.join(staged, 'ZHANG SAN_小票1.jpg'), 'utf8'), 'img1');
  // 复核HIGH-1:cleanup 契约(调用方下载完成回调里清)——不清=每单在 tmp 攒整批图副本
  assert.equal(typeof result.cleanup, 'function');
  result.cleanup();
  assert.ok(!fs.existsSync(zipped.cwd), 'cleanup 后 staging+zip 应删净');
});

test('单文件拷失败:跳过+计数留痕不整单炸;全失败才中止且不留垃圾', async (t) => {
  const dir = makeBatchDir(t);
  const mkService = (copyFileFn) => createExportPlanExecuteService({
    resolveBatchRelativePath: (b, rel) => path.join(dir, rel),
    zipFn: async (zipPath) => { fs.writeFileSync(zipPath, 'ZIP'); return { ok: true }; },
    copyFileFn,
  });
  const batch = {
    id: 'b1',
    tasks: [
      { id: 't1', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '26140001', extractedNameFinal: 'ZHANG SAN', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r1.jpg' },
      { id: 't2', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '26140001', extractedNameFinal: 'ZHANG SAN', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r2.jpg' },
    ],
  };

  // 半失败:跳过坏图继续出包,copyFailed 留痕可追查(审计#10:曾裸吞→包内静默少图)
  const partial = mkService(async (src, dest) => {
    if (src.endsWith('r2.jpg')) throw new Error('EIO 模拟');
    return fsp.copyFile(src, dest);
  });
  const result = await partial.executeDslPlan({ plan: DSL_PLAN, batch });
  assert.equal(result.stats.files, 1);
  assert.equal(result.stats.copyFailed, 1);
  assert.match(result.copyFailed[0], /小票2/);
  result.cleanup();
  assert.ok(!fs.existsSync(result.zipPath));

  // 全失败:中止并抛清单,work 目录不留垃圾
  const allFail = mkService(async () => { throw new Error('all EIO'); });
  await assert.rejects(() => allFail.executeDslPlan({ plan: DSL_PLAN, batch }),
    (e) => e.code === 'EXPORT_PLAN_COPY_ALL_FAILED' && e.copyFailed.length === 2);
});

test('DSL 硬闸:blocked(缺字段)/跨客户撞名 → 拒绝执行带清单,绝不带病落盘', async (t) => {
  const dir = makeBatchDir(t);
  const service = createExportPlanExecuteService({
    resolveBatchRelativePath: (b, rel) => path.join(dir, rel),
    zipFn: async () => ({ ok: true }),
  });
  const blockedBatch = {
    id: 'b1',
    tasks: [{ id: 't1', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r1.jpg' }],
  };
  await assert.rejects(() => service.executeDslPlan({ plan: DSL_PLAN, batch: blockedBatch }),
    (e) => e.code === 'EXPORT_PLAN_BLOCKED' && e.blocked.length === 1);

  const collidePlan = { ...DSL_PLAN, levels: [{ template: '夹' }], naming: { template: '{groupNo}' } };
  const collideBatch = {
    id: 'b1',
    tasks: [
      { id: 't1', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '111', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r1.jpg' },
      { id: 't2', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '111', sourceFolderName: 'CL20260714-002', sourceImagePath: 'r2.jpg' },
    ],
  };
  await assert.rejects(() => service.executeDslPlan({ plan: collidePlan, batch: collideBatch }),
    (e) => e.code === 'EXPORT_PLAN_COLLISION' && e.collisions.length >= 1);
});

test('Excel 落盘:真 exceljs 出表,表头=中文列名,行=台账查询结果', async (t) => {
  const service = createExportPlanExecuteService({
    resolveBatchRelativePath: () => '',
    queryLedgerRows: ({ workspaceKey, modes }) => {
      assert.equal(workspaceKey, '260714');
      assert.deepEqual(modes, ['现代百货']);
      return [
        { stmt_date: '2026-07-14', agent: '梁总百货', brand: '루이비통', gross_krw: 4500000, receipt_no: '1622-0011' },
        { stmt_date: '2026-07-14', agent: '梁总百货', brand: '티파니', gross_krw: 700000, receipt_no: '9584-0083' },
      ];
    },
  });
  const plan = { planLabel: '百货明细', excel: { columns: ['stmt_date', 'agent', 'brand', 'gross_krw', 'receipt_no'] }, scope: { modes: ['现代百货'] } };
  const result = await service.executeExcelPlan({ plan, workspaceKey: '260714' });
  assert.ok(result.downloadName.endsWith('.xlsx'));
  assert.equal(result.stats.rows, 2);
  assert.equal(typeof result.cleanup, 'function');
  t.after(() => result.cleanup());

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(result.zipPath);
  const sheet = wb.getWorksheet('明细');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['收票日期', '代理', '品牌', '交易金额(￦)', '小票号/交易编号']);
  assert.equal(sheet.getRow(2).getCell(3).value, '루이비통');
  assert.equal(sheet.getRow(3).getCell(4).value, 700000);

  // 统一表格样式(视觉层)——既有值/表头断言全保留,仅新增样式断言
  const hdrCell = sheet.getRow(1).getCell(1);
  assert.equal(hdrCell.font.name, '微软雅黑', '表头字体=微软雅黑');
  assert.equal(hdrCell.fill.fgColor.argb, 'FF44546A', '表头深蓝灰底色');
  assert.equal(sheet.views[0].state, 'frozen', '冻结视图');
  assert.equal(sheet.views[0].xSplit, 0, 'freezeCols=0 不冻结左侧列');
  assert.equal(sheet.views[0].ySplit, 1, '冻结表头行');

  await assert.rejects(() => service.executeExcelPlan({ plan, workspaceKey: '' }),
    (e) => e.code === 'EXPORT_PLAN_WORKSPACE_REQUIRED');
});

test('Excel 落盘:receipt_no 按行 mode_raw 重排(与客户数据Excel同 formatReceiptNoCell,防副本失步 审计MEDIUM)', async (t) => {
  const service = createExportPlanExecuteService({
    resolveBatchRelativePath: () => '',
    queryLedgerRows: () => [
      // 乐天(digits14):带杠存储 → 出表去杠纯14位(与内置客户数据Excel同口径)
      { stmt_date: '2026-07-14', agent: '本司', mode_raw: '乐天SG-本司', receipt_no: '9080-0626-004856' },
      // 模式未知/无票号形态 → 原样输出,绝不空
      { stmt_date: '2026-07-14', agent: '梁总', mode_raw: '', receipt_no: '1622-0011' },
    ],
  });
  const plan = { planLabel: '票号重排', excel: { columns: ['agent', 'receipt_no'] }, scope: {} };
  const result = await service.executeExcelPlan({ plan, workspaceKey: '260714' });
  t.after(() => result.cleanup());
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(result.zipPath);
  const sheet = wb.getWorksheet('明细');
  assert.equal(String(sheet.getRow(2).getCell(2).value), '90800626004856', '乐天 digits14 去杠(与客户数据Excel同函数)');
  assert.equal(String(sheet.getRow(3).getCell(2).value), '1622-0011', '无形态模式原样,不空');
});

test('Excel 落盘:「不用记」行在导出出口按 mode_raw 过滤(台账仍留行,账单不出;2026-07-24 拍板)', async (t) => {
  const service = createExportPlanExecuteService({
    resolveBatchRelativePath: () => '',
    queryLedgerRows: () => [
      { stmt_date: '2026-07-14', agent: '梁总', mode_raw: '乐天SG-本司', receipt_no: '1622-0011' },
      // 「不用记」尾巴 → isNoRecordMode 命中 → 整行不进导出账单表(避免未收对账误催,行仍留台账)
      { stmt_date: '2026-07-14', agent: '不该出现', mode_raw: '乐天SG-本司不用记', receipt_no: '9999-0000' },
      { stmt_date: '2026-07-14', agent: '本司', mode_raw: '', receipt_no: '9584-0083' },
    ],
  });
  const plan = { planLabel: '不用记过滤', excel: { columns: ['agent', 'receipt_no'] }, scope: {} };
  const result = await service.executeExcelPlan({ plan, workspaceKey: '260714' });
  t.after(() => result.cleanup());
  assert.equal(result.stats.rows, 2, '3 行入,1 行不用记被出口过滤 → 出表 2 行');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(result.zipPath);
  const sheet = wb.getWorksheet('明细');
  const agents = [sheet.getRow(2).getCell(1).value, sheet.getRow(3).getCell(1).value];
  assert.deepEqual(agents, ['梁总', '本司'], '保留的两行是非不用记行');
  assert.ok(!agents.includes('不该出现'), '不用记行不落表');
});

test('Excel 落盘:全为「不用记」行 → 出表 0 行(空 sheet 不报错)', async (t) => {
  const service = createExportPlanExecuteService({
    resolveBatchRelativePath: () => '',
    queryLedgerRows: () => [
      { stmt_date: '2026-07-14', agent: '甲', mode_raw: '乐天SG-本司不用记', receipt_no: '1111-0000' },
      { stmt_date: '2026-07-14', agent: '乙', mode_raw: '济州乐天SG-道辉不用记录', receipt_no: '2222-0000' },
    ],
  });
  const plan = { planLabel: '全不用记', excel: { columns: ['agent', 'receipt_no'] }, scope: {} };
  const result = await service.executeExcelPlan({ plan, workspaceKey: '260714' });
  t.after(() => result.cleanup());
  assert.equal(result.stats.rows, 0, '全部不用记 → 空 sheet,rows=0');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(result.zipPath);
  const sheet = wb.getWorksheet('明细');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['代理', '小票号/交易编号'], '表头仍在,空 sheet 不炸');
});
