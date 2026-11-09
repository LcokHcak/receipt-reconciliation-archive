'use strict';

/**
 * auto_approve_policy — B1 自动终审策略边界测试
 *
 * 红线:不让错误信息自动通过。逐条验证「放行」与「各闸一票否决」。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluateAutoApprove,
  BLOCK_CODES,
  DEFAULT_OPTIONS,
  POLICY_VERSION,
} = require('../lib/auto_approve_policy');

// 一张「字段全过」的 LOTTE 小票审核任务(LOTTE:小票号14位、团号8位)。
function validReceiptTask(overrides = {}) {
  return {
    id: 'task-1',
    docTypeFinal: 'receipt',
    docTypeAuto: 'receipt',
    docTypeConfidence: 0.95,
    machineState: 'completed',
    classificationConfirmed: true,
    needsReview: false,
    reviewReasons: '',
    rephotoRequested: false,
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '12345678901234', // 14 位
    groupNoFinal: '12345678', // 8 位
    purchaseDateFinal: '2026-01-10',
    departureDateFinal: '2026-01-15',
    ...overrides,
  };
}

// 双命中:团号 ∈ 团号表 且 小票号 ∈ 免税店账单
const matched = { groupCodeInTable: true, receiptInBill: true };

test('放行:全部硬约束成立 → approve=true,blockedBy 空', () => {
  const r = evaluateAutoApprove(validReceiptTask(), matched);
  assert.equal(r.approve, true, JSON.stringify(r.blockedBy));
  assert.deepEqual(r.blockedBy, []);
  assert.equal(r.policyVersion, POLICY_VERSION);
  assert.ok(r.reasons.includes('group_code_in_table'));
  assert.ok(r.reasons.includes('all_fields_valid'));
});

test('一票否决:置信 < 0.92', () => {
  const r = evaluateAutoApprove(validReceiptTask({ docTypeConfidence: 0.8 }), matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.LOW_CONFIDENCE));
});

test('一票否决:团号不在本批团号表', () => {
  const r = evaluateAutoApprove(validReceiptTask(), { groupCodeInTable: false });
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.GROUP_CODE_NOT_IN_TABLE));
});

test('一票否决:团号信号缺失(未传 = 视为不在表)', () => {
  const r = evaluateAutoApprove(validReceiptTask(), {});
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.GROUP_CODE_NOT_IN_TABLE));
});

test('一票否决:小票号不在免税店账单(命门——读错的号对不上账单)', () => {
  const r = evaluateAutoApprove(validReceiptTask(), { groupCodeInTable: true, receiptInBill: false });
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.RECEIPT_NOT_IN_BILL));
});

test('团号命中但账单缺失 → 仍不放行(单团号不够)', () => {
  const r = evaluateAutoApprove(validReceiptTask(), { groupCodeInTable: true });
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.RECEIPT_NOT_IN_BILL));
});

test('一票否决:docType=other 永不自动', () => {
  const r = evaluateAutoApprove(validReceiptTask({ docTypeFinal: 'other' }), matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.DOC_TYPE_NOT_ALLOWED));
});

test('一票否决:护照默认不在第一档白名单', () => {
  const passport = {
    id: 'p1',
    docTypeFinal: 'passport',
    docTypeConfidence: 0.99,
    machineState: 'completed',
    classificationConfirmed: true,
    extractedNameFinal: 'ZHANG SAN',
    passportNoFinal: 'EA1234567',
    chineseNameFinal: '张三',
  };
  const r = evaluateAutoApprove(passport, matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.DOC_TYPE_NOT_ALLOWED));
});

test('一票否决:缺字段(团号空)', () => {
  const r = evaluateAutoApprove(validReceiptTask({ groupNoFinal: '', groupNoAuto: '' }), matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.MISSING_FIELDS));
});

test('一票否决:格式错(LOTTE 团号只有 3 位;小票号已解禁不再拦)', () => {
  // 小票号解禁(RECEIPT_NO_STRICT=false)后长度不构成格式错 → 改用团号(未解禁)验证同一否决机制。
  const r = evaluateAutoApprove(validReceiptTask({ groupNoFinal: '123' }), matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.INVALID_FIELDS));

  // 回归:13位 LOTTE 小票号(旧规则要14位)解禁后不再是格式错
  const relaxed = evaluateAutoApprove(validReceiptTask({ receiptNoFinal: '1234567890123' }), matched);
  assert.ok(!relaxed.blockedBy.includes(BLOCK_CODES.INVALID_FIELDS), JSON.stringify(relaxed.blockedBy));
});

test('needsReview 布尔不再硬拦(机器对小票默认全标,护照字段噪声)', () => {
  // 关键修正:机器 needsReview 99% 为真且多为护照字段问题,对小票无关。
  // 小票字段由本策略强校验独立覆盖,故 needsReview 布尔本身不拦。
  const r = evaluateAutoApprove(validReceiptTask({ needsReview: true }), matched);
  assert.equal(r.approve, true, JSON.stringify(r.blockedBy));
});

test('软性/护照字段 reason 不拦小票(field_passport_no_invalid 等)', () => {
  const r = evaluateAutoApprove(
    validReceiptTask({ reviewReasons: 'field_passport_no_invalid|field_chinese_name_invalid|模糊' }),
    matched,
  );
  assert.equal(r.approve, true, JSON.stringify(r.blockedBy));
});

test('一票否决:机器硬信号 qwen_no_document', () => {
  const r = evaluateAutoApprove(validReceiptTask({ reviewReasons: 'qwen_no_document' }), matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.MACHINE_HARD_FLAG));
});

test('一票否决:OCR 未完成(processing)', () => {
  const r = evaluateAutoApprove(validReceiptTask({ machineState: 'processing' }), matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.MACHINE_NOT_COMPLETED));
});

test('一票否决:需重拍', () => {
  const r = evaluateAutoApprove(validReceiptTask({ rephotoRequested: true }), matched);
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.REPHOTO_REQUESTED));
});

test('日期倒挂(购买晚于离境)→ 格式闸拦截', () => {
  const r = evaluateAutoApprove(
    validReceiptTask({ purchaseDateFinal: '2026-01-20', departureDateFinal: '2026-01-15' }),
    matched,
  );
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.INVALID_FIELDS));
});

test('SHILLA IPARK 店专属长度(小票13/团号5)放行', () => {
  const r = evaluateAutoApprove(
    validReceiptTask({
      receiptStoreFinal: 'SHILLA IPARK',
      receiptNoFinal: '1234567890123', // 13 位
      groupNoFinal: '12345', // 5 位
    }),
    matched,
  );
  assert.equal(r.approve, true, JSON.stringify(r.blockedBy));
});

test('多闸同时不过:全部记入 blockedBy', () => {
  const r = evaluateAutoApprove(
    validReceiptTask({ docTypeConfidence: 0.5, machineState: 'error', reviewReasons: 'qwen_no_document' }),
    { groupCodeInTable: false },
  );
  assert.equal(r.approve, false);
  assert.ok(r.blockedBy.includes(BLOCK_CODES.LOW_CONFIDENCE));
  assert.ok(r.blockedBy.includes(BLOCK_CODES.MACHINE_NOT_COMPLETED));
  assert.ok(r.blockedBy.includes(BLOCK_CODES.MACHINE_HARD_FLAG));
  assert.ok(r.blockedBy.includes(BLOCK_CODES.GROUP_CODE_NOT_IN_TABLE));
});

test('阈值可覆盖:放宽到 0.85 时 0.88 置信可过', () => {
  const r = evaluateAutoApprove(
    validReceiptTask({ docTypeConfidence: 0.88 }),
    matched,
    { minDocTypeConfidence: 0.85 },
  );
  assert.equal(r.approve, true, JSON.stringify(r.blockedBy));
});

test('默认阈值就是 0.92,白名单只有 receipt', () => {
  assert.equal(DEFAULT_OPTIONS.minDocTypeConfidence, 0.92);
  assert.deepEqual([...DEFAULT_OPTIONS.allowedDocTypes], ['receipt']);
});
