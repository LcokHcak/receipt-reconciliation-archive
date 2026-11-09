'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createImportJobRepository } = require('../../repositories/import_job_repository');
const { createUnreceivedStateRepository } = require('../../repositories/unreceived_state_repository');
const { createUnreceivedResolutionRepository } = require('../../repositories/unreceived_resolution_repository');
const { createWorkflowTaskRepository } = require('../../repositories/workflow_task_repository');
const { createCustomerReconciliationService } = require('../../services/monthly/customer_reconciliation_service');
const {
  createAgentUnreceivedService, EXPORT_COLUMNS, UNRECEIVED_TASK_TYPE,
} = require('../../services/monthly/agent_unreceived_service');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-05';
const T0 = '2026-05-11T00:00:00.000Z';

function makeCtx({ now = () => T0, withTasks = false } = {}) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES ('${WS}', 2026, 5, 'open', '${T0}', '${T0}')
  `);
  const storeBillRepo = createStoreBillRepository({ db });
  // 未收=SMG总账口径:store_bill 未收行挂 smg_ledger job,billUnreceivedStmt 才认。
  smgJobId = createImportJobRepository({ db }).create({
    workspaceKey: WS, jobType: 'smg_ledger', sourceFile: 'SMG总账.xlsx', operator: 'op', startedAt: T0,
  });
  const resolutionRepo = createUnreceivedResolutionRepository({ db });
  const workflowTaskRepo = withTasks ? createWorkflowTaskRepository({ db }) : null;
  const ctx = {
    db,
    storeBillRepo,
    resolutionRepo,
    workflowTaskRepo,
    nowRef: { now },
    service: null,
  };
  ctx.service = createAgentUnreceivedService({
    customerReconciliationService: createCustomerReconciliationService({
      db,
      unreceivedResolutionRepo: resolutionRepo,
    }),
    unreceivedStateRepo: createUnreceivedStateRepository({ db }),
    unreceivedResolutionRepo: resolutionRepo,
    workflowTaskRepository: workflowTaskRepo,
    now: () => ctx.nowRef.now(),
    logger: { error() {} },
  });
  return ctx;
}

let billSeq = 0;
let smgJobId = null;
function bill({ passportNo, name, receiptNo, tourNo = 'T001', family = '乐天首尔', branch = '明洞',
  mode = '乐天SG', brand = 'LV', purchaseDate = '2026-05-10', transactionType = null }) {
  billSeq += 1;
  return {
    workspaceKey: WS, storeFamily: family, storeBranch: branch, mode,
    name, passportNo, receiptNo, tourNo, brand, purchaseDate,
    transactionType, isDetailSheet: true,
    rowHash: `h${billSeq}`, importedAt: T0,
    importJobId: smgJobId, // 未收=SMG总账口径
  };
}

let dailySeq = 0;
function insertDaily(db, { passportNo, name, receiptNo }) {
  dailySeq += 1;
  db.prepare(`
    INSERT INTO daily_receipt_export
      (workspace_key, passport_no, name, receipt_no, tour_no, mode_folder, tour_match_status, row_hash, imported_at)
    VALUES (?, ?, ?, ?, 'T001', '乐天首尔', 'matched', ?, ?)
  `).run(WS, passportNo, name, receiptNo, `d${dailySeq}`, T0);
}

function insertAgent(db, { tourNo, agent }) {
  db.prepare(`
    INSERT INTO group_code (workspace_key, tour_no, agent, row_hash, imported_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(WS, tourNo, agent, `g${tourNo}${agent}`, T0);
}

test('对账分组:护照+团号成组,代理归属,退款行排除,未归属殿后', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertAgent(db, { tourNo: 'T001', agent: '张代理' });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1' }),
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R2' }),
    bill({ passportNo: 'P2', name: 'BB', receiptNo: 'R3', tourNo: 'T999' }), // 团号查无代理 → 未归属
    bill({ passportNo: 'P3', name: 'CC', receiptNo: 'R4', transactionType: 'refund' }), // 退款排除
  ]);

  const view = service.buildView({ workspaceKey: WS });
  assert.equal(view.groups.length, 2, '退款行不成组');
  const g1 = view.groups.find((g) => g.passportNo === 'P1');
  assert.equal(g1.agentName, '张代理');
  assert.equal(g1.totalCount, 2);
  assert.equal(g1.receivedCount, 0);
  assert.equal(g1.status, 'pending');
  const g2 = view.groups.find((g) => g.passportNo === 'P2');
  assert.equal(g2.agentName, '未归属', '拍板②:团号查不到代理 → 未归属兜底桶');
  assert.equal(view.agents[view.agents.length - 1].agentName, '未归属', '未归属永远殿后');
  // 8 列字段全在行上
  const row = g1.rows[0];
  for (const k of ['name', 'passportNo', 'tourNo', 'receiptNo', 'storeFamily', 'storeBranch', 'mode', 'brand', 'purchaseDate']) {
    assert.ok(k in row, `行缺字段 ${k}`);
  }
});

test('first_seen 锚:首次对账盖章,重算不重置;+7天翻 overdue(拍板③)', () => {
  const ctx = makeCtx();
  ctx.storeBillRepo.insertMany([bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1' })]);

  const v1 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v1.groups[0].firstSeenAt, T0, '首次对账 = first_seen');
  assert.equal(v1.groups[0].status, 'pending');

  // 3 天后重算:first_seen 不动,仍 pending
  ctx.nowRef.now = () => '2026-05-14T00:00:00.000Z';
  const v2 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v2.groups[0].firstSeenAt, T0, '重算不重置计时');
  assert.equal(v2.groups[0].status, 'pending');

  // 8 天后:超 7 天翻红
  ctx.nowRef.now = () => '2026-05-19T00:00:01.000Z';
  const v3 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v3.groups[0].status, 'overdue');
  assert.equal(v3.groups[0].rows[0].overdue, true);
  assert.equal(v3.stats.overdueGroups, 1);
});

test('状态翻转:补收一张→partial;全部进台账→received 变灰;从没未收过的票不进 B 页', () => {
  const ctx = makeCtx();
  ctx.storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1' }),
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R2' }),
    bill({ passportNo: 'P9', name: 'ZZ', receiptNo: 'R9' }),
  ]);
  // P9 的 R9 在第一次对账前就已进台账(收得及时,从没未收过)
  insertDaily(ctx.db, { passportNo: 'P9', name: 'ZZ', receiptNo: 'R9' });

  const v1 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v1.groups.length, 1, '从没未收过的 P9 不进 B 页');

  // 补收 R1 → partial(1/2)
  insertDaily(ctx.db, { passportNo: 'P1', name: 'AA', receiptNo: 'R1' });
  const v2 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v2.groups[0].status, 'partial');
  assert.equal(v2.groups[0].receivedCount, 1);
  assert.equal(v2.groups[0].totalCount, 2);

  // 补收 R2 → received 整组变灰(仍显示,曾未收过)
  insertDaily(ctx.db, { passportNo: 'P1', name: 'AA', receiptNo: 'R2' });
  const v3 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v3.groups[0].status, 'received');
  assert.equal(v3.stats.receivedGroups, 1);
});

test('搜索(姓名/护照/票号/团号)与代理筛选', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertAgent(db, { tourNo: 'T001', agent: '张代理' });
  insertAgent(db, { tourNo: 'T002', agent: '李代理' });
  storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'KIM AA', receiptNo: 'R100', tourNo: 'T001' }),
    bill({ passportNo: 'P2', name: 'LEE BB', receiptNo: 'R200', tourNo: 'T002' }),
  ]);

  assert.equal(service.buildView({ workspaceKey: WS, search: 'R200' }).groups.length, 1, '按票号搜');
  assert.equal(service.buildView({ workspaceKey: WS, search: 'kim' }).groups.length, 1, '按姓名搜(大小写不敏感)');
  assert.equal(service.buildView({ workspaceKey: WS, search: 'T001' }).groups.length, 1, '按团号搜');
  const byAgent = service.buildView({ workspaceKey: WS, agentKey: '李代理' });
  assert.equal(byAgent.groups.length, 1);
  assert.equal(byAgent.groups[0].passportNo, 'P2');
  assert.equal(byAgent.agents.length, 2, '左栏代理桶不受筛选影响(全景)');
});

test('未收清单.xlsx:sheet1 总表+每代理一 sheet+未归属殿后,9 列模板,已收行不进催收清单', () => {
  const ctx = makeCtx();
  insertAgent(ctx.db, { tourNo: 'T001', agent: '张代理' });
  ctx.storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1', tourNo: 'T001' }),
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R2', tourNo: 'T001' }),
    bill({ passportNo: 'P2', name: 'BB', receiptNo: 'R3', tourNo: 'T999' }), // 未归属
  ]);
  ctx.service.buildView({ workspaceKey: WS }); // 先对账盖锚
  insertDaily(ctx.db, { passportNo: 'P1', name: 'AA', receiptNo: 'R1' }); // R1 补收

  const { workbook, rowCount } = ctx.service.buildWorkbook({ workspaceKey: WS });
  assert.equal(rowCount, 2, '已收的 R1 不进催收清单');
  const names = workbook.worksheets.map((s) => s.name);
  assert.deepEqual(names, ['未收总表', '张代理', '未归属']);
  const total = workbook.getWorksheet('未收总表');
  assert.deepEqual(
    total.getRow(1).values.slice(1),
    EXPORT_COLUMNS.map((c) => c.header),
    '9 列用户模板:返点模式/免税分店/代理/购买日期/团号/姓名/护照号/小票号/品牌',
  );
  assert.equal(total.rowCount, 3, '表头+2 行未收');
  assert.equal(workbook.getWorksheet('张代理').rowCount, 2, '张代理 sheet:表头+R2');
  const unassignedRow = workbook.getWorksheet('未归属').getRow(2);
  assert.equal(unassignedRow.getCell(8).value, 'R3', '未归属 sheet 装 T999 的票');
});

test('未收清单.xlsx:统一表格样式(表头深蓝灰白字微软雅黑+冻结首行),不改列/值', () => {
  const ctx = makeCtx();
  insertAgent(ctx.db, { tourNo: 'T001', agent: '张代理' });
  ctx.storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1', tourNo: 'T001' }),
    bill({ passportNo: 'P2', name: 'BB', receiptNo: 'R3', tourNo: 'T999' }),
  ]);
  ctx.service.buildView({ workspaceKey: WS });

  const { workbook } = ctx.service.buildWorkbook({ workspaceKey: WS });
  const total = workbook.getWorksheet('未收总表');

  // 表头样式:深蓝灰底 + 白字 + 微软雅黑(样式层,不动表头文本/列序)
  const headerCell = total.getRow(1).getCell(1);
  assert.equal(headerCell.fill.fgColor.argb, 'FF44546A', '表头深蓝灰底');
  assert.equal(headerCell.font.name, '微软雅黑');
  assert.equal(headerCell.font.color.argb, 'FFFFFFFF', '表头白字');
  // 冻结首行(freezeCols=0:只冻表头,不冻列)
  assert.deepEqual(total.views, [{ state: 'frozen', xSplit: 0, ySplit: 1 }]);
  // 正文字体也上了统一样式
  assert.equal(total.getRow(2).getCell(1).font.name, '微软雅黑');
  // 契约不变:表头文本与小票号列位仍在原处
  assert.deepEqual(total.getRow(1).values.slice(1), EXPORT_COLUMNS.map((c) => c.header));
  assert.equal(total.getRow(2).getCell(8).value, 'R1', '小票号仍在第 8 列,值未变');
});

test('P3 无需补:waive 变灰留痕/催收清单排除/unwaive 恢复;老页 link 处理行不进 B 页', () => {
  const ctx = makeCtx();
  ctx.storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1' }),
    bill({ passportNo: 'P2', name: 'BB', receiptNo: 'R2' }),
  ]);
  const v0 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v0.groups.length, 2);
  const g1 = v0.groups.find((g) => g.passportNo === 'P1');
  const item = g1.rows[0];

  // waive → 组变 waived,行带留痕
  const out = ctx.service.waiveItems({
    workspaceKey: WS,
    items: [{ itemKey: item.itemKey, passportNo: 'P1', name: 'AA', receiptNo: 'R1' }],
    note: '客人退团',
    by: 'op1',
  });
  assert.equal(out.waived, 1);
  const v1 = ctx.service.buildView({ workspaceKey: WS });
  const g1w = v1.groups.find((g) => g.passportNo === 'P1');
  assert.equal(g1w.status, 'waived');
  assert.equal(g1w.rows[0].waived, true);
  assert.equal(g1w.rows[0].waivedBy, 'op1');
  assert.equal(g1w.rows[0].waivedNote, '客人退团');
  assert.equal(v1.stats.unreceivedRows, 1, '豁免行不计未收票');
  assert.equal(v1.stats.waivedGroups, 1);

  // xlsx 催收清单排除豁免行
  const { workbook, rowCount } = ctx.service.buildWorkbook({ workspaceKey: WS });
  assert.equal(rowCount, 1, '只剩 P2 的 R2 要催');
  assert.equal(workbook.getWorksheet('未收总表').getRow(2).getCell(8).value, 'R2');

  // unwaive 恢复催收
  const back = ctx.service.unwaiveItems({ workspaceKey: WS, itemKeys: [item.itemKey] });
  assert.equal(back.restored, 1);
  const v2 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v2.groups.find((g) => g.passportNo === 'P1').status, 'pending');

  // 老页 link 处理的行(非 waive)不进 B 页
  ctx.resolutionRepo.resolveMany({
    workspaceKey: WS,
    items: [{ itemKey: item.itemKey, passportNo: 'P1', name: 'AA', receiptNo: 'R1' }],
    action: 'link',
    resolvedBy: 'op2',
  });
  const v3 = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(v3.groups.some((g) => g.passportNo === 'P1'), false, 'link 行老页已处理,B 页不再显示');
});

test('P3 在途判定:票号在工作台镜像→partial+图片数含在途;护照命中→registered 带审核深链', () => {
  const ctx = makeCtx();
  ctx.storeBillRepo.insertMany([
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1' }),
    bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R2' }),
    bill({ passportNo: 'P8', name: 'YY', receiptNo: 'R8' }), // 免护照百货形态:护照镜像无、票号镜像有
    bill({ passportNo: 'P9', name: 'ZZ', receiptNo: 'R9' }),
  ]);
  // 模拟工作台镜像:P1 已建档(批次 b7/组 g3),R1 的图已收还在审;
  // P8 纯百货组零护照任务(护照镜像查不到)但票 R8 在审;P9 完全没建档
  ctx.service.setInFlightLookup(({ passportNos, receiptNos }) => {
    assert.ok(passportNos.has('p1'), '查找入参用归一护照');
    assert.ok(receiptNos.has('r1'));
    return {
      passports: new Map([['p1', { batchId: 'b7', groupKey: 'g3' }]]),
      receipts: new Map([
        ['r1', { batchId: 'b7', groupKey: 'g3' }],
        ['r8', { batchId: 'b8', groupKey: 'g8' }],
      ]),
    };
  });

  const view = ctx.service.buildView({ workspaceKey: WS });
  const g1 = view.groups.find((g) => g.passportNo === 'P1');
  assert.equal(g1.status, 'partial', '图收了还在审=部分已收(拍板④)');
  assert.equal(g1.collectedCount, 1, '图片数分子含在途');
  assert.equal(g1.receivedCount, 0, '台账仍是 0');
  assert.equal(g1.rows.find((r) => r.receiptNo === 'R1').inFlight, true);
  assert.equal(g1.registered, true);
  assert.equal(g1.reviewBatchId, 'b7');
  assert.equal(g1.reviewGroupKey, 'g3');
  // 部署前整体复查 HIGH:免护照百货(零护照任务)靠票号命中兜底认已建档,
  // 否则同一行"在途审核中"与"未建档"自相矛盾
  const g8 = view.groups.find((g) => g.passportNo === 'P8');
  assert.equal(g8.registered, true, '票号命中镜像=图已在系统,不显未建档');
  assert.equal(g8.reviewBatchId, 'b8');
  assert.equal(g8.reviewGroupKey, 'g8');
  assert.equal(g8.status, 'partial', '在途照常算部分已收');
  const g9 = view.groups.find((g) => g.passportNo === 'P9');
  assert.equal(g9.registered, false, '未建档明示(拍板⑤),前端不渲染跳转');

  // 在途行不算超期:8 天后 R1(在途)不红,R2(没影)红
  ctx.nowRef.now = () => '2026-05-19T00:00:01.000Z';
  const late = ctx.service.buildView({ workspaceKey: WS });
  const g1late = late.groups.find((g) => g.passportNo === 'P1');
  assert.equal(g1late.rows.find((r) => r.receiptNo === 'R1').overdue, false, '在途不催');
  assert.equal(g1late.rows.find((r) => r.receiptNo === 'R2').overdue, true);
  assert.equal(g1late.status, 'overdue', '组内还有真没影的票→整组红');

  // 催收 xlsx 排除在途(部署前业务走查 HIGH):R1/R8 在审不该再催,只剩 R2/R9
  const { workbook, rowCount } = ctx.service.buildWorkbook({ workspaceKey: WS });
  assert.equal(rowCount, 2, '在途行不进催收清单');
  const exported = [];
  workbook.getWorksheet('未收总表').eachRow((row, n) => { if (n > 1) exported.push(row.getCell(8).value); });
  assert.deepEqual(exported.sort(), ['R2', 'R9']);
});

test('P3 催收任务:未收建任务(due=首见+7天)/收齐自动完成/全豁免取消/复发带版本重建', () => {
  const ctx = makeCtx({ withTasks: true });
  ctx.storeBillRepo.insertMany([bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1' })]);

  // 首次对账 → 建 pending 任务,due=first_seen+7d,与 A 页任务列同窗(calendar_month=账期)
  const v1 = ctx.service.buildView({ workspaceKey: WS });
  const gk = v1.groups[0].groupKey;
  let tasks = ctx.workflowTaskRepo.list({ workspaceKey: WS, taskType: UNRECEIVED_TASK_TYPE });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'pending');
  assert.equal(tasks[0].calendarMonth, WS);
  assert.equal(tasks[0].groupKey, gk);
  assert.equal(tasks[0].dueAt, '2026-05-18T00:00:00.000Z');

  // 重复对账幂等:不重复建
  ctx.service.buildView({ workspaceKey: WS });
  tasks = ctx.workflowTaskRepo.list({ workspaceKey: WS, taskType: UNRECEIVED_TASK_TYPE });
  assert.equal(tasks.length, 1);

  // 收齐 → 自动完成
  insertDaily(ctx.db, { passportNo: 'P1', name: 'AA', receiptNo: 'R1' });
  ctx.service.buildView({ workspaceKey: WS });
  tasks = ctx.workflowTaskRepo.list({ workspaceKey: WS, taskType: UNRECEIVED_TASK_TYPE });
  assert.equal(tasks[0].status, 'done');
  assert.equal(tasks[0].completedBy, 'system:unreceived');

  // 复发(台账行被删,票又变未收)→ 带版本重建,不撞已 done 的审计终态
  ctx.db.prepare('DELETE FROM daily_receipt_export WHERE workspace_key = ?').run(WS);
  ctx.service.buildView({ workspaceKey: WS });
  tasks = ctx.workflowTaskRepo.list({ workspaceKey: WS, taskType: UNRECEIVED_TASK_TYPE });
  assert.equal(tasks.length, 2);
  const pending = tasks.find((t) => t.status === 'pending');
  assert.ok(pending.taskKey.endsWith(':v2'), '复发任务带版本号');

  // 全组豁免 → 任务取消(没催成,不算完成)
  const item = ctx.service.buildView({ workspaceKey: WS }).groups[0].rows[0];
  ctx.service.waiveItems({ workspaceKey: WS, items: [{ itemKey: item.itemKey }], by: 'op1' });
  ctx.service.buildView({ workspaceKey: WS });
  tasks = ctx.workflowTaskRepo.list({ workspaceKey: WS, taskType: UNRECEIVED_TASK_TYPE });
  assert.equal(tasks.find((t) => t.taskKey.endsWith(':v2')).status, 'cancelled');
});

test('stampWorkspace:导入钩子只盖锚不炸(异常吞掉留日志)', () => {
  const ctx = makeCtx();
  ctx.storeBillRepo.insertMany([bill({ passportNo: 'P1', name: 'AA', receiptNo: 'R1' })]);
  const out = ctx.service.stampWorkspace(WS);
  assert.equal(out.ok, true);
  assert.equal(out.rows, 1);
  // 盖过锚:马上 buildView 的 firstSeen 与 stamp 时刻一致
  ctx.nowRef.now = () => '2026-05-12T00:00:00.000Z';
  const view = ctx.service.buildView({ workspaceKey: WS });
  assert.equal(view.groups[0].firstSeenAt, T0, 'stamp 时刻就是起算点(拍板③导入对账时)');

  const bad = ctx.service.stampWorkspace(''); // workspaceKey 缺 → 结构化失败不 throw
  assert.equal(bad.ok, false);
});
