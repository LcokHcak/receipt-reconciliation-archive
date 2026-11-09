const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'frontend', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

/**
 * 本系统有**两套侧栏**,这是架构事实,不是 bug:
 *   - `App.vue` 内联的 `<aside class="sidebar">` —— 除月度/审计外的所有页面
 *   - `layouts/AppSidebar.vue`(shadcn 版)—— `/monthly/v2` 与 `/audit/v2` 自带
 *     AppLayout shell,App.vue 主动让位(见 App.vue 里 hasOwnShell 的注释)
 *
 * 代价是:**任何导航调整都必须改两处**。0728 波3 定的是「全站重命名+导航归组」,
 * 实际只改了 App.vue 那套,结果生产上出现两套完全不同的导航——分组名不同、条目不同、
 * 品牌名不同,而且**结算中心里根本点不到审核台**(审核员要复核得先回首页)。
 * 靠人记住"还有另一套"是不可靠的,所以在这里锁住。
 */
test('两套侧栏必须同构:主栏的每个业务入口,结算栏里都要有', () => {
  const app = read('App.vue');
  const monthly = read('layouts/AppSidebar.vue');

  // 主栏(App.vue navItems)里的业务入口 = 结算栏必须也提供的最小集
  const MUST_HAVE = [
    '首页', '收票建档',
    '审核中心', '审核台', '异常补救',
    '客户中心', '已收客户组', '未收客户组', '日交付',
    '结算中心',
    '配置台',
  ];
  for (const label of MUST_HAVE) {
    assert.ok(app.includes(label), `前提失效:主栏应有「${label}」,是不是主栏改了?`);
    assert.ok(monthly.includes(label), `结算栏缺「${label}」——两套导航又分叉了`);
  }

  // 最要命的一条单独断言:进了结算中心必须能一步回审核台
  assert.match(monthly, /label: '审核台'[^}]*to: '\/review\/latest'/,
    '结算栏必须有直达审核台的入口(否则审核员发现问题要绕回首页)');
});

test('两套侧栏品牌一致:同一个系统换页面不该换名字', () => {
  const app = read('App.vue');
  const monthly = read('layouts/AppSidebar.vue');
  for (const word of ['收票对账系统', 'Receipt Reconciliation']) {
    assert.ok(app.includes(word), `前提失效:主栏应有品牌「${word}」`);
    assert.ok(monthly.includes(word), `结算栏品牌与主栏不一致,缺「${word}」`);
  }
});

// 全站唯一入口都挂在结算栏上;删条目前先想清楚这些页面还怎么进得去。
// /library-cleanup 就是活教训:0728 从主导航撤掉、注释说"移入配置台",
// 但配置台里并没有真的加,于是它成了只能手打 URL 的孤儿页。
test('结算栏承载的独占入口不得丢失(丢了对应页面就只能手打 URL)', () => {
  const monthly = read('layouts/AppSidebar.vue');
  const EXCLUSIVE = [
    ['模型训练', "'/training'"],
    ['Badcase', "v2('badcases')"],
    ['数据导入(灾备)', "v2('imports')"],
    ['数据库-团号', "v2('groups')"],
    ['操作日志', "v2('logs')"],
    ['审计日志', "'/audit/v2/logs'"],
  ];
  for (const [label, to] of EXCLUSIVE) {
    assert.ok(monthly.includes(label), `独占入口「${label}」被删了`);
    assert.ok(monthly.includes(to), `独占入口「${label}」的路由 ${to} 没了`);
  }
});

test('同路径靠 query 区分的两项(已收/未收客户组)不得同时高亮', () => {
  const monthly = read('layouts/AppSidebar.vue');
  assert.match(monthly, /function isActive[\s\S]{0,400}route\.query/,
    'isActive 必须比对 query,否则 /agents 与 /agents?view=unreceived 会同时点亮');
  assert.match(monthly, /if \(!query\) return !route\.query\.view/,
    '无 query 的「已收」在 ?view=unreceived 时不该亮');
});
