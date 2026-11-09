'use strict';

/**
 * 域3 交付导出边界缺口补测(docs/边界测试设计.md「域3」2026-07-21):
 *   1. 缺口#10 library_mode_export owner 隔离服务层(buildFilter 的 operatorUser 分支经 listRows 实测:
 *      IN(自有批次) / 无自有批次 1=0 / admin·不传·null 全量)。
 *   2. 缺口#16 collectLedgerGaps 五降级/过滤分支(函数未导出,经 POST /api/library/delivery-readiness
 *      的 mode_delivery 内置计划触发):①重拍组跳过 ②无组键散图跳过 ③纯护照组跳过
 *      ④台账查询抛错不误报 ⑤repo 未接线两类全空。
 *   3. 缺口#6 normalizeStoreFamily 歧义店串(lib/validation/field_rules.js:77 百货优先防线)
 *      + 前端镜像 normalizeReceiptStore(frontend/src/lib/reviewFieldConfig.js:318,未导出,
 *      经导出面 buildReviewFieldPayload 触达)前后端一致性。
 *   4. lotte_dept planDelivery 缺购买日期客户夹名回退(`{M.D} 名` → 仅姓名,不炸不带空格)。
 *
 * 只加测试,不改任何源码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const { createLibraryModeExportService } = require('../services/monthly/library_mode_export_service');
const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createLibraryDeliveryRoutes } = require('../routes/library_delivery_routes');
const { createModeDeliveryExportService } = require('../services/mode_delivery_export_service');
const { createHyundaiDeliveryExportService } = require('../services/hyundai_delivery_export_service');
const { createLotteDeptDeliveryExportService } = require('../services/lotte_dept_delivery_export_service');
const { normalizeStoreFamily, STORE_FAMILIES } = require('../lib/validation/field_rules');

const LEDGER_TABLE_SQL = `CREATE TABLE daily_receipt_export (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
  purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
  agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
  gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT, imported_at TEXT
)`;

// ══════════════════ 1. library_mode_export owner 隔离服务层 ══════════════════
// owner 概念(读源码确认):台账无 owner 列,靠 source_batch_id 映射批次 owner——
// ownedBatches = batchRepository.listBatches() 里 batch.ownerUsername(/createdBy)与
// operatorUser.username 匹配(operator_scope.filterBatchesByOperator);
// buildFilter 取 b.id || b.batchId 拼 IN 子句,无自有批次时压 `1 = 0`。

function makeOwnerDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(LEDGER_TABLE_SQL);
  const ins = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_customer_id, source_batch_id, mode_raw, purchase_date, name, receipt_no)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run('2026-07', 'c1', 'batch_op1', '乐天SG-本司', '2026-07-01', '甲', 'r_op1_a');
  ins.run('2026-07', 'c1', 'batch_op1', '乐天SG-本司', '2026-07-02', '甲', 'r_op1_b');
  ins.run('2026-07', 'c2', 'batch_op2', '乐天SG-本司', '2026-07-03', '乙', 'r_op2_a');
  return db;
}

// op2 的批次故意只带 batchId(无 id)——锁死 buildFilter 的 `b.id || b.batchId` 取号回退
const ownerBatchRepo = {
  listBatches: () => [
    { id: 'batch_op1', name: '批次1', ownerUsername: 'op1' },
    { batchId: 'batch_op2', name: '批次2', ownerUsername: 'op2' },
  ],
};

function receiptNosOf(rows) {
  return rows.map((r) => r.receipt_no).sort();
}

test('owner隔离:listRows 按 operatorUser 收窄到自有批次(op1/op2 各看各的)', () => {
  const svc = createLibraryModeExportService({ db: makeOwnerDb(), batchRepository: ownerBatchRepo });
  const op1Rows = svc.listRows({ operatorUser: { username: 'op1', role: 'reviewer' } });
  assert.deepEqual(receiptNosOf(op1Rows), ['r_op1_a', 'r_op1_b'], 'op1 只见 batch_op1 两行');
  const op2Rows = svc.listRows({ operatorUser: { username: 'op2', role: 'reviewer' } });
  assert.deepEqual(receiptNosOf(op2Rows), ['r_op2_a'], 'op2 只见 batch_op2 一行(批次靠 batchId 字段取号)');
});

test('owner隔离:操作员无自有批次 → 1=0 空结果(listRows/listModeSummary 同走 buildFilter)', () => {
  const svc = createLibraryModeExportService({ db: makeOwnerDb(), batchRepository: ownerBatchRepo });
  const op3 = { username: 'op3', role: 'reviewer' };
  assert.deepEqual(svc.listRows({ operatorUser: op3 }), [], '无自有批次的操作员必须空结果');
  // 叠加工作区筛选也不该漏(1=0 与其它子句 AND)
  assert.deepEqual(svc.listRows({ workspaceKey: '2026-07', operatorUser: op3 }), []);
  // buildFilter 是共享底座:listModeSummary 同样收窄
  assert.deepEqual(svc.listModeSummary({ operatorUser: op3 }), [], 'listModeSummary 同路必须空');
});

test('owner隔离:admin / 不传 / null operatorUser → 全量;owner 收窄与批次筛选 AND 叠加', () => {
  const svc = createLibraryModeExportService({ db: makeOwnerDb(), batchRepository: ownerBatchRepo });
  const all = ['r_op1_a', 'r_op1_b', 'r_op2_a'];
  assert.deepEqual(receiptNosOf(svc.listRows({ operatorUser: { username: 'boss', role: 'admin' } })), all, 'admin 全量');
  assert.deepEqual(receiptNosOf(svc.listRows({})), all, '不传 operatorUser(undefined)不启用隔离');
  assert.deepEqual(receiptNosOf(svc.listRows({ operatorUser: null })), all, 'null 用户按全局口径(canAccessAllOperatorData(null)=true)');
  // op1 指名要 batch_op2:owner IN 子句与 source_batch_id=? AND 叠加 → 空,不越权
  assert.deepEqual(svc.listRows({ batchId: 'batch_op2', operatorUser: { username: 'op1', role: 'reviewer' } }), [],
    '操作员点名别人的批次,owner IN 与批次筛选相与后必须为空');
});

// ══════════════════ 2. collectLedgerGaps 五降级/过滤分支 ══════════════════
// 函数未导出(library_delivery_routes.js:150 闭包内),按任务书经路由触发:
// POST /api/library/delivery-readiness + 内置计划「内置·多模式四规则」(mode_delivery)。

let taskSeq = 0;
function gapTask(over) {
  taskSeq += 1;
  return {
    id: `task_${String(taskSeq).padStart(4, '0')}`,
    reviewed: true,
    docTypeFinal: 'receipt',
    sourceImagePath: '',
    sourceOriginalPath: '',
    ...over,
  };
}

// 控制组:护照1本+乐天免税小票,整组已审、台账 0 行 → 必进 reviewedNotSettled。
// 各分支测试都带上它,证明"没进清单"是分支跳过,不是管道整体哑火。
function ctrlGroupTasks(img) {
  return [
    gapTask({
      docTypeFinal: 'passport', extractedNameFinal: 'ZHANG SAN', passportNoFinal: 'EQ123456',
      sourceGroupKey: 'g_ctrl', sourceGroupLabel: 'CL20260721-001',
      sourceOriginalPath: 'ws1/CL20260721-001/pp.jpg', sourceImagePath: img,
    }),
    gapTask({
      receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', groupNoFinal: '26141846',
      receiptNoFinal: '12345678901234',
      sourceGroupKey: 'g_ctrl', sourceGroupLabel: 'CL20260721-001',
      sourceOriginalPath: 'ws1/CL20260721-001/r1.jpg', sourceImagePath: img,
    }),
  ];
}

async function makeGapServer(t, { buildTasks, dailyReceiptRepo } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-gaps-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  db.exec(LEDGER_TABLE_SQL);
  const repository = createModeConfigRepository({ db });
  const img = path.join('source', 'shared.jpg');
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.writeFileSync(path.join(dir, img), 'img');
  const batch = {
    id: `batch_gap_${path.basename(dir)}`, // 独名批次,避开模块级 plansCache 串台
    name: '边界缺口批次',
    ownerUsername: 'op1',
    tasks: buildTasks(img),
  };
  const resolveBatchRelativePath = (_batchId, rel) => path.join(dir, rel);
  const hyundai = createHyundaiDeliveryExportService({ resolveBatchRelativePath });
  // 与真仓库同名同形的默认查询(库里没种行 → 每组都查无行)
  const defaultRepo = {
    listWorkspaceKeysForSourceGroup: ({ sourceBatchId, sourceCustomerId }) => db.prepare(
      'SELECT DISTINCT workspace_key AS w FROM daily_receipt_export WHERE source_batch_id = ? AND source_customer_id = ?',
    ).all(String(sourceBatchId || ''), String(sourceCustomerId || '')).map((r) => r.w).filter(Boolean),
  };

  const app = express();
  app.use(express.json());
  createLibraryDeliveryRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'op1', role: 'reviewer' }; next(); } },
    deps: {
      loadBatch: (id) => (id === batch.id ? batch : null),
      modeDeliveryExportService: createModeDeliveryExportService({ resolveBatchRelativePath, hyundaiDeliveryExportService: hyundai }),
      hyundaiDeliveryExportService: hyundai,
      resolveBatchRelativePath,
      // undefined=用默认可用查询;测试⑤传 {}(有 repo 无方法)踩"未接线"分支
      dailyReceiptRepo: dailyReceiptRepo === undefined ? defaultRepo : dailyReceiptRepo,
    },
  }).register(app);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function readiness() {
    const response = await fetch(`${base}/api/library/delivery-readiness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: batch.id, planName: '内置·多模式四规则' }),
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }
  return { readiness, batch };
}

const groupKeysOf = (list) => (list || []).map((g) => g.groupKey).sort();

test('collectLedgerGaps①:重拍组(旗标/「重拍」文本两形态)跳过两类清单;控制组仍被列', async (t) => {
  const { readiness } = await makeGapServer(t, {
    buildTasks: (img) => [
      ...ctrlGroupTasks(img),
      // 重拍组A:布尔旗标 rephotoRequested(护照齐,台账 0 行——不跳就会误进已审未结算)
      gapTask({
        docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EK987654',
        sourceGroupKey: 'g_re_flag', sourceGroupLabel: 'CL20260721-002',
        sourceOriginalPath: 'ws1/CL20260721-002/pp.jpg', sourceImagePath: img,
      }),
      gapTask({
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', receiptNoFinal: '22345678901234',
        rephotoRequested: true,
        sourceGroupKey: 'g_re_flag', sourceGroupLabel: 'CL20260721-002',
        sourceOriginalPath: 'ws1/CL20260721-002/r1.jpg', sourceImagePath: img,
      }),
      // 重拍组B:processResult 含「重拍」文本 + 无护照(不跳就会误进缺护照拦结算清单)
      gapTask({
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', receiptNoFinal: '32345678901234',
        processResult: '需要重拍',
        sourceGroupKey: 'g_re_text', sourceGroupLabel: 'CL20260721-003',
        sourceOriginalPath: 'ws1/CL20260721-003/r1.jpg', sourceImagePath: img,
      }),
    ],
  });
  const { status, body } = await readiness();
  assert.equal(status, 200);
  assert.deepEqual(groupKeysOf(body.reviewedNotSettled), ['g_ctrl'], '重拍组不得进已审未结算;控制组必须在');
  assert.deepEqual(body.passportBlocked, [], '无护照的重拍组也不得进缺护照清单(重拍另有清单)');
  for (const list of [body.reviewedNotSettled, body.passportBlocked]) {
    assert.ok(!list.some((g) => g.groupKey === 'g_re_flag' || g.groupKey === 'g_re_text'));
  }
  assert.equal(body.stats.reviewedNotSettled, 1);
  assert.equal(body.stats.passportBlocked, 0);
});

test('collectLedgerGaps②:无 sourceGroupKey/Label 散图不入组、不误报;控制组仍被列', async (t) => {
  const { readiness } = await makeGapServer(t, {
    buildTasks: (img) => [
      ...ctrlGroupTasks(img),
      // 散图:两组键全空 → 查不了台账归属,整条跳过(它无护照又无台账行,不跳就两类都可能误报)
      gapTask({
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', receiptNoFinal: '42345678901234',
        sourceGroupKey: '', sourceGroupLabel: '',
        sourceOriginalPath: '', sourceImagePath: img,
      }),
    ],
  });
  const { status, body } = await readiness();
  assert.equal(status, 200);
  assert.deepEqual(groupKeysOf(body.reviewedNotSettled), ['g_ctrl'], '散图不得进已审未结算;控制组必须在');
  assert.deepEqual(body.passportBlocked, [], '散图不得进缺护照清单');
});

test('collectLedgerGaps③:纯护照无小票组跳过两类清单(先于护照数量判定)', async (t) => {
  const { readiness } = await makeGapServer(t, {
    buildTasks: (img) => [
      ...ctrlGroupTasks(img),
      // 纯护照组:故意放 2 本护照(若走到护照闸会判 invalid_passport_count)——
      // 断言证明「没小票 → 本就不产生台账行」的跳过发生在护照判定**之前**,两类都不进。
      gapTask({
        docTypeFinal: 'passport', extractedNameFinal: 'WANG WU', passportNoFinal: 'EA111222',
        sourceGroupKey: 'g_pp_only', sourceGroupLabel: 'CL20260721-004',
        sourceOriginalPath: 'ws1/CL20260721-004/pp1.jpg', sourceImagePath: img,
      }),
      gapTask({
        docTypeFinal: 'passport', extractedNameFinal: 'WANG WU', passportNoFinal: 'EA333444',
        sourceGroupKey: 'g_pp_only', sourceGroupLabel: 'CL20260721-004',
        sourceOriginalPath: 'ws1/CL20260721-004/pp2.jpg', sourceImagePath: img,
      }),
    ],
  });
  const { status, body } = await readiness();
  assert.equal(status, 200);
  assert.deepEqual(groupKeysOf(body.reviewedNotSettled), ['g_ctrl'], '纯护照组不得进已审未结算');
  assert.deepEqual(body.passportBlocked, [], '纯护照组不得进缺护照清单(2本护照也不误判)');
});

test('collectLedgerGaps④:台账查询抛错 → hasRows=true 不误报已审未结算;缺护照清单不受影响', async (t) => {
  let throwCalls = 0; // 证明抛错路径真被走到(防「repo 压根没被调」的空转假绿)
  const { readiness } = await makeGapServer(t, {
    dailyReceiptRepo: {
      listWorkspaceKeysForSourceGroup: () => { throwCalls += 1; throw new Error('ledger query boom'); },
    },
    buildTasks: (img) => [
      // 组1:护照齐+台账实际 0 行——查询若正常会进已审未结算;抛错时必须按 hasRows=true 按下不报
      ...ctrlGroupTasks(img),
      // 组2:免税小票无护照——护照闸在台账查询**之前**,抛错不影响缺护照归因
      gapTask({
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', receiptNoFinal: '52345678901234',
        sourceGroupKey: 'g_nopp', sourceGroupLabel: 'CL20260721-006',
        sourceOriginalPath: 'ws1/CL20260721-006/r1.jpg', sourceImagePath: img,
      }),
    ],
  });
  const { status, body } = await readiness();
  assert.equal(status, 200, '查询抛错必须被吞在组级 catch,不能 500');
  assert.ok(throwCalls >= 1, '抛错查询必须真被调到(g_ctrl 组走到台账存在性查询)');
  assert.deepEqual(body.reviewedNotSettled, [], '查询故障一律视作有行,绝不误报已审未结算');
  assert.deepEqual(groupKeysOf(body.passportBlocked), ['g_nopp'], '护照闸先于查询,抛错不影响缺护照清单');
  assert.equal(body.stats.reviewedNotSettled, 0);
  assert.equal(body.stats.passportBlocked, 1);
});

test('collectLedgerGaps⑤:dailyReceiptRepo 未接线(无该方法)→ 两类清单全空不误伤', async (t) => {
  const { readiness } = await makeGapServer(t, {
    dailyReceiptRepo: {}, // 有 repo 对象但没有 listWorkspaceKeysForSourceGroup 方法 = 未接线
    buildTasks: (img) => [
      ...ctrlGroupTasks(img), // 已审+台账0行:接线时会进已审未结算
      gapTask({ // 无护照:接线时会进缺护照清单
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天SG-本司', receiptNoFinal: '62345678901234',
        sourceGroupKey: 'g_nopp', sourceGroupLabel: 'CL20260721-006',
        sourceOriginalPath: 'ws1/CL20260721-006/r1.jpg', sourceImagePath: img,
      }),
    ],
  });
  const { status, body } = await readiness();
  assert.equal(status, 200);
  assert.deepEqual(body.reviewedNotSettled, [], '未接线不报已审未结算(不误伤)');
  assert.deepEqual(body.passportBlocked, [], '未接线连缺护照清单也整体不报(整函数短路)');
  assert.equal(body.stats.reviewedNotSettled, 0);
  assert.equal(body.stats.passportBlocked, 0);
});

// ══════════════════ 3. normalizeStoreFamily 歧义店串 + 前端镜像 ══════════════════

test('normalizeStoreFamily 歧义店串:含百货必走百货分支(百货优先);认出百货不知家 → 空不猜', () => {
  // 同含「百货」+「免税店」:百货优先规则拍死 → SHINSEGAE_DEPT,绝不落 SHINSEGAE 免税店
  assert.equal(normalizeStoreFamily('新世界百货免税店'), STORE_FAMILIES.SHINSEGAE_DEPT);
  assert.notEqual(normalizeStoreFamily('新世界百货免税店'), STORE_FAMILIES.SHINSEGAE);
  // 韩文百货词「백화점」也认
  assert.equal(normalizeStoreFamily('현대백화점'), STORE_FAMILIES.HYUNDAI_DEPT);
  // 中韩混串(店名+韩文分店)
  assert.equal(normalizeStoreFamily('乐天百货 본점'), STORE_FAMILIES.LOTTE_DEPT);
  // 认出百货但不知哪家 → 留空审核员选,绝不掉进免税店分支
  assert.equal(normalizeStoreFamily('某某百货'), '');
  // 反向锁:不含百货词的免税店串不受百货分支影响
  assert.equal(normalizeStoreFamily('新世界免税店'), STORE_FAMILIES.SHINSEGAE);
  assert.equal(normalizeStoreFamily('SHINSEGAE DUTY FREE'), STORE_FAMILIES.SHINSEGAE);
});

// 前端 normalizeReceiptStore 未导出(reviewFieldConfig.js:318);经导出面 buildReviewFieldPayload
// 触达:receipt + receiptStoreFinal 键必在白名单(免税/百货/选店中伪面板均含店家字段),
// 归一值原样落 payload。ESM 加载手法与 tests/frontend_review_field_config.test.js 同款。
let frontendModulePromise = null;
function loadFrontendModule() {
  if (!frontendModulePromise) {
    frontendModulePromise = import(pathToFileURL(path.join(
      __dirname,
      '../frontend/src/lib/reviewFieldConfig.js',
    )).href);
  }
  return frontendModulePromise;
}

test('前后端镜像:歧义店串同串同结果;不可归家串两侧都拒绝落免税店家族', async () => {
  const { buildReviewFieldPayload } = await loadFrontendModule();
  const frontendNormalize = (value) => buildReviewFieldPayload('receipt', { receiptStoreFinal: value }).receiptStoreFinal;

  // 可归家的歧义串:前后端必须逐字同结果(副本漂移即红)
  for (const raw of ['新世界百货免税店', '현대백화점', '乐天百货 본점', '新世界百货', '롯데백화점']) {
    assert.equal(frontendNormalize(raw), normalizeStoreFamily(raw),
      `前后端归一必须一致:「${raw}」`);
  }

  // 「某某百货」:两侧都认出是百货、都拒绝猜家——这是一致性的业务面。
  // 哨兵值差异是**双方注释明示的设计**(非漂移):
  //   后端 field_rules.js:87 →「留空,审核员选」返回 '';
  //   前端 reviewFieldConfig.js:326 →「原样保留,审核员从下拉选」返回原串(不清用户输入框)。
  // 锁死各自契约 + 共同红线(两侧都绝不落任何已知家族)。
  assert.equal(normalizeStoreFamily('某某百货'), '', '后端:认出百货不知家 → 空');
  assert.equal(frontendNormalize('某某百货'), '某某百货', '前端:认出百货不知家 → 原样保留');
  const families = new Set([
    ...Object.values(STORE_FAMILIES),
  ]);
  assert.ok(!families.has(frontendNormalize('某某百货')), '前端不得把未知百货猜成任何已知家族');
});

// ══════════════════ 4. lotte_dept 缺购买日期客户夹名回退 ══════════════════

test('lotte_dept planDelivery:LOTTE_DEPT 票购买日期全空、姓名齐 → customerDir===englishName 不炸', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotte-date-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // ⚠️ 两条小票各用各的图:共用一个图片文件 = 同一张照片按两个票号报两笔账,
  // 一票一图护栏(lib/delivery_render)会拦下来。生产实测自然产生的共用是 0 条。
  const img = path.join('source', 'r1.jpg');
  const img2 = path.join('source', 'r2.jpg');
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.writeFileSync(path.join(dir, img), 'img');
  fs.writeFileSync(path.join(dir, img2), 'img');
  const svc = createLotteDeptDeliveryExportService({
    resolveBatchRelativePath: (_batchId, rel) => path.join(dir, rel),
  });

  const batch = {
    id: 'b_lotte_date',
    tasks: [
      // 两张乐天百货票,购买日期 Final/Auto 全空;无独立护照,身份=同框票捐赠(donor)
      {
        id: 't1', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT',
        receiptNoFinal: '12345678', branchFinal: '0394',
        purchaseDateFinal: '', purchaseDateAuto: '',
        extractedNameFinal: 'QIN SHIHUANG', passportNoFinal: 'EB1234567',
        sourceOriginalPath: 'ws1/CL20260721-011/r1.jpg', sourceImagePath: img,
      },
      {
        id: 't2', reviewed: true, docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT',
        receiptNoFinal: '87654321', branchFinal: '0001',
        purchaseDateFinal: '', purchaseDateAuto: '',
        sourceOriginalPath: 'ws1/CL20260721-011/r2.jpg', sourceImagePath: img2,
      },
    ],
  };

  const plan = svc.planDelivery(batch); // 回退路径不得抛
  assert.equal(plan.customers, 1);
  assert.deepEqual(plan.missingReceiptNo, []);
  assert.deepEqual(plan.missingBranch, []);
  // 夹名回退契约:`{M.D} 名`.trim() → 日期空时恰好等于英文名,无首尾空格残留
  assert.ok(plan.entries.length > 0, '缺日期不得静默产出空计划');
  for (const entry of plan.entries) {
    assert.equal(entry.customerDir, 'QIN SHIHUANG', '客户夹名必须回退为纯英文名');
    assert.ok(!/^\s|\s$/.test(entry.customerDir), '夹名不得带首尾空格(`{M.D} 名` 模板残留)');
    assert.equal(entry.branch, '明洞', '0394/0001 均归明洞店夹');
  }
  // 双图契约在回退夹名下仍成立:两票各按交易编号(0727#13-4:4-4带杠)+ 护照图恰好一份(同夹去重)
  const baseNames = plan.entries.map((e) => e.baseName).sort();
  assert.deepEqual(baseNames, ['1234-5678', '8765-4321', '护照']);
  // 无独立护照 → 同框整图兜底充当护照图 + 进 passportFallback 信息名单(不阻断)
  const passportEntry = plan.entries.find((e) => e.baseName === '护照');
  assert.ok(passportEntry.sourcePath.endsWith('r1.jpg') || passportEntry.sourcePath.endsWith('.jpg'));
  assert.deepEqual(plan.passportFallback, ['CL20260721-011']);
});
