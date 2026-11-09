const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeDocumentOcr } = require('../lib/paddle_document_analyzer');
const { DOC_TYPES } = require('../lib/package_constants');

test('analyzeDocumentOcr classifies and extracts passport fields', () => {
  const result = analyzeDocumentOcr({
    fileName: 'passport_1.jpg',
    sourcePath: 'D:\\docs\\passport_1.jpg',
    sourceKey: 'batch/passport_1.jpg',
    ocrRecord: {
      joined_text: `
        PASSPORT
        PEOPLE'S REPUBLIC OF CHINA
        Surname
        CHENG
        Given Names
        SHANSHAN
        Passport No EJ1234567
        P<CHNCHENG<<SHANSHAN<<<<<<<<<<<<<<<<
        EJ1234567CHN9001011M3001012<<<<<<<<<<
      `,
      line_count: 9,
      average_score: 0.93,
      lines: [
        { text: 'PASSPORT', box: { top: 10, left: 10 } },
        { text: "PEOPLE'S REPUBLIC OF CHINA", box: { top: 20, left: 10 } },
        { text: 'Surname', box: { top: 30, left: 10 } },
        { text: 'CHENG', box: { top: 40, left: 10 } },
        { text: 'Given Names', box: { top: 50, left: 10 } },
        { text: 'SHANSHAN', box: { top: 60, left: 10 } },
        { text: 'Passport No EJ1234567', box: { top: 70, left: 10 } },
        { text: 'P<CHNCHENG<<SHANSHAN<<<<<<<<<<<<<<<<', box: { top: 80, left: 10 } },
        { text: 'EJ1234567CHN9001011M3001012<<<<<<<<<<', box: { top: 90, left: 10 } },
      ],
    },
  });

  assert.equal(result.docTypeAuto, DOC_TYPES.PASSPORT);
  assert.equal(result.extractedNameAuto, 'CHENG SHANSHAN');
  assert.equal(result.chineseNameAuto, '');
  assert.equal(result.passportNoAuto, 'EJ1234567');
  assert.equal(result.lineCount, 9);
});

test('analyzeDocumentOcr carries over the parsed passport chinese name', () => {
  const result = analyzeDocumentOcr({
    fileName: 'passport_zh.jpg',
    sourcePath: 'D:\\docs\\passport_zh.jpg',
    sourceKey: 'batch/passport_zh.jpg',
    ocrRecord: {
      joined_text: `
        PASSPORT
        PEOPLE'S REPUBLIC OF CHINA
        姓名
        张三
        Passport No EJ1234567
      `,
      line_count: 5,
      average_score: 0.92,
      lines: [
        { text: 'PASSPORT', box: { top: 10, left: 10 } },
        { text: "PEOPLE'S REPUBLIC OF CHINA", box: { top: 20, left: 10 } },
        { text: '姓名', box: { top: 30, left: 10 } },
        { text: '张三', box: { top: 40, left: 10 } },
        { text: 'Passport No EJ1234567', box: { top: 50, left: 10 } },
      ],
    },
  });

  assert.equal(result.docTypeAuto, DOC_TYPES.PASSPORT);
  assert.equal(result.chineseNameAuto, '张三');
});

test('analyzeDocumentOcr classifies and extracts receipt fields', () => {
  const result = analyzeDocumentOcr({
    fileName: 'receipt_1.jpg',
    sourcePath: 'D:\\docs\\receipt_1.jpg',
    sourceKey: 'batch/receipt_1.jpg',
    ocrRecord: {
      joined_text: `
        THE SHILLA DUTY FREE
        SHOPPING CARD
        SALEDATE:2025-12-06 13:23
        Name: AN YUMENG
        Passport No.: EQ9196495
        FightNo:9C7206
        TOTAL $ 3,069.00
      `,
      line_count: 7,
      average_score: 0.88,
      lines: [
        { text: 'THE SHILLA DUTY FREE', box: { top: 10, left: 10 } },
        { text: 'SHOPPING CARD', box: { top: 20, left: 10 } },
        { text: 'SALEDATE:2025-12-06 13:23', box: { top: 30, left: 10 } },
        { text: 'Name: AN YUMENG', box: { top: 40, left: 10 } },
        { text: 'Passport No.: EQ9196495', box: { top: 50, left: 10 } },
        { text: 'FightNo:9C7206', box: { top: 60, left: 10 } },
        { text: 'TOTAL $ 3,069.00', box: { top: 70, left: 10 } },
      ],
    },
  });

  assert.equal(result.docTypeAuto, DOC_TYPES.RECEIPT);
  assert.equal(result.passportNoAuto, 'EQ9196495');
  assert.equal(result.receiptStoreAuto, 'THE SHILLA');
  assert.equal(result.receiptAmountAuto, '3069');
});

test('analyzeDocumentOcr can keep receipt extraction on second-pass sparse OCR when doc type is known', () => {
  const result = analyzeDocumentOcr({
    fileName: 'task_1.jpg',
    sourcePath: 'D:\\docs\\task_1.jpg',
    sourceKey: 'batch/task_1.jpg',
    forcedDocType: DOC_TYPES.RECEIPT,
    ocrRecord: {
      joined_text: `
        SH1LLALDARK
        221256320003155
        G
      `,
      line_count: 3,
      average_score: 0.78,
      lines: [
        { text: 'SH1LLALDARK', box: { top: 10, left: 10 } },
        { text: '221256320003155', box: { top: 20, left: 10 } },
        { text: 'G', box: { top: 30, left: 10 } },
      ],
    },
  });

  assert.equal(result.docTypeAuto, DOC_TYPES.RECEIPT);
  assert.equal(result.receiptStoreAuto, 'THE SHILLA');
  assert.equal(result.receiptNoAuto, '221256320003155');
});

test('analyzeDocumentOcr can use a model classification override before OCR-rule classification', () => {
  const result = analyzeDocumentOcr({
    fileName: 'ambiguous.jpg',
    sourcePath: 'D:\\docs\\ambiguous.jpg',
    sourceKey: 'batch/ambiguous.jpg',
    classificationOverride: {
      docType: DOC_TYPES.RECEIPT,
      confidence: 0.93,
      needsReview: false,
      reviewReasons: [],
      scores: {
        passport: 0.02,
        receipt: 0.93,
        other: 0.05,
      },
      modelMeta: {
        source: 'paddlex_image_classification',
        modelName: 'PP-HGNetV2-B6',
      },
    },
    ocrRecord: {
      joined_text: 'PASSPORT PEOPLE REPUBLIC OF CHINA',
      line_count: 1,
      average_score: 0.9,
      lines: [{ text: 'PASSPORT PEOPLE REPUBLIC OF CHINA', box: { top: 10, left: 10 } }],
    },
  });

  assert.equal(result.docTypeAuto, DOC_TYPES.RECEIPT);
  assert.equal(result.docTypeConfidence, 0.93);
  // Rule-set v2: every receipt record gets needsReview=true because the
  // OCR text alone rarely satisfies every strict field rule. Classification
  // staying at 'model' still proves the override took effect.
  assert.equal(result.classificationSource, 'model');
  assert.equal(result.modelMeta.modelName, 'PP-HGNetV2-B6');
});
