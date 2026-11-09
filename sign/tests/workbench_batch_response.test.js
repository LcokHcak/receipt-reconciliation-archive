const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const { PROCESS_RESULTS } = require('../lib/workbench_task_flow');
const { createWorkbenchBatchResponseBuilder } = require('../lib/workbench_batch_response');

test('batch response builder adds workflow state and status counts', () => {
  const responseBuilder = createWorkbenchBatchResponseBuilder({
    toStorageUrl: (batchId, relativePath) => (relativePath ? `/storage/${batchId}/${relativePath}` : ''),
    buildRecognitionProgressSnapshot: () => ({ percent: 100 }),
    buildResponseSourceGroups: () => [{ key: 'root', taskCount: 2 }],
  });

  const batch = {
    id: 'batch_1',
    name: 'Batch 1',
    scenario: 'FullProcess',
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:01:00.000Z',
    machineState: 'completed',
    tasks: [
      {
        id: 'passport_ready',
        machineState: 'completed',
        docTypeFinal: DOC_TYPES.PASSPORT,
        classificationConfirmed: true,
        extractedNameFinal: 'ZHANG SAN',
        passportNoFinal: 'E12345678',
        chineseNameFinal: '张三',
        finalSignaturePath: 'final_signatures/passport_ready.png',
        sourceImagePath: 'source/passport_ready.jpg',
      },
      {
        id: 'receipt_missing',
        machineState: 'completed',
        docTypeFinal: DOC_TYPES.RECEIPT,
        classificationConfirmed: true,
        receiptStoreFinal: 'LOTTE',
        receiptFieldModelMeta: {
          source: 'receipt_field_detection_crop_ocr',
          fields: {
            receipt_no_region: { value: '12345678901234' },
          },
          detections: {
            receipt_no_region: {
              confidence: 0.86,
              box: { left: 20, top: 30, right: 180, bottom: 52 },
            },
          },
        },
      },
    ],
  };

  const response = responseBuilder.summarizeBatch(batch, { includeTasks: true });

  assert.equal(response.counts.finalReview, 1);
  assert.equal(response.counts.fields, 1);
  assert.equal(response.tasks[0].workflowState.stage, 'final_review');
  assert.equal(response.tasks[0].finalSignatureUrl, '/storage/batch_1/final_signatures/passport_ready.png');
  assert.equal(response.tasks[1].processResult, PROCESS_RESULTS.FIELDS);
  assert.deepEqual(response.tasks[1].fieldRegions, [
    {
      key: 'receiptNoFinal',
      label: '\u5c0f\u7968\u53f7',
      modelLabel: 'receipt_no_region',
      confidence: 0.86,
      source: 'receipt_field_detection_crop_ocr',
      value: '12345678901234',
      box: { left: 20, top: 30, width: 160, height: 22 },
    },
  ]);
});

// \u5de5\u4f5c\u53f0\u9996\u9875\u5206\u79bb(2026-07-18):task.reviewedAt \u4e0a\u6d6e\u4e3a\u6279\u6b21\u6458\u8981 reviewStats,
// \u9996\u9875"\u4eca\u65e5\u5ba1\u6838/\u5b8c\u6210\u65f6\u95f4/\u8017\u65f6"\u90fd\u4ece\u8fd9\u91cc\u53d6\u3002\u65e5\u671f\u6876\u6309\u4e1a\u52a1\u65f6\u533a(KST)\u6298\u7b97\u3002
test('summarizeBatch \u4e0a\u6d6e reviewStats:\u9996\u672b\u5ba1\u6838\u65f6\u95f4 + \u6309\u65e5\u8ba1\u6570;\u672a\u5ba1\u4efb\u52a1\u4e0d\u8ba1', () => {
  const responseBuilder = createWorkbenchBatchResponseBuilder({
    toStorageUrl: () => '',
    buildRecognitionProgressSnapshot: () => ({}),
    buildResponseSourceGroups: () => [],
  });

  const batch = {
    id: 'batch_rs',
    tasks: [
      // 2026-05-03T23:30Z = KST 2026-05-04 08:30 \u2192 \u843d\u5728 05-04 \u6876(\u65f6\u533a\u6298\u7b97\u5b9e\u8bc1)
      { id: 't1', machineState: 'completed', reviewedAt: '2026-05-03T23:30:00.000Z' },
      { id: 't2', machineState: 'completed', reviewedAt: '2026-05-04T02:00:00.000Z' },
      { id: 't3', machineState: 'completed', reviewedAt: '2026-05-01T00:00:00.000Z' },
      { id: 't4', machineState: 'completed' }, // \u672a\u5ba1:\u4e0d\u8ba1
      { id: 't5', machineState: 'queued', reviewedAt: '' },
    ],
  };

  const { reviewStats } = responseBuilder.summarizeBatch(batch, { includeTasks: false });
  assert.equal(reviewStats.firstReviewedAt, '2026-05-01T00:00:00.000Z');
  assert.equal(reviewStats.lastReviewedAt, '2026-05-04T02:00:00.000Z');
  assert.deepEqual(reviewStats.reviewedByDate, {
    '2026-05-01': 1,
    '2026-05-04': 2,
  });
  // P2:每天首末审核时间(工时跨度地基);05-04 桶=t1(KST 折算进来)+t2
  assert.deepEqual(reviewStats.reviewSpans, {
    '2026-05-01': { first: '2026-05-01T00:00:00.000Z', last: '2026-05-01T00:00:00.000Z' },
    '2026-05-04': { first: '2026-05-03T23:30:00.000Z', last: '2026-05-04T02:00:00.000Z' },
  });
});

test('summarizeBatch \u900f\u4f20\u5bfc\u51fa\u7559\u75d5\u4e09\u5b57\u6bb5(P1:\u9996\u9875\u5bfc\u51fa\u72b6\u6001\u5217/\u5f85\u5bfc\u51fa\u7684\u6570\u636e\u6e90)', () => {
  const responseBuilder = createWorkbenchBatchResponseBuilder({
    toStorageUrl: () => '',
    buildRecognitionProgressSnapshot: () => ({}),
    buildResponseSourceGroups: () => [],
  });
  const summary = responseBuilder.summarizeBatch({
    id: 'b_exp',
    exportedAt: '2026-07-18T09:00:00.000Z',
    exportedBy: 'admin',
    exportKind: 'workbook',
    tasks: [],
  }, {});
  assert.equal(summary.exportedAt, '2026-07-18T09:00:00.000Z');
  assert.equal(summary.exportedBy, 'admin');
  assert.equal(summary.exportKind, 'workbook');

  const bare = responseBuilder.summarizeBatch({ id: 'b_bare', tasks: [] }, {});
  assert.equal(bare.exportedAt, '');
  assert.equal(bare.exportKind, '');
});

test('summarizeBatch reviewStats:\u7a7a\u6279\u6b21/\u5168\u672a\u5ba1\u7ed9\u7a7a\u7edf\u8ba1,\u4e0d\u62a5\u9519', () => {
  const responseBuilder = createWorkbenchBatchResponseBuilder({
    toStorageUrl: () => '',
    buildRecognitionProgressSnapshot: () => ({}),
    buildResponseSourceGroups: () => [],
  });
  const { reviewStats } = responseBuilder.summarizeBatch({ id: 'b', tasks: [] }, {});
  assert.deepEqual(reviewStats, { firstReviewedAt: '', lastReviewedAt: '', reviewedByDate: {}, reviewSpans: {} });
});
