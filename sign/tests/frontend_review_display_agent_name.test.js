'use strict';

// 队列组名口径(2026-07-14 报障):左侧恒显**代理名**;结算归档把客户档案
// displayName 改成护照英文名(交付命名用)不得泄进队列。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadReviewDisplay() {
  return import(pathToFileURL(path.join(__dirname, '../frontend/src/lib/reviewDisplay.js')).href);
}

test('组名=代理优先;结算后 displayName 变英文名不再顶掉代理', async () => {
  const { buildReviewGroupDisplay } = await loadReviewDisplay();
  const task = {
    customerAgentName: '梁总百货',
    sourceGroupLabel: '蜜蜂',
    sourceFolderName: 'CL20260714-001', // customerIdOfTask 首选 sourceFolderName 原样
  };
  // 结算前:代理优先(不再显示建档标签)
  assert.equal(buildReviewGroupDisplay(task, {}).name, '梁总百货');
  // 结算后:customerNameById 映射成英文名,也不得顶掉代理
  assert.equal(buildReviewGroupDisplay(task, { 'CL20260714-001': 'NIU QINGXIA' }).name, '梁总百货');
});

test('无代理字段的旧任务:回落原链(displayName→标签→客户号),行为不回归', async () => {
  const { buildReviewGroupDisplay } = await loadReviewDisplay();
  const task = { sourceGroupLabel: '蜜蜂', sourceFolderName: 'CL20260714-002' };
  assert.equal(buildReviewGroupDisplay(task, { 'CL20260714-002': '韩免喜宝' }).name, '韩免喜宝');
  assert.equal(buildReviewGroupDisplay(task, {}).name, '蜜蜂');
});
