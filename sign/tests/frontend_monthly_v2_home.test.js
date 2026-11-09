const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const files = [
  'frontend/src/views/v2/MonthlyV2View.vue',
  'frontend/src/components/v2/MonthlyHeader.vue',
  'frontend/src/mocks/v2/index.js',
  'frontend/src/mocks/v2/seed.js',
];

test('monthly v2 home is an operations control center, not a KPI dashboard', () => {
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
  const view = read('frontend/src/views/v2/MonthlyV2View.vue');
  assert.match(view, /getMonthly/);
  assert.match(view, /MonthlyHeader/);
  // 首页已简化为运营控制台:用 nextAction/quickActions/blockingAlerts,
  // 不再用 AlertList/ActivityFeed/四桶状态 等 KPI 看板块(Codex c20866e/f9917d3 故意删)。
  assert.match(view, /nextAction/);
  assert.match(view, /quickActions/);
  assert.match(view, /blockingAlerts/);
  assert.match(view, /月度处理控制台/);
  assert.match(view, /下一步建议/);
  assert.match(view, /快捷入口/);
  assert.doesNotMatch(view, /PipelineSegment/);
  assert.doesNotMatch(view, /MonthlySummary/);
});

test('monthly v2 home exposes the five operational destinations', () => {
  const view = read('frontend/src/views/v2/MonthlyV2View.vue');
  for (const routeName of [
    'v2-monthly-ledger',
    'v2-monthly-bill-match',
    'v2-monthly-bill-review',
    'v2-monthly-unreceived',
    'v2-monthly-delivery',
  ]) {
    assert.match(view, new RegExp(routeName), `${routeName} should be reachable from home`);
  }
  assert.match(view, /nextAction/);
  assert.match(view, /quickActions/);
  assert.match(view, /blockingAlerts/);
});

test('monthly v2 uses tabular numbers and design-token status colors', () => {
  const combined = files.map(read).join('\n');
  assert.match(combined, /TabularNumber/);
  assert.doesNotMatch(combined, /toLocaleString/);
  assert.match(combined, /text-status-error/);
  assert.match(combined, /text-status-ok/);
  assert.match(combined, /bg-status-test\/10/);
});

test('monthly v2 header is minimal (demo badge), no lock/menu clutter', () => {
  // Codex c20866e 简化头部:移除四桶模式下拉/省略号菜单/出报表/复制键/健康检查详情。
  // 出报表挪到首页 body;未绑定模式提示移到账单匹配页。头部只保留 demo 模式徽章。
  const header = read('frontend/src/components/v2/MonthlyHeader.vue');
  assert.match(header, /StatusBadge[\s\S]*variant="test"/);
  assert.doesNotMatch(header, /Lock/);
  assert.doesNotMatch(header, /monthState/);
});

test('monthly v2 mock keeps fallback data for home control center', () => {
  const mock = read('frontend/src/mocks/v2/index.js');
  const seed = read('frontend/src/mocks/v2/seed.js');
  for (const stage of ['recognize', 'review', 'bridge', 'match']) {
    assert.match(mock, new RegExp(`${stage}:`));
  }
  assert.doesNotMatch(mock, /closed:/);
  assert.match(mock, /getMonthly/);
  assert.match(mock, /modeBindings/);
  assert.match(seed, /activities/);
  assert.match(seed, /Array\.from\(\{ length: 50 \}/);
});
