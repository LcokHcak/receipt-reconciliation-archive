'use strict';

/**
 * 点1 · 模式别名 aliases 归一链边界锁定(2026-07-21 配置台↔审核↔导出链路排查)。
 *
 * 链路事实(源码实证,本测试逐条锁死):
 *   - 归一单源 = lib/mode_record_matrix.js:normalizeModeName(:81 剥尾部括号/「不用记(录)」/折叠大小写)
 *     + MODE_ALIASES 静态桥(:99)+ resolveCanonicalModeName(:176)。
 *     配置台 payload.aliases(scripts/seed_factory_config.js:37)只是**展示用**,运行时归一不读它。
 *   - 台账 mode_raw 存**团号表原串**(裸串):tour_match_service.js:377-396 `modeRaw = gc.mode || ...`
 *     原样落列;预匹配 task.modeRawPre 同为原串(group_code_prematch_service.js:176)。
 *   - 三处消费:
 *     ① DSL 导出计划 scope:引擎 lib/export_plan_engine.js:218-221(A4 修复,双侧归一)
 *        + 路由 routes/library_delivery_routes.js:101/116-118/126/357-361(canonicalMode/batchCanonicalModes)
 *        + Excel 计划行过滤 workbench_server.js:1409-1412(拉全月 JS 归一过滤;装配闭包,本文件不直测)
 *     ② 资料库切片选择器/计数:services/monthly/library_mode_export_service.js:161-172(listModeSummary
 *        按裸串 GROUP BY)/:340(buildWorkbook 按裸串分 sheet)——**不归一**,与①口径不同 → [非对称留档]
 *     ③ 台账桥/导出查规则:lib/workbench_receipt_export.js:228(resolveTaskModeRule 返回**原串** mode)
 *        → lookupModeRecordRule(mode_record_matrix.js:155)内部归一(出厂 BY_NAME / 运行时
 *        mode_config_resolver.js:126 resolveCanonicalModeName)——规则命中归一,尾巴语义按原串现算。
 *
 * 只锁现行为,不改源码;不一致处用 [非对称留档] 标注在用例名里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const {
  lookupModeRecordRule,
  resolveCanonicalModeName,
  setModeRuleResolver,
} = require('../lib/mode_record_matrix');
const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createModeConfigResolver } = require('../services/mode_config_resolver');
const { resolveExportPlan } = require('../lib/export_plan_engine');
const { createLibraryDeliveryRoutes } = require('../routes/library_delivery_routes');
const { createModeDeliveryExportService } = require('../services/mode_delivery_export_service');
const { createHyundaiDeliveryExportService } = require('../services/hyundai_delivery_export_service');
const { createLotteDeptDeliveryExportService } = require('../services/lotte_dept_delivery_export_service');
const { createBatchCustomerDataExportService } = require('../services/batch_customer_data_export_service');
const { createLibraryModeExportService } = require('../services/monthly/library_mode_export_service');

const ALL_COLUMNS = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});

// ══════════════ A · 归一层(消费③:lookupModeRecordRule / resolveCanonicalModeName)══════════════

test('A1 别名桥:表侧拼写「乐天H团-本司（原乐天V-本司）」归一命中正名规则(MODE_ALIASES)', () => {
  const viaAlias = lookupModeRecordRule('乐天H团-本司（原乐天V-本司）');
  assert.equal(viaAlias.known, true, '别名串应命中矩阵');
  assert.equal(viaAlias.mode, '乐天H团（原乐天V）-本司', '规则挂正名(名字中间括号是本体,不剥)');
  assert.equal(viaAlias.receiptNoForm, 'digits14');
  // 两种拼写归一到同一正名 → ①scope/③规则查询同串同判的前提
  assert.equal(
    resolveCanonicalModeName('乐天H团-本司（原乐天V-本司）'),
    resolveCanonicalModeName('乐天H团（原乐天V）-本司'),
  );
});

test('A2 尾巴串矩阵:「不用记」/全半角括号备注/小写字母都归一命中;尾巴语义按原串现算', () => {
  // 「济州新罗SG-道辉 不用记」:剥空白+「不用记」→ 命中 SLIM 简记;noRecord 语义保留
  const noRecord = lookupModeRecordRule('济州新罗SG-道辉 不用记');
  assert.equal(noRecord.known, true);
  assert.equal(noRecord.mode, '济州新罗SG-道辉');
  assert.equal(noRecord.noRecord, true, '「不用记」尾巴=导出层跳行语义,按原串现算');
  assert.equal(noRecord.columns.receiptNo, false, '命中 SLIM 简记(不是跌默认全记)');
  assert.equal(resolveCanonicalModeName('济州新罗SG-道辉 不用记'), '济州新罗SG-道辉');

  // 全角括号尾巴:剥掉命中 + 尾巴动作转语义
  const suffixed = lookupModeRecordRule('乐天SG-本司（发小票17）');
  assert.equal(suffixed.known, true);
  assert.equal(suffixed.receiptNoForm, 'digits14');
  assert.ok(suffixed.actions.includes('及时发上家'), '发小票17 尾巴 → 及时发上家(29ac3ec 统一文案)');

  // 半角括号统一到全角再剥(normalizeModeName :85)
  assert.equal(resolveCanonicalModeName('乐天SG-本司(发小票17)'), '乐天SG-本司');

  // ASCII 小写折叠(生产团号表 251 行「爱宝客pkg-本司」实锤)
  assert.equal(lookupModeRecordRule('爱宝客pkg-本司').receiptNoForm, 'digits13');
  assert.equal(resolveCanonicalModeName('爱宝客pkg-本司'), '爱宝客PKG-本司');
});

test('A3 [非对称留档] 裸尾巴(无括号、非「不用记」)不剥:同语义两种写法吃两套列配置', () => {
  // 带括号写法:剥掉命中 SLIM 简记
  const withParen = lookupModeRecordRule('济州乐天SG-道辉（单独整理）');
  assert.equal(withParen.known, true);
  assert.equal(withParen.columns.receiptNo, false, '命中矩阵 SLIM(只记 收票日期/代理/团号)');
  assert.ok(withParen.actions.includes('按团号单独整理'));

  // 裸尾巴写法:normalizeModeName 只剥「尾部括号」与「不用记(录)」,裸「单独整理」不剥 → 查矩阵落空
  const bare = lookupModeRecordRule('济州乐天SG-道辉 单独整理');
  assert.equal(bare.known, false, '裸尾巴不剥 → 跌默认(未知模式=普通模式全记)');
  assert.equal(bare.columns.receiptNo, true, '默认全记:列配置与带括号写法分家');
  assert.ok(bare.actions.includes('按团号单独整理'), '尾巴动作仍按原串现算(语义没丢,列配置丢了)');
  // 归一名也分家 → DSL scope/切片会把两种写法当两个模式(留档:29ac3ec 尾巴规则只覆盖括号与不用记)
  assert.notEqual(resolveCanonicalModeName('济州乐天SG-道辉 单独整理'), '济州乐天SG-道辉');
});

test('A4 运行时配置(配置台)按正名命中:带尾巴/别名串照吃同一条 DB 配置,「不用记」仍按原串现算', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-chain-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const resolver = createModeConfigResolver({
    modeConfigRepository: repository,
    logger: { warn: () => {}, info: () => {} },
  });
  t.after(() => {
    setModeRuleResolver(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 配置存在**正名**名下(config_console_routes.js:195 保存名一律 resolveCanonicalModeName)
  repository.saveNewVersion({
    kind: 'mode',
    name: '济州新罗SG-道辉',
    payload: { columns: { ...ALL_COLUMNS }, receiptNoForm: 'digits13' }, // 故意与出厂(SLIM/无形态)不同
  });
  setModeRuleResolver(resolver.getModeRecordRule);

  // 团号表原串(带尾巴)查询 → mode_config_resolver.js:126 归一到正名命中配置
  const rule = lookupModeRecordRule('济州新罗SG-道辉 不用记');
  assert.equal(rule.configVersion, 1, '带尾巴原串必须命中正名名下的 DB 配置');
  assert.equal(rule.receiptNoForm, 'digits13', '配置覆盖出厂');
  assert.equal(rule.columns.receiptNo, true, '配置列覆盖出厂 SLIM');
  assert.equal(rule.noRecord, true, '「不用记」语义仍按原串现算(composeModeRule 单一份)');

  // 静态别名桥同吃(乐天H团系,mode_config_resolver.test 已锁;这里补带尾巴叠加别名)
  repository.saveNewVersion({
    kind: 'mode',
    name: '乐天H团（原乐天V）-本司',
    payload: { columns: { ...ALL_COLUMNS }, receiptNoForm: 'digits14' },
  });
  const aliasTail = lookupModeRecordRule('乐天H团-本司（原乐天V-本司）不用记');
  assert.equal(aliasTail.configVersion, 1, '别名+尾巴叠加也命中正名配置');
  assert.equal(aliasTail.noRecord, true);
});

// ══════════════ B · DSL 引擎 scope(消费①a:export_plan_engine A4 双侧归一)══════════════

const DSL_PLAN = Object.freeze({
  planLabel: '别名域计划',
  levels: [{ template: '{groupNo}' }],
  naming: { template: '{docLabel}{i}' },
  includes: ['receipt'],
  emptyPolicy: 'block_prefix',
});

function makeAliasGroup(modeRawPre, customerId = 'CL20260721-001') {
  return {
    customerId,
    tasks: [{
      id: `r_${customerId}`,
      docTypeFinal: 'receipt',
      reviewed: true,
      groupNoFinal: '26140001',
      modeRawPre,
      sourcePath: 'b/r1.jpg',
    }],
  };
}

test('B1 scope 配正名 × 任务 modeRawPre=别名串 → 归一命中(A4 修复行为);{mode} 渲染仍是原串', () => {
  const plan = { ...DSL_PLAN, scope: { modes: ['乐天H团（原乐天V）-本司'] } };
  const out = resolveExportPlan(plan, [makeAliasGroup('乐天H团-本司（原乐天V-本司）')]);
  assert.equal(out.skipped.length, 0, '别名串票不得漏出 scope');
  assert.equal(out.entries.length, 1);

  // [非对称留档] scope 判定归一,但 {mode} token 渲染的是任务原串(export_plan_engine.js:97
  // resolveTaskModeRule(task).mode=原串)——别名拼写会原样进夹名,与按正名配的 scope 名不同形
  const modePlan = { ...DSL_PLAN, scope: { modes: ['乐天H团（原乐天V）-本司'] }, levels: [{ template: '{mode}' }] };
  const rendered = resolveExportPlan(modePlan, [makeAliasGroup('乐天H团-本司（原乐天V-本司）')]);
  assert.equal(rendered.entries.length, 1);
  assert.match(rendered.entries[0].destPath, /^乐天H团-本司（原乐天V-本司）\//, '{mode} 夹名=任务原串(裸串展示,判定归一)');
});

test('B2 scope 配正名 × 任务 modeRawPre=带尾巴串(「不用记」)→ 归一命中', () => {
  const plan = { ...DSL_PLAN, scope: { modes: ['济州新罗SG-道辉'] } };
  const out = resolveExportPlan(plan, [makeAliasGroup('济州新罗SG-道辉 不用记')]);
  assert.equal(out.skipped.length, 0);
  assert.equal(out.entries.length, 1);
});

test('B3 反向:scope 配别名串/带尾巴串 × 任务 modeRawPre=正名 → 同样命中(scope 侧也归一)', () => {
  const aliasScope = { ...DSL_PLAN, scope: { modes: ['乐天H团-本司（原乐天V-本司）'] } };
  const viaAlias = resolveExportPlan(aliasScope, [makeAliasGroup('乐天H团（原乐天V）-本司')]);
  assert.equal(viaAlias.entries.length, 1, 'scope 写别名拼写也认正名票');

  const tailScope = { ...DSL_PLAN, scope: { modes: ['济州新罗SG-道辉 不用记'] } };
  const viaTail = resolveExportPlan(tailScope, [makeAliasGroup('济州新罗SG-道辉')]);
  assert.equal(viaTail.entries.length, 1, 'scope 写带尾巴串也认正名票');
});

test('B4 负例:真不同模式仍出 scope(归一不误吞——S活动是独立矩阵模式,不是尾巴)', () => {
  const plan = { ...DSL_PLAN, scope: { modes: ['乐天SG-本司'] } };
  const out = resolveExportPlan(plan, [makeAliasGroup('乐天SG-S活动')]);
  assert.equal(out.entries.length, 0);
  assert.equal(out.skipped[0].reason, '模式不在计划范围');
});

// ══════════════ C · 路由 applicable/计数(消费①b:library_delivery_routes 归一)══════════════

const LEDGER_TABLE_SQL = `CREATE TABLE daily_receipt_export (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT, source_customer_id TEXT, source_batch_id TEXT, mode_raw TEXT,
  purchase_date TEXT, tour_no TEXT, name TEXT, passport_no TEXT, receipt_no TEXT,
  agent TEXT, upstream TEXT, shop TEXT, branch TEXT, brand TEXT, qty INTEGER,
  gross_krw INTEGER, net_krw INTEGER, customer_rebate INTEGER, departure_date TEXT, imported_at TEXT
)`;

async function makeDeliveryServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-routes-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  db.exec(LEDGER_TABLE_SQL);
  const repository = createModeConfigRepository({ db });

  const mkImg = (rel) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'img');
    return rel;
  };
  // plansCache 是模块级 Map(routes 文件顶层),批次 id 必须每次唯一,防跨用例串缓存
  const batch = {
    id: `batch_alias_${path.basename(dir)}`,
    name: '260721-别名域',
    ownerUsername: 'op1',
    tasks: [
      { // 客户1:别名拼写票
        id: 'task_0001', reviewed: true, docTypeFinal: 'receipt',
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天H团-本司（原乐天V-本司）',
        groupNoFinal: '26140001', receiptNoFinal: '12345678901234',
        sourceGroupKey: 'g_1', sourceGroupLabel: 'CL20260721-001',
        sourceOriginalPath: 'ws1/CL20260721-001/r1.jpg', sourceImagePath: mkImg('source/r1.jpg'),
      },
      { // 客户2:正名拼写票
        id: 'task_0002', reviewed: true, docTypeFinal: 'receipt',
        receiptStoreFinal: 'LOTTE', modeRawPre: '乐天H团（原乐天V）-本司',
        groupNoFinal: '26140002', receiptNoFinal: '12345678901235',
        sourceGroupKey: 'g_2', sourceGroupLabel: 'CL20260721-002',
        sourceOriginalPath: 'ws1/CL20260721-002/r2.jpg', sourceImagePath: mkImg('source/r2.jpg'),
      },
    ],
  };

  const resolveBatchRelativePath = (_batchId, rel) => path.join(dir, rel);
  const hyundai = createHyundaiDeliveryExportService({ resolveBatchRelativePath });
  const app = express();
  app.use(express.json());
  createLibraryDeliveryRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'op1', role: 'reviewer' }; next(); } },
    deps: {
      loadBatch: (id) => (id === batch.id ? batch : null),
      modeDeliveryExportService: createModeDeliveryExportService({ resolveBatchRelativePath, hyundaiDeliveryExportService: hyundai }),
      lotteDeptDeliveryExportService: createLotteDeptDeliveryExportService({ resolveBatchRelativePath }),
      hyundaiDeliveryExportService: hyundai,
      batchCustomerDataExportService: createBatchCustomerDataExportService({
        customerLibraryRepository: { resolveCustomerDir: () => '' },
        resolveBatchRelativePath,
      }),
      libraryModeExportService: createLibraryModeExportService({ db }),
      resolveBatchRelativePath,
      dailyReceiptRepo: { listWorkspaceKeysForSourceGroup: () => [] },
    },
  }).register(app);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function call(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload };
  }
  return { call, repository, batchId: batch.id };
}

test('C1 delivery-plans applicable/计数双侧归一;modesInBatch 清单是裸串 [非对称留档]', async (t) => {
  const { call, repository, batchId } = await makeDeliveryServer(t);
  const dslPayload = (modes) => ({
    planLabel: 'x', scope: { modes },
    levels: [{ template: '{groupNo}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  });
  // 三个计划:正名 scope / 别名 scope / 域外负例
  repository.saveNewVersion({ kind: 'export_plan', name: '别名正向', createdBy: 't', payload: dslPayload(['乐天H团（原乐天V）-本司']) });
  repository.saveNewVersion({ kind: 'export_plan', name: '别名反向', createdBy: 't', payload: dslPayload(['乐天H团-本司（原乐天V-本司）']) });
  repository.saveNewVersion({ kind: 'export_plan', name: '域外负例', createdBy: 't', payload: dslPayload(['现代-JEOCU']) });

  const { status, body } = await call('GET', `/api/library/delivery-plans?batchId=${batchId}`);
  assert.equal(status, 200);

  // [非对称留档] 切片选择器供货清单 modesInBatch=任务原串:同一正名两拼写出现两条
  // (batchModes :107-114 收原串;归一只发生在 applicable/计数比对,展示层裸串)
  assert.deepEqual(
    [...body.modesInBatch].sort(),
    ['乐天H团-本司（原乐天V-本司）', '乐天H团（原乐天V）-本司'].sort(),
  );

  const p1 = body.plans.find((p) => p.name === '别名正向');
  assert.equal(p1.applicable, true, 'scope 正名 × 批次别名串 → 归一后应命中(:357-360)');
  assert.equal(p1.stats.customers, 2, '两种拼写的客户都计入(countBatchCustomers :126 双侧归一)');

  const p2 = body.plans.find((p) => p.name === '别名反向');
  assert.equal(p2.applicable, true, 'scope 别名串 × 批次正名票 → 同样命中');
  assert.equal(p2.stats.customers, 2);

  const p3 = body.plans.find((p) => p.name === '域外负例');
  assert.equal(p3.applicable, false, '真不同模式不误吞');
  assert.equal(p3.stats.customers, 0);
});

// ══════════════ D · 资料库切片/计数(消费②:library_mode_export 裸串粒度)══════════════

function makeLibraryDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-lib-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  db.exec(LEDGER_TABLE_SQL);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const insert = db.prepare(`INSERT INTO daily_receipt_export
    (workspace_key, source_batch_id, source_customer_id, mode_raw, purchase_date, tour_no, name, passport_no, receipt_no, agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return { db, insert };
}

test('D1 [非对称留档] 切片选择器/计数按裸串 GROUP BY:同一正名两拼写分成两片(不归一,与①口径分裂)', (t) => {
  const { db, insert } = makeLibraryDb(t);
  // 台账 mode_raw=团号表原串(tour_match_service.js:377 gc.mode 原样落列)——正名与带尾巴两拼写
  insert.run('2026-07', 'b1', 'g_1', '济州新罗SG-道辉', '2026-07-01', '71001', 'ZHANG SAN', 'EA1234567', '111', '道辉');
  // 用「（发小票17）」而非「不用记」当第二拼写:「不用记」已是导出层过滤标记(2026-07-24 拍板整表剔除),
  // 会被 buildWorkbook 过滤掉、无法再验证"按裸串分片";（发小票17）同样归一到正名但不触发过滤。
  insert.run('2026-07', 'b1', 'g_2', '济州新罗SG-道辉（发小票17）', '2026-07-02', '71002', 'LI SI', 'EA7654321', '222', '道辉');
  const svc = createLibraryModeExportService({ db });

  // 两拼写归一后同一正名(证明这确实是"同一模式的两写法",不是两个模式)
  assert.equal(
    resolveCanonicalModeName('济州新罗SG-道辉（发小票17）'),
    resolveCanonicalModeName('济州新罗SG-道辉'),
  );

  // 现行为:listModeSummary 按裸串分片(:161-172 GROUP BY mode_raw)→ 两片各 1 票,不合并
  const modes = svc.listModeSummary({ workspaceKey: '2026-07' });
  assert.equal(modes.length, 2, '[非对称留档] 切片按裸串:同一正名两拼写=两片(DSL scope/Excel 计划侧归一,此处不归一)');
  assert.deepEqual(
    modes.map((m) => m.mode).sort(),
    ['济州新罗SG-道辉', '济州新罗SG-道辉（发小票17）'].sort(),
  );
  assert.ok(modes.every((m) => m.receipts === 1 && m.customers === 1));

  // buildWorkbook 同粒度:汇总 sheet(2026-07-27 需求F③新增,固定第一页)+ 每裸串一 sheet + 需重拍 sheet = 4
  // 本条断言的是"按裸串分片"这一口径:汇总页是额外新增的整批视图,不改分片粒度。
  const workbook = svc.buildWorkbook({ workspaceKey: '2026-07' });
  assert.equal(workbook.worksheets.length, 4, '汇总 + 两裸串 sheet + 需重拍 sheet');
  assert.equal(workbook.worksheets[0].name, svc.SUMMARY_SHEET);
  assert.deepEqual(
    workbook.worksheets.slice(1, 3).map((w) => w.name).sort(),
    ['济州新罗SG-道辉', '济州新罗SG-道辉（发小票17）'].sort(),
    '分片粒度不变:两拼写仍各自成页',
  );
});

test('D2 行级规则仍归一:带尾巴 mode_raw 行的小票号形态照吃正名规则(formatReceiptNoCell)', (t) => {
  const { db, insert } = makeLibraryDb(t);
  // 带尾巴串行:归一后=乐天SG-本司(digits14)→ 出口剥杠;切片虽按裸串,行内规则查找归一
  insert.run('2026-07', 'b1', 'g_1', '乐天SG-本司（发小票17）', '2026-07-01', '26141846', 'ZHANG SAN', 'EA1234567', '1234-5678901234', '本司');
  const svc = createLibraryModeExportService({ db });

  const workbook = svc.buildWorkbook({ workspaceKey: '2026-07' });
  const sheet = workbook.worksheets.find((ws) => ws.name === '乐天SG-本司（发小票17）');
  assert.ok(sheet, 'sheet 名=裸串(切片粒度)');
  // COLUMNS: 购买日期/收票日期/团号/姓名/护照号/小票号 → 小票号=第6列(2026-07-24 新增收票日期列后整体后移一位);digits14 → 剥杠纯数字
  assert.equal(sheet.getRow(2).getCell(6).value, '12345678901234', '行级 lookupModeRecordRule 归一命中 digits14(:94)');
});
