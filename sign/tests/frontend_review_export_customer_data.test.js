'use strict';

// ReviewView「更多」菜单的「导出当前批次客户数据」+ 本批次已处理完内联条样式。结构断言。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const review = fs.readFileSync(path.join(root, 'frontend', 'src', 'views', 'ReviewView.vue'), 'utf8');
const api = fs.readFileSync(path.join(root, 'frontend', 'src', 'api', 'workbench.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend', 'src', 'style.css'), 'utf8');

test('MoreMenu 含「导出当前批次客户数据」并触发 exportCustomerData', () => {
  assert.match(review, /导出当前批次客户数据/);
  assert.match(review, /@click="exportCustomerData"/);
  assert.match(review, /async function exportCustomerData/);
  assert.match(review, /exportBatchCustomerData/);
});

test('api 层有 exportBatchCustomerData(responseType blob)', () => {
  assert.match(api, /export function exportBatchCustomerData/);
  assert.match(api, /export-customer-data/);
  assert.match(api, /responseType: 'blob'/);
});

test('批次完成卡:独立类(旧全屏空态面板类已退役),样式在场', () => {
  // 2026-07-28 完成态改版:review-complete-panel(满屏居中类)退役,完成卡只挂 inline 类;
  // 卡内结构(✓态标/三桶数字/需重拍联动)的契约在 frontend_review_taskflow.test.js。
  assert.match(review, /class="review-complete-inline"/);
  assert.ok(!review.includes('review-complete-panel'), '旧满屏居中类不再引用');
  assert.match(css, /\.review-complete-inline\s*\{/);
});

// 审核台顶部瘦身(2026-07-26 用户需求:高度直接减半,图片才能更大)
test('顶部瘦身:批次上下文内联进标题行(去掉独占一行的带框卡)+ 三类提示统一为不带框单行', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/views/ReviewView.vue'), 'utf8');
  // ① 原 BatchContextCard(独占一行、带边框+内边距的卡片)已下线,建档日期/换团号表并进标题行
  assert.ok(!/<BatchContextCard/.test(src), 'BatchContextCard 已不再渲染(改内联)');
  assert.ok(!/import BatchContextCard/.test(src), '未使用的 import 已删');
  assert.match(src, /rv-batch-meta/, '建档日期内联进标题行');
  assert.match(src, /rv-gc-link/, '换团号表改内联下划线链接');
  // ② 三类提示统一写法:不带框(border-bottom 一条线)+ 图标 + 彩色字 + 下划线动作链接
  assert.match(src, /'is-error' : 'is-ok'/, '报错=红 / 全通过=ok 态(按 error 动态切)');
  assert.match(src, /rv-notice is-ok/, '回执提示走 ok 态(0728 绿删:灰阶)');
  assert.match(src, /rv-notice is-info/, '日常提醒=蓝');
  assert.match(src, /\.rv-notice\.is-error \.rv-notice-text \{ color: #b42318/, '红');
  assert.match(src, /\.rv-notice\.is-ok \.rv-notice-text \{ color: #475569/, '0728 硬规则:绿删,正常=灰阶');
  assert.match(src, /\.rv-notice\.is-info \.rv-notice-text \{ color: #175cd3/, '蓝');
  assert.match(src, /rv-notice-link/, '动作用下划线链接不用按钮');
  assert.ok(!/class="notice-panel"/.test(src), '旧的带框 notice-panel 已换掉');
  assert.ok(!/receipt-card-bar/.test(src), '旧的带框回执卡已换掉');
});
