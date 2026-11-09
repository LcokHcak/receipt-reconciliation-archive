'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAgentName,
  calendarMonthOf,
  customerPkOf,
  buildCustomerAnchor,
  buildReviewOverlay,
} = require('../lib/agent_workspace/customer_projection');

// ── 代理名规范化(V1 只做字符级:NFKC 全半角/去首尾空格/大小写;不做语义合并)──
test('normalizeAgentName 字符级规范化,空值归未标代理', () => {
  assert.deepEqual(normalizeAgentName(' 永乐 '), { agentKey: '永乐', agentName: '永乐', unlabeled: false });
  // 全角字母/空格 NFKC 归一;key 小写,展示名保留原写法(trim 后)
  assert.equal(normalizeAgentName('ＡＢＣ旅行').agentKey, 'abc旅行');
  assert.equal(normalizeAgentName('ＡＢＣ旅行').agentName, 'ABC旅行');
  assert.equal(normalizeAgentName('YongLe').agentKey, 'yongle');
  // 空/纯空格 → 未标代理(计入异常)
  assert.deepEqual(normalizeAgentName(''), { agentKey: '__unlabeled__', agentName: '未标代理', unlabeled: true });
  assert.deepEqual(normalizeAgentName('   '), { agentKey: '__unlabeled__', agentName: '未标代理', unlabeled: true });
  // 不同名不合并:永乐 与 永乐旅行 是两个 key
  assert.notEqual(normalizeAgentName('永乐').agentKey, normalizeAgentName('永乐旅行').agentKey);
});

// ── 自然月:业务时区(默认首尔)下的 createdAt;禁止从 workspaceKey 推导 ──
test('calendarMonthOf 按业务时区换月,UTC 边界正确(韩国月初 00:30)', () => {
  // UTC 2026-06-30T15:30 = 首尔 2026-07-01T00:30 → 归 2026-07
  assert.equal(calendarMonthOf('2026-06-30T15:30:00.000Z', 'Asia/Seoul'), '2026-07');
  // UTC 同刻在 UTC 时区 → 2026-06
  assert.equal(calendarMonthOf('2026-06-30T15:30:00.000Z', 'UTC'), '2026-06');
  assert.equal(calendarMonthOf('', 'Asia/Seoul'), '');
  assert.equal(calendarMonthOf('not-a-date', 'Asia/Seoul'), '');
});

test('customerPkOf 稳定主键=workspaceKey+customerId(customerId 不全局唯一)', () => {
  assert.equal(customerPkOf('260701-小票22', 'CL20260701-001'), '260701-小票22::CL20260701-001');
  assert.notEqual(customerPkOf('a', 'CL1'), customerPkOf('b', 'CL1'));
});

// ── 客户锚点:代理/owner/时间/图片数只来自 customer.json ──
test('buildCustomerAnchor 从 customer.json 建锚点,月份来自 createdAt 业务时区', () => {
  const anchor = buildCustomerAnchor({
    workspaceKey: '260701-小票22',
    timeZone: 'Asia/Seoul',
    customer: {
      customerId: 'CL20260701-003',
      agentName: ' 西雅国际 ',
      ownerUserId: 15,
      ownerUsername: '小票22',
      displayName: 'ZHANG SAN',
      createdAt: '2026-06-30T15:30:00.000Z', // 首尔 07-01
      images: [
        { imageId: 'i1' },
        { imageId: 'i2', preprocessWarning: true },
        { imageId: 'i3' },
      ],
    },
  });
  assert.equal(anchor.customerPk, '260701-小票22::CL20260701-003');
  assert.equal(anchor.calendarMonth, '2026-07');
  assert.equal(anchor.monthSource, 'createdAt');
  assert.equal(anchor.agentKey, '西雅国际');
  assert.equal(anchor.agentName, '西雅国际');
  assert.equal(anchor.ownerUserId, 15);
  assert.equal(anchor.ownerUsername, '小票22');
  assert.equal(anchor.customerName, 'ZHANG SAN');
  assert.equal(anchor.receivedAt, '2026-06-30T15:30:00.000Z');
  assert.equal(anchor.originalImageCount, 3);
  assert.equal(anchor.abnormalImageCount, 1);
  assert.deepEqual(anchor.warnings, []);
});

test('buildCustomerAnchor createdAt 缺失时降级用 customerId 日期并记 warning', () => {
  const anchor = buildCustomerAnchor({
    workspaceKey: 'ws',
    timeZone: 'Asia/Seoul',
    customer: { customerId: 'CL20260703-011', agentName: '', images: [] },
  });
  assert.equal(anchor.calendarMonth, '2026-07');
  assert.equal(anchor.monthSource, 'customerId');
  assert.ok(anchor.warnings.includes('created_at_missing'));
  // 空代理 → 未标代理,计异常
  assert.equal(anchor.agentKey, '__unlabeled__');
  assert.equal(anchor.agentUnlabeled, true);
});

// ── 审核覆盖层:票级两步流口径(修订#1/#2)──
test('buildReviewOverlay 票级口径:待表态计数/候选与确认模式分开且去重', () => {
  const overlay = buildReviewOverlay({
    tasks: [
      // 护照:不吃团号,不计入 stance
      { docTypeFinal: 'passport', reviewed: true },
      // 未表态小票(候选模式来源)
      { docTypeFinal: 'receipt', modeRawPre: '乐天SG-本司' },
      { docTypeFinal: 'receipt', modeRawPre: '乐天SG-本司' }, // 重复候选去重
      // 已表态 matched(确认模式;人选优先)
      { docTypeFinal: 'receipt', tourStance: 'matched', modeRawPre: '现代-JEOCU', reviewed: true },
      { docTypeFinal: 'receipt', tourStance: 'matched', modeRawPre: '别的', modeManualPick: '新世界SG-振华 不用记', reviewed: true },
      // 无团号表态:不产生模式
      { docTypeFinal: 'receipt', tourStance: 'none', reviewed: false },
      // 豁免:机场"无"不计待表态
      { docTypeFinal: 'receipt', groupNoAuto: '无' },
      // 豁免:百货 canonical
      { docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', reviewed: true },
      // 识别中
      { docTypeFinal: 'receipt', machineState: 'processing' },
      // 重拍
      { docTypeFinal: 'receipt', rephotoRequested: true },
      // 原图参考件不算必审
      { docTypeFinal: 'receipt', autoSplitRole: 'original' },
    ],
    settlementStatus: '',
  });
  // 待表态 = 2张未表态普通小票 + 识别中那张 + 重拍那张(都未表态)——机场/百货豁免、护照、原图不计。
  // 重拍票计入与前端 isTaskStanceLocked 同口径;状态优先级层 rephoto 压过 tour_pending,展示不冲突。
  assert.equal(overlay.stanceLockedCount, 4);
  assert.equal(overlay.rephotoCount, 1);
  assert.equal(overlay.recognizingCount, 1);
  assert.deepEqual(overlay.candidateModes, ['乐天SG-本司']);
  // 确认模式:matched 票的 manualPick 优先于 modeRawPre
  assert.deepEqual(overlay.confirmedModes.sort(), ['新世界SG-振华 不用记', '现代-JEOCU'].sort());
  assert.ok(overlay.pendingReviewCount > 0);
  assert.equal(overlay.hasTasks, true);
});

test('buildReviewOverlay 空任务与空组是安全缺省', () => {
  const overlay = buildReviewOverlay({ tasks: [], settlementStatus: '' });
  assert.equal(overlay.hasTasks, false);
  assert.equal(overlay.stanceLockedCount, 0);
  assert.deepEqual(overlay.candidateModes, []);
  assert.deepEqual(overlay.confirmedModes, []);
});
