'use strict';

/**
 * 交付流程页面行为契约(2026-06-11 重构后):
 * - 「生成交付数据」(merge) 在最终核对页(DeliveryCheckView),不在交付页。
 * - 最终交付页(DeliveryView)是极简终点:两类一键出包 + zip 自动下载 + 结果计数。
 * - 千位抹零对负净额(退货冲减)用 trunc 不用 floor(floor 会放大欠款)。
 *
 * 静态源码断言,沿用 tests/sprint_f/*.js 风格(node --test,无 jest)。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const CHECK_VIEW = 'frontend/src/views/v2/DeliveryCheckView.vue';
const DELIVERY_VIEW = 'frontend/src/views/v2/DeliveryView.vue';

test('delivery-check: 打开核对页按需自动重算(ensureFresh),不再需要手点按钮', () => {
  // 2026-06-13:monthly_data 改纯派生只读。打开核对页 ensureFresh(过期/首次→重跑链),
  // 导出跟最新结果走;手点「生成交付数据」按钮 + 逐行手改全删。
  const view = read(CHECK_VIEW);
  assert.match(view, /import\s*\{\s*ensureFresh\s*\}\s*from\s*['"]@\/api\/v2\/stages['"]/);
  assert.match(view, /async function ensureFreshData\(\)/);
  assert.match(view, /await ensureFresh\(workspaceKey\.value\)/);
  // 旧手点入口/手改全删
  assert.doesNotMatch(view, /data-testid="generate-delivery-data"/);
  assert.doesNotMatch(view, /handleGenerateDeliveryData/);
  assert.doesNotMatch(view, /function saveEdit/, '逐行手改已删')
  assert.doesNotMatch(view, /api\.patch/, '不再 PATCH monthly-data')
});

test('delivery: one-click export passes single packageType and auto-downloads', () => {
  const view = read(DELIVERY_VIEW);
  const api = read('frontend/src/api/v2/delivery.js');
  assert.match(api, /export function runFinalDeliveryExport\(workspaceKey,\s*options\s*=\s*\{\}\)/);
  assert.match(api, /api\.post\(`\$\{base\(workspaceKey\)\}\/exports\/final-delivery`,\s*options,/);
  // 每个按钮固定传单一 packageType,不再有勾选框
  assert.match(view, /packageTypes:\s*\[pkg\.type\]/);
  assert.doesNotMatch(view, /deliveryPackageTypes/);
  assert.match(view, /function triggerArchiveDownload\(/);
  assert.match(view, /triggerArchiveDownload\(result\.archive\)/);
});

test('delivery: result counts come from backend response, not hardcoded', () => {
  const view = read(DELIVERY_VIEW);
  // 计数来自 result.counts(后端动态统计:0 行的桶不生成文件,文件数不能写死 4)
  assert.match(view, /lastCounts\.value\s*=\s*result\?\.counts/);
  ['finalDataFileCount', 'customerFolderCount', 'receiptCount', 'customerPdfCount']
    .forEach((key) => assert.match(view, new RegExp(key), key));
});

test('delivery: readiness gate disables export and links to delivery-check', () => {
  const view = read(DELIVERY_VIEW);
  assert.match(view, /:disabled="!!actionLoading \|\| !readiness\?\.ok"/);
  assert.ok(view.includes('去最终核对处理'), 'link back to check page');
});

test('floorToThousand: 千位抹零对负净额用 trunc(退货冲减不放大欠款)', () => {
  const { floorToThousand } = require('../services/monthly/final_delivery_export_service');
  assert.equal(floorToThousand(1954275), 1954000);
  assert.equal(floorToThousand(999), 0);
  // 负数:-1500 抹零应为 -1000(向零取整),不是 floor 的 -2000
  assert.equal(floorToThousand(-1500), -1000);
  assert.equal(floorToThousand(-695662.5), -695000);
  assert.equal(floorToThousand(0), 0);
  assert.equal(floorToThousand(null), 0);
});
