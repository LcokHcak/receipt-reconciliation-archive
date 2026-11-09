'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { STATUS_PRIORITY, deriveCustomerStatus } = require('../lib/agent_workspace/status_policy');
const { buildReviewOverlay } = require('../lib/agent_workspace/customer_projection');

function overlayOf(tasks, settlementStatus = '') {
  return buildReviewOverlay({ tasks, settlementStatus });
}

test('状态优先级固定:rephoto > recognizing > ready_for_sync > tour_pending > review_pending > needs_remedy > needs_confirm > passed', () => {
  assert.deepEqual(STATUS_PRIORITY, [
    'rephoto',
    'recognizing',
    'ready_for_sync',
    'tour_pending',
    'review_pending',
    'needs_remedy',
    'needs_confirm',
    'passed',
  ]);
});

test('客户存在但无有效批次关联 → ready_for_sync(不丢行)', () => {
  const s = deriveCustomerStatus({ hasActiveBatch: false, overlay: null, settlementStatus: '' });
  assert.equal(s.reviewStatus, 'ready_for_sync');
  assert.equal(s.nextAction, 'sync_to_batch');
});

test('重拍优先于一切;同时命中多异常时列表取最高优先级、reasonCodes 返回全部', () => {
  const overlay = overlayOf([
    { docTypeFinal: 'receipt', rephotoRequested: true },
    { docTypeFinal: 'receipt', machineState: 'processing' },
    { docTypeFinal: 'receipt' }, // 未表态
  ]);
  const s = deriveCustomerStatus({ hasActiveBatch: true, overlay, settlementStatus: '' });
  assert.equal(s.reviewStatus, 'rephoto');
  assert.ok(s.reasonCodes.includes('rephoto'));
  assert.ok(s.reasonCodes.includes('recognizing'));
  assert.ok(s.reasonCodes.includes('tour_pending'));
  assert.equal(s.nextAction, 'review_rephoto');
});

test('票级修订#1:存在未表态小票 → tour_pending,跳团号匹配(实时审核定位)', () => {
  const overlay = overlayOf([
    { docTypeFinal: 'passport' },
    { docTypeFinal: 'receipt', modeRawPre: '乐天SG-本司' }, // 未表态
  ]);
  const s = deriveCustomerStatus({ hasActiveBatch: true, overlay, settlementStatus: '' });
  assert.equal(s.reviewStatus, 'tour_pending');
  assert.equal(s.nextAction, 'confirm_tour');
});

test('全部表态但仍有必审未完成 → review_pending', () => {
  const overlay = overlayOf([
    { docTypeFinal: 'receipt', tourStance: 'matched', modeRawPre: 'A' }, // 未 reviewed
  ]);
  const s = deriveCustomerStatus({ hasActiveBatch: true, overlay, settlementStatus: '' });
  assert.equal(s.reviewStatus, 'review_pending');
  assert.equal(s.nextAction, 'review_fields');
});

test('结算态透传:待补救/待人工确认/已通过', () => {
  const done = overlayOf([
    { docTypeFinal: 'receipt', tourStance: 'matched', modeRawPre: 'A', reviewed: true },
  ]);
  assert.equal(
    deriveCustomerStatus({ hasActiveBatch: true, overlay: done, settlementStatus: 'needs_remedy' }).reviewStatus,
    'needs_remedy',
  );
  assert.equal(
    deriveCustomerStatus({ hasActiveBatch: true, overlay: done, settlementStatus: 'needs_confirm' }).reviewStatus,
    'needs_confirm',
  );
  const passed = deriveCustomerStatus({ hasActiveBatch: true, overlay: done, settlementStatus: 'settled' });
  assert.equal(passed.reviewStatus, 'passed');
  assert.equal(passed.nextAction, 'view_record');
});

test('审完但未结算 → needs_confirm + awaiting_settlement 原因码(显式口径,非 passed)', () => {
  const done = overlayOf([
    { docTypeFinal: 'receipt', tourStance: 'matched', modeRawPre: 'A', reviewed: true },
    { docTypeFinal: 'passport', reviewed: true },
  ]);
  const s = deriveCustomerStatus({ hasActiveBatch: true, overlay: done, settlementStatus: '' });
  assert.equal(s.reviewStatus, 'needs_confirm');
  assert.ok(s.reasonCodes.includes('awaiting_settlement'));
});

test('无小票豁免客户(纯护照)不卡 tour_pending,审完未结算走 awaiting_settlement', () => {
  const overlay = overlayOf([{ docTypeFinal: 'passport', reviewed: true }]);
  const s = deriveCustomerStatus({ hasActiveBatch: true, overlay, settlementStatus: '' });
  assert.notEqual(s.reviewStatus, 'tour_pending');
});

test('识别中优先于待表态(修订#1 与识别态的边界)', () => {
  const overlay = overlayOf([
    { docTypeFinal: 'receipt', machineState: 'queued' },
  ]);
  const s = deriveCustomerStatus({ hasActiveBatch: true, overlay, settlementStatus: '' });
  assert.equal(s.reviewStatus, 'recognizing');
});
