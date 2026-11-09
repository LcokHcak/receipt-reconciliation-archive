'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const { createLibraryModeExportService } = require('../services/monthly/library_mode_export_service');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  // 注意:列名必须与生产 daily_receipt_export 一致(customer_rebate,无 _krw 后缀)。
  // 之前夹具写成 customer_rebate_krw 与代码里的同名笔误互相印证,导致导出崩溃没被测出。
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, tour_no, name, passport_no, receipt_no, agent)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run('2026-01', 'c1', 'batch_x', '乐天H团-本司', '2026-01-03', '111', '张三', 'E1', 'r1', '本司');
  ins.run('2026-01', 'c1', 'batch_x', '乐天H团-本司', '2026-01-04', '111', '张三', 'E1', 'r2', '本司');
  ins.run('2026-01', 'c2', 'batch_y', '乐天H团-本司', '2026-01-05', '112', '李四', 'E2', 'r3', '本司');
  ins.run('2026-01', 'c3', 'batch_x', '济州新罗V团-本司', '2026-01-06', '71992', '王五', 'E3', 'r4', '本司');
  ins.run('2026-01', 'c4', 'batch_x', '', '2026-01-07', '999', '空模式', 'E4', 'r5', 'x');
  ins.run('2026-02', 'c5', 'batch_z', '乐天SG-本司', '2026-02-01', '222', '二月', 'E5', 'r6', '本司');
  return db;
}

function makeBatchRepo() {
  const batch = {
    id: 'batch_x', name: '批次X', monthlyWorkspaceKey: '2026-01', ownerUsername: '小票01',
    sourceGroups: [{ key: 'g1', label: '张三组' }, { key: 'g2', label: '李四组' }],
    tasks: [
      { sourceGroupKey: 'g1', rephotoRequested: true, customerAgentName: '本司' },
      { sourceGroupKey: 'g1', rephotoRequested: false, customerAgentName: '本司' },
      { sourceGroupKey: 'g2', rephotoRequested: false, customerAgentName: '新琪' },
    ],
  };
  return {
    listBatches: () => [{ id: 'batch_x', name: '批次X', createdAt: '2026-07-01T02:38:00.000Z', ownerUsername: '小票01' }],
    listBatchIds: () => ['batch_x'],
    loadBatch: (id) => (id === 'batch_x' ? batch : null),
  };
}

test('listWorkspaces + listBatches 供下拉(含 createdAt/owner 供分组消歧)', () => {
  const svc = createLibraryModeExportService({ db: makeDb(), batchRepository: makeBatchRepo() });
  assert.deepEqual(svc.listWorkspaces().map((w) => w.workspaceKey), ['2026-02', '2026-01']);
  assert.deepEqual(svc.listBatches(), [{
    id: 'batch_x', name: '批次X', createdAt: '2026-07-01T02:38:00.000Z', ownerUsername: '小票01',
    workspaceKey: '', // 2026-07-16 P0:批次带月度工作区(左栏按月筛;fixture 无 monthlyWorkspaceKey → 空)
  }]);
});

test('listModeSummary 支持 全部 / 按工作区 / 按批次 三种筛选', () => {
  const svc = createLibraryModeExportService({ db: makeDb() });
  // 全部:2026-02 的乐天SG 也在
  assert.ok(svc.listModeSummary({}).find((m) => m.mode === '乐天SG-本司'));
  // 按工作区 2026-01:不含 2026-02
  assert.ok(!svc.listModeSummary({ workspaceKey: '2026-01' }).find((m) => m.mode === '乐天SG-本司'));
  // 按批次 batch_x:乐天H团 只剩 c1 的 2 票(c2 在 batch_y)
  const byBatch = svc.listModeSummary({ batchId: 'batch_x' });
  const lotte = byBatch.find((m) => m.mode === '乐天H团-本司');
  assert.equal(lotte.receipts, 2);
  assert.equal(lotte.customers, 1);
});

test('listRephotoGroups 从批次拉重拍客户组', () => {
  const svc = createLibraryModeExportService({ db: makeDb(), batchRepository: makeBatchRepo() });
  const byBatch = svc.listRephotoGroups({ batchId: 'batch_x' });
  assert.equal(byBatch.length, 1, '只有 g1 组有重拍任务');
  assert.equal(byBatch[0].label, '张三组');
  assert.equal(byBatch[0].collector, '小票01');
  // 扫全部活批次也应命中
  assert.equal(svc.listRephotoGroups({}).length, 1);
  // 无 batchRepository → 空(不报错)
  assert.deepEqual(createLibraryModeExportService({ db: makeDb() }).listRephotoGroups({}), []);
});

// 2026-07-16 P0:overview=老 summary+customers 合并且重拍只扫一遍(修双跑)
test('listOverview 等价老端点组合;重拍批次扫描单遍;批次带已结算徽章', () => {
  const repo = makeBatchRepo();
  let loadCalls = 0;
  const countingRepo = { ...repo, loadBatch: (id) => { loadCalls += 1; return repo.loadBatch(id); } };
  const svc = createLibraryModeExportService({ db: makeDb(), batchRepository: countingRepo });

  const overview = svc.listOverview({ batchId: 'batch_x' });
  // 等价:customers/modes/rephotoCount 与老端点逐字段一致
  assert.deepEqual(overview.customers, svc.listCustomers({ batchId: 'batch_x' }));
  assert.deepEqual(overview.modes, svc.listModeSummary({ batchId: 'batch_x' }));
  assert.equal(overview.rephotoCount, svc.listRephotoGroups({ batchId: 'batch_x' }).length);
  assert.deepEqual(overview.workspaces.map((w) => w.workspaceKey), svc.listWorkspaces().map((w) => w.workspaceKey));
  // 徽章:batch_x 已结算 3 客户(c1/c3/c4)4 票
  const bx = overview.batches.find((b) => b.id === 'batch_x');
  assert.equal(bx.settledCustomers, 3);
  assert.equal(bx.settledReceipts, 4);
  // 单遍:overview 一次调用只 loadBatch 一遍(老路径 summary+customers 会两遍)
  loadCalls = 0;
  svc.listOverview({ batchId: 'batch_x' });
  assert.equal(loadCalls, 1, `overview 重拍扫描必须单遍,实际 loadBatch ${loadCalls} 次`);
});

// 2026-07-20 五问题#5修②:客户数据 Excel 小票号按行 mode_raw 走交付合同重排——
// 存量台账混有被兜底数字投影"剥了字母/杠"的行,出口瞬间救回来;存储零改动。
test('buildWorkbook 小票号按模式重排:dashed19 干净16位补杠;已带杠原样;letters14 剥杠保字母;空模式原样', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, tour_no, name, passport_no, receipt_no, agent)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  // dashed19 存量被剥成干净16位 → 补杠 2-6-3-5
  ins.run('2026-01', 'c1', 'b1', '新世界机场-振华', '2026-01-03', '无', '甲', 'E1', '2926063010900126', 'x');
  // dashed19 已带杠 → 原样
  ins.run('2026-01', 'c2', 'b1', '现代-JEOCU', '2026-01-04', '70299', '乙', 'E2', '01-260630-109-00126', 'x');
  // letters14(济州乐天V):存储带杠 → 出口剥杠保字母(交付合同)
  ins.run('2026-01', 'c3', 'b1', '济州乐天V团特殊-道辉', '2026-01-05', '26907555', '丙', 'E3', '90G331-26-000309', 'x');
  // 未知/空模式 → 原样,不折腾
  ins.run('2026-01', 'c4', 'b1', '', '2026-01-06', '999', '丁', 'E4', '03-261-635', 'x');

  const svc = createLibraryModeExportService({ db });
  const wb = svc.buildWorkbook({ workspaceKey: '2026-01' });
  const buf = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buf);
  const receiptNoOf = (sheetName) => reloaded.getWorksheet(sheetName).getRow(2).getCell(6).value; // 第6列=小票号(收票日期插到第2列后整体后移一位)
  assert.equal(receiptNoOf('新世界机场-振华'), '29-260630-109-00126', 'dashed19 干净16位补杠 2-6-3-5');
  assert.equal(receiptNoOf('现代-JEOCU'), '01-260630-109-00126', '已带杠原样');
  assert.equal(receiptNoOf('济州乐天V团特殊-道辉'), '90G33126000309', 'letters14 剥杠保字母');
  assert.equal(receiptNoOf(svc.NO_MODE), '03-261-635', '空模式原样输出');
});

// 2026-07-20 百货交付重构§2/§4:免税分店拆两列(免税店+门店编号)+ 加「上家」列;存储不动只拆出口
test('buildWorkbook 拆列:免税店/门店编号从"明洞(0394)"拆出;裸码按 shop 反查;上家列落值', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, agent, upstream, shop, branch)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  // 乐天百货:标准"名(码)"存量 → 直接拆
  ins.run('2026-07', 'c1', 'b1', '乐天百货', '2026-07-01', '甲', '12345678', '代理A', '', '乐天百货', '明洞(0394)');
  // 乐天百货:裸码存量(2026-07-13 之前入库)→ 按 shop 反查店名
  ins.run('2026-07', 'c2', 'b1', '乐天百货', '2026-07-02', '乙', '87654321', '代理A', '', '乐天百货', '0001');
  // 乐天百货:未识别裸码 → 店名空、码照出
  ins.run('2026-07', 'c3', 'b1', '乐天百货', '2026-07-03', '丙', '11112222', '代理A', '', '乐天百货', '0999');
  // 现代百货:无门店有上家 → 上家列落值,两拆列为空
  ins.run('2026-07', 'c4', 'b1', '现代百货', '2026-07-04', '丁', '1622-0011', '代理B', '金浦奥莱', '现代百货', '');

  const svc = createLibraryModeExportService({ db });
  // 列序:收票日期(插在购买日期后)+ 免税分店拆两列 + 上家列(表头契约,上家在代理后)
  assert.deepEqual(svc.COLUMNS.map(([h]) => h), [
    '购买日期', '收票日期', '团号', '姓名', '护照号', '小票号', '代理', '上家', '返点模式',
    '免税店', '门店编号', '品牌', '数量', '总卖出(￦)', '纯卖出(￦)', '客人返点金额', '出境日期',
  ]);
  const wb = svc.buildWorkbook({ workspaceKey: '2026-07' });
  const buf = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buf);
  const COL = { collectedDate: 2, receiptNo: 6, agent: 7, upstream: 8, branchName: 10, branchCode: 11 };
  const lotte = reloaded.getWorksheet('乐天百货');
  assert.equal(lotte.getRow(1).getCell(COL.collectedDate).value, '收票日期', '第2列=收票日期表头');
  assert.equal(lotte.getRow(2).getCell(COL.collectedDate).value, '',
    '非 CLyyyymmdd 客户号(c1)且未 SELECT created_at → 收票日期空(不误用行内 receipt_date)');
  assert.equal(lotte.getRow(1).getCell(COL.branchName).value, '免税店');
  assert.equal(lotte.getRow(1).getCell(COL.branchCode).value, '门店编号');
  assert.equal(lotte.getRow(2).getCell(COL.branchName).value, '明洞');
  assert.equal(lotte.getRow(2).getCell(COL.branchCode).value, '0394');
  assert.equal(lotte.getRow(3).getCell(COL.branchName).value, '明洞', '裸码 0001 按 shop 反查=明洞');
  assert.equal(lotte.getRow(3).getCell(COL.branchCode).value, '0001');
  assert.equal(lotte.getRow(4).getCell(COL.branchName).value, '', '未识别码店名留空');
  assert.equal(lotte.getRow(4).getCell(COL.branchCode).value, '0999');
  const hyundai = reloaded.getWorksheet('现代百货');
  assert.equal(hyundai.getRow(2).getCell(COL.upstream).value, '金浦奥莱', '上家列=台账 upstream');
  assert.equal(hyundai.getRow(2).getCell(COL.agent).value, '代理B');
});

// 2026-07-24 用户拍板规则2:收票日期=我们收到并上传小票那天(客户建档日),取客户编号
// CLyyyymmdd(KST 上传日),而非台账行 receipt_date(那是审核/结算当天)。
test('buildWorkbook 收票日期=客户编号 CLyyyymmdd(上传日),非 receipt_date', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, agent)
    VALUES (?,?,?,?,?,?,?,?)`);
  // 客户编号内嵌 KST 上传日 2026-07-03;purchase_date(购买日)刻意不同 → 收票日期取上传日
  ins.run('2026-07', 'CL20260703-001', 'b1', '乐天SG-本司', '2026-07-01', '甲', '12345678', '代理A');

  const svc = createLibraryModeExportService({ db });
  const wb = svc.buildWorkbook({ workspaceKey: '2026-07' });
  const buf = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buf);
  const sheet = reloaded.getWorksheet('乐天SG-本司');
  assert.equal(sheet.getRow(1).getCell(1).value, '购买日期');
  assert.equal(sheet.getRow(1).getCell(2).value, '收票日期', '收票日期插在购买日期后=第2列');
  assert.equal(sheet.getRow(2).getCell(1).value, '2026-07-01', '购买日期原样');
  assert.equal(sheet.getRow(2).getCell(2).value, '2026-07-03', '收票日期=客户编号 CLyyyymmdd 上传日');
});

// 2026-07-24 用户拍板规则1:代理标注「不用记」的票不进任何导出账单(台账仍保留避免未收误催),
// 出口按行 mode_raw 过滤;某模式全是不用记 → 该 sheet 不出现(容忍空,不报错)。
test('buildWorkbook 过滤「不用记」行:整模式不用记 → 无该 sheet;混合模式只留可记行', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, agent)
    VALUES (?,?,?,?,?,?,?,?)`);
  // 可记模式的两行
  ins.run('2026-07', 'c1', 'b1', '乐天SG-本司', '2026-07-01', '甲', 'r1', 'x');
  ins.run('2026-07', 'c2', 'b1', '乐天SG-本司', '2026-07-02', '乙', 'r2', 'x');
  // 同模式带「不用记」尾巴的行 → 过滤掉
  ins.run('2026-07', 'c3', 'b1', '乐天SG-本司不用记', '2026-07-03', '丙', 'r3', 'x');
  // 整个模式都是「不用记」→ 无该 sheet
  ins.run('2026-07', 'c4', 'b1', '新罗SG-新琪 不用记录', '2026-07-04', '丁', 'r4', 'x');

  const svc = createLibraryModeExportService({ db });
  const wb = svc.buildWorkbook({ workspaceKey: '2026-07' });
  const buf = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buf);
  const names = reloaded.worksheets.map((s) => s.name);
  // 「不用记」的模式 sheet 一个都不出现(整模式为空则容忍不建 sheet)
  assert.ok(!names.some((n) => n.includes('不用记')), '不用记模式不得出现为 sheet');
  // 可记模式 sheet 仍在,但只剩 2 行数据(表头+2 行,不含 c3 不用记行)
  const kept = reloaded.getWorksheet('乐天SG-本司');
  assert.ok(kept, '可记模式 sheet 仍在');
  assert.equal(kept.rowCount, 3, '1 表头 + 2 可记行(不用记的 c3 被过滤)');
});

test('buildWorkbook 每模式一 sheet + 需重拍 sheet', async () => {
  const svc = createLibraryModeExportService({ db: makeDb(), batchRepository: makeBatchRepo() });
  const wb = svc.buildWorkbook({});
  const buf = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buf);
  const names = reloaded.worksheets.map((s) => s.name);
  assert.ok(names.includes('乐天H团-本司'));
  assert.ok(names.includes(svc.REPHOTO_SHEET), '应有需重拍 sheet');
  const rsheet = reloaded.getWorksheet(svc.REPHOTO_SHEET);
  assert.equal(rsheet.rowCount, 2, '1 表头 + 1 重拍组');
  assert.equal(rsheet.getRow(2).getCell(1).value, '张三组');

  // 统一表格样式已套上(仅视觉层,不改列/值/表头)
  const modeSheet = reloaded.getWorksheet('乐天H团-本司');
  const headerCell = modeSheet.getRow(1).getCell(1);
  assert.equal(headerCell.fill.fgColor.argb, 'FF44546A', '表头深蓝灰底色');
  assert.equal(headerCell.font.name, '微软雅黑', '表头微软雅黑字体');
  assert.equal(headerCell.font.color.argb, 'FFFFFFFF', '表头白字');
  // 冻结首行(freezeCols=0:购买日期/团号非身份列,只冻表头)
  const view = modeSheet.views[0];
  assert.equal(view.state, 'frozen', '冻结状态');
  assert.equal(view.xSplit, 0, 'freezeCols=0 不冻结左侧列');
  assert.equal(view.ySplit, 1, '冻结表头行');
  // 重拍 sheet 同样套样式
  assert.equal(rsheet.getRow(1).getCell(1).fill.fgColor.argb, 'FF44546A', '重拍 sheet 表头样式一致');
});

// 2026-07-27 需求F③:sheet1 = 全部模式汇总(用户:想看整批全貌不该自己拼 N 页),
// sheet2 起每模式一页,「需重拍·去回收」仍在最后。
test('buildWorkbook sheet 顺序:①汇总(全部模式合在一起) ②起每模式一页 末页需重拍', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, tour_no, name, passport_no, receipt_no, agent)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run('2026-01', 'c1', 'b1', '乐天SG-本司', '2026-01-03', 'T1', '甲', 'E1', '11111111111111', 'a');
  ins.run('2026-01', 'c2', 'b1', '乐天SG-本司', '2026-01-03', 'T1', '乙', 'E2', '22222222222222', 'a');
  ins.run('2026-01', 'c3', 'b1', '新世界SG-振华', '2026-01-04', 'T2', '丙', 'E3', '2926063010900126', 'b');
  // 不用记的行仍然一张都不出现(2026-07-24 拍板),汇总页也不能漏网
  ins.run('2026-01', 'c4', 'b1', '不用记', '2026-01-05', 'T3', '丁', 'E4', '33333333333333', 'c');

  const svc = createLibraryModeExportService({ db });
  const wb = svc.buildWorkbook({ workspaceKey: '2026-01' });
  const buf = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buf);
  const names = reloaded.worksheets.map((w) => w.name);

  assert.equal(names[0], svc.SUMMARY_SHEET, 'sheet1 必须是汇总页');
  assert.deepEqual(names.slice(1), ['乐天SG-本司', '新世界SG-振华', svc.REPHOTO_SHEET], 'sheet2 起每模式一页,需重拍垫底');

  // 汇总页 = 各模式页之和(表头 1 行 + 3 行数据),且列与模式页完全一致
  const summary = reloaded.getWorksheet(svc.SUMMARY_SHEET);
  assert.equal(summary.rowCount, 4, '3 行数据(不用记那行已在出口滤掉)');
  assert.deepEqual(summary.getRow(1).values.slice(1), svc.COLUMNS.map(([h]) => h), '汇总页表头与模式页同一套');
  const namesInSummary = [2, 3, 4].map((r) => summary.getRow(r).getCell(4).value); // 第4列=姓名
  assert.deepEqual(namesInSummary.sort(), ['丙', '乙', '甲'], '两个模式的行都在汇总页里');
  assert.ok(!namesInSummary.includes('丁'), '「不用记」行不进任何页,汇总页也不例外');
  // 「返点模式」列在汇总页里区分行归属(所以不用为汇总页另立表头)
  const modeCol = svc.COLUMNS.findIndex(([, k]) => k === 'mode_raw') + 1;
  assert.equal(new Set([2, 3, 4].map((r) => summary.getRow(r).getCell(modeCol).value)).size, 2);

  // 各模式页行数不变(汇总是新增的第一页,不是把模式页合并掉)
  assert.equal(reloaded.getWorksheet('乐天SG-本司').rowCount, 3);
  assert.equal(reloaded.getWorksheet('新世界SG-振华').rowCount, 2);
});

// ── 0727反馈#13-1/#14-2:百货页签表头 小票号→交易编号 / 总卖出→交易金额 ──────────
test('百货模式页签表头换叫法(交易编号/交易金额),免税/汇总页保持通用表头', () => {
  const db = makeDb();
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, shop, gross_krw)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('2026-01', 'c9', 'batch_x', '乐天百货', '2026-01-08', '百货客', '12345678', 'LOTTE_DEPT', 3500000);
  const svc = createLibraryModeExportService({ db, batchRepository: makeBatchRepo() });
  const wb = svc.buildWorkbook({ workspaceKey: '2026-01' });
  const headerOf = (sheetName) => {
    const sheet = wb.worksheets.find((s) => s.name === sheetName);
    return sheet ? sheet.getRow(1).values.filter((v) => v !== undefined && v !== null) : null;
  };
  const dept = headerOf('乐天百货');
  assert.ok(dept, '乐天百货页签存在');
  assert.ok(dept.includes('交易编号'), '百货页签:小票号→交易编号');
  assert.ok(dept.includes('交易金额(￦)'), '百货页签:总卖出→交易金额');
  assert.ok(!dept.includes('小票号') && !dept.includes('总卖出(￦)'));
  const duty = headerOf('乐天H团-本司');
  assert.ok(duty.includes('小票号') && duty.includes('总卖出(￦)'), '免税模式页保持通用表头');
  const summary = headerOf('汇总');
  assert.ok(summary.includes('小票号'), '汇总页混流保持通用表头');
  // 百货行 dash44:存量8位在导出瞬间补杠(与交付包文件名同源)
  const deptSheet = wb.worksheets.find((s) => s.name === '乐天百货');
  const receiptCol = deptSheet.getRow(1).values.findIndex((v) => v === '交易编号');
  assert.equal(deptSheet.getRow(2).values[receiptCol], '1234-5678');
});

test('⭐汇总页永远用通用叫法——哪怕整批全是百货(0801 拍板)', () => {
  // 纯百货的日子现在很常见。旧实现"整页皆百货就换表头"对汇总页也生效,于是同一张汇总页
  // 的列名会随当天数据变(纯百货换、混进一张免税店票又换回来),看的人以为自己看错了表。
  // 而本文件第 52 行的注释一直写着"汇总页混流保持通用叫法"——实现与注释不一致。
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, shop, gross_krw)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('2026-01', 'c1', 'batch_x', '乐天百货', '2026-01-08', '甲', '1234-5678', 'LOTTE_DEPT', 100);
  ins.run('2026-01', 'c2', 'batch_x', '新世界百货', '2026-01-09', '乙', '2921-7193', 'SHINSEGAE_DEPT', 200);
  const svc = createLibraryModeExportService({ db, batchRepository: makeBatchRepo() });
  const wb = svc.buildWorkbook({ workspaceKey: '2026-01' });
  const headerOf = (n) => wb.worksheets.find((s) => s.name === n).getRow(1).values
    .filter((v) => v !== undefined && v !== null);

  const summary = headerOf('汇总');
  assert.ok(summary.includes('小票号') && summary.includes('总卖出(￦)'),
    `汇总页必须用通用叫法,实际:${summary.join('|')}`);
  assert.ok(!summary.includes('交易编号'), '汇总页不许跟着当天数据换名字');
  // 对照:模式页仍然换(0727#13-1 的需求没被这次改动动到)
  assert.ok(headerOf('乐天百货').includes('交易编号'), '模式页照旧换叫法');
});

test('⭐收票日期兜底:客户编号不标准时回落 imported_at(0801 拍板),不再整列空白', () => {
  // 旧兜底写的是 row.created_at,而 daily_receipt_export **没有这一列**(实查 PRAGMA 确认),
  // 查询里也没查它 —— 客户编号一旦不是标准 CLyyyymmdd-NNN(导入的历史行/改过 ID 的行),
  // 这一列就是整列空白,正是用户截图 image37 的"有表头没数据"。
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE daily_receipt_export (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
    purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
    agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
    gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT,
    imported_at TEXT
  )`);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, imported_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  ins.run('2026-01', 'CL20260710-042', 'batch_x', '乐天H团-本司', '2026-01-03', '标准号', 'r1', '2026-01-20T05:00:00Z');
  ins.run('2026-01', '历史导入-无编号', 'batch_x', '乐天H团-本司', '2026-01-04', '非标号', 'r2', '2026-01-21T05:00:00Z');
  const svc = createLibraryModeExportService({ db, batchRepository: makeBatchRepo() });
  const sheet = svc.buildWorkbook({ workspaceKey: '2026-01' }).worksheets.find((s) => s.name === '汇总');
  const col = sheet.getRow(1).values.findIndex((v) => v === '收票日期');
  const byName = new Map();
  sheet.eachRow((row, i) => { if (i > 1) byName.set(row.values[sheet.getRow(1).values.indexOf('姓名')], row.values[col]); });

  assert.equal(byName.get('标准号'), '2026-07-10', '标准客户号仍走编号内嵌的上传日,优先级不变');
  assert.equal(byName.get('非标号'), '2026-01-21', '非标客户号回落 imported_at,不再空白');
});

// ── 0727反馈#15:导出前真实预检(台账格式检查+定位) ────────────────────────────
test('格式预检:按交付合同核票号形态,提示写人话,带批次+客户定位;不用记/无合同模式不妄断', () => {
  const db = makeDb();
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, shop)
    VALUES (?,?,?,?,?,?,?,?)`);
  // 乐天SG(digits14):13位=少一位 → 疑似
  ins.run('2026-03', 'CLA', 'batch_p', '乐天SG-本司', '2026-03-01', '甲', '0326163500159', 'LOTTE');
  // 乐天SG:字母混在中间 → 疑似(尾缀单字母另有豁免,见 CLR)
  ins.run('2026-03', 'CLB', 'batch_p', '乐天SG-本司', '2026-03-01', '乙', '03261635X00159', 'LOTTE');
  // 尾缀 R 豁免(0728 生产实锤:OCR 纯数字、审核员手动补 R = 有意标记非失误)→ 不报
  ins.run('2026-03', 'CLR', 'batch_p', '乐天SG-本司', '2026-03-01', '润', '03261635001590R', 'LOTTE');
  // 乐天百货(dash44):杠位错 → 疑似
  ins.run('2026-03', 'CLC', 'batch_p', '乐天百货', '2026-03-02', '丙', '123-45678', 'LOTTE_DEPT');
  // 正常行:14位纯数字 → 不报
  ins.run('2026-03', 'CLD', 'batch_p', '乐天SG-本司', '2026-03-03', '丁', '03261635001590', 'LOTTE');
  // 购买日期空 → 疑似(即使票号正常)
  ins.run('2026-03', 'CLE', 'batch_p', '乐天SG-本司', '', '戊', '03261635001590', 'LOTTE');
  // 「不用记」模式:不预检(它不进导出)
  ins.run('2026-03', 'CLF', 'batch_p', '乐天SG-本司不用记', '2026-03-04', '己', 'xx', 'LOTTE');
  // 未知模式(无合同):票号不妄断
  ins.run('2026-03', 'CLG', 'batch_p', '某新模式', '2026-03-05', '庚', '99', 'LOTTE');
  // 护照号形态(0728 image36 实锤):MRZ 整行灌列 / 12位身份证合法不报
  const insP = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, shop, passport_no)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  insP.run('2026-03', 'CLH', 'batch_p', '乐天SG-本司', '2026-03-06', '辛', '03261635001590', 'LOTTE', 'N7904233F3306242MLM7005282M');
  insP.run('2026-03', 'CLI', 'batch_p', '乐天SG-本司', '2026-03-06', '壬', '03261635001590', 'LOTTE', 'EP9789060<<3');
  insP.run('2026-03', 'CLJ', 'batch_p', '乐天SG-本司', '2026-03-06', '癸', '03261635001590', 'LOTTE', '079089021273');

  const svc = createLibraryModeExportService({ db, batchRepository: makeBatchRepo() });
  const { checkedRows, issues } = svc.listFormatIssues({ workspaceKey: '2026-03' });
  assert.equal(checkedRows, 10, '不用记行不计入(11-1)');
  const byCust = new Map(issues.map((i) => [i.customerId, i]));
  assert.match(byCust.get('CLA').problems[0], /13 位.*应是 14 位/, '少一位要说人话');
  assert.match(byCust.get('CLB').problems[0], /混了字母/, '字母在中间照报');
  assert.ok(!byCust.has('CLR'), '整位数+尾缀单字母(R)=审核员有意标记,不报(0728 实锤豁免)');
  assert.match(byCust.get('CLC').problems[0], /杠打错位置.*4-4/);
  assert.ok(!byCust.has('CLD'), '正常行不报');
  assert.deepEqual(byCust.get('CLE').problems, ['购买日期是空的']);
  assert.ok(!byCust.has('CLF'), '不用记不预检');
  assert.ok(!byCust.has('CLG'), '无合同模式不妄断票号');
  assert.match(byCust.get('CLH').problems[0], /MRZ 整行/, '超12位疑似机读行整串灌列(image36 红框)');
  assert.match(byCust.get('CLI').problems[0], /填充符</, 'MRZ 填充符 < 铁证');
  assert.ok(!byCust.has('CLJ'), '12位越南身份证是合法值不误伤(image36 绿框)');
  // 定位三件套:跳审核台全靠它
  assert.equal(byCust.get('CLA').batchId, 'batch_p');
  assert.equal(byCust.get('CLA').workspaceKey, '2026-03');
  assert.ok(byCust.get('CLA').rowId > 0);
});

test('格式预检接线契约:路由暴露 precheck 端点(owner 隔离同款 filter);前端面板前置+跳审核台', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const routeSrc = fs2.readFileSync(path2.join(__dirname, '../routes/monthly/export_routes.js'), 'utf8');
  assert.match(routeSrc, /library-export\/precheck/);
  assert.match(routeSrc, /listFormatIssues\(filterFromReq\(req\)\)/, 'owner 隔离走同一 filterFromReq');
  const viewSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/LibraryView.vue'), 'utf8');
  assert.match(viewSrc, /fetchLibraryPrecheck/);
  assert.match(viewSrc, /疑似审核失误/, '错误信息前置面板');
  assert.match(viewSrc, /goFixIssue/, '每条可跳审核台');
  assert.match(viewSrc, /buildReviewDeepLink\(\{/, '深链与代理视图同一构造器,不另写副本');
  assert.match(viewSrc, /格式预检通过/, '通过态也要给一句肯定,不是静默');
});

// ── 0801:预检那一页的三个洞(核账报告 idx43 ②③④)──────────────────────────
test('⭐预检的筛选口径 = 你正要导出的那一批(跨批/整月以前压根不触发)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  // 后端一直支持 batchIds(filterFromReq 解析逗号串),是前端没接
  const routeSrc = fs2.readFileSync(path2.join(__dirname, '../routes/monthly/export_routes.js'), 'utf8');
  assert.match(routeSrc, /batchIds: String\(req\.query\?\.batchIds/, '后端支持跨批筛选');

  const apiSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/api/libraryExport.js'), 'utf8');
  const fn = /export function fetchLibraryPrecheck[\s\S]*?\n}/.exec(apiSrc);
  assert.ok(fn, '没定位到 fetchLibraryPrecheck');
  assert.match(fn[0], /batchIds/, '预检请求必须能带 batchIds,否则跨批导出永远检不到');
  assert.match(fn[0], /batchIds\.join\(','\)/, '与下载端点同一种串法');

  const viewSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/LibraryView.vue'), 'utf8');
  const scope = /const precheckScope = computed\(\(\) => \{[\s\S]*?\n\}\)/.exec(viewSrc);
  assert.ok(scope, '没定位到 precheckScope');
  // 三条导出路径都要覆盖:勾选跨批 > 当前批 > 整月工作区
  assert.match(scope[0], /pickedBatchIds/, '勾了跨批就检那几批');
  assert.match(scope[0], /selectedBatchId/, '没勾就检当前批');
  assert.match(scope[0], /filterWorkspace/, '连批次都没选就检整个工作区(整月导出走的就是它)');
  // 口径变了必须重跑:跟着 scope.key 走,而不是只跟着 selectedBatchId
  assert.match(viewSrc, /watch\(\(\) => precheckScope\.value\.key/, '换了导出口径要重新预检');
});

test('⭐预检自己崩了要说出来——不能和「通过」「还没结算」长成一个样', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const viewSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/LibraryView.vue'), 'utf8');
  assert.match(viewSrc, /precheckError/, '要有独立的失败态');
  assert.match(viewSrc, /v-if="precheckError"/, '失败态要真的渲染出来,不是只存在 state 里');
  assert.match(viewSrc, /格式预检没跑成/, '说人话');
  assert.match(viewSrc, /@click="loadPrecheck\(\)"/, '给重试,不是只报错');
  // 失败态必须排在"有问题/通过"之前,否则被 v-else-if 链吃掉
  const failedAt = viewSrc.indexOf('v-if="precheckError"');
  const issuesAt = viewSrc.indexOf('v-else-if="precheck.issues.length"');
  const okAt = viewSrc.indexOf('格式预检通过');
  assert.ok(failedAt > -1 && issuesAt > failedAt && okAt > issuesAt,
    '三态顺序必须是 失败 → 有问题 → 通过,否则失败态永远显示不出来');
  // catch 里不能只是清空(那就是老毛病)
  const loader = /async function loadPrecheck\(\)[\s\S]*?\n\}/.exec(viewSrc);
  assert.match(loader[0], /precheckError\.value = /, 'catch 必须写失败原因');
});

test('⭐「去审核台改」跳过去要回得来:/library 进白名单,返回按钮说对地方', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const libSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/lib/agentWorkspaceLinks.js'), 'utf8');
  const { sanitizeReturnTo, returnToLabel } = new Function(
    `${libSrc.replace(/^export /gm, '')}\nreturn { sanitizeReturnTo, returnToLabel };`,
  )();

  // 预检每行都往审核台深链,而 /library 以前不在白名单 → 返回参数被清成空串,按钮不渲染
  assert.equal(sanitizeReturnTo('/library'), '/library', '资料库要能回跳');
  assert.equal(sanitizeReturnTo('/library?tab=blocked'), '/library?tab=blocked', 'query 完整保留');
  assert.equal(sanitizeReturnTo('/agents?month=2026-07'), '/agents?month=2026-07', '代理页照旧');
  // 安全边界一条没松
  assert.equal(sanitizeReturnTo('https://evil.example/x'), '', '站外拒');
  assert.equal(sanitizeReturnTo('//evil.example'), '', '协议相对拒');
  assert.equal(sanitizeReturnTo('/library/../settings'), '', '穿越拒');
  assert.equal(sanitizeReturnTo('/settings'), '', '白名单外的站内路径照旧拒');

  // 文案跟着来源走,不再硬编码「代理工作台」
  assert.equal(returnToLabel('/library?x=1'), '资料库交付');
  assert.equal(returnToLabel('/agents'), '代理工作台');
  assert.equal(returnToLabel(''), '上一页', '认不出用中性说法,不瞎说地方');

  const reviewSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  assert.match(reviewSrc, /← 返回\{\{ returnToName \}\}/, '按钮文案要动态');
  assert.doesNotMatch(reviewSrc, /← 返回代理工作台/, '不许再硬编码');
});

// ── 跨批多选导出(2026-07-28,F4 参考图第二刀)──────────────────────────────────
test('跨批过滤:batchIds IN 聚合;与 owner 隔离相与不越权;buildWorkbook 汇总页合并多批', () => {
  const db = makeDb();
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no, agent)
    VALUES (?,?,?,?,?,?,?,?)`);
  ins.run('2026-03', 'cm1', 'batch_m1', '乐天SG-本司', '2026-03-01', '甲', '03261635001590', '本司');
  ins.run('2026-03', 'cm2', 'batch_m2', '乐天SG-本司', '2026-03-02', '乙', '03261635001591', '本司');
  ins.run('2026-03', 'cm3', 'batch_m3', '乐天SG-本司', '2026-03-03', '丙', '03261635001592', '本司');

  const repo = {
    listBatches: () => [
      { id: 'batch_m1', ownerUsername: 'op1' },
      { id: 'batch_m2', ownerUsername: 'op1' },
      { id: 'batch_m3', ownerUsername: 'op2' },
    ],
    listBatchIds: () => ['batch_m1', 'batch_m2', 'batch_m3'],
    loadBatch: () => null,
  };
  const svc = createLibraryModeExportService({ db, batchRepository: repo });

  // 两批并集;batchIds 优先于单 batchId
  const rows = svc.listRows({ batchIds: ['batch_m1', 'batch_m3'], batchId: 'batch_m2' });
  assert.deepEqual(rows.map((r) => r.source_customer_id).sort(), ['cm1', 'cm3']);

  // owner 隔离相与:op1 勾了别人的 m3 → 只出自己的 m1(不越权)
  const scoped = svc.listRows({ batchIds: ['batch_m1', 'batch_m3'], operatorUser: { username: 'op1', role: 'reviewer' } });
  assert.deepEqual(scoped.map((r) => r.source_customer_id), ['cm1']);

  // workbook 跨批合并:汇总页数据行=选中两批之和
  const wb = svc.buildWorkbook({ batchIds: ['batch_m1', 'batch_m2'] });
  const summary = wb.worksheets.find((s) => s.name === '汇总');
  assert.equal(summary.actualRowCount - 1, 2, '汇总页=两批合并(减表头)');
});

test('跨批接线契约:路由解析逗号串 batchIds(≤50);前端批次栏复选+跨批导出脚', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const routeSrc = fs2.readFileSync(path2.join(__dirname, '../routes/monthly/export_routes.js'), 'utf8');
  assert.match(routeSrc, /batchIds: String\(req\.query\?\.batchIds \|\| ''\)/);
  assert.match(routeSrc, /slice\(0, 50\)/, '上限防滥用');
  const viewSrc = fs2.readFileSync(path2.join(__dirname, '../frontend/src/views/LibraryView.vue'), 'utf8');
  assert.match(viewSrc, /pickedBatchIds/);
  assert.match(viewSrc, /已选 \{\{ pickedBatchSummary\.count \}\} 个批次/);
  assert.match(viewSrc, /跨批导出 Excel/);
  assert.match(viewSrc, /点行仍是单选进面板/, '勾选与单选面板互不干扰的口径写明');
});
