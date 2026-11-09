'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeReceiptJunk } = require('../lib/qwen_ocr/qwen_ocr_adapter');

// 审计H4:build 路径此前直接读原始 sidecar 绕过垃圾值过滤器,历史脏 sidecar(编造团号/票号)
// 裸奔进任务混绿。修=build 也过 sanitizeReceiptJunk。这里锁两层:①过滤器行为 ②build 调用点契约。

test('sanitizeReceiptJunk:小票编造团号/票号置空+qwen_junk标红+needsReview', () => {
  const dirty = {
    docTypeFinal: 'receipt',
    receiptNoAuto: '0000000000000000', receiptNoRawAuto: '0000-0000-0000-0000',
    groupNoAuto: '12345', // 病例:编造团号还骗过5位长度规则
    reviewReasons: [],
  };
  const out = sanitizeReceiptJunk(dirty);
  assert.equal(out.receiptNoAuto, '', '编造票号必须置空');
  assert.equal(out.receiptNoRawAuto, '');
  assert.equal(out.groupNoAuto, '', '编造团号必须置空');
  assert.ok(out.reviewReasons.includes('qwen_junk_receipt_no'));
  assert.ok(out.reviewReasons.includes('qwen_junk_group_no'));
  assert.equal(out.needsReview, true, '标红后不得自动过审');
});

test('sanitizeReceiptJunk:真实值不误伤;非小票原样返回', () => {
  const clean = { docTypeFinal: 'receipt', receiptNoAuto: '0326438300043', groupNoAuto: '26141846', reviewReasons: [] };
  const out = sanitizeReceiptJunk(clean);
  assert.equal(out.receiptNoAuto, '0326438300043');
  assert.equal(out.groupNoAuto, '26141846');
  assert.ok(!out.needsReview);

  const passport = { docTypeFinal: 'passport', passportNoAuto: 'E12345678' };
  assert.equal(sanitizeReceiptJunk(passport), passport, '非小票不动');
});

// 契约:build 路径(qwenBuildDocumentAnalysisForTask)必须对读回的 sidecar 过 sanitizeReceiptJunk。
// 防有人日后把这层去掉重新打开绕过窗口。
test('契约:batch_processing build 路径调用 sanitizeReceiptJunk', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/batch_processing_service.js'), 'utf8');
  const fnStart = src.indexOf('function qwenBuildDocumentAnalysisForTask');
  assert.ok(fnStart > 0, '应存在 build 路径函数');
  const fnBody = src.slice(fnStart, fnStart + 600);
  assert.ok(/sanitizeReceiptJunk\s*\(/.test(fnBody), 'build 路径必须对 sidecar 过 sanitizeReceiptJunk(审计H4)');
  assert.ok(/readSidecar/.test(fnBody), 'build 路径读 sidecar');
});
