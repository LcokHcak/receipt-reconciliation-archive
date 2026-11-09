'use strict';

/**
 * f6_v2_delivery - 交付双页契约测试(2026-06-11 重构后)。
 *
 * 职责分离:
 * - 最终核对(DeliveryCheckView):生成交付数据(merge)+交付前检查(blocking/warning/
 *   待人工确认)+逐行核对。所有"看和判断"在这页。
 * - 最终交付(DeliveryView):极简终点页 —— 只读状态条 + 两类一键出包(汇总-最终数据
 *   data / 客户-最终文件 customer)+ 结果计数卡。不再有过程导出/文件列表。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F6 t1: api/v2/delivery.js exports delivery helpers via axios client', () => {
  assert.equal(exists('frontend/src/api/v2/delivery.js'), true);
  const src = read('frontend/src/api/v2/delivery.js');
  [
    'fetchExportFiles',
    'fetchFinalDeliveryReadiness',
    'runFinalDeliveryExport',
    'runReceivedReceiptExport',
    'downloadExportUrl',
  ].forEach((name) => assert.match(src, new RegExp(`export function ${name}\\b`), name));
  assert.match(src, /from ['"]\.\.\/client['"]/);
  assert.match(src, /EXPORT_TIMEOUT_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);

  // ⭐ 2026-08-01:上面那条只查「声明那行字在不在」,不查它有没有被**用上**。
  // 变异验证过:把两处请求的 `{ timeout: EXPORT_TIMEOUT_MS }` 整个删掉、
  // 只留常量声明(它变成死代码),这个测试**照样绿** ——
  // 而超时保护没了,长耗时的最终交付/收票汇总导出会被 axios 默认超时掐断,
  // 操作员看到的是"导出失败",实际后台还在跑。
  // 这正是「源码里有这行字 ≠ 这件事会发生」的原型。
  const usedAt = [...src.matchAll(/timeout:\s*EXPORT_TIMEOUT_MS/g)].length;
  assert.ok(usedAt >= 2,
    `EXPORT_TIMEOUT_MS 只被用了 ${usedAt} 次 —— `
    + '两个长耗时导出(final-delivery / received-receipt)都必须带上它,'
    + '否则常量还在、保护已经没了');
  // 而且要真的挂在那两个请求上,不是挂在别处
  for (const ep of ['final-delivery', 'received-receipt']) {
    const re = new RegExp(`${ep}[^\\n]*\\n?[^\\n]*timeout:\\s*EXPORT_TIMEOUT_MS`);
    assert.match(src, re, `${ep} 这个请求要带 EXPORT_TIMEOUT_MS`);
  }
});

test('⭐F6 t9b: 导出互斥锁的**解锁**那半边也要有断言(卡死发生在解锁侧)', () => {
  const view = read('frontend/src/views/v2/DeliveryView.vue');
  // 2026-08-01:原来只断了"上锁"(actionLoading.value = 'final' 这类赋值存在)
  // 和 ":disabled 出现 >=3 次"。变异验证过:把三个 handler 的
  // `} finally { actionLoading.value = '' }` 全删掉 —— actionLoading 一旦置位
  // 永不复位,任意一次导出(**哪怕成功**)之后三个按钮永久禁用,只能刷新页面。
  // 而测试照样绿:上锁有文本证据,解锁那半边一个字都没断。
  // 注:这页 0714 之后收敛成**一个** handleExport(pkg),不再是三个独立 handler
  // (我第一版照工作流报告里的旧名字写死,断言直接挂 —— 报告本身也会滞后)。
  const at = view.indexOf('async function handleExport');
  assert.ok(at > 0, '找不到 handleExport —— 页面结构变了,这条断言要跟着改');
  const body = view.slice(at, at + 1600);

  // 上锁(原来只断了这半边)
  assert.match(body, /actionLoading\.value = pkg\.type/, '要上锁');
  // ⭐ 解锁 —— 卡死发生在这一侧
  const unlocks = [...body.matchAll(/actionLoading\.value = ''/g)].length;
  assert.ok(unlocks >= 2,
    `解锁只出现 ${unlocks} 次。成功路径和失败路径都必须复位 —— `
    + '少一条,那条路走过之后按钮永久禁用,只能刷新页面');
  // 并发保护:锁着的时候不许再进来
  assert.match(body, /if \(!workspaceKey\.value \|\| actionLoading\.value\) return/,
    '锁着时要挡住重复点击');
});

test('F6 t2: delivery + delivery-check routes registered', () => {
  const router = read('frontend/src/router/index.js');
  assert.ok(router.includes('/monthly/v2/:workspaceKey/delivery'));
  assert.ok(router.includes("name: 'v2-monthly-delivery'"));
  assert.match(router, /DeliveryView\.vue/);
  assert.ok(router.includes('/monthly/v2/:workspaceKey/delivery-check'));
  assert.match(router, /DeliveryCheckView\.vue/);
});

test('F6 t3: DeliveryView is a thin endpoint — readiness + final export only', () => {
  const view = read('frontend/src/views/v2/DeliveryView.vue');
  ['fetchFinalDeliveryReadiness', 'runFinalDeliveryExport']
    .forEach((name) => assert.match(view, new RegExp(name), name));
  // 过程性内容仍移出:不再有 过程包/收票汇总/文件列表/月度概览
  ['runMonthlyExport', 'runReceivedReceiptExport', 'fetchExportFiles', 'fetchMonthlyOverview', 'classifyExportFile', 'DataTable']
    .forEach((name) => assert.doesNotMatch(view, new RegExp(`\\b${name}\\b`), `removed: ${name}`));
  // 2026-06-13:一键出包前按需重算 ensureFresh(过期 derivationDirtyFrom 或从未生成→重跑链),
  // 出的包永远跟最新匹配结果走。runMerge 已退役,改用 ensureFresh。
  assert.match(view, /ensureFresh/, 'ensure-fresh before export');
  assert.doesNotMatch(view, /\brunMerge\b/, 'runMerge 退役');
});

test('F6 t4: DeliveryView offers two one-click packages (data / customer)', () => {
  const view = read('frontend/src/views/v2/DeliveryView.vue');
  assert.match(view, /type:\s*['"]data['"]/);
  assert.match(view, /type:\s*['"]customer['"]/);
  assert.match(view, /packageTypes:\s*\[pkg\.type\]/);
  assert.ok(view.includes('汇总 - 最终数据类'), 'data package title');
  assert.ok(view.includes('客户 - 最终文件类'), 'customer package title');
  // 四桶在数据包说明里
  ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗V团']
    .forEach((bucket) => assert.ok(view.includes(bucket), bucket));
  // 客户包两类文件夹说明
  assert.ok(view.includes('收据单'), '收据单');
  assert.ok(view.includes('客户 PDF'), '客户 PDF');
  assert.match(view, /triggerArchiveDownload\(result\.archive\)/);
});

test('F6 t5: DeliveryView shows result counts instead of file list', () => {
  const view = read('frontend/src/views/v2/DeliveryView.vue');
  ['finalDataFileCount', 'customerFolderCount', 'receiptCount', 'customerPdfCount']
    .forEach((key) => assert.match(view, new RegExp(key), key));
  ['导出文件', '总客户文件夹', '生成收据单', '生成客户 PDF']
    .forEach((label) => assert.ok(view.includes(label), label));
  assert.match(view, /data-testid="delivery-result-counts"/);
});

test('F6 t6: DeliveryView readiness bar links back to delivery-check', () => {
  const view = read('frontend/src/views/v2/DeliveryView.vue');
  assert.match(view, /data-testid="delivery-readiness-bar"/);
  assert.ok(view.includes('可交付行'), '可交付行');
  assert.ok(view.includes('去最终核对处理'), '去最终核对处理');
  assert.match(view, /delivery-check/);
});

test('F6 t7: DeliveryCheckView owns ensureFresh(按需自动重算) + readiness checks', () => {
  const view = read('frontend/src/views/v2/DeliveryCheckView.vue');
  // 2026-06-13:按需重算 ensureFresh 取代手点 merge;monthly_data 只读
  assert.match(view, /ensureFresh/);
  assert.match(view, /async function ensureFreshData\(\)/);
  assert.doesNotMatch(view, /data-testid="generate-delivery-data"/);
  ['fetchFinalDeliveryReadiness', 'readinessBlocking', 'readinessWarnings', 'pendingReasonItems']
    .forEach((token) => assert.match(view, new RegExp(token), token));
  ['交付前检查', '当前不能交付的原因', '警告项说明', '待人工确认来源']
    .forEach((label) => assert.ok(view.includes(label), label));
});

test('F6 t8: decodeError handles backend codes on both pages', () => {
  const view = read('frontend/src/views/v2/DeliveryView.vue');
  ['FINAL_DELIVERY_BLOCKED', 'PIPELINE_LOCKED', 'WORKSPACE_LOCKED', 'service_unavailable']
    .forEach((code) => assert.match(view, new RegExp(code), code));
  const check = read('frontend/src/views/v2/DeliveryCheckView.vue');
  ['PIPELINE_LOCKED', 'WORKSPACE_LOCKED', 'merge_blocked', 'STAGE_ALREADY_RUNNING', 'STAGE_PRECONDITION_FAILED']
    .forEach((code) => assert.match(check, new RegExp(code), code));
});

test('F6 t9: backend final-delivery response exposes count scalars', () => {
  const routes = read('routes/monthly/export_routes.js');
  ['finalDataFileCount', 'customerFolderCount', 'receiptCount', 'customerPdfCount']
    .forEach((key) => assert.match(routes, new RegExp(key), key));
  // finalDataFileCount 必须动态来自 files(0 行的桶不生成文件,不能写死 4)
  assert.match(routes, /finalDataFileCount:\s*result\.files\.filter/);
});
