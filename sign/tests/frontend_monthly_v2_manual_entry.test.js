const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

// 2026-06-12 B2 最终方案:手动录入页下线,替代品是未收清单页的「补录入台账」——
// 从账单复制真实数据反向建台账行(无编造/无手填汇率),自动重跑账单匹配。

test('manual entry page is retired (B2: replaced by unreceived backfill)', () => {
  assert.equal(fs.existsSync('frontend/src/views/v2/ManualEntryView.vue'), false, 'view deleted');
  assert.equal(fs.existsSync('frontend/src/api/v2/manualEntry.js'), false, 'api wrapper deleted');
  assert.equal(fs.existsSync('frontend/src/components/v2/ManualEntryForm.vue'), false, 'form deleted');
  assert.equal(fs.existsSync('frontend/src/components/v2/ManualEntryList.vue'), false, 'list deleted');
  const router = read('frontend/src/router/index.js');
  assert.doesNotMatch(router, /ManualEntryView/);
  const sidebar = read('frontend/src/layouts/AppSidebar.vue');
  assert.doesNotMatch(sidebar, /manual-entry/);
  // mock 假汇率随页面一起退役
  assert.doesNotMatch(read('frontend/src/mocks/v2/index.js'), /export function getManualEntries/);
});

test('unreceived page wires backfill (real bill data, auto bill-match)', () => {
  const view = read('frontend/src/views/v2/UnreceivedView.vue');
  assert.match(view, /backfillUnreceived/);
  assert.match(view, /data-testid="backfill-unreceived"/);
  assert.ok(view.includes('补录入台账'), 'button label');
  // 必须带确认弹窗,且明确告知不出客户 PDF/文件夹
  assert.match(view, /window\.confirm/);
  assert.ok(view.includes('不生成客户 PDF'), 'confirm copy mentions no customer pdf');

  const api = read('frontend/src/api/v2/billReview.js');
  assert.match(api, /export function backfillUnreceived\(workspaceKey,\s*payload\)/);
  assert.match(api, /bill-match\/unreceived\/backfill/);
});

test('backend backfill route registered with service guard', () => {
  const routes = read('routes/monthly/bill_match_routes.js');
  assert.match(routes, /bill-match\/unreceived\/backfill/);
  assert.match(routes, /unreceivedBackfillService/);
  // 服务器装配注入
  const server = read('workbench_server.js');
  assert.match(server, /createUnreceivedBackfillService/);
  assert.match(server, /unreceivedBackfillService: monthlyUnreceivedBackfillService/);
});
