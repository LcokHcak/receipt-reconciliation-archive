'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 资料库交付工作台前端契约(2026-07-16 P0):批次优先布局 + 计划卡 + 预检 + 渠道子卡。
// 文件内容断言(本仓库前端契约测试惯例):锁关键接线,防重构时静默丢功能。
function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('LibraryView:批次优先 + 计划卡 + 预检 + 渠道子卡 + 阻断深链 全在', () => {
  const view = read('frontend/src/views/LibraryView.vue');
  for (const marker of [
    '我的批次', 'selectBatch', 'batch-rail',                    // 左栏批次优先(每人每批次,不混)
    'fetchLibraryOverview', 'fetchDeliveryPlans', 'fetchDeliveryReadiness', // 三新端点接线
    '一键交付包', 'PLAN_TITLES',                                 // 内置白话标题(注册表 name 不动)
    'zone-row', 'toggleZone', 'exportSelectedZones',             // 渠道清单多选导出(image27:多选,不是11个独立命令)
    '按客户导出', '客户夹',                                       // 清单表头 + 已选合计
    '未归类',                                                    // 未归类行不给勾选给指引
    'buildReviewDeepLink', '定位审核台',                         // 阻断行深链审核台
    '预检', 'runReadiness',                                      // 预检前置
    'rulesSpec',                                                 // 规则说明(配置台同源)
    'reviewedNotSettled', 'passportBlocked',                     // 五问题#3/#4 有夹无行两类清单接线
    '已审核未结算(台账0行', '缺护照(结算闸拦死',                 // 面板文案(样式照 blocked-row)
  ]) {
    assert.ok(view.includes(marker), `LibraryView 缺 ${marker}`);
  }
});

test('api/libraryExport:新端点包装 + mode-delivery zone 参数', () => {
  const api = read('frontend/src/api/libraryExport.js');
  for (const fn of ['fetchLibraryOverview', 'fetchDeliveryPlans', 'fetchDeliveryReadiness']) {
    assert.ok(api.includes(`export function ${fn}`), `api 缺 ${fn}`);
  }
  assert.ok(api.includes('zone ? { zone } : null'), 'downloadModeDelivery 需支持 zone 切片参数');
  // 老端点原样保留(P0 承载导出;红线6)
  for (const fn of ['downloadBatchCustomerFolders', 'downloadHyundaiDelivery', 'downloadLotteDeptDelivery', 'downloadModeDelivery', 'downloadLibraryModeExport']) {
    assert.ok(api.includes(`export function ${fn}`), `老端点包装不许删:${fn}`);
  }
});

test('后端接线:overview 端点 + library 交付路由挂载 + handler zone 透传', () => {
  const routes = read('routes/monthly/export_routes.js');
  assert.ok(routes.includes("'/api/monthly/library-export/overview'"), '缺 overview 合并端点');
  const server = read('workbench_server.js');
  assert.ok(server.includes('createLibraryDeliveryRoutes'), 'workbench_server 需挂载交付路由');
  const handlers = read('services/handlers/workbench/batch_handlers.js');
  assert.ok(handlers.includes('req.body?.zone'), 'exportModeDelivery 需读 zone 参数');
});

// ── 2026-07-27 需求F①:模式列表不加粗 + 整理方式灰括号 ──────────────────────
test('F①模式清单不加粗,整理方式跟在名字后面(灰色括号)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'LibraryView.vue'), 'utf8');
  // 用户原话「没有什么重点需要突出,不要加粗体!!!」——一列模式里没有哪个该被强调
  const nameCss = /\.zone-name \{([^}]*)\}/.exec(src);
  assert.ok(nameCss, '找得到 .zone-name 样式');
  assert.match(nameCss[1], /font-weight:\s*400/);
  assert.ok(!/font-weight:\s*[6-9]00/.test(nameCss[1]), '不得再加粗');
  // 整理方式:灰色、比名字小一号,跟在名字后面的括号里
  assert.match(src, /z\.layout/);
  assert.match(src, /zone-layout/);
  const layoutCss = /\.zone-layout \{([^}]*)\}/.exec(src);
  assert.ok(layoutCss, '找得到 .zone-layout 样式');
  assert.match(layoutCss[1], /color:\s*#98a2b3/, '灰色字体');
  assert.match(layoutCss[1], /font-size:\s*12px/, '比模式名(13px)小一号');
});

// ── 0728 image27 参考图定稿:「多选,不是11个独立命令」──────────────────────
test('image27:渠道区=勾选清单+计数右对齐,逐行「单独导出」按钮清零,唯一动作=导出选中', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'LibraryView.vue'), 'utf8');
  assert.ok(!src.includes('单独导出'), '逐行导出按钮必须清零(单发一家=只勾一家)');
  assert.match(src, /已选 \{\{ selectedZones\.size \}\} · \{\{ selectedZoneDirs \}\} 客户夹/, '表头右侧「已选 N · M 客户夹」合计');
  assert.match(src, /zone-count/, '计数右对齐列');
  assert.match(src, /selectedZoneDirs = computed/, '客户夹合计是派生值不是手账');
  // 单渠道导出文件名回单区口径(与后端 stagingName 一致),多选才带「选中N渠道」
  assert.match(src, /zones\.length === 1 \? `_\$\{zones\[0\]\}` : `_选中\$\{zones\.length\}渠道`/);
});

test('F③客户数据 Excel 展示名点明 sheet1 是汇总(用户要能一眼知道第一页是什么)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'LibraryView.vue'), 'utf8');
  assert.match(src, /sheet1汇总\+每模式一sheet/);
});

test('F②客户数据 Excel 卡不出「预检」(它的 readiness 是零信息),其它计划照出', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'LibraryView.vue'), 'utf8');
  const actions = src.slice(src.indexOf('plan-card-actions'), src.indexOf('plan-card-stats'));
  assert.match(actions, /v-if="plan\.builtin !== 'library_excel'"/, '只对 Excel 卡隐藏');
  assert.match(actions, /预检/, '别的计划仍有预检(交付包的阻断明细是真需求)');
  assert.match(actions, /收起规则/, '规则按钮保留(内置计划透明化,用户 07-15 专门要的)');
});

// ── 「规则」按钮:只能看不能改,那至少给个去改的入口(0724-F3 拍板「优化一下」)──
// 用户原话:「看一下【规则】/【预检】,规则在配置台设置,预检看有什么必要性」。
// 现状:预检已按 0727#15 收过一刀;**规则按钮一个字没动** —— 它展开的是只读说明
// (这个计划会产出哪些文件夹/文件),内容有用(导出前正想知道这个),
// 但看完想改就断了:页面上没有任何通往配置台的路,得自己去菜单里找。
const fs2 = require('node:fs');
const path2 = require('node:path');

test('⭐规则说明要写清它是只读的,并给出去配置台改的入口', () => {
  const src = fs2.readFileSync(
    path2.join(__dirname, '../frontend/src/views/LibraryView.vue'), 'utf8');
  const i = src.indexOf('class="plan-rules"');
  assert.notEqual(i, -1, '找不到规则说明面板');
  const panel = src.slice(i, src.indexOf('</div>\n\n', i) + 8);

  assert.ok(/配置台/.test(panel), '规则面板没说这些规则是在配置台设的');
  // 深链要落到「交付导出」板块(nav=exports),不是把人扔到配置台首页自己找
  assert.ok(/nav=exports/.test(panel),
    '没有跳配置台「交付导出」的深链 —— 看完只读说明想改就断了');
});

test('按钮文案要点明是"看",不能让人以为点了能改', () => {
  const src = fs2.readFileSync(
    path2.join(__dirname, '../frontend/src/views/LibraryView.vue'), 'utf8');
  assert.ok(src.includes("'收起规则' : '查看规则'"),
    '按钮还叫「规则」—— 和配置台里那个能改的「规则」重名,点进来才发现只能看');
});
