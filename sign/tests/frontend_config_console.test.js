'use strict';

// 配置台前端契约:锁住关键接线和红线,别被后续重构悄悄拆散。
// 2026-07-16 推倒重排为单导航(渠道模式/百货店/交付导出/字段字典/帮助),删配置日志页,黑话换人话。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('单导航五项 + 模式编辑(8列/审核字段/保存/回滚/新建覆盖率) 全在', () => {
  const view = read('frontend/src/views/ConfigConsoleView.vue');
  for (const marker of [
    'fetchConfigModes', 'saveConfigMode', 'activateConfigModeVersion', 'deactivateConfigMode',
    "nav = ref('modes')",                       // 单导航状态(取代旧双导航 section+activeTab)
    '渠道模式', '百货店', '交付导出', '字段字典', '帮助',   // 五个导航入口
    'recordDate', 'departureDate',              // 台账8列(首尾键)
    // 2026-07-29:这里原来写的是 '特殊动作签' —— 而界面上早就没有这四个字了(0724 已改名),
    // 它一直绿只是因为那四个字**活在注释里**,includes 连注释一起算。锁的是个不存在的旧文案。
    // 换成界面真在用的「任务设置」。
    '任务设置', '改动历史', '回到默认',        // 主区块④ + 折叠高级(旧「修改日志/回落出厂」已换)
    'expectBaseVersion', '409', 'unconfigured',
  ]) {
    assert.ok(view.includes(marker), `视图缺 ${marker}`);
  }
  // 单导航:旧双导航痕迹必须清除(防重构回潮)
  assert.ok(!view.includes('activeTab = ref'), '旧顶部页签 activeTab 应已删除');
  assert.ok(!view.includes('console-body'), '旧四区骨架 console-body 应已删除');
  assert.ok(!view.includes('loadChangelog'), '配置日志页应已删除(用户砍)');
});

test('新建模式重名闸(审计MEDIUM):同名不新建切编辑;归一撞名 409 给走编辑提示', () => {
  const view = read('frontend/src/views/ConfigConsoleView.vue');
  // 新建前先按名查重(modes 列表已含),命中即切到编辑、不调保存
  assert.ok(view.includes("modes.value.find((mode) => mode.name === trimmed)"), '缺重名前置查重');
  assert.ok(view.includes('已存在,已切到它的编辑'), '重名应提示并切到编辑而非新建');
  // 归一后撞名由后端 409 兜底,前端给出走编辑的友好提示(不再显示裸乐观锁报错)
  assert.ok(view.includes('err?.response?.status === 409'), '缺 409 归一撞名兜底');
  assert.ok(view.includes('归一后与已有模式同名'), '409 应给走编辑的人话提示');
});

test('API 包装 + 路由/导航挂 admin', () => {
  const api = read('frontend/src/api/configConsole.js');
  for (const fn of [
    'fetchConfigModes', 'fetchConfigModeVersions', 'saveConfigMode', 'activateConfigModeVersion', 'deactivateConfigMode',
    'fetchExportPlans', 'fetchExportPlanVersions', 'saveExportPlan', 'previewExportPlan', 'executeExportPlan',
    'fetchReviewBases', 'impactReviewBase', 'saveReviewBase', 'fetchStoreProfiles', 'saveStoreFields', 'deactivateStoreFields',
    'fetchModeConflicts', 'fetchFieldRegistry',
  ]) {
    assert.ok(api.includes(`export function ${fn}`), `api 缺 ${fn}`);
  }
  assert.ok(api.includes("responseType: 'blob'"), 'execute 需 blob 下载');
  const router = read('frontend/src/router/index.js');
  assert.match(router, /name: 'admin-config'/);
  assert.match(router, /ConfigConsoleView/);
  const app = read('frontend/src/App.vue');
  assert.ok(app.includes("{ label: '配置台', to: { name: 'admin-config' }, roles: ['admin']"));
});

test('内置规则明细:后端接线 + 前端渲染 全在(用户要透明,不是黑盒)', () => {
  // 2026-07-16 资料库P0:planRowsForList 抽到 lib/export_plan_registry(配置台/资料库同源),契约随迁
  const registry = read('lib/export_plan_registry.js');
  assert.ok(registry.includes('getBuiltinPlanSpec'), '注册表 planRowsForList 需附 rulesSpec');
  assert.ok(registry.includes('rulesSpec: getBuiltinPlanSpec'), '内置行需带 rulesSpec 字段');
  const routes = read('routes/config_console_routes.js');
  assert.ok(routes.includes("require('../lib/export_plan_registry')"), '配置台需引用共享注册表(不许自留副本)');
  const lib = read('lib/builtin_export_plan_specs.js');
  assert.ok(lib.includes("mode_delivery") && lib.includes('lotte_dept'), 'specs 覆盖两个内置计划');
  for (const key of ['hyundai_delivery', 'customer_folders', 'library_excel']) {
    assert.ok(lib.includes(key), `specs 缺收编出口 ${key}`);
  }

  const view = read('frontend/src/views/ConfigConsoleView.vue');
  for (const marker of [
    'rulesSpec', 'builtin-spec', '规则③',                          // 内置黑盒→只读规则明细
    '普通模式', '按模式名建文件夹',                                  // "没配置的模式去哪"说明
  ]) {
    assert.ok(view.includes(marker), `视图缺 ${marker}`);
  }
});

test('交付导出:三选皮肤 + Excel列 + 执行导出 + 草稿闭环 全在', () => {
  const view = read('frontend/src/views/ConfigConsoleView.vue');
  for (const marker of [
    '单一字段', '多字段拼接', '自由模板', 'levelSkins',              // 三选皮肤
    '明细表列', 'planExcelCols',                                    // Excel 列编辑
    'executePlan', '执行导出', 'previewExportPlan', '预览产出',
    'savedAsDraft', '存为草稿', 'planBaseVersion',                  // 草稿闭环 + 乐观锁水位
    'block_prefix', '一级文件夹',
  ]) {
    assert.ok(view.includes(marker), `视图缺 ${marker}`);
  }
});

test('红线契约:店家锚字段锁死 + 百货店独立入口 + 一键保存快照 + 基线影响面预检', () => {
  const view = read('frontend/src/views/ConfigConsoleView.vue');
  for (const marker of [
    // ⭐店家=路由锚字段,不可免审(复核 HIGH-2,必须锁死不被重构破坏)
    "fieldKey === 'receiptStoreFinal'",
    // 百货店从模式区独立成入口(本次重构):独立选中态
    'selectedStoreFamily', 'selectedStoreFields',
    // ⭐一键保存快照定格(复核 CRITICAL 根治,必须锁)
    'saveAll', 'planStoreSaveSnapshots', 'hasUnsaved', 'storeDirtyFamilies',
    // 模式微调并入 payload.review;基线抽屉影响面预检二次确认
    'modeReviewDraft', 'affectedTasks', 'impactReviewBase',
    // 命中团号后才微调(时序墙,人话)
    '命中团号后',
  ]) {
    assert.ok(view.includes(marker), `视图缺 ${marker}`);
  }
  assert.ok(view.includes('review.relax') || view.includes('review = { ...prevReview }'), '模式微调需并入 payload.review');
  assert.ok(view.includes('saveStoreFields('), '店档案保存接线缺失');
  // 丢数据红线:店家 relax 前端拦截
  assert.ok(view.includes("if (key === 'receiptStoreFinal') return"), '店家不可 relax 的前端闸缺失');
});

// ── 深链:代理视图「状态·任务」列头齿轮 → 配置台的任务设置(2026-07-29)────────────
// ⚠️这一组刻意**真的调用** readConfigDeepLink,而不是断言源码里出现过这个词。
// 档案 0729 的教训:源码字符串断言只能锁"写法有没有退化",锁不住"它还能不能跑"。
test('配置台深链解析:认识的 nav 才切,不认识的一律不切;focus=tasks 才聚焦', async () => {
  const { pathToFileURL } = require('node:url');
  const { readConfigDeepLink } = await import(
    pathToFileURL(path.join(__dirname, '..', 'frontend/src/lib/configConsoleDeepLink.js')).href
  );
  const NAV_KEYS = ['modes', 'stores', 'exports', 'fields', 'cleanup', 'help'];

  // 齿轮实际发出的那条链接
  assert.deepEqual(
    readConfigDeepLink({ nav: 'modes', focus: 'tasks' }, NAV_KEYS),
    { nav: 'modes', focusTasks: true },
  );
  // 不认识的板块名绝不能切过去——切到一个不存在的 nav 会把整页渲染成空白
  assert.deepEqual(readConfigDeepLink({ nav: 'nope', focus: 'tasks' }, NAV_KEYS).nav, '');
  assert.deepEqual(readConfigDeepLink({ nav: '../admin' }, NAV_KEYS).nav, '');
  // 裸进配置台(无参数)= 什么都不做,保持默认板块、不乱滚不乱闪
  assert.deepEqual(readConfigDeepLink({}, NAV_KEYS), { nav: '', focusTasks: false });
  assert.deepEqual(readConfigDeepLink(undefined, NAV_KEYS), { nav: '', focusTasks: false });
  // focus 只认 tasks;别的值不聚焦(将来加 focus=exports 时这里要一起改)
  assert.equal(readConfigDeepLink({ focus: 'export' }, NAV_KEYS).focusTasks, false);
  assert.equal(readConfigDeepLink({ focus: ' tasks ' }, NAV_KEYS).focusTasks, true, '两端空白要吃掉');
  // navKeys 没传时不能崩,也不能瞎切
  assert.deepEqual(readConfigDeepLink({ nav: 'modes' }), { nav: '', focusTasks: false });
});
