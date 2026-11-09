'use strict';

// 团号补救链路改版 P2+P3 前端契约(2026-07-18 设计):
// P2 互相找回(审核台⇄补救台深链)+ 客户信息弹窗 + 平铺改客户单元;F11 混合组日期行排除。
// 结构断言(本仓库前端测试风格),锁的是"入口存在+口径同构",防回退。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', ...p), 'utf8');
const remedyView = read('views', 'DailyRemedyView.vue');
const reviewView = read('views', 'ReviewView.vue');
const groupedList = read('components', 'GroupedTaskList.vue');

// ── P2-1 审核台→补救台精准落位 ─────────────────────────────────────
test('GroupedTaskList:待补救徽章可点,emit go-remedy(其它状态徽章纯展示)', () => {
  // 2026-07-27 任务流改造加了 queue-change/go-prev/go-next;本契约只锁「这两个必须在」,
  // 不锁完整清单(否则每加一个 emit 都要来改这里)。
  assert.match(groupedList, /defineEmits\(\[[^\]]*'on-select'[^\]]*'go-remedy'[^\]]*\]\)/);
  assert.match(groupedList, /group\.next\.cls === 'next-remedy'/);
  assert.match(groupedList, /@click\.stop="emit\('go-remedy', group\)"/);
  assert.match(groupedList, /group-next-clickable/);
});

test('ReviewView:待补救徽章/结算面板「去补救台」都走同一个 remedyDeepLink(batch+customer 带参)', () => {
  assert.match(reviewView, /function remedyDeepLink\(ws, batchId, groupKey\)/);
  assert.match(reviewView, /query\.batch = `\$\{w\}::\$\{batchId\}`/);
  assert.match(reviewView, /query\.customer = String\(groupKey\)/);
  // 结算面板「去补救台」与徽章点击都复用它,禁再出现裸跳 /daily/remedy 的第二套
  assert.match(reviewView, /router\.push\(remedyDeepLink\(ws, selectedBatchId\.value, selectedGroupKey\.value\)\)/);
  assert.match(reviewView, /router\.push\(remedyDeepLink\(ws, selectedBatchId\.value, group\?\.key\)\)/);
  assert.match(reviewView, /@go-remedy="goRemedyForGroup"/);
});

test('DailyRemedyView:onMounted 读深链 query(batch 预选批次 / customer 只看客户 / tour 展开组)', () => {
  assert.match(remedyView, /if \(q\.batch\) selectedBatchKey\.value = String\(q\.batch\)/);
  assert.match(remedyView, /if \(q\.customer\) customerFilter\.value = String\(q\.customer\)/);
  assert.match(remedyView, /startsWith\(`\$\{g\.workspaceKey\}::\$\{tour\}::`\)/);
  // customer 过滤作用在 filteredRows(与批次过滤叠加),并有可见的清除入口
  assert.match(remedyView, /String\(r\.sourceCustomerId \|\| ''\) === customerFilter\.value/);
  assert.match(remedyView, /清除,看全部/);
});

// ── P2-2 补救台→审核台 组卡片级定位 ────────────────────────────────
test('补救台:组卡片级「定位审核台」,单批次组直跳、跨批次退回逐行', () => {
  assert.match(remedyView, /function groupReviewTarget\(group\)/);
  assert.match(remedyView, /batchIds\.size === 1/);
  assert.match(remedyView, /function locateGroupInReview\(group\)/);
  assert.match(remedyView, /@click="locateGroupInReview\(g\)"/);
  // 行级定位保留(既有能力不回退)
  assert.match(remedyView, /@click="locateInReview\(row\)"/);
});

// ── P2-3 客户信息弹窗 ────────────────────────────────────────────
test('补救台:客户信息弹窗按 sourceBatchId 回溯批次,取同 sourceGroupKey 全部任务+原图+定位', () => {
  assert.match(remedyView, /async function openCustomerInfo\(row\)/);
  assert.match(remedyView, /fetchBatch\(row\.sourceBatchId\)/);
  assert.match(remedyView, /String\(t\.sourceGroupKey \|\| ''\) === String\(row\.sourceCustomerId\)/);
  // 护照→小票排序复用审核台共享真相源,不另写副本
  assert.match(remedyView, /sortTasksForReview\(groupTasks\)/);
  // 弹窗里能看原图(复用 ImageViewer)+ 一键定位审核台
  assert.match(remedyView, /ImageViewer :task="customerInfo\.activeTask"/);
  assert.match(remedyView, /@click="locateInReview\(customerInfo\.row\)"/);
  // 组内行 + 按客户卡 两处都有「客户信息」入口
  assert.match(remedyView, /@click="openCustomerInfo\(row\)"/);
  assert.match(remedyView, /@click="openCustomerInfo\(c\.rows\[0\]\)"/);
});

// ── P2-4 平铺改客户单元 ──────────────────────────────────────────
test('补救台:平铺视图改「按客户」聚合卡,逐票补救内嵌卡内', () => {
  // eslint --fix 后按钮文字可能独占一行,断言容忍标签内换行
  assert.match(remedyView, />\s*按客户\s*</);
  assert.doesNotMatch(remedyView, />\s*平铺\s*</, '旧「平铺」命名应改掉');
  assert.match(remedyView, /const customerCards = computed/);
  assert.match(remedyView, /r\.sourceCustomerId\s*\n?\s*\? `\$\{r\._workspaceKey\}::\$\{r\.sourceBatchId \|\| ''\}::\$\{r\.sourceCustomerId\}`/);
  // 卡内逐票仍走单行确认(submitMode/modeEdit),口径不变
  assert.match(remedyView, /@click="submitMode\(row\)"/);
  // 逐票 DataTable 已退役
  assert.doesNotMatch(remedyView, /<DataTable/, '按客户卡替代 DataTable 平铺');
});

// ── F11 混合组一键同模式排除日期行 ─────────────────────────────────
test('F11:组级/全组一键补救排除日期类行,跳过数明示', () => {
  assert.match(remedyView, /function groupModeEligibleRows\(group\)/);
  assert.match(remedyView, /!DATE_REASONS\.has\(r\.tourMatchStatus\)/);
  // submitGroup / submitAllGroups 都只吃 eligible 行
  const submitGroupSrc = remedyView.slice(remedyView.indexOf('async function submitGroup'), remedyView.indexOf('async function submitAllGroups'));
  const submitAllSrc = remedyView.slice(remedyView.indexOf('async function submitAllGroups'), remedyView.indexOf('function decodeError'));
  assert.match(submitGroupSrc, /groupModeEligibleRows\(group\)/);
  assert.match(submitGroupSrc, /for \(const row of eligible\)/);
  assert.match(submitAllSrc, /groupModeEligibleRows\(group\)/);
  assert.match(submitAllSrc, /for \(const row of eligible\)/);
  assert.match(remedyView, /跳过 \$\{skippedDates\} 张日期类/);
  // 组头按钮计数按可补救数(count - dateRowCount),不虚报全组
  // (2026-07-27 文案精简为「补救 N」,计数口径不变)
  assert.match(remedyView, /补救 \$\{g\.count - g\.dateRowCount\}/);
});
