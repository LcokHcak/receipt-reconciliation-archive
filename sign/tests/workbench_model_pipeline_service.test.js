const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createWorkbenchModelPipelineService } = require('../lib/workbench_model_pipeline_service');

function createTask(id, imagePath) {
  return {
    id,
    imagePath,
  };
}

test('processChunk runs model stages in order and writes merged results', async () => {
  const calls = [];
  const taskA = createTask('task-a', 'C:\\batch\\a.png');
  const taskB = createTask('task-b', 'C:\\batch\\b.png');
  const pendingChunk = [taskA, taskB];
  const ocrRecordA = { image: taskA.imagePath, text: 'a' };
  const ocrRecordB = { image: taskB.imagePath, text: 'b' };
  const initialPassport = { docTypeFinal: 'passport', source: 'initial-a' };
  const initialReceipt = { docTypeFinal: 'receipt', source: 'initial-b' };
  const passportRecord = { image: taskA.imagePath, text: 'passport second' };
  const receiptRecord = { image: taskB.imagePath, text: 'receipt second' };
  const finalPassport = { docTypeFinal: 'passport', source: 'passport-second' };
  const finalReceipt = { docTypeFinal: 'receipt', source: 'receipt-second' };
  const fieldPassport = { docTypeFinal: 'passport', source: 'passport-field' };
  let appliedPayload;

  const service = createWorkbenchModelPipelineService({
    resolveImagePath: (_batchId, task) => task.imagePath,
    runStage: async (_batchId, stageName, action) => {
      calls.push(['stage', stageName]);
      return action();
    },
    runOcr: async ({ imagePaths }) => {
      calls.push(['ocr', imagePaths]);
      return [ocrRecordA, ocrRecordB];
    },
    classifyDocumentTypesForChunk: async () => {
      calls.push(['classification']);
      return new Map([
        ['task-a', { docType: 'passport' }],
        ['task-b', { docType: 'receipt' }],
      ]);
    },
    buildDocumentAnalysisForTask: (_batchId, task, record, options = {}) => {
      calls.push(['analysis', task.id, record.text, options]);
      if (record === ocrRecordA) {
        assert.deepEqual(options.classificationOverride, { docType: 'passport' });
        return initialPassport;
      }
      if (record === ocrRecordB) {
        assert.deepEqual(options.classificationOverride, { docType: 'receipt' });
        return initialReceipt;
      }
      if (record === passportRecord) {
        assert.equal(options.forcedDocType, 'passport');
        return finalPassport;
      }
      if (record === receiptRecord) {
        assert.equal(options.forcedDocType, 'receipt');
        return finalReceipt;
      }
      throw new Error(`unexpected record ${record.text}`);
    },
    runPassportSecondPassForChunk: async (_batchId, _dirs, _pendingChunk, initialAnalysisMap) => {
      calls.push(['passport_second_pass', initialAnalysisMap]);
      assert.equal(initialAnalysisMap.get('task-a'), initialPassport);
      return new Map([['task-a', passportRecord]]);
    },
    runReceiptSecondPassForChunk: async (_batchId, _dirs, _pendingChunk, initialAnalysisMap) => {
      calls.push(['receipt_second_pass', initialAnalysisMap]);
      assert.equal(initialAnalysisMap.get('task-b'), initialReceipt);
      return new Map([['task-b', receiptRecord]]);
    },
    runPassportFieldModelForChunk: async (_batchId, _dirs, _pendingChunk, finalAnalysisMap) => {
      calls.push(['passport_field_model', finalAnalysisMap]);
      assert.equal(finalAnalysisMap.get('task-a'), finalPassport);
      assert.equal(finalAnalysisMap.get('task-b'), finalReceipt);
      return new Map([['task-a', fieldPassport]]);
    },
    applyChunkResults: async (payload) => {
      calls.push(['apply_results']);
      appliedPayload = payload;
    },
    docTypes: {
      passport: 'passport',
      receipt: 'receipt',
    },
  });

  await service.processChunk({
    batchId: 'batch-1',
    dirs: { rawJson: 'raw' },
    pendingChunk,
    paddleOcrOptions: { opt: true },
  });

  assert.deepEqual(
    calls.filter((call) => call[0] === 'stage').map((call) => call[1]),
    ['classification', 'ocr', 'passport_second_pass', 'receipt_second_pass', 'passport_field_model', 'apply_results']
  );
  assert.deepEqual(calls.find((call) => call[0] === 'ocr')[1], [taskA.imagePath, taskB.imagePath]);
  assert.equal(appliedPayload.ocrResultMap.get(path.resolve(taskA.imagePath)), ocrRecordA);
  assert.equal(appliedPayload.initialAnalysisMap.get('task-a'), initialPassport);
  assert.equal(appliedPayload.passportSecondPassMap.get('task-a'), passportRecord);
  assert.equal(appliedPayload.receiptSecondPassMap.get('task-b'), receiptRecord);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-a'), fieldPassport);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-b'), finalReceipt);
  assert.deepEqual([...appliedPayload.extractionTaskIds], ['task-a', 'task-b']);
  assert.deepEqual([...appliedPayload.classificationOnlyTaskIds], []);
});

test('processChunk routes by classification before OCR and skips low confidence and other records', async () => {
  const calls = [];
  const passportTask = createTask('task-passport', 'C:\\batch\\passport.png');
  const receiptTask = createTask('task-receipt', 'C:\\batch\\receipt.png');
  const otherTask = createTask('task-other', 'C:\\batch\\other.png');
  const lowConfidenceTask = createTask('task-low', 'C:\\batch\\low.png');
  const pendingChunk = [passportTask, receiptTask, otherTask, lowConfidenceTask];
  const passportRecord = { image: passportTask.imagePath, text: 'passport ocr' };
  const receiptRecord = { image: receiptTask.imagePath, text: 'receipt ocr' };
  const passportSecondRecord = { image: passportTask.imagePath, text: 'passport second-pass' };
  const receiptSecondRecord = { image: receiptTask.imagePath, text: 'receipt second-pass' };
  const passportAnalysis = { docTypeFinal: 'passport', source: 'passport-analysis' };
  const receiptAnalysis = { docTypeFinal: 'receipt', source: 'receipt-analysis' };
  const passportSecondAnalysis = { docTypeFinal: 'passport', source: 'passport-second-pass' };
  const receiptSecondAnalysis = { docTypeFinal: 'receipt', source: 'receipt-second-pass' };
  const passportFieldAnalysis = { docTypeFinal: 'passport', source: 'passport-field' };
  const otherAnalysis = { docTypeFinal: 'other', source: 'other-classification' };
  const lowAnalysis = { docTypeFinal: 'passport', needsReview: true, source: 'low-classification' };
  let appliedPayload;

  const service = createWorkbenchModelPipelineService({
    resolveImagePath: (_batchId, task) => task.imagePath,
    runStage: async (_batchId, stageName, action) => {
      calls.push(['stage', stageName]);
      return action();
    },
    runOcr: async ({ imagePaths }) => {
      calls.push(['ocr', imagePaths]);
      assert.deepEqual(imagePaths, [passportTask.imagePath, receiptTask.imagePath]);
      return [passportRecord, receiptRecord];
    },
    classifyDocumentTypesForChunk: async (_batchId, tasks) => {
      calls.push(['classification', tasks.map((task) => task.id)]);
      return new Map([
        ['task-passport', { docType: 'passport', confidence: 0.96, needsReview: false }],
        ['task-receipt', { docType: 'receipt', confidence: 0.94, needsReview: false }],
        ['task-other', { docType: 'other', confidence: 0.97, needsReview: false }],
        ['task-low', { docType: 'passport', confidence: 0.52, needsReview: true, reviewReasons: ['low_model_confidence'] }],
      ]);
    },
    buildDocumentAnalysisForTask: (_batchId, task, record, options = {}) => {
      calls.push(['analysis', task.id, record?.text || '', options]);
      if (task === passportTask) {
        if (record === passportRecord) {
          return passportAnalysis;
        }
        if (record === passportSecondRecord) {
          assert.equal(options.forcedDocType, 'passport');
          return passportSecondAnalysis;
        }
        throw new Error(`unexpected passport record ${record?.text}`);
      }
      if (task === receiptTask) {
        if (record === receiptRecord) {
          return receiptAnalysis;
        }
        if (record === receiptSecondRecord) {
          assert.equal(options.forcedDocType, 'receipt');
          return receiptSecondAnalysis;
        }
        throw new Error(`unexpected receipt record ${record?.text}`);
      }
      if (task === otherTask) {
        assert.equal(record, null);
        assert.equal(options.classificationOverride.docType, 'other');
        return otherAnalysis;
      }
      if (task === lowConfidenceTask) {
        assert.equal(record, null);
        assert.equal(options.classificationOverride.needsReview, true);
        return lowAnalysis;
      }
      throw new Error(`unexpected task ${task.id}`);
    },
    runPassportSecondPassForChunk: async (_batchId, _dirs, tasks, initialAnalysisMap) => {
      calls.push(['passport_second_pass', tasks.map((task) => task.id)]);
      assert.deepEqual(tasks.map((task) => task.id), ['task-passport', 'task-receipt']);
      assert.equal(initialAnalysisMap.get('task-passport'), passportAnalysis);
      assert.equal(initialAnalysisMap.has('task-low'), true);
      return new Map([['task-passport', passportSecondRecord]]);
    },
    runReceiptSecondPassForChunk: async (_batchId, _dirs, tasks, initialAnalysisMap) => {
      calls.push(['receipt_second_pass', tasks.map((task) => task.id)]);
      assert.deepEqual(tasks.map((task) => task.id), ['task-passport', 'task-receipt']);
      assert.equal(initialAnalysisMap.get('task-receipt'), receiptAnalysis);
      return new Map([['task-receipt', receiptSecondRecord]]);
    },
    runPassportFieldModelForChunk: async (_batchId, _dirs, tasks, finalAnalysisMap) => {
      calls.push(['passport_field_model', tasks.map((task) => task.id)]);
      assert.deepEqual(tasks.map((task) => task.id), ['task-passport', 'task-receipt']);
      assert.equal(finalAnalysisMap.get('task-passport'), passportSecondAnalysis);
      assert.equal(finalAnalysisMap.get('task-receipt'), receiptSecondAnalysis);
      return new Map([['task-passport', passportFieldAnalysis]]);
    },
    applyChunkResults: async (payload) => {
      calls.push(['apply_results']);
      appliedPayload = payload;
    },
    docTypes: {
      passport: 'passport',
      receipt: 'receipt',
      other: 'other',
    },
  });

  await service.processChunk({
    batchId: 'batch-1',
    dirs: { rawJson: 'raw' },
    pendingChunk,
    paddleOcrOptions: {},
  });

  assert.deepEqual(
    calls.filter((call) => call[0] === 'stage').map((call) => call[1]),
    ['classification', 'ocr', 'passport_second_pass', 'receipt_second_pass', 'passport_field_model', 'apply_results']
  );
  assert.equal(appliedPayload.ocrResultMap.size, 2);
  assert.equal(appliedPayload.initialAnalysisMap.get('task-other'), otherAnalysis);
  assert.equal(appliedPayload.initialAnalysisMap.get('task-low'), lowAnalysis);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-passport'), passportFieldAnalysis);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-receipt'), receiptSecondAnalysis);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-other'), otherAnalysis);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-low'), lowAnalysis);
  assert.deepEqual([...appliedPayload.extractionTaskIds], ['task-passport', 'task-receipt']);
  assert.deepEqual([...appliedPayload.classificationOnlyTaskIds], ['task-other', 'task-low']);
});

test('processChunk applies classification-only results when every task skips OCR', async () => {
  const otherTask = createTask('task-other', 'C:\\batch\\other.png');
  const lowConfidenceTask = createTask('task-low', 'C:\\batch\\low.png');
  const pendingChunk = [otherTask, lowConfidenceTask];
  const otherAnalysis = { docTypeFinal: 'other', source: 'other-classification' };
  const lowAnalysis = { docTypeFinal: 'passport', needsReview: true, source: 'low-classification' };
  let ocrCalled = false;
  let appliedPayload;

  const service = createWorkbenchModelPipelineService({
    resolveImagePath: (_batchId, task) => task.imagePath,
    runStage: async (_batchId, _stageName, action) => action(),
    runOcr: async () => {
      ocrCalled = true;
      return [];
    },
    classifyDocumentTypesForChunk: async () => new Map([
      ['task-other', { docType: 'other', confidence: 0.98, needsReview: false }],
      ['task-low', { docType: 'receipt', confidence: 0.41, needsReview: true }],
    ]),
    buildDocumentAnalysisForTask: (_batchId, task, record, options = {}) => {
      assert.equal(record, null);
      if (task === otherTask) {
        assert.equal(options.classificationOverride.docType, 'other');
        return otherAnalysis;
      }
      if (task === lowConfidenceTask) {
        assert.equal(options.classificationOverride.needsReview, true);
        return lowAnalysis;
      }
      throw new Error(`unexpected task ${task.id}`);
    },
    runPassportSecondPassForChunk: async (_batchId, _dirs, tasks) => {
      assert.deepEqual(tasks, []);
      return new Map();
    },
    runReceiptSecondPassForChunk: async (_batchId, _dirs, tasks) => {
      assert.deepEqual(tasks, []);
      return new Map();
    },
    runPassportFieldModelForChunk: async (_batchId, _dirs, tasks) => {
      assert.deepEqual(tasks, []);
      return new Map();
    },
    applyChunkResults: async (payload) => {
      appliedPayload = payload;
    },
    docTypes: {
      passport: 'passport',
      receipt: 'receipt',
      other: 'other',
    },
  });

  await service.processChunk({
    batchId: 'batch-1',
    dirs: { rawJson: 'raw' },
    pendingChunk,
    paddleOcrOptions: {},
  });

  assert.equal(ocrCalled, false);
  assert.equal(appliedPayload.ocrResultMap.size, 0);
  assert.equal(appliedPayload.initialAnalysisMap.get('task-other'), otherAnalysis);
  assert.equal(appliedPayload.initialAnalysisMap.get('task-low'), lowAnalysis);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-other'), otherAnalysis);
  assert.equal(appliedPayload.finalAnalysisMap.get('task-low'), lowAnalysis);
  assert.deepEqual([...appliedPayload.extractionTaskIds], []);
  assert.deepEqual([...appliedPayload.classificationOnlyTaskIds], ['task-other', 'task-low']);
});

test('processChunk skips analysis for OCR failures and still writes failure context', async () => {
  const task = createTask('task-a', 'C:\\batch\\a.png');
  let appliedPayload;

  const service = createWorkbenchModelPipelineService({
    resolveImagePath: (_batchId, item) => item.imagePath,
    runStage: async (_batchId, _stageName, action) => action(),
    runOcr: async () => [{ image: task.imagePath, error: 'ocr failed' }],
    classifyDocumentTypesForChunk: async () => new Map(),
    buildDocumentAnalysisForTask: () => {
      throw new Error('analysis should not run for failed OCR');
    },
    runPassportSecondPassForChunk: async () => new Map(),
    runReceiptSecondPassForChunk: async () => new Map(),
    runPassportFieldModelForChunk: async () => new Map(),
    applyChunkResults: async (payload) => {
      appliedPayload = payload;
    },
    docTypes: {
      passport: 'passport',
      receipt: 'receipt',
    },
  });

  await service.processChunk({
    batchId: 'batch-1',
    dirs: { rawJson: 'raw' },
    pendingChunk: [task],
    paddleOcrOptions: {},
  });

  assert.equal(appliedPayload.ocrResultMap.get(path.resolve(task.imagePath)).error, 'ocr failed');
  assert.equal(appliedPayload.initialAnalysisMap.size, 0);
  assert.equal(appliedPayload.finalAnalysisMap.size, 0);
});

test('processChunk lets stage failures propagate after the stage wrapper marks them', async () => {
  const markedFailures = [];
  const service = createWorkbenchModelPipelineService({
    resolveImagePath: (_batchId, task) => task.imagePath,
    runStage: async (_batchId, stageName, action) => {
      try {
        return await action();
      } catch (error) {
        markedFailures.push({ stageName, message: error.message });
        throw error;
      }
    },
    runOcr: async () => {
      throw new Error('paddle unavailable');
    },
    classifyDocumentTypesForChunk: async () => new Map(),
    buildDocumentAnalysisForTask: () => ({}),
    runPassportSecondPassForChunk: async () => new Map(),
    runReceiptSecondPassForChunk: async () => new Map(),
    runPassportFieldModelForChunk: async () => new Map(),
    applyChunkResults: async () => {},
    docTypes: {
      passport: 'passport',
      receipt: 'receipt',
    },
  });

  await assert.rejects(
    () => service.processChunk({
      batchId: 'batch-1',
      dirs: { rawJson: 'raw' },
      pendingChunk: [createTask('task-a', 'C:\\batch\\a.png')],
      paddleOcrOptions: {},
    }),
    /paddle unavailable/
  );

  assert.deepEqual(markedFailures, [
    { stageName: 'ocr', message: 'paddle unavailable' },
  ]);
});
