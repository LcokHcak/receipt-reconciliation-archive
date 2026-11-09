'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createConfigConsoleRoutes, buildModeConfigWarnings } = require('../routes/config_console_routes');
const { createLotteDeptDeliveryExportService } = require('../services/lotte_dept_delivery_export_service');
const { MATRIX } = require('../lib/mode_record_matrix');

const ALL_COLUMNS = Object.freeze({
  recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
  groupNo: true, name: true, passportNo: true, departureDate: true,
});

async function makeServer(t, { user = { username: 'boss', role: 'admin' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-routes-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const auditCalls = [];
  const state = { user };

  const app = express();
  app.use(express.json());
  createConfigConsoleRoutes({
    modeConfigRepository: repository,
    auditLogRepo: { log: (entry) => auditCalls.push(entry) },
    auth: {
      authenticateToken: (req, res, next) => {
        req.user = state.user;
        next();
      },
    },
    listGroupCodeModes: () => ['乐天SG-本司', '爱宝客pkg-本司', '野生新模式串（发小票17）', '野生新模式串', '乐天H团-本司（原乐天V-本司）'],
  }).register(app);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

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

  return { repository, auditCalls, state, call };
}

test('非 admin 一律 403(reviewer/操作员点不进配置台)', async (t) => {
  const { call, state } = await makeServer(t, { user: { username: 'op1', role: 'reviewer' } });
  assert.equal((await call('GET', '/api/admin/config/modes')).status, 403);
  assert.equal((await call('POST', '/api/admin/config/modes/乐天SG-本司', { payload: {} })).status, 403);
  state.user = { username: 'boss', role: 'admin' };
  assert.equal((await call('GET', '/api/admin/config/modes')).status, 200);
});

test('总览:出厂29条全列出;覆盖率只报"出厂和配置都不认识"的模式串(归一后去重)', async (t) => {
  const { call } = await makeServer(t);
  const { status, body } = await call('GET', '/api/admin/config/modes');
  assert.equal(status, 200);
  assert.equal(body.modes.length, MATRIX.length);
  assert.ok(body.modes.every((mode) => mode.source === 'factory' && mode.factory && !mode.config));
  // 乐天SG-本司/爱宝客pkg(小写归一)都在出厂 → 不在未配置名单;野生串两种写法归一成一条
  assert.equal(body.unconfigured.length, 1);
  assert.equal(body.unconfigured[0].name, '野生新模式串');
});

test('保存→生效→版本流水→回滚→停用 全链;乐观锁 409;坏 payload 400', async (t) => {
  const { call, repository, auditCalls } = await makeServer(t);

  // 坏 payload:硬校验 400 拒存
  const bad = await call('POST', '/api/admin/config/modes/乐天SG-本司', {
    payload: { columns: { ...ALL_COLUMNS, extra: true } },
  });
  assert.equal(bad.status, 400);

  // 保存 v1(带软警告:不记小票号列却配形态)
  const v1 = await call('POST', '/api/admin/config/modes/乐天SG-本司', {
    payload: { columns: { ...ALL_COLUMNS, receiptNo: false }, receiptNoForm: 'digits14' },
    note: '试关小票号列',
  });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.version, 1);
  assert.ok(v1.body.warnings.some((w) => w.includes('形态不会生效')));
  assert.equal(repository.getActive('mode', '乐天SG-本司').version, 1);

  // 保存 v2(基于 v1)
  const v2 = await call('POST', '/api/admin/config/modes/乐天SG-本司', {
    payload: { columns: { ...ALL_COLUMNS } },
    expectBaseVersion: 1,
  });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.version, 2);

  // 乐观锁:又有人基于 v1 保存 → 409 带当前版本
  const stale = await call('POST', '/api/admin/config/modes/乐天SG-本司', {
    payload: { columns: { ...ALL_COLUMNS } },
    expectBaseVersion: 1,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentVersion, 2);

  // 版本流水=修改日志
  const versions = await call('GET', '/api/admin/config/modes/乐天SG-本司/versions');
  assert.equal(versions.body.versions.length, 2);
  assert.equal(versions.body.versions[1].note, '试关小票号列');

  // 回滚到 v1;版本不存在 404
  assert.equal((await call('POST', '/api/admin/config/modes/乐天SG-本司/activate', { version: 1 })).status, 200);
  assert.equal(repository.getActive('mode', '乐天SG-本司').version, 1);
  assert.equal((await call('POST', '/api/admin/config/modes/乐天SG-本司/activate', { version: 99 })).status, 404);

  // 停用=回落出厂;总览显示回 factory
  assert.equal((await call('POST', '/api/admin/config/modes/乐天SG-本司/deactivate')).status, 200);
  assert.equal(repository.getActive('mode', '乐天SG-本司'), null);
  const overview = await call('GET', '/api/admin/config/modes');
  const row = overview.body.modes.find((mode) => mode.name === '乐天SG-本司');
  assert.equal(row.source, 'factory');

  // 全部写操作进审计
  const actions = auditCalls.map((entry) => entry.action);
  assert.ok(actions.includes('config_save'));
  assert.ok(actions.includes('config_rollback'));
  assert.ok(actions.includes('config_deactivate'));
});

test('乐观锁基版闸(审计HIGH line514):已有版本却省略 expectBaseVersion → 409,不再静默跳过乐观锁', async (t) => {
  const { call, repository } = await makeServer(t);
  const good = { columns: { ...ALL_COLUMNS } };

  // v1 全新创建:省略 expectBaseVersion 放行(base=0,无可覆盖),以 0 作基版
  const v1 = await call('POST', '/api/admin/config/modes/新罗SEOUL-测', { payload: good });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.version, 1);

  // v2 省略 expectBaseVersion:此前会跳过乐观锁直接新版+激活(绕过并发保护);现在 base=1>0 → 409
  const bypass = await call('POST', '/api/admin/config/modes/新罗SEOUL-测', { payload: good });
  assert.equal(bypass.status, 409, '已有版本却不带基版=绕过乐观锁,必须 409');
  assert.equal(bypass.body.currentVersion, 1);
  assert.equal(repository.getActive('mode', '新罗SEOUL-测').version, 1, '被拦下:未产生 v2');

  // 带正确基版则照常保存
  const v2 = await call('POST', '/api/admin/config/modes/新罗SEOUL-测', { payload: good, expectBaseVersion: 1 });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.version, 2);

  // 非法基版(负数/非整数)→ 400
  const badVer = await call('POST', '/api/admin/config/modes/新罗SEOUL-测', { payload: good, expectBaseVersion: -3 });
  assert.equal(badVer.status, 400);

  // 并发创建保护:两个客户都以 base=0 创建同一新实体,第二个应被 saveNewVersion 的乐观锁拦下
  const c1 = await call('POST', '/api/admin/config/modes/济州PKG-测', { payload: good });
  assert.equal(c1.status, 200);
  const c2 = await call('POST', '/api/admin/config/modes/济州PKG-测', { payload: good, expectBaseVersion: 0 });
  assert.equal(c2.status, 409, '第二个创建者基于已过期的 base=0 → 409(创建也受保护)');
});

test('配置台新建矩阵外模式:入总览(factory=null);名称按归一存', async (t) => {
  const { call } = await makeServer(t);
  const saved = await call('POST', '/api/admin/config/modes/野生新模式串（发小票17）', {
    payload: { modeLabel: '野生新模式串', columns: { ...ALL_COLUMNS } },
  });
  assert.equal(saved.status, 200);
  const overview = await call('GET', '/api/admin/config/modes');
  const row = overview.body.modes.find((mode) => mode.name === '野生新模式串');
  assert.ok(row);
  assert.equal(row.source, 'db');
  assert.equal(row.factory, null);
  // 配置后不再出现在未配置名单
  assert.equal(overview.body.unconfigured.length, 0);
});

test('软警告:百货模式勾团号列/收票日期代理全关', () => {
  assert.ok(buildModeConfigWarnings('乐天百货', { columns: { ...ALL_COLUMNS } })
    .some((w) => w.includes('百货模式无团号')));
  assert.ok(buildModeConfigWarnings('乐天SG-本司', {
    columns: { ...ALL_COLUMNS, recordDate: false, agent: false },
  }).some((w) => w.includes('难以溯源')));
  assert.equal(buildModeConfigWarnings('乐天SG-本司', { columns: { ...ALL_COLUMNS } }).length, 0);
});

test('别名写侧归一(复核HIGH#1):按别名保存落到矩阵正名,不造影子配置;覆盖率不推荐别名串', async (t) => {
  const { call, repository } = await makeServer(t);

  // 覆盖率:别名串 ×10141 归一到正名(在出厂)→ 不出现在未配置名单
  const overview = await call('GET', '/api/admin/config/modes');
  assert.ok(!overview.body.unconfigured.some((item) => item.name.includes('乐天H团')));

  // 按别名保存 → 存到正名名下
  const saved = await call('POST', '/api/admin/config/modes/乐天H团-本司（原乐天V-本司）', {
    payload: { columns: {
      recordDate: true, agent: true, purchaseDate: true, receiptNo: true,
      groupNo: true, name: true, passportNo: true, departureDate: true,
    }, receiptNoForm: 'digits14' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, '乐天H团（原乐天V）-本司');
  assert.ok(repository.getActive('mode', '乐天H团（原乐天V）-本司'));
  assert.equal(repository.getActive('mode', '乐天H团-本司'), null); // 没有影子
});

// ── P2:导出计划端点 ──────────────────────────────────────────────
const DSL_PLAN = Object.freeze({
  planLabel: '按团号整理',
  scope: { modes: [] },
  levels: [{ template: '{groupNo}' }],
  naming: { template: '{docLabel}{i}' },
  includes: ['receipt'],
  emptyPolicy: 'block_prefix',
});

async function makePlanServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-routes-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const app = express();
  app.use(express.json());
  const fakeBatch = {
    id: 'batch_x',
    tasks: [
      // 同一客户两张(CL 客户库编号=分组键;复核HIGH后按客户分组)
      { id: 'r1', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '26140001', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r1.jpg' },
      { id: 'r2', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '26140001', sourceFolderName: 'CL20260714-001', sourceImagePath: 'r2.jpg' },
      // 另一客户,同上传夹、**无团号**:绝不能借到别人的 26140001,应进 blocked(空值护栏)
      { id: 'r9', docTypeFinal: 'receipt', reviewed: true, groupNoFinal: '', groupNoAuto: '', sourceFolderName: 'CL20260714-002', sourceImagePath: 'r9.jpg' },
    ],
  };
  // 乐天预览走**真实服务**(2026-07-20 复核HIGH教训:mock 手写 missingPassport 形状与真服务
  // 分叉+该分支零覆盖 → 服务改形状路由必崩没测出;真实服务防再次失步)
  const fakeLotteBatch = {
    id: 'batch_lotte',
    tasks: [
      // 无独立护照的乐天百货客户(拍板a:同框整图兜底,不阻断)
      { id: 'lr1', docTypeFinal: 'receipt', reviewed: true, receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '12345678', branchFinal: '0394', purchaseDateFinal: '2026-07-01', extractedNameFinal: 'WANG YI', passportNoFinal: 'EB2345678', sourceGroupKey: 'CL20260720-041', sourceOriginalPath: '2607/CL20260720-041/x.jpg', sourceImagePath: 'lr1.jpg' },
      // 缺门店 → 仍是阻断类
      { id: 'lr2', docTypeFinal: 'receipt', reviewed: true, receiptStoreFinal: 'LOTTE_DEPT', receiptNoFinal: '87654321', branchFinal: '', purchaseDateFinal: '2026-07-02', extractedNameFinal: 'LI LEI', sourceGroupKey: 'CL20260720-042', sourceOriginalPath: '2607/CL20260720-042/x.jpg', sourceImagePath: 'lr2.jpg' },
    ],
  };
  // DSL 预览要求 sourcePath 真实存在:指到本测试文件自身(statSync isFile ✓)
  createConfigConsoleRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'boss', role: 'admin' }; next(); } },
    previewDeps: {
      loadBatch: (id) => (id === 'batch_x' ? fakeBatch : (id === 'batch_lotte' ? fakeLotteBatch : null)),
      resolveBatchRelativePath: () => __filename,
      modeDeliveryExportService: {
        planModeDelivery: () => ({
          files: [{ dir: '济州新罗SG-道辉/26141001', baseName: 'X_小票1', sourcePath: 'a.jpg' }],
          skippedUnreviewed: ['CL9'],
          missingSActivityReceiptNo: ['S活动:CL2/t1'],
          missingDeptTransNo: ['百货:CL3/t2'],
          missingHyundaiReceiptNo: [],
        }),
      },
      lotteDeptDeliveryExportService: createLotteDeptDeliveryExportService({ resolveBatchRelativePath: () => __filename }),
    },
  }).register(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload };
  }
  return { call, repository };
}

test('导出计划:未seed也列出内置虚行;DSL保存入库并出现在列表;坏计划400', async (t) => {
  const { call } = await makePlanServer(t);
  const list0 = await call('GET', '/api/admin/config/export-plans');
  assert.equal(list0.status, 200);
  // 2026-07-16 资料库P0:收编三老出口后内置=5(注册表 lib/export_plan_registry 单源)
  assert.equal(list0.body.plans.filter((p) => p.kindType === 'builtin').length, 5);
  assert.ok(list0.body.plans.every((p) => p.source === 'factory'));
  // 既有两条逐字段不变(收编=只加行,零变化红线)
  const four = list0.body.plans.find((p) => p.name === '内置·多模式四规则');
  assert.equal(four.label, '内置·多模式四规则(济州道辉/现代三池/S活动双份/百货上家链/未归类)');
  // 2026-07-20 百货交付重构:规则⑤ 新世界/现代百货上家链入册 → 4+1=5
  assert.equal(four.rulesSpec.rules.length, 5);
  const lotte = list0.body.plans.find((p) => p.name === '内置·乐天百货门店双图');
  assert.ok(lotte && lotte.rulesSpec);
  // 新收编三条在册且带规则说明
  for (const name of ['内置·现代三池交付包', '内置·客户文件夹', '内置·客户数据Excel']) {
    const row = list0.body.plans.find((p) => p.name === name);
    assert.ok(row, `${name} 应在册`);
    assert.equal(row.kindType, 'builtin');
    assert.ok(row.rulesSpec && row.rulesSpec.summary, `${name} 应带人话规则`);
  }
  // 收编出口在配置台无路径预览 → 400 指路资料库(不是 500)
  const noPreview = await call('POST', '/api/admin/config/export-plans/内置·客户文件夹/preview', { batchId: 'batch_x' });
  assert.equal(noPreview.status, 400);
  assert.ok(noPreview.body.error.includes('资料库'));

  assert.equal((await call('POST', '/api/admin/config/export-plans/按团号整理', {
    payload: { ...DSL_PLAN, levels: [{ template: '{nonexistentField}' }] },
  })).status, 400);

  const saved = await call('POST', '/api/admin/config/export-plans/按团号整理', { payload: DSL_PLAN });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.kindType, 'dsl');
  const list1 = await call('GET', '/api/admin/config/export-plans');
  const row = list1.body.plans.find((p) => p.name === '按团号整理');
  assert.equal(row.kindType, 'dsl');
  assert.equal(row.source, 'db');
});

// B6(2026-07-16 同步一致性审计):基线改动会漂移已启用计划的硬冲突判据——保存基线的响应必须
// 附带受影响计划警告(此前只在计划 save/activate 时检查,时序可绕过"硬冲突禁启用"闸)。
test('改基线 → 响应附带已启用计划的漂移硬冲突警告(不拦保存)', async (t) => {
  const { call } = await makePlanServer(t);
  // 先启用一个用 {groupNo} 的 DSL 计划(出厂基线含团号,无冲突,保存即启用)
  const saved = await call('POST', '/api/admin/config/export-plans/按团号整理', { payload: DSL_PLAN });
  assert.equal(saved.status, 200);
  assert.ok(!saved.body.savedAsDraft, '出厂基线下应无硬冲突,直接启用');

  // 后改基线:把团号从必审集拿掉(保留锚字段免税店)→ 该计划的 {groupNo} 来源被抽走
  const base = await call('POST', '/api/admin/config/review-base/receipt', {
    payload: { fields: ['receiptStoreFinal', 'receiptNoFinal', 'purchaseDateFinal'] },
  });
  assert.equal(base.status, 200, JSON.stringify(base.body));
  assert.ok(Array.isArray(base.body.activePlanConflicts), '基线保存响应必须带漂移复查结果');
  const hit = base.body.activePlanConflicts.find((w) => w.plan === '按团号整理');
  assert.ok(hit, '受影响的已启用计划必须被点名');
  assert.ok(hit.hardConflicts >= 1);
});

test('预览:builtin走老planner归一化输出;DSL走引擎;批次不存在404', async (t) => {
  const { call } = await makePlanServer(t);
  const builtin = await call('POST', '/api/admin/config/export-plans/内置·多模式四规则/preview', { batchId: 'batch_x' });
  assert.equal(builtin.status, 200);
  assert.equal(builtin.body.kindType, 'builtin');
  assert.deepEqual(builtin.body.paths, ['济州新罗SG-道辉/26141001/X_小票1.jpg']);
  assert.ok(builtin.body.blocked[0].includes('缺小票号'));
  assert.ok(builtin.body.blocked.some((x) => x.includes('缺交易编码:百货:CL3/t2')), '规则5缺交易编码计入预览阻断');
  assert.equal(builtin.body.skipped[0].customerId, 'CL9');

  // 2026-07-20 复核HIGH回归:乐天预览走真实服务——无独立护照不阻断(旧代码读已删的
  // missingPassport 字段直接 500),缺门店仍是阻断类
  const lotte = await call('POST', '/api/admin/config/export-plans/内置·乐天百货门店双图/preview', { batchId: 'batch_lotte' });
  assert.equal(lotte.status, 200, JSON.stringify(lotte.body));
  // 0727#13-4:交易编号文件名按票面 4-4 带杠
  assert.ok(lotte.body.paths.includes('明洞/7.1 WANG YI/1234-5678.js'), lotte.body.paths.join('\n'));
  assert.ok(lotte.body.paths.includes('明洞/7.1 WANG YI/护照.js'), '无独立护照 → 同框整图兜底出护照文件');
  assert.ok(!lotte.body.blocked.some((x) => x.includes('缺护照')), '无独立护照不再是阻断');
  assert.ok(lotte.body.blocked.some((x) => x.includes('缺门店')), '缺门店仍阻断');

  await call('POST', '/api/admin/config/export-plans/按团号整理', { payload: DSL_PLAN });
  const dsl = await call('POST', '/api/admin/config/export-plans/按团号整理/preview', { batchId: 'batch_x' });
  assert.equal(dsl.status, 200);
  assert.equal(dsl.body.kindType, 'dsl');
  assert.deepEqual(dsl.body.paths, ['26140001/小票1.js', '26140001/小票2.js']); // 源文件=本测试文件,扩展名 .js
  // 复核HIGH回归:CL-002 无团号,绝不借 CL-001 的——进 blocked 而不是串进 26140001/
  assert.equal(dsl.body.stats.blocked, 1);
  assert.ok(dsl.body.blocked[0].includes('CL20260714-002'));
  assert.ok(dsl.body.blocked[0].includes('groupNo'));

  assert.equal((await call('POST', '/api/admin/config/export-plans/按团号整理/preview', { batchId: 'nope' })).status, 404);
});

// ── P3a:审核基线 + 店档案字段 + 影响面预检 ──────────────────────
test('审核基线:出厂视图/保存/坏字段400/影响面预检统计将新增的必改', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-base-routes-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const app = express();
  app.use(express.json());
  const fakeBatches = [{ id: 'b1' }];
  const fakeBatch = {
    id: 'b1',
    tasks: [
      // 未审免税店小票,groupNo 空 → 若基线新增团号,该票计入影响面(此处反向:先去掉团号再预检加回)
      { id: 't1', docTypeFinal: 'receipt', reviewed: false, receiptStoreFinal: 'THE SHILLA', groupNoFinal: '', groupNoAuto: '' },
      { id: 't2', docTypeFinal: 'receipt', reviewed: true, receiptStoreFinal: 'THE SHILLA', groupNoFinal: '' }, // 已审不计
      { id: 't3', docTypeFinal: 'receipt', reviewed: false, receiptStoreFinal: 'HYUNDAI_DEPT', groupNoFinal: '' }, // 百货不吃基线
    ],
  };
  createConfigConsoleRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'boss', role: 'admin' }; next(); } },
    previewDeps: { listBatches: async () => fakeBatches, loadBatch: (id) => (id === 'b1' ? fakeBatch : null) },
  }).register(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const list = await call('GET', '/api/admin/config/review-base');
  assert.equal(list.status, 200);
  const receiptRow = list.body.bases.find((b) => b.docType === 'receipt');
  assert.equal(receiptRow.source, 'factory');
  assert.equal(receiptRow.fields.length, 5);

  assert.equal((await call('POST', '/api/admin/config/review-base/receipt', { payload: { fields: ['野字段'] } })).status, 400);

  // 先保存去掉团号的基线
  const slim4 = ['receiptStoreFinal', 'receiptNoFinal', 'purchaseDateFinal', 'departureDateFinal'];
  assert.equal((await call('POST', '/api/admin/config/review-base/receipt', { payload: { fields: slim4 } })).status, 200);

  // 预检:把团号加回 → t1(未审、团号空、免税店)计入;t2 已审不计;t3 百货不计
  const impact = await call('POST', '/api/admin/config/review-base/receipt/impact', { payload: { fields: [...slim4, 'groupNoFinal'] } });
  assert.equal(impact.status, 200);
  assert.deepEqual(impact.body.added, ['groupNoFinal']);
  assert.equal(impact.body.affectedTasks, 1);
  assert.equal(impact.body.sample[0].taskId, 't1');
});

test('店档案字段:三家列出(passportFree只读展示);改现代去掉上家;非百货400', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-fields-routes-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const app = express();
  app.use(express.json());
  createConfigConsoleRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'boss', role: 'admin' }; next(); } },
  }).register(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const list = await call('GET', '/api/admin/config/stores');
  assert.equal(list.body.stores.length, 3);
  const hyundai = list.body.stores.find((s) => s.family === 'HYUNDAI_DEPT');
  assert.equal(hyundai.readonly.passportFree, true); // 冻结区只读展示
  assert.ok(hyundai.fields.includes('upstream'));
  // 断点①明示:出厂规则快照随店下发(只读展示;运行时读硬编码,配置台改不了)
  assert.deepEqual(hyundai.factoryRules.upstream, ['金浦奥莱', '东方']);
  assert.equal(hyundai.factoryRules.upstreamDefault, '东方');
  const lotteDept = list.body.stores.find((s) => s.family === 'LOTTE_DEPT');
  assert.equal(lotteDept.factoryRules.receiptNo.digits, 8);
  assert.equal(lotteDept.factoryRules.branchNames['0394'], '明洞');
  assert.equal(lotteDept.factoryRules.delivery, 'lotte_dept');

  const saved = await call('POST', '/api/admin/config/stores/HYUNDAI_DEPT/fields', {
    fields: hyundai.fields.filter((f) => f !== 'upstream'),
  });
  assert.equal(saved.status, 200);
  const after = await call('GET', '/api/admin/config/stores');
  const hyundaiAfter = after.body.stores.find((s) => s.family === 'HYUNDAI_DEPT');
  assert.ok(!hyundaiAfter.fields.includes('upstream'));
  assert.equal(hyundaiAfter.readonly.passportFree, true); // 安全闸没被字段编辑动到

  assert.equal((await call('POST', '/api/admin/config/stores/LOTTE/fields', { fields: ['receiptNo'] })).status, 400);
});

// ── P3b:冲突检查v2(硬判/存草稿/启用复查)+ Excel 预览 + 落盘执行 ──
async function makeP3bServer(t, { executeService = null, queryLedgerRows = null, reviewConfigResolver = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3b-routes-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const app = express();
  app.use(express.json());
  createConfigConsoleRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'boss', role: 'admin' }; next(); } },
    previewDeps: {
      loadBatch: (id) => (id === 'bx' ? { id: 'bx', tasks: [] } : null),
      queryLedgerRows,
      executeService,
      reviewConfigResolver, // 默认 null=出厂回落路径;测试可注入桩验证配置命中路径
    },
  }).register(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* download 流 */ }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  return { call, repository };
}

test('P3b 冲突检查v2:百货模式勾出境日期=硬冲突→存草稿不启用;启用复查409;改好后正常启用', async (t) => {
  const { call, repository } = await makeP3bServer(t);
  // 计划scope=现代百货,模板用{departureDate}:百货无出境日期=硬
  const bad = await call('POST', '/api/admin/config/export-plans/百货按日期', { payload: {
    planLabel: '百货按日期', scope: { modes: ['现代百货'] },
    levels: [{ template: '{departureDate}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  } });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.savedAsDraft, true);
  assert.ok(bad.body.conflicts.some((c) => c.severity === 'hard' && /出境日期|departureDate/.test(c.field + c.message)));
  assert.equal(repository.getActive('export_plan', '百货按日期'), null); // 草稿=未启用
  // 启用复查:硬冲突未修 → 409 带清单
  const act = await call('POST', '/api/admin/config/export-plans/百货按日期/activate', { version: 1 });
  assert.equal(act.status, 409);
  assert.ok(act.body.conflicts.length >= 1);
  // 改成百货可用字段(品牌/门店)→ 直接启用成功
  // (v1 草稿已存在,base=1;乐观锁基版闸要求带 expectBaseVersion,审计 HIGH line514)
  const good = await call('POST', '/api/admin/config/export-plans/百货按日期', { payload: {
    planLabel: '百货按门店', scope: { modes: ['现代百货'] },
    levels: [{ template: '{upstream}' }], naming: { template: '{receiptNo}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  }, expectBaseVersion: 1 });
  assert.equal(good.body.savedAsDraft, false);
  assert.equal(repository.getActive('export_plan', '百货按日期').version, 2);
});

test('免护照店护照需求=软不硬(2026-07-17 出厂去票级护照);乐天缺勾仍硬', async (t) => {
  // 桩 resolver:模拟乐天店档案被配置成缺 passportNo(现代走出厂=已无票级护照)
  const { call } = await makeP3bServer(t, {
    reviewConfigResolver: {
      getDeptFields: (family) => (family === 'LOTTE_DEPT'
        ? ['extractedName', 'receiptNo', 'receiptAmount', 'branch', 'brand', 'purchaseDate']
        : null),
    },
  });
  // 现代百货 passportFree+出厂已无票级护照:计划用 {passportNo} → 软提示(身份来自随行护照),直接启用
  const soft = await call('POST', '/api/admin/config/export-plans/百货护照夹', { payload: {
    planLabel: '百货护照夹', scope: { modes: ['现代百货'] },
    levels: [{ template: '{passportNo}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  } });
  assert.equal(soft.body.savedAsDraft, false, 'passportFree 店=软冲突,不挡启用');
  assert.ok(soft.body.conflicts.some((c) => c.severity === 'soft' && /免护照/.test(c.message)));
  assert.ok(!soft.body.conflicts.some((c) => c.severity === 'hard'));
  // 乐天百货(同框票不免):店档案缺 passportNo → 同款计划=硬冲突存草稿(硬闸没被软化)
  const hard = await call('POST', '/api/admin/config/export-plans/乐天护照夹', { payload: {
    planLabel: '乐天护照夹', scope: { modes: ['乐天百货'] },
    levels: [{ template: '{passportNo}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  } });
  assert.equal(hard.body.savedAsDraft, true, '乐天缺护照勾=硬冲突');
  assert.ok(hard.body.conflicts.some((c) => c.severity === 'hard' && /店档案未勾/.test(c.message)));
});

test('P3b Excel计划:品牌列配到免税店模式=硬冲突草稿;配到百货=启用;预览按workspace出行', async (t) => {
  const rows = [
    { stmt_date: '2026-07-14', agent: '梁总百货', brand: '루이비통', gross_krw: 4500000 },
  ];
  const { call } = await makeP3bServer(t, { queryLedgerRows: ({ workspaceKey }) => (workspaceKey === '260714' ? rows : []) });
  const dutyFree = await call('POST', '/api/admin/config/export-plans/明细A', { payload: {
    planLabel: '明细A', scope: { modes: ['乐天SG-本司'] }, excel: { columns: ['stmt_date', 'brand'] },
  } });
  assert.equal(dutyFree.body.savedAsDraft, true); // brand 仅百货有来源
  // 现代百货档案没有「品牌」→ 配 brand 也是硬冲突(冲突检查抓得对);品牌只属乐天百货
  const hyundaiBrand = await call('POST', '/api/admin/config/export-plans/明细H', { payload: {
    planLabel: '现代配品牌', scope: { modes: ['现代百货'] }, excel: { columns: ['stmt_date', 'brand'] },
  } });
  assert.equal(hyundaiBrand.body.savedAsDraft, true);
  assert.ok(hyundaiBrand.body.conflicts.some((c) => /店档案未勾/.test(c.message)));

  const dept = await call('POST', '/api/admin/config/export-plans/明细B', { payload: {
    planLabel: '乐天百货明细', scope: { modes: ['乐天百货'] }, excel: { columns: ['stmt_date', 'agent', 'brand', 'branch', 'gross_krw'] },
  } });
  assert.equal(dept.body.savedAsDraft, false);
  const preview = await call('POST', '/api/admin/config/export-plans/明细B/preview', { workspaceKey: '260714' });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.headers, ['收票日期', '代理', '品牌', '门店编号', '交易金额(￦)']);
  assert.equal(preview.body.rows.length, 1);
  assert.equal(preview.body.rows[0][2], '루이비통');
  assert.equal((await call('POST', '/api/admin/config/export-plans/明细B/preview', {})).status, 400);
});

test('P3b 模式视角冲突聚合 + 落盘执行(下载流/422带清单/内置400)', async (t) => {
  const executeService = {
    executeDslPlan: async ({ plan }) => {
      if (plan.planLabel === '会炸') { const e = new Error('缺字段'); e.code = 'EXPORT_PLAN_BLOCKED'; e.blocked = [{ reason: '缺groupNo' }]; throw e; }
      return { zipPath: __filename, downloadName: '交付.zip', stats: { files: 1 } };
    },
    executeExcelPlan: async () => ({ zipPath: __filename, downloadName: '明细.xlsx', stats: { rows: 1 } }),
  };
  const { call } = await makeP3bServer(t, { executeService });
  // 聚合:给现代百货挂一个带硬冲突的启用计划(scope空=命不中?scope空命中所有→会入聚合)
  await call('POST', '/api/admin/config/export-plans/通用坏计划', { payload: {
    planLabel: '通用坏计划', scope: { modes: ['现代百货'] },
    levels: [{ template: '{groupNo}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  } });
  const agg = await call('GET', '/api/admin/config/modes/现代百货/conflicts');
  assert.equal(agg.status, 200);
  assert.equal(agg.body.hard, 0); // 硬冲突的存成了草稿,不在启用集里 → 聚合干净
  // 落盘:好计划下载流
  await call('POST', '/api/admin/config/export-plans/好计划', { payload: {
    planLabel: '好计划', scope: { modes: [] },
    levels: [{ template: '{groupNo}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  } });
  const ok = await call('POST', '/api/admin/config/export-plans/好计划/execute', { batchId: 'bx' });
  assert.equal(ok.status, 200);
  assert.ok(String(ok.headers.get('content-disposition') || '')?.includes('.zip'));
  // 阻断:422 带清单
  await call('POST', '/api/admin/config/export-plans/会炸', { payload: {
    planLabel: '会炸', scope: { modes: [] },
    levels: [{ template: '{groupNo}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  } });
  const boom = await call('POST', '/api/admin/config/export-plans/会炸/execute', { batchId: 'bx' });
  assert.equal(boom.status, 422);
  assert.equal(boom.body.code, 'EXPORT_PLAN_BLOCKED');
  // 内置计划走老按钮
  const builtin = await call('POST', '/api/admin/config/export-plans/内置·多模式四规则/execute', { batchId: 'bx' });
  assert.equal(builtin.status, 400);
});

test('店档案回落出厂端点:保存→deactivate→GET 回出厂(链路探针实锤缺口回归)', async (t) => {
  const { call } = await makeP3bServer(t);
  await call('POST', '/api/admin/config/stores/HYUNDAI_DEPT/fields', { fields: ['receiptNo', 'receiptAmount'] });
  const before = (await call('GET', '/api/admin/config/stores')).body.stores.find((s) => s.family === 'HYUNDAI_DEPT');
  assert.equal(before.source, 'db');
  const off = await call('POST', '/api/admin/config/stores/HYUNDAI_DEPT/deactivate', {});
  assert.equal(off.status, 200);
  assert.equal(off.body.fallback, 'factory');
  const after = (await call('GET', '/api/admin/config/stores')).body.stores.find((s) => s.family === 'HYUNDAI_DEPT');
  assert.equal(after.source, 'factory');
  assert.ok(after.fields.includes('upstream'), '出厂现代档案必须回来含上家');
  // 非百货家族拒
  assert.equal((await call('POST', '/api/admin/config/stores/LOTTE/deactivate', {})).status, 400);
});

test('P3c:公开 review-config(登录即可)/字段注册表/配置日志聚合', async (t) => {
  const { call } = await makeP3bServer(t);
  // review-config:登录即可(端点不走 requireAdmin),形状=stores+双基线+stamp
  const rc = await call('GET', '/api/review-config');
  assert.equal(rc.status, 200);
  assert.ok(rc.body.stores.LOTTE_DEPT.fields.length >= 5);
  assert.equal(rc.body.stores.LOTTE_DEPT.configVersion, 0); // 出厂=0,前端见 0 不过滤
  assert.ok(rc.body.receiptBaseFields.includes('receiptNoFinal'));
  assert.ok(rc.body.passportBaseFields.includes('passportNoFinal'));
  // 配置现代百货档案 → review-config 立刻反映,configVersion>0
  await call('POST', '/api/admin/config/stores/HYUNDAI_DEPT/fields', { fields: ['receiptNo', 'receiptAmount', 'purchaseDate'] });
  const rc2 = await call('GET', '/api/review-config');
  assert.deepEqual(rc2.body.stores.HYUNDAI_DEPT.fields, ['receiptNo', 'receiptAmount', 'purchaseDate']);
  assert.ok(rc2.body.stores.HYUNDAI_DEPT.configVersion > 0);
  assert.ok(rc2.body.stamp > rc.body.stamp, '配置写入后 stamp 必须前进(前端缓存失效依据)');

  // 字段注册表只读:守卫字段带 guarded 标
  const reg = await call('GET', '/api/admin/config/field-registry');
  assert.equal(reg.status, 200);
  const byKey = Object.fromEntries(reg.body.fields.map((f) => [f.key, f]));
  assert.equal(byKey.receiptNoFinal.exportable, true);
  assert.equal(byKey.tourStance.guarded, true);

  // 配置日志:跨 kind 聚合,新→旧,分页夹取
  const modeSave = await call('POST', '/api/admin/config/modes/测试模式X', { payload: { modeLabel: '测试模式X', columns: {
    recordDate: true, agent: true, purchaseDate: true, receiptNo: true, groupNo: true, name: true, passportNo: true, departureDate: true,
  } } });
  assert.equal(modeSave.status, 200, `模式保存须成功:${JSON.stringify(modeSave.body)}`);
  const log = await call('GET', '/api/admin/config/changelog?limit=5');
  assert.equal(log.status, 200);
  assert.ok(log.body.total >= 2);
  assert.equal(log.body.rows[0].name, '测试模式X'); // 最新在前
  assert.ok(['mode', 'store'].includes(log.body.rows[0].kind));
  const page2 = await call('GET', '/api/admin/config/changelog?limit=1&offset=1');
  assert.equal(page2.body.rows.length, 1);
});

test('execute 下载失败:头未发出时客户端得到 500(不挂死),并发闸复位可再点(复核HIGH-A回归)', async (t) => {
  let cleaned = 0;
  const executeService = {
    // zipPath 指向不存在的文件 → res.download 头发出前就失败 → 回调必须自己响应
    executeDslPlan: async () => ({
      zipPath: path.join(os.tmpdir(), `no-such-${process.pid}-x.zip`),
      downloadName: '交付.zip',
      stats: { files: 1 },
      cleanup: () => { cleaned += 1; },
    }),
  };
  const { call } = await makeP3bServer(t, { executeService });
  await call('POST', '/api/admin/config/export-plans/好计划', { payload: {
    planLabel: '好计划', scope: { modes: [] },
    levels: [{ template: '{groupNo}' }], naming: { template: '{docLabel}{i}' },
    includes: ['receipt'], emptyPolicy: 'block_prefix',
  } });
  const fail1 = await call('POST', '/api/admin/config/export-plans/好计划/execute', { batchId: 'bx' });
  assert.equal(fail1.status, 500, '头未发出的下载失败必须给客户端 500,不能静默挂死');
  assert.equal(cleaned, 1, '失败路径也要清 staging');
  // 闸已在回调里复位:再点不是 429
  const fail2 = await call('POST', '/api/admin/config/export-plans/好计划/execute', { batchId: 'bx' });
  assert.notEqual(fail2.status, 429, '下载回调必须复位并发闸');
  assert.equal(cleaned, 2);
});

// ── 0727反馈#6:门店码点选清单(配置台增减 → 审核台点选) ─────────────────────
test('门店码清单:乐天出厂清单下发;保存增减后 stores/review-config 同步;非法/无门店概念店拒绝', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-options-routes-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  const app = express();
  app.use(express.json());
  createConfigConsoleRoutes({
    modeConfigRepository: repository,
    auth: { authenticateToken: (req, res, next) => { req.user = { username: 'boss', role: 'admin' }; next(); } },
  }).register(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // 出厂:乐天有清单(码+店名),新世界/现代无门店概念(branchConfigurable=false,不带清单)
  const list = await call('GET', '/api/admin/config/stores');
  const lotte = list.body.stores.find((s) => s.family === 'LOTTE_DEPT');
  assert.equal(lotte.branchConfigurable, true);
  assert.ok(lotte.branchOptions.some((o) => o.code === '0394' && o.name === '明洞'));
  assert.deepEqual(lotte.branchOptions, lotte.factoryBranchOptions, '未配置=出厂清单');
  const shinsegae = list.body.stores.find((s) => s.family === 'SHINSEGAE_DEPT');
  assert.equal(shinsegae.branchConfigurable, false);

  // 审核台运行时口径:review-config 带同一份清单
  const rc0 = await call('GET', '/api/review-config');
  assert.ok(rc0.body.stores.LOTTE_DEPT.branchOptions.some((o) => o.code === '0001'));
  assert.ok(!rc0.body.stores.SHINSEGAE_DEPT.branchOptions, '无门店概念的店不带清单键');

  // 增一个新码 0999 江南 → stores 与 review-config 双端同步
  const saved = await call('POST', '/api/admin/config/stores/LOTTE_DEPT/branch-options', {
    branchOptions: [...lotte.branchOptions, { code: '0999', name: '江南' }],
    expectBaseVersion: 0,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = (await call('GET', '/api/admin/config/stores')).body.stores.find((s) => s.family === 'LOTTE_DEPT');
  assert.ok(after.branchOptions.some((o) => o.code === '0999' && o.name === '江南'));
  const rc = await call('GET', '/api/review-config');
  assert.ok(rc.body.stores.LOTTE_DEPT.branchOptions.some((o) => o.code === '0999'));
  // 字段勾选没被门店码保存动到(payload 合并不是覆盖)
  assert.deepEqual(after.fields, lotte.fields);

  // 非法清单/无门店概念店:400
  assert.equal((await call('POST', '/api/admin/config/stores/LOTTE_DEPT/branch-options', { branchOptions: [{ code: '99', name: 'x' }], expectBaseVersion: 1 })).status, 400);
  assert.equal((await call('POST', '/api/admin/config/stores/LOTTE_DEPT/branch-options', { branchOptions: [{ code: '0111' }, { code: '0111' }], expectBaseVersion: 1 })).status, 400, '码重复拒绝');
  assert.equal((await call('POST', '/api/admin/config/stores/SHINSEGAE_DEPT/branch-options', { branchOptions: [{ code: '0001', name: 'x' }], expectBaseVersion: 0 })).status, 400, '无门店概念店拒绝');
});
