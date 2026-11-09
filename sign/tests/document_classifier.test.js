const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyDocument,
  scoreDocumentText,
} = require('../lib/document_classifier');
const { DOC_TYPES } = require('../lib/package_constants');

test('classifyDocument recognizes passport-like OCR text', () => {
  const result = classifyDocument({
    fileName: 'passport_photo.jpg',
    ocrText: `
      PASSPORT
      PEOPLE'S REPUBLIC OF CHINA
      Nationality CHN
      Passport No EJ1234567
      Surname CHENG
      Given names SHANSHAN
      P<CHNCHENG<<SHANSHAN
    `,
  });

  assert.equal(result.docType, DOC_TYPES.PASSPORT);
  assert.equal(result.needsReview, false);
  assert.ok(result.scores.passport > result.scores.receipt);
});

test('classifyDocument recognizes receipt-like OCR text', () => {
  const result = classifyDocument({
    fileName: 'wechat_001.png',
    ocrText: `
      LOTTE DUTY FREE
      SaleDT 2025-12-26 11:55
      Passport No. CHN-ED52
      Date of Departure 2025-12-28
      Flight No. 9C8560
      ITEM Description
      Amount 32
      TOTAL 32
      WECHATPAY
      APPROVAL NO
    `,
  });

  assert.equal(result.docType, DOC_TYPES.RECEIPT);
  assert.equal(result.needsReview, false);
  assert.ok(result.scores.receipt > result.scores.other);
});

test('classifyDocument recognizes shilla-family receipts without lotte duty free keywords', () => {
  const result = classifyDocument({
    fileName: 'sample_receipt.jpg',
    ocrText: `
      THE SHILLA
      0325652400439
      G 71992
      SALE DATE 2025-12-02 17:20
      Date of Departure 2025-12-03
    `,
  });

  assert.equal(result.docType, DOC_TYPES.RECEIPT);
  assert.ok(result.scores.receipt > result.scores.other);
});

test('classifyDocument routes ticket-like OCR text into other', () => {
  const result = classifyDocument({
    fileName: 'boarding-pass.jpeg',
    ocrText: `
      BOARDING PASS
      FLIGHT KE123
      FROM ICN TO GMP
      GATE 12
      SEAT 18A
      BOARDING TIME 07:30
      TERMINAL 2
    `,
  });

  assert.equal(result.docType, DOC_TYPES.OTHER);
  assert.equal(result.needsReview, false);
});

test('classifyDocument recognizes Chinese passport keywords without mojibake patterns', () => {
  const result = classifyDocument({
    fileName: '微信图片_001.jpg',
    ocrText: `
      中华人民共和国
      护照
      姓名 张三
      护照号 E12345678
      国籍 中国
    `,
  });

  assert.equal(result.docType, DOC_TYPES.PASSPORT);
  assert.equal(result.needsReview, false);
});

test('classifyDocument recognizes Chinese receipt keywords without mojibake patterns', () => {
  const result = classifyDocument({
    fileName: '微信收款图.png',
    ocrText: `
      收款凭证
      小票
      付款金额 56000
      出境日期 2026-04-28
      团号 G12345
    `,
  });

  assert.equal(result.docType, DOC_TYPES.RECEIPT);
  assert.equal(result.needsReview, false);
});

test('classifyDocument marks weak ambiguous text for review', () => {
  const result = classifyDocument({
    fileName: 'wechat_image.png',
    ocrText: 'share calendar service details',
  });

  assert.equal(result.needsReview, true);
  assert.ok(result.reviewReasons.length >= 1);
});

test('scoreDocumentText returns explainable category scores', () => {
  const scores = scoreDocumentText('passport chn nationality boarding pass total amount');

  assert.equal(typeof scores.passport, 'number');
  assert.equal(typeof scores.receipt, 'number');
  assert.equal(typeof scores.other, 'number');
});
