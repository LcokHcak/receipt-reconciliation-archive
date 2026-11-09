const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerWorkbenchRoutes } = require('../routes/workbench_routes');
const { createWorkbenchApp } = require('../server/create_app');
const {
  createWorkbenchDependencies,
  createUploadFileFilter,
  isOfficeTempUpload,
} = require('../server/dependencies');

function runUploadFilter(file) {
  const filter = createUploadFileFilter();
  return new Promise((resolve, reject) => {
    filter({}, file, (err, accepted) => (err ? reject(err) : resolve(accepted)));
  });
}

const WORKBENCH_HANDLER_NAMES = [
  'getHealth',
  'getState',
  'getMyTodos',
  'openSignatureBrowser',
  'closeSignatureBrowser',
  'getBatch',
  'deleteBatch',
  'importBatch',
  'importBatchLedger',
  'createManualReceiptFromTask',
  'setTaskDocBox',
  'getTaskOriginalImage',
  'rereadTaskBox',
// ⚠️ 这份名单是**桩**:它验的是"注册路由这段代码本身能跑",
// **不验**生产真的有这个 handler。0731 有过一次:新 handler 加了路由、
// 忘了进 workbench_server.js 的聚合表,服务启动即炸,而这里只要把名字
// 补进名单就绿了。真正管那件事的是 tests/route_handler_aggregate_table.test.js。
  'updateTask',
  'requeueTasks',
  'resplitTask',
  'approveSourceGroup',
  'settleSourceGroup',
  'confirmGroupModes',
  'correctGroupLedger',
  'getGroupTourCandidates',
  'confirmGroupTour',
  'unconfirmGroupTour',
  'markGroupTourResponded',
  'getTourPrior',
  'listSendbackQueue',
  'markSendbackDone',
  'deleteSourceGroupCustomer',
  'deleteTask',
  'queueTaskWebsiteSignature',
  'queueBatchWebsiteSignatures',
  'deleteWebsiteSignature',
  'saveManualSignature',
  'deleteManualSignature',
  'exportBatch',
  'exportCustomerData',
  'exportHyundaiDelivery',
  'exportLotteDeptDelivery',
  'exportModeDelivery',
];

function createJsonHandler(payload = { ok: true }) {
  return (_req, res) => res.json(payload);
}

function createWorkbenchHandlers(overrides = {}) {
  const handlers = {};
  for (const name of WORKBENCH_HANDLER_NAMES) {
    handlers[name] = createJsonHandler({ ok: true, route: name });
  }
  return { ...handlers, ...overrides };
}

test('multer file count overflow returns a readable 400 response', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-upload-limit-'));
  const appDir = path.join(tempRoot, 'app');
  const batchesRoot = path.join(tempRoot, 'batches');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(batchesRoot, { recursive: true });

  const upload = {
    array() {
      return (_req, _res, next) => next({ code: 'LIMIT_FILE_COUNT' });
    },
  };

  const app = createWorkbenchApp({
    projectRoot: tempRoot,
    appDir,
    batchesRoot,
    upload,
    registerWorkbenchRoutes,
    workbenchHandlers: createWorkbenchHandlers({
      getHealth: createJsonHandler({ ok: true }),
      getState: createJsonHandler({ ok: true }),
      getMyTodos: createJsonHandler({ ok: true, todos: [] }),
    }),
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(() => {
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/batches/import`, { method: 'POST' });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, '单次最多导入 3000 个文件，请分批导入。');
});

test('Office temporary upload names are rejected with a business error', async (t) => {
  assert.equal(isOfficeTempUpload({ originalname: '~$收票汇总.xlsx' }), true);
  assert.equal(isOfficeTempUpload({ originalname: '收票汇总.xlsx' }), false);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-office-temp-upload-'));
  const appDir = path.join(tempRoot, 'app');
  const batchesRoot = path.join(tempRoot, 'batches');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(batchesRoot, { recursive: true });

  const upload = {
    array() {
      return (_req, _res, next) => {
        const error = new Error('请不要上传 Office 临时文件（~$ 开头），请关闭 Excel 后选择正式文件。');
        error.code = 'OFFICE_TEMP_FILE';
        next(error);
      };
    },
  };

  const app = createWorkbenchApp({
    projectRoot: tempRoot,
    appDir,
    batchesRoot,
    upload,
    registerWorkbenchRoutes,
    workbenchHandlers: createWorkbenchHandlers(),
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(() => {
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/batches/import`, { method: 'POST' });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /Office 临时文件/);
});

test('上传白名单:jpg/png/webp/heic 放行,无扩展名按图片MIME放行,脚本拒绝', async () => {
  // 全链路支持的图片扩展名放行
  assert.equal(await runUploadFilter({ originalname: 'a.jpg', mimetype: 'image/jpeg' }), true);
  assert.equal(await runUploadFilter({ originalname: 'a.png', mimetype: 'image/png' }), true);
  assert.equal(await runUploadFilter({ originalname: 'a.webp', mimetype: 'image/webp' }), true);
  // 无扩展名(手机哈希名)但 MIME 是支持的图片 → 放行
  assert.equal(await runUploadFilter({ originalname: '4c5318a1251d9067024f1541', mimetype: 'image/jpeg' }), true);
  // heic/heif 放行(intake 落盘前会转 jpg):扩展名 或 无扩展名+heic MIME 均放行
  assert.equal(await runUploadFilter({ originalname: 'IMG_0001.heic', mimetype: 'image/heic' }), true);
  assert.equal(await runUploadFilter({ originalname: 'IMG_0001', mimetype: 'image/heic' }), true);
  // 有扩展名但非白名单 + 图片 MIME → 仍拒(只对无扩展名兜底,避免 .php 伪装)
  assert.equal(await runUploadFilter({ originalname: 'x.php', mimetype: 'image/jpeg' }), false);
  // 非图片脚本 → 拒
  assert.equal(await runUploadFilter({ originalname: 'x.svg', mimetype: 'image/svg+xml' }), false);
});

test('workbench upload defaults allow large monthly receipt workbooks', (t) => {
  const previous = process.env.SIGN_UPLOAD_MAX_MB;
  delete process.env.SIGN_UPLOAD_MAX_MB;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-upload-size-'));
  t.after(() => {
    if (previous === undefined) delete process.env.SIGN_UPLOAD_MAX_MB;
    else process.env.SIGN_UPLOAD_MAX_MB = previous;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const deps = createWorkbenchDependencies({ projectRoot: tempRoot });

  assert.equal(deps.uploadMaxFileSizeMb, 100);
  assert.equal(deps.upload.limits.fileSize, 100 * 1024 * 1024);
});
