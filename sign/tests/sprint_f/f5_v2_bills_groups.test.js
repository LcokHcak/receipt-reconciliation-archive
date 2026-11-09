'use strict';

/**
 * f5_v2_bills_groups — Sprint F F5 contract tests
 *
 * 1. components/v2/DataTable.vue 通用表存在,支持 columns/rows/loading/total/limit/offset
 * 2. DataTable 暴露 @prev / @next 事件
 * 3. DataTable 支持 cell-{key} 命名插槽
 * 4. api/v2/bills.js 提供 fetchBills + fetchGroupCodes,走 axios client
 * 5. v2 路由 /monthly/v2/:ws/bills + /monthly/v2/:ws/groups 已注册
 * 6. BillsView + GroupCodesView 都 import DataTable + 对应 api
 * 7. 两个 view 都解码 service_unavailable (F2 对齐)
 * 8. GroupCodesView 用 cell-tourNo 插槽显示 isPlaceholder 徽章
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F5 t1: DataTable.vue exists with columns/rows/loading props', () => {
  assert.equal(exists('frontend/src/components/v2/DataTable.vue'), true);
  const src = read('frontend/src/components/v2/DataTable.vue');
  ['columns', 'rows', 'loading', 'total', 'limit', 'offset']
    .forEach((prop) => assert.match(src, new RegExp(`${prop}:\\s*{[^}]*type:`), prop));
});

test('F5 t2: DataTable emits prev + next pagination events', () => {
  const src = read('frontend/src/components/v2/DataTable.vue');
  assert.match(src, /defineEmits\(\[['"]prev['"]\s*,\s*['"]next['"]\]\)/);
  // 按钮在边界禁用
  assert.match(src, /:disabled=["']offset === 0["']/);
  assert.match(src, /:disabled=["']offset \+ limit >= total["']/);
});

test('F5 t3: DataTable supports cell-{key} named slots for custom rendering', () => {
  const src = read('frontend/src/components/v2/DataTable.vue');
  assert.match(src, /<slot\s+:name=["']?`cell-\$\{col\.key\}`["']?/);
});

test('F5 t4: api/v2/bills.js exports fetchBills + fetchGroupCodes via axios client', () => {
  assert.equal(exists('frontend/src/api/v2/bills.js'), true);
  const src = read('frontend/src/api/v2/bills.js');
  assert.match(src, /export function fetchBills\b/);
  assert.match(src, /export function fetchGroupCodes\b/);
  assert.match(src, /from ['"]\.\.\/client['"]/);
  // 端点对齐 v1
  assert.match(src, /\/bills/);
  assert.match(src, /\/group-codes/);
});

test('F5 t5: v2 routes registered for bills + groups', () => {
  const router = read('frontend/src/router/index.js');
  assert.ok(router.includes('/monthly/v2/:workspaceKey/bills'));
  assert.ok(router.includes("name: 'v2-monthly-bills'"));
  assert.ok(router.includes('/monthly/v2/:workspaceKey/groups'));
  assert.ok(router.includes("name: 'v2-monthly-groups'"));
  assert.match(router, /BillsView\.vue/);
  assert.match(router, /GroupCodesView\.vue/);
});

test('F5 t6: BillsView + GroupCodesView import DataTable + their api', () => {
  assert.equal(exists('frontend/src/views/v2/BillsView.vue'), true);
  assert.equal(exists('frontend/src/views/v2/GroupCodesView.vue'), true);

  const bills = read('frontend/src/views/v2/BillsView.vue');
  assert.match(bills, /from ['"]@\/components\/v2\/DataTable\.vue['"]/);
  assert.match(bills, /fetchBills/);
  assert.match(bills, /from ['"]@\/api\/v2\/bills['"]/);

  const groups = read('frontend/src/views/v2/GroupCodesView.vue');
  assert.match(groups, /from ['"]@\/components\/v2\/DataTable\.vue['"]/);
  assert.match(groups, /fetchUsedGroupCodes/);
  assert.match(groups, /fetchBatchGroupCodes/);
  assert.match(groups, /from ['"]@\/api\/v2\/bills['"]/);
  assert.match(groups, /from ['"]@\/api\/v2\/batchGroupCodes['"]/);
});

test('F5 t7: both views decode service_unavailable (F2 alignment)', () => {
  ['frontend/src/views/v2/BillsView.vue', 'frontend/src/views/v2/GroupCodesView.vue']
    .forEach((p) => {
      const src = read(p);
      assert.match(src, /service_unavailable/, p);
    });
});

test('F5 t8: GroupCodesView uses cell-tourNo slot to show isPlaceholder badge', () => {
  const src = read('frontend/src/views/v2/GroupCodesView.vue');
  assert.match(src, /#cell-tourNo/);
  assert.match(src, /isPlaceholder/);
});
