'use strict';

/**
 * SMG总账导入(smg_ledger,2026-07-21 拍板:只做未收对账)。
 *
 * 覆盖:
 *  ① 卖出明细解析+列映射(出账日期 MM/DD 归一/退货负额识别/空行跳过)
 *     + 四桶隔离(is_detail_sheet=0:match/merge/桶汇总吃不到,未收对账吃得到)
 *  ② 明细 sheet 定位三级宽严(精确>单sheet直收>唯一模糊命中);定位不了/歧义 → 清晰报错,不动库
 *  ③ 替换语义:导两版,修订行以新版为准、旧 job 标 replaced、店家账单行不受伤,
 *     first_seen 不重置(锚键=护照|姓名|票号,不依赖账单行 id)
 *  ④ 并发守卫:同工作区已有 running 总账导入 → 409
 *  ⑤ readWorkbookSheetNames:zip 目录级 sheet 名(中文/实体转义)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ExcelJS = require('exceljs');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { readWorkbookSheetNames } = require('../../lib/monthly_pipeline/xlsx_sheet_names');
const { createImportJobRepository } = require('../../repositories/import_job_repository');
const { createGroupCodeRepository } = require('../../repositories/group_code_repository');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../../repositories/missing_receipt_repository');
const { createUnreceivedStateRepository } = require('../../repositories/unreceived_state_repository');
const { createImportService } = require('../../services/monthly/import_service');
const { createCustomerReconciliationService, unreceivedItemKey } = require('../../services/monthly/customer_reconciliation_service');
const { createAgentUnreceivedService } = require('../../services/monthly/agent_unreceived_service');
const { createUnreceivedBackfillService } = require('../../services/monthly/unreceived_backfill_service');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-07';
const T0 = '2026-07-20T00:00:00.000Z';

// 实测《SMG总账 7.20.xlsx》卖出明细 58 列的头部子集(列名逐字一致)
const SMG_HEADERS = [
  '日期', '出账日期', '付款模式', '返点模式', '免税店', '免税分店', '上家', '入店公司',
  '导游', '代理', '原日期', '购买日期', '团号', '姓名', '护照号', '小票号', '原小票号',
  '分类', '品牌', 'SKU', '数量', '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)', '备注',
];

function smgRow(over = {}) {
  return {
    日期: 1,
    出账日期: '07/02',
    付款模式: '现金',
    返点模式: 'SG',
    免税店: '乐天',
    免税分店: '乐天釜山',
    上家: 210,
    代理: '韩伴游',
    购买日期: '2026-07-01',
    团号: '26802035',
    姓名: 'HUANG YING',
    护照号: 'ER4848769',
    小票号: '90800626004856',
    分类: 'COS and PFM',
    品牌: 'CHANEL',
    数量: 1,
    '总卖出($)': 38,
    '纯卖出($)': 36,
    '纯卖出(￦)': 55494,
    ...over,
  };
}

async function writeSmgWorkbook(rows, { detailSheetName = '卖出明细', extraSheets = ['总账', '流水'] } = {}) {
  const filePath = path.join(os.tmpdir(), `smg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  for (const name of extraSheets) {
    const s = workbook.addWorksheet(name);
    s.addRow(['汇总项', '金额']);
    s.addRow(['合计', 999]);
  }
  const sheet = workbook.addWorksheet(detailSheetName);
  sheet.addRow(SMG_HEADERS);
  for (const row of rows) sheet.addRow(SMG_HEADERS.map((h) => row[h] ?? null));
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

function makeCtx() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  const importJobRepo = createImportJobRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const importService = createImportService({
    importJobRepo,
    groupCodeRepo: createGroupCodeRepository({ db }),
    storeBillRepo,
    missingReceiptRepo: createMissingReceiptRepository({ db }),
  });
  return { db, importJobRepo, storeBillRepo, importService };
}

function cleanup(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
}

test('smg导入:卖出明细列映射+出账日期归一+退货识别+四桶隔离', async () => {
  const { db, storeBillRepo, importService } = makeCtx();
  const filePath = await writeSmgWorkbook([
    smgRow(),
    smgRow({ 姓名: 'NIAN BIN', 护照号: 'EH6443042', 小票号: '90800626004927', 品牌: 'DIOR' }),
    // 退货行:纯卖出负值 → transaction_type=refund,不算未收
    smgRow({ 小票号: '90800626009999', '纯卖出($)': -36, '总卖出($)': -38, 数量: -1 }),
    // 空行(无票号/护照/姓名)→ 跳过
    { 出账日期: '07/03' },
  ]);
  try {
    const job = await importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' });
    assert.equal(job.status, 'done');
    assert.equal(job.rowsInserted, 3, '2 售出 + 1 退货入库,空行跳过');
    assert.equal(job.replacedRows, 0, '首导无可替换');

    const rows = db.prepare('SELECT * FROM store_bill WHERE workspace_key = ? ORDER BY id').all(WS);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.is_detail_sheet, 0, '总账行必须 is_detail_sheet=0(不进四桶)');
      assert.equal(r.source_sheet, '卖出明细');
    }
    const first = rows[0];
    assert.equal(first.statement_date, '2026-07-02', '出账日期 07/02 补账期年份归一');
    assert.equal(first.purchase_date, '2026-07-01');
    assert.equal(first.mode, 'SG', '返点模式优先于付款模式');
    assert.equal(first.store_family, '乐天');
    assert.equal(first.store_branch, '乐天釜山');
    assert.equal(first.tour_no, '26802035');
    assert.equal(first.net_usd, 36);
    assert.equal(first.transaction_type, null, '正常售出 = sale 语义(NULL)');
    const payload = JSON.parse(first.raw_payload);
    assert.deepEqual(payload, { 上家: '210', 代理: '韩伴游' }, 'rawPayload 只留溯源缩减版');
    const refund = rows.find((r) => r.receipt_no === '90800626009999');
    assert.equal(refund.transaction_type, 'refund', '负额行识别为退货/退款');

    // 四桶隔离:匹配/合并/桶汇总(is_detail_sheet=1)吃不到总账行
    assert.equal(storeBillRepo.iterateMatchCandidates(WS).length, 0);
    assert.equal(storeBillRepo.iterateDetailLight(WS).length, 0);
    assert.equal([...storeBillRepo.iterateMergeCandidates(WS)].length, 0);

    // 未收对账吃得到:2 张售出票未收,退货行被 sale-only 过滤
    const recon = createCustomerReconciliationService({ db });
    const unreceived = recon.listUnreceived(WS);
    assert.equal(unreceived.length, 2);
    assert.equal(unreceived[0].statement_date, '2026-07-02', '未收行带出账日期');
  } finally {
    cleanup(filePath);
  }
});

test('SMG总账行不污染店家账单读面(审计MEDIUM):列表/计数/家族/覆盖率/兜底只见明细行', async () => {
  const { db, importJobRepo, storeBillRepo, importService } = makeCtx();
  // 一条真店家账单明细行(is_detail_sheet=1),团号 T-BILL
  const billJobId = importJobRepo.create({ workspaceKey: WS, jobType: 'store_bill', sourceFile: '乐天账单.xlsx', operator: 'op', startedAt: T0 });
  storeBillRepo.insertMany([{
    workspaceKey: WS, storeFamily: '乐天首尔', name: 'BILL NAME', passportNo: 'PK1', receiptNo: 'RK1',
    tourNo: 'T-BILL', isDetailSheet: true, rowHash: 'keepbill1', importedAt: T0, importJobId: billJobId,
  }]);
  // 导入 SMG 总账迷你版:3 行 is_detail_sheet=0(生产是 28 万行)
  const filePath = await writeSmgWorkbook([
    smgRow({ 小票号: 'SMG-A' }),
    smgRow({ 小票号: 'SMG-B', 护照号: 'ER4848769' }),
    smgRow({ 小票号: 'SMG-C' }),
  ]);
  try {
    await importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' });
    assert.equal(db.prepare('SELECT COUNT(1) AS n FROM store_bill WHERE workspace_key = ?').get(WS).n, 4, '底表 1 明细 + 3 总账');

    // ① 账单列表 + total 只见明细行(修复前首页全是总账、total 虚增)
    const list = storeBillRepo.list({ workspaceKey: WS, family: null, mode: null, limit: 500, offset: 0 });
    assert.deepEqual(list.map((r) => r.receiptNo), ['RK1'], '账单列表不含总账行');
    // ② 工作区计数/家族计数排除总账
    assert.equal(storeBillRepo.countByWorkspace(WS), 1, 'storeBills 计数排除总账');
    assert.deepEqual(storeBillRepo.countByFamily(WS).map((r) => r.family), ['乐天首尔'], '家族计数不含 SMG 的「乐天」');
    // ③ 团号覆盖率:billsTotal 与 distinct tours 都排除总账团号
    const cov = storeBillRepo.tourCoverageStats(WS);
    assert.equal(cov.billsTotal, 1);
    assert.equal(cov.billsDistinctTours, 1, '只数明细行团号(T-BILL),不数总账团号 26802035');
    // ④ 兜底/富集 findByReceipt/Passport 捡不到总账行(否则 monthly_data 写进总账来源)
    assert.deepEqual(storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'SMG-A' }), [], 'findByReceipt 不返总账行');
    assert.deepEqual(storeBillRepo.findByPassport({ workspaceKey: WS, passportNo: 'ER4848769' }), [], 'findByPassport 不返总账行');
    assert.equal(storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'RK1' }).length, 1, '明细行照常可查');
  } finally {
    cleanup(filePath);
  }
});

test('smg导入:sheet 定位不了(多sheet无「卖出/明细」字样)→ 清晰报错且不动库', async () => {
  const { db, importService } = makeCtx();
  // 多 sheet 且没有一张名字含「卖出」或「明细」→ 三级宽严全落空
  const filePath = await writeSmgWorkbook([], { detailSheetName: '数据2026', extraSheets: ['总账'] });
  try {
    await assert.rejects(
      importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' }),
      (err) => {
        assert.match(err.message, /卖出明细/);
        assert.match(err.message, /总账/, '报错列出现有 sheet 名');
        assert.equal(err.statusCode, 422);
        return true;
      },
    );
    assert.equal(db.prepare('SELECT COUNT(1) AS n FROM store_bill').get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(1) AS n FROM import_job WHERE job_type = 'smg_ledger'`).get().n, 0, '预检失败不建 job');
  } finally {
    cleanup(filePath);
  }
});

// 0727红批注 image15 实锤:上家发的总账唯一 sheet 叫 Sheet1,旧精确匹配直接 422,
// 用户每次要手动改名。单 sheet 工作簿没有第二种可能 → 名字随意直收。
test('smg导入:单 sheet 工作簿(Sheet1)不再挑名字,直接接受', async () => {
  const { db, importService } = makeCtx();
  const filePath = await writeSmgWorkbook([smgRow(), smgRow({ 小票号: 'S1-2', 护照号: 'EH6443042' })],
    { detailSheetName: 'Sheet1', extraSheets: [] });
  try {
    const job = await importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' });
    assert.equal(job.status, 'done');
    assert.equal(job.rowsInserted, 2);
    const rows = db.prepare('SELECT source_sheet FROM store_bill WHERE workspace_key = ?').all(WS);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source_sheet, 'Sheet1', '来源 sheet 如实记录(不伪装成卖出明细)');
  } finally {
    cleanup(filePath);
  }
});

test('smg导入:多 sheet 无精确名但唯一模糊命中(7月卖出明细)→ 接受;歧义仍报错', async () => {
  const { db, importService } = makeCtx();
  // 唯一模糊命中:汇总/流水不含关键词,「7月卖出明细」独中
  const fuzzyOk = await writeSmgWorkbook([smgRow({ 小票号: 'FZ1' })],
    { detailSheetName: '7月卖出明细', extraSheets: ['汇总', '流水'] });
  // 歧义:两张都含「明细」→ 猜错整本导错,宁可 422 让人挑
  const ambiguous = await writeSmgWorkbook([smgRow({ 小票号: 'FZ2' })],
    { detailSheetName: '7月卖出明细', extraSheets: ['退货明细'] });
  try {
    const job = await importService.importSmgLedger({ workspaceKey: WS, filePath: fuzzyOk, operator: 'tester' });
    assert.equal(job.status, 'done');
    assert.equal(job.rowsInserted, 1);
    assert.equal(db.prepare('SELECT source_sheet FROM store_bill WHERE workspace_key = ?').get(WS).source_sheet, '7月卖出明细');

    await assert.rejects(
      importService.importSmgLedger({ workspaceKey: '2026-08', filePath: ambiguous, operator: 'tester' }),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.match(err.message, /退货明细/, '歧义报错列出候选 sheet');
        return true;
      },
    );
    assert.equal(db.prepare(`SELECT COUNT(1) AS n FROM store_bill WHERE workspace_key = '2026-08'`).get().n, 0, '歧义不动库');
  } finally {
    cleanup(fuzzyOk);
    cleanup(ambiguous);
  }
});

test('smg导入:替换语义 — 修订行以新版为准,店家账单行无伤,first_seen 不重置', async () => {
  const { db, importJobRepo, storeBillRepo, importService } = makeCtx();
  // 干扰项:一条店家账单行(job_type=store_bill),替换绝不能伤到它
  const storeBillJobId = importJobRepo.create({
    workspaceKey: WS, jobType: 'store_bill', sourceFile: '乐天账单.xlsx', operator: 'op', startedAt: T0,
  });
  storeBillRepo.insertMany([{
    workspaceKey: WS, storeFamily: '乐天首尔', name: 'KEEP ME', passportNo: 'PK1', receiptNo: 'RK1',
    isDetailSheet: true, rowHash: 'keep1', importedAt: T0, importJobId: storeBillJobId,
  }]);

  // B 页对账服务(锚表键=护照|姓名|票号)
  const nowRef = { now: () => T0 };
  const agentService = createAgentUnreceivedService({
    customerReconciliationService: createCustomerReconciliationService({ db }),
    unreceivedStateRepo: createUnreceivedStateRepository({ db }),
    now: () => nowRef.now(),
    logger: { error() {} },
  });

  const v1 = await writeSmgWorkbook([
    smgRow({ 小票号: 'R1', 品牌: 'CHANEL' }),
    smgRow({ 小票号: 'R2', 品牌: 'GUCCI' }),
  ]);
  const v2 = await writeSmgWorkbook([
    smgRow({ 小票号: 'R1', 品牌: 'DIOR' }), // 上家修订了品牌
    smgRow({ 小票号: 'R3', 品牌: 'LV' }),   // 新增行;R2 被上家删掉
  ]);
  try {
    const job1 = await importService.importSmgLedger({ workspaceKey: WS, filePath: v1, operator: 'tester' });
    assert.equal(job1.rowsInserted, 2);
    agentService.stampWorkspace(WS); // 模拟导入钩子:对账盖 first_seen
    const anchors1 = new Map(db.prepare('SELECT item_key, first_seen_at FROM unreceived_state WHERE workspace_key = ?')
      .all(WS).map((r) => [r.item_key, r.first_seen_at]));
    const keyR1 = unreceivedItemKey({ passportNo: 'ER4848769', name: 'HUANG YING', receiptNo: 'R1' });
    assert.equal(anchors1.get(keyR1), T0, 'v1 导入后 R1 盖锚');

    // 一周后导 v2(滚动全量替换)
    nowRef.now = () => '2026-07-27T00:00:00.000Z';
    const job2 = await importService.importSmgLedger({ workspaceKey: WS, filePath: v2, operator: 'tester' });
    assert.equal(job2.replacedRows, 2, '旧总账 2 行被清');
    agentService.stampWorkspace(WS);

    const smgRows = db.prepare(`
      SELECT receipt_no, brand FROM store_bill sb
      WHERE workspace_key = ? AND EXISTS (
        SELECT 1 FROM import_job ij WHERE ij.id = sb.import_job_id AND ij.job_type = 'smg_ledger'
      ) ORDER BY receipt_no
    `).all(WS).map((r) => ({ ...r }));
    assert.deepEqual(smgRows, [
      { receipt_no: 'R1', brand: 'DIOR' },
      { receipt_no: 'R3', brand: 'LV' },
    ], '修订行以新版为准,R2 不残留');
    assert.equal(db.prepare(`SELECT COUNT(1) AS n FROM store_bill WHERE receipt_no = 'RK1'`).get().n, 1, '店家账单行无伤');
    assert.equal(importJobRepo.findById(job1.id).status, 'replaced', '旧 job 标 replaced');
    assert.equal(importJobRepo.findById(job2.id).status, 'done');

    const anchors2 = new Map(db.prepare('SELECT item_key, first_seen_at FROM unreceived_state WHERE workspace_key = ?')
      .all(WS).map((r) => [r.item_key, r.first_seen_at]));
    assert.equal(anchors2.get(keyR1), T0, '替换导入不重置 first_seen(超7天红起算点不漂移)');
    const keyR3 = unreceivedItemKey({ passportNo: 'ER4848769', name: 'HUANG YING', receiptNo: 'R3' });
    assert.equal(anchors2.get(keyR3), '2026-07-27T00:00:00.000Z', '新行按本次对账时间盖锚');
  } finally {
    cleanup(v1);
    cleanup(v2);
  }
});

test('smg导入:并发守卫 — 已有 running 总账导入拒 409,完成后放行', async () => {
  const { importJobRepo, importService } = makeCtx();
  const runningId = importJobRepo.create({
    workspaceKey: WS, jobType: 'smg_ledger', sourceFile: '总账A.xlsx', operator: 'op',
    startedAt: new Date().toISOString(),
  });
  const filePath = await writeSmgWorkbook([smgRow()]);
  try {
    await assert.rejects(
      importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' }),
      (err) => err.statusCode === 409 && /正在进行/.test(err.message),
    );
    importJobRepo.finalize({
      id: runningId, status: 'done', rowsTotal: 0, rowsInserted: 0, rowsSkipped: 0,
      finishedAt: new Date().toISOString(),
    });
    const job = await importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' });
    assert.equal(job.status, 'done');
  } finally {
    cleanup(filePath);
  }
});

test('SMG替换窗口隔离(审计MEDIUM):导入中导出409 + 视图 importing 标 + 任务同步跳过,完成后恢复', async () => {
  const { db, importJobRepo, importService } = makeCtx();
  const v1 = await writeSmgWorkbook([
    smgRow({ 小票号: 'W1' }),
    smgRow({ 小票号: 'W2', 护照号: 'EH6443042' }),
  ]);
  const syncCalls = [];
  const workflowTaskRepository = {
    findPendingByScope: (args) => { syncCalls.push(args); return null; },
    countByScope: () => ({ settled: 0 }),
    createExpected: () => {},
    complete: () => {},
    cancel: () => {},
  };
  const agentService = createAgentUnreceivedService({
    customerReconciliationService: createCustomerReconciliationService({ db }),
    unreceivedStateRepo: createUnreceivedStateRepository({ db }),
    workflowTaskRepository,
    importJobRepo,
    now: () => '2026-07-25T00:00:00.000Z',
    logger: { error() {} },
  });
  try {
    await importService.importSmgLedger({ workspaceKey: WS, filePath: v1, operator: 'tester' });

    // 造替换窗口:一个 running 的 smg_ledger job(<2h 非僵尸)
    const runningId = importJobRepo.create({ workspaceKey: WS, jobType: 'smg_ledger', sourceFile: 'v2.xlsx', operator: 'op', startedAt: '2026-07-25T00:00:00.000Z' });
    assert.equal(agentService.isSmgImporting(WS), true);

    // ① 导出直接 409(ConflictError)——不把残缺清单发给代理
    assert.throws(
      () => agentService.buildWorkbook({ workspaceKey: WS }),
      (e) => e.status === 409 && /导入|残缺/.test(e.message),
    );
    // ② 视图不抛、importing:true(前端横幅),且任务同步被跳过(不误 complete 催收任务)
    syncCalls.length = 0;
    const view = agentService.buildView({ workspaceKey: WS });
    assert.equal(view.importing, true);
    assert.equal(syncCalls.length, 0, '替换窗口内不同步任务(否则残缺数据误判组收齐)');

    // ③ 导入完成 → 恢复:isSmgImporting=false、导出可用、importing=false、任务同步恢复
    importJobRepo.finalize({ id: runningId, status: 'done', rowsTotal: 0, rowsInserted: 0, rowsSkipped: 0, finishedAt: '2026-07-25T00:10:00.000Z' });
    assert.equal(agentService.isSmgImporting(WS), false);
    syncCalls.length = 0;
    const view2 = agentService.buildView({ workspaceKey: WS });
    assert.equal(view2.importing, false);
    assert.ok(syncCalls.length > 0, '导入完成后任务同步恢复(以完整数据)');
    assert.doesNotThrow(() => agentService.buildWorkbook({ workspaceKey: WS }));
  } finally {
    cleanup(v1);
  }
});

test('SMG替换窗口:僵尸 running job(>2h)不挡道,视为已死放行导出', async () => {
  const { db, importJobRepo } = makeCtx();
  importJobRepo.create({ workspaceKey: WS, jobType: 'smg_ledger', sourceFile: 'zombie.xlsx', operator: 'op', startedAt: '2026-07-25T00:00:00.000Z' });
  const agentService = createAgentUnreceivedService({
    customerReconciliationService: createCustomerReconciliationService({ db }),
    unreceivedStateRepo: createUnreceivedStateRepository({ db }),
    importJobRepo,
    now: () => '2026-07-25T03:00:00.000Z', // 距 startedAt 3 小时 > 2h 阈值
    logger: { error() {} },
  });
  assert.equal(agentService.isSmgImporting(WS), false, '超2h的 running job=进程已死的僵尸,不挡导出');
  assert.doesNotThrow(() => agentService.buildWorkbook({ workspaceKey: WS }));
});

test('smg导入:总账行不可被"未收补录"推进四桶(复核 CRITICAL 回归)', async () => {
  const { db, importService } = makeCtx();
  const filePath = await writeSmgWorkbook([smgRow({ 小票号: 'RSMG1' })]);
  try {
    await importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' });
    const backfill = createUnreceivedBackfillService({
      db,
      dailyReceiptRepo: createDailyReceiptRepository({ db }),
    });
    const result = await backfill.backfill({
      workspaceKey: WS,
      items: [{ passportNo: 'ER4848769', name: 'HUANG YING', receiptNo: 'RSMG1' }],
      operator: 'tester',
    });
    assert.equal(result.backfilled, 0, '总账行(is_detail_sheet=0)不许补录成台账行');
    assert.equal(result.notFound.length, 1, '按未找到如实上报');
    assert.equal(
      db.prepare('SELECT COUNT(1) AS n FROM daily_receipt_export WHERE workspace_key = ?').get(WS).n,
      0,
      '没有伪造台账行落库',
    );
  } finally {
    cleanup(filePath);
  }
});

test('smg导入:进程内互斥 — 同工作区真并发只放行一个(复核 HIGH 回归)', async () => {
  const { importService } = makeCtx();
  const f1 = await writeSmgWorkbook([smgRow({ 小票号: 'RC1' })]);
  const f2 = await writeSmgWorkbook([smgRow({ 小票号: 'RC2' })]);
  try {
    const outcomes = await Promise.allSettled([
      importService.importSmgLedger({ workspaceKey: WS, filePath: f1, operator: 'a' }),
      importService.importSmgLedger({ workspaceKey: WS, filePath: f2, operator: 'b' }),
    ]);
    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(ok.length, 1, '恰好一个导入成功');
    assert.equal(rejected.length, 1, '另一个被互斥拒绝');
    assert.equal(rejected[0].reason.statusCode, 409);
  } finally {
    cleanup(f1);
    cleanup(f2);
  }
});

test('smg导入:同文件秒拒 — 指纹等于当前生效版直接409,不动数据不建job', async () => {
  const { db, importService } = makeCtx();
  const filePath = await writeSmgWorkbook([smgRow({ 小票号: 'RD1' })]);
  try {
    const job1 = await importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' });
    assert.equal(job1.status, 'done');
    await assert.rejects(
      importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester2' }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /完全相同|无需重复/);
        return true;
      },
    );
    assert.equal(db.prepare(`SELECT COUNT(1) AS n FROM import_job WHERE job_type = 'smg_ledger'`).get().n, 1, '秒拒不建第二个 job');
    assert.equal(db.prepare('SELECT COUNT(1) AS n FROM store_bill WHERE workspace_key = ?').get(WS).n, 1, '数据原样');
  } finally {
    cleanup(filePath);
  }
});

test('smg导入:旧版守卫 — 出账日期回退时 done+staleWarning 明示(不静默回退)', async () => {
  const { importJobRepo, importService } = makeCtx();
  const vNew = await writeSmgWorkbook([smgRow({ 小票号: 'RN1', 出账日期: '07/20' })]);
  const vOld = await writeSmgWorkbook([smgRow({ 小票号: 'RO1', 出账日期: '07/02' })]);
  try {
    const jobNew = await importService.importSmgLedger({ workspaceKey: WS, filePath: vNew, operator: 'tester' });
    assert.equal(jobNew.staleWarning, null, '正常首导无警告');
    const jobOld = await importService.importSmgLedger({ workspaceKey: WS, filePath: vOld, operator: 'tester' });
    assert.equal(jobOld.status, 'done', '替换语义照常执行(重导最新版即可恢复)');
    assert.match(jobOld.staleWarning, /旧版/, '出账日期上限回退 → 明示疑似旧文件');
    assert.match(jobOld.staleWarning, /2026-07-02/, '警告带新旧日期');
    assert.match(jobOld.staleWarning, /2026-07-20/);
    assert.match(importJobRepo.findById(jobOld.id).details.staleWarning, /旧版/, '警告落 job.details 供前端轮询取');
  } finally {
    cleanup(vNew);
    cleanup(vOld);
  }
});

test('smg导入:路由守卫登记 — smg-ledger 是唯一 admin-only 导入类型', () => {
  const { IMPORT_TYPES } = require('../../routes/monthly/import_routes');
  const smg = IMPORT_TYPES.find(([slug]) => slug === 'smg-ledger');
  assert.ok(smg, 'smg-ledger 在导入类型注册表里');
  assert.equal(smg[2], 'admin', '收权拍板(2026-07-21):总账导入仅管理员');
  for (const [slug, , guardKey] of IMPORT_TYPES) {
    if (slug !== 'smg-ledger') assert.equal(guardKey, undefined, `${slug} 保持 intake 守卫不受影响`);
  }
});

test('readWorkbookSheetNames:zip 目录级读名,中文/转义/顺序一致', async () => {
  const filePath = path.join(os.tmpdir(), `sheetnames-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  for (const name of ['总账', '卖出明细', 'A&B', '流水 7月']) {
    workbook.addWorksheet(name).addRow(['x']);
  }
  await workbook.xlsx.writeFile(filePath);
  try {
    assert.deepEqual(readWorkbookSheetNames(filePath), ['总账', '卖出明细', 'A&B', '流水 7月']);
    assert.deepEqual(readWorkbookSheetNames(`${filePath}.does-not-exist`), [], '读不到 → 空数组降级');
  } finally {
    cleanup(filePath);
  }
});

test('smg导入:落库失败(flushAll抛)→ job 必转 failed 不卡 running,立即重导不被 2h 守卫 409(审计LOW回归)', async () => {
  const { importJobRepo, storeBillRepo, importService } = makeCtx();
  const filePath = await writeSmgWorkbook([smgRow()]);
  const origInsertMany = storeBillRepo.insertMany;
  const origConsoleError = console.error;
  const errorLogs = [];
  try {
    // 模拟磁盘满/约束错:persistBatch(insertMany)抛 → 旧实现里 catch 内 flushAll 再抛,
    // finalize('failed') 被跳过,job 永留 running,DB 守卫 409 挡重导 2 小时。
    storeBillRepo.insertMany = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
    console.error = (...args) => { errorLogs.push(args.join(' ')); };
    await assert.rejects(
      importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' }),
      /SQLITE_FULL/,
    );
    const jobs = importJobRepo.listByWorkspace({ workspaceKey: WS, jobType: 'smg_ledger', limit: 10 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'failed', 'finalize(failed) 必达,不许卡 running');
    assert.match(jobs[0].errorMessage || '', /SQLITE_FULL/, 'errorMessage 记根因');
    assert.ok(errorLogs.some((l) => l.includes('flushAll failed on error path')), '错误路径 flushAll 失败留日志面包屑');
    // 症状消除:恢复落库能力后立即重导应放行(不被 running 守卫 409)并成功
    storeBillRepo.insertMany = origInsertMany;
    const retry = await importService.importSmgLedger({ workspaceKey: WS, filePath, operator: 'tester' });
    assert.equal(retry.status, 'done', '失败后立即重导成功,无需等 2 小时');
    assert.equal(retry.rowsInserted, 1);
  } finally {
    storeBillRepo.insertMany = origInsertMany;
    console.error = origConsoleError;
    cleanup(filePath);
  }
});
