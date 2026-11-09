const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createImportedImageTask } = require('../lib/workbench_task_factory');
const { createWorkbenchBatchImportHandlers } = require('../services/workbench_batch_import_handlers');

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-batch-import-'));
}

function writeUpload(root, fileName, contents = 'image') {
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function createHandlers(root) {
  const saved = [];
  const scheduled = [];
  const batchesRoot = path.join(root, 'batches');
  return {
    saved,
    scheduled,
    handlers: createWorkbenchBatchImportHandlers({
      buildBatchSkeleton(batchId, name, scenario) {
        return {
          id: batchId,
          name,
          scenario,
          tasks: [],
          sourceGroups: [],
        };
      },
      batchSubdirs(batchId) {
        const dirs = {
          root: path.join(batchesRoot, batchId),
          source: path.join(batchesRoot, batchId, 'source'),
          attachments: path.join(batchesRoot, batchId, 'attachments'),
        };
        fs.mkdirSync(dirs.source, { recursive: true });
        fs.mkdirSync(dirs.attachments, { recursive: true });
        return dirs;
      },
      createImportedImageTask,
      async saveBatchAsync(batch) {
        saved.push(JSON.parse(JSON.stringify(batch)));
      },
      scheduleBatch(batchId) {
        scheduled.push(batchId);
      },
      summarizeBatch(batch, options) {
        return {
          id: batch.id,
          tasks: options?.includeTasks ? batch.tasks : [],
          sourceGroups: batch.sourceGroups,
        };
      },
      nowStamp: () => '20260506_231500',
      randomId: () => 'abcdef12',
      supportedExtensions: new Set(['.jpg', '.jpeg', '.png']),
      supportedAttachmentExtensions: new Set(['.xlsx', '.csv']),
      defaultScenario: 'FullProcess',
    }),
  };
}

test('workbench batch import handler stores images and attachments by uploaded folder manifest', async () => {
  const root = createTempRoot();
  const imagePath = writeUpload(root, 'upload-image.tmp');
  const attachmentPath = writeUpload(root, 'upload-sheet.tmp', 'sheet');
  const { handlers, saved, scheduled } = createHandlers(root);
  const res = createRes();

  await handlers.importBatch({
    body: {
      batchName: '0505test',
      uploadManifest: JSON.stringify([
        { relativePath: '0505test/CL001/passport.jpg' },
        { relativePath: '0505test/CL001/bill.xlsx' },
      ]),
    },
    files: [
      { path: imagePath, originalname: 'passport.jpg' },
      { path: attachmentPath, originalname: 'bill.xlsx' },
    ],
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saved.length, 1);
  assert.deepEqual(scheduled, [saved[0].id]);
  assert.equal(saved[0].name, '0505test');
  assert.equal(saved[0].tasks.length, 1);
  assert.equal(saved[0].tasks[0].sourceFolderPath, 'CL001');
  assert.equal(saved[0].tasks[0].sourceFileName, 'passport.jpg');
  assert.equal(saved[0].tasks[0].machineState, 'queued');
  assert.equal(saved[0].sourceGroups.length, 1);
  assert.equal(saved[0].sourceGroups[0].folderPath, 'CL001');
  assert.equal(saved[0].sourceGroups[0].attachmentFiles.length, 1);
  assert.equal(saved[0].sourceGroups[0].attachmentFiles[0].originalFileName, 'bill.xlsx');
  assert.equal(fs.existsSync(imagePath), false);
  assert.equal(fs.existsSync(attachmentPath), false);
  assert.equal(res.body.batch.tasks.length, 1);
});

test('workbench batch import handler rejects uploads without supported image files and cleans temp files', async () => {
  const root = createTempRoot();
  const unsupportedPath = writeUpload(root, 'note.txt', 'note');
  const { handlers, saved, scheduled } = createHandlers(root);
  const res = createRes();

  await handlers.importBatch({
    body: { batchName: 'unsupported' },
    files: [{ path: unsupportedPath, originalname: 'note.txt' }],
  }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'No supported image files found' });
  assert.equal(saved.length, 0);
  assert.deepEqual(scheduled, []);
  assert.equal(fs.existsSync(unsupportedPath), false);
});

test('workbench batch import handler keeps the empty-upload response contract', async () => {
  const root = createTempRoot();
  const { handlers } = createHandlers(root);
  const res = createRes();

  await handlers.importBatch({ body: {}, files: [] }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'No files uploaded' });
});
