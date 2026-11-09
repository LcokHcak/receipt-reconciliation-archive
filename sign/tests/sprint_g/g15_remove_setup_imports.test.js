'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

// 注:`setup` 页仍删除并重定向到账单匹配;`imports` 页已按业务需要恢复为
// 「月度数据导入(灾备/迁移)」入口(团号汇总 + 日度台账直导,后端灾备端点的 UI)。
// 正常生产台账仍走 OCR 审核台;本页仅灾备/历史迁移/白盒测试。
test('G15 t7: setup 仍删除并重定向;imports 已恢复为灾备导入页', () => {
  assert.equal(exists('frontend/src/views/v2/WorkspaceSetupView.vue'), false);
  assert.equal(exists('frontend/src/views/v2/ImportsView.vue'), true);
  const router = read('frontend/src/router/index.js');
  // setup 仍是重定向
  assert.match(router, /path: '\/monthly\/v2\/:workspaceKey\/setup'/);
  assert.match(router, /redirect: \(to\) => `\/monthly\/v2\/\$\{to\.params\.workspaceKey\}\/bill-match`/);
  assert.doesNotMatch(router, /WorkspaceSetupView\.vue/);
  // imports 现在挂真实组件
  assert.match(router, /path: '\/monthly\/v2\/:workspaceKey\/imports'/);
  assert.match(router, /ImportsView\.vue/);
});

test('G15 t8: 侧栏不再链接 setup;imports 作为灾备入口可链接', () => {
  const sidebar = read('frontend/src/layouts/AppSidebar.vue');
  const monthly = read('frontend/src/views/v2/MonthlyV2View.vue');
  const header = read('frontend/src/components/v2/MonthlyHeader.vue');
  // setup 入口仍不存在
  assert.doesNotMatch(sidebar, /v2\('setup'\)/);
  assert.doesNotMatch(monthly, /v2-monthly-setup/);
  assert.doesNotMatch(header, /v2-monthly-setup/);
  // imports 灾备入口已加入侧栏
  assert.match(sidebar, /v2\('imports'\)/);
  assert.match(monthly, /v2-monthly-bill-match/);
});
