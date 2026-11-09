const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');

const { nowStamp } = require('../lib/workbench_utils');
const { createImportedImageTask } = require('../lib/workbench_task_factory');
const { createWorkbenchBatchRepository } = require('../repositories/workbench_batch_repository');
const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');
const { createCustomerTemplateRepository } = require('../repositories/customer_template_repository');
const { createCustomerIntakeService } = require('../services/customer_intake_service');
const { createCustomerBatchBridgeService } = require('../services/customer_batch_bridge_service');
const { createCustomerImagePrepService } = require('../services/customer_image_prep_service');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-batch-bridge-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

async function createImage(filePath, width, height, color) {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  });
  if (/\.jpe?g$/i.test(filePath)) {
    await image.jpeg().toFile(filePath);
    return;
  }
  await image.png().toFile(filePath);
}

function acceptAllCustomerImages(customerLibraryRepository, workspaceKey, customerId) {
  const customer = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
  customerLibraryRepository.saveCustomer({
    ...customer,
    images: customer.images.map((image) => ({ ...image, reviewStatus: 'accepted' })),
  });
}

function buildBatchSkeleton(batchId, name, scenario) {
  const now = new Date().toISOString();
  return {
    id: batchId,
    name,
    scenario,
    createdAt: now,
    updatedAt: now,
    machineState: 'queued',
    sourceGroups: [],
    tasks: [],
  };
}

test('importWorkspaceToBatch creates one source group per customer folder and copies images into batch storage', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    const uploadB = path.join(tempRoot, 'upload-b.png');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');
    await createImage(uploadB, 120, 80, '#00ff00');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '微信收件-周三',
      agentName: 'Agent Han',
      files: [
        { path: uploadA, originalname: 'passport.jpg' },
        { path: uploadB, originalname: 'receipt.png' },
      ],
    });
    acceptAllCustomerImages(customerLibraryRepository, '微信收件-周三', 'CL20260420-001');
    const createdCustomer = customerLibraryRepository.loadCustomer('微信收件-周三', 'CL20260420-001');
    customerLibraryRepository.saveCustomer({
      ...createdCustomer,
      displayName: 'ZHANG SAN',
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '微信收件-周三',
      batchName: 'workspace import',
      scenario: 'FullProcess',
      monthlyWorkspaceKey: '2026-05',
      groupCodeImportJobId: 'job-group-1',
      groupCodeSourceFile: '团号表.xlsx',
    });

    assert.equal(batch.sourceGroups.length, 1);
    assert.equal(batch.tasks.length, 2);
    assert.equal(batch.monthlyWorkspaceKey, '2026-05');
    assert.deepEqual(batch.groupCodeImport, {
      scope: 'monthly_legacy',
      workspaceKey: '2026-05',
      jobId: 'job-group-1',
      sourceFile: '团号表.xlsx',
    });
    assert.equal(batch.sourceGroups[0].label, 'ZHANG SAN');
    assert.equal(batch.tasks[0].sourceGroupLabel, 'ZHANG SAN');
    assert.equal(batch.tasks[0].customerAgentName, 'Agent Han');
    assert.match(batch.tasks[0].sourceOriginalPath, /^微信收件-周三\/CL20260420-001\//);
    assert.equal(batch.tasks[0].machineState, 'queued');
    assert.equal(fs.existsSync(path.join(batchesRoot, batch.id, batch.tasks[0].sourceImagePath)), true);

    const customer = customerLibraryRepository.loadCustomer('微信收件-周三', 'CL20260420-001');
    assert.equal(customer.review.lastBatchId, batch.id);
    assert.equal(customer.review.lastSourceGroupId, batch.sourceGroups[0].key);
    assert.equal(customer.status, 'in_review');
  } finally {
    cleanup(tempRoot);
  }
});

test('两步走建空批次:只声明团号表文件名 → 出生即盖 awaiting_upload 绑定章', async () => {
  const tempRoot = makeTempDir();

  try {
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
    });
    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'),
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch, pendingGroupCode } = await service.importWorkspaceToBatch({
      workspaceKey: '260709-小票06',
      batchName: '空批次声明表',
      scenario: 'FullProcess',
      allowEmpty: true,
      groupCodeSourceFile: 'gc-0709.xlsx',
    });

    assert.equal(pendingGroupCode, null, '没带文件就没有后台解析任务');
    assert.deepEqual(batch.groupCodeImport, {
      scope: 'batch',
      status: 'awaiting_upload',
      sourceWorkspaceKey: '260709-小票06',
      sourceFile: 'gc-0709.xlsx',
    });
    // 后台上传半路断了 → 批次留着可见的 awaiting_upload,不再是无声的无表批次。
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch preserves demo workspace when importing a batch-scoped group code file', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const groupCodePath = path.join(tempRoot, 'group-code.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    fs.writeFileSync(groupCodePath, 'group-code-bytes', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'demo-2026-01-uat',
      agentName: 'Agent Demo',
      files: [{ path: uploadA, originalname: 'receipt.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, 'demo-2026-01-uat', 'CL20260420-001');

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
      batchGroupCodeImportService: {
        async importFile({ sourceWorkspaceKey }) {
          assert.equal(sourceWorkspaceKey, 'demo-2026-01-uat');
          return {
            sourceFile: 'group-code.xlsx',
            importedAt: '2026-04-20T10:15:00.000Z',
            rowsTotal: 1,
            rowsInserted: 1,
            rowsSkipped: 0,
          };
        },
      },
    });

    const { batch, pendingGroupCode } = await service.importWorkspaceToBatch({
      workspaceKey: 'demo-2026-01-uat',
      batchName: 'demo batch import',
      scenario: 'FullProcess',
      groupCodeFilePath: groupCodePath,
      groupCodeSourceFile: 'group-code.xlsx',
    });

    assert.equal(batch.monthlyWorkspaceKey, 'demo-2026-01-uat');
    // 团号表后台化:导入只先标 parsing(不同步等解析),批次秒返回。
    assert.deepEqual(batch.groupCodeImport, {
      scope: 'batch',
      status: 'parsing',
      sourceWorkspaceKey: 'demo-2026-01-uat',
      sourceFile: 'group-code.xlsx',
    });
    assert.ok(pendingGroupCode, '应返回待后台解析的团号表信息');

    // 后台解析跑完 → 批次 groupCodeImport.status 变 ready 且带行数。
    await service.runBatchGroupCodeParse(pendingGroupCode);
    const reloaded = batchRepository.loadBatch(batch.id);
    assert.equal(reloaded.groupCodeImport.status, 'ready');
    assert.equal(reloaded.groupCodeImport.rowsInserted, 1);
    assert.equal(reloaded.groupCodeImport.rowsTotal, 1);
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch with allowEmpty creates an empty batch (new flow: bind team table first, append customers later)', async () => {
  const tempRoot = makeTempDir();
  try {
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-01T10:00:00+09:00'),
    });
    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'),
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    // 无客户 + allowEmpty=true → 不抛错,建出 0 task 的空批次(之后建档再 append)。
    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '0701-梓陌', batchName: '空批次', scenario: 'FullProcess', allowEmpty: true,
    });
    assert.equal(batch.tasks.length, 0);
    assert.ok(batchRepository.hasBatch(batch.id));

    // 无客户 + 不给 allowEmpty → 仍抛错(旧行为保留,灰度)。
    await assert.rejects(
      () => service.importWorkspaceToBatch({ workspaceKey: '0701-梓陌', batchName: 'x', scenario: 'FullProcess' }),
      /No customer images/,
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('⭐事故回归:老工作区(有已审存量客户)上建空批次 → 零导入,lastBatchId 不被改写', async () => {
  // 2026-07-05 生产事故:操作员在 79 个已审客户的工作区点"新建批次",allowEmpty 路径仍把
  // 全工作区客户(含已结算)吸入新批次并改写 lastBatchId → 老数据整批复活成"等待识别"。
  const tempRoot = makeTempDir();
  try {
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-05T09:00:00+09:00'),
    });
    // 造一个"已审过"的存量客户(带图 + lastBatchId 指向老批次)
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '260703-小票06', customerId: 'CL20260703-001', agentName: '蜜蜂', images: [],
    });
    const imagesDir = path.join(
      customerLibraryRepository.customerDir('260703-小票06', customer.customerId), 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, '01-r.jpg'), 'x');
    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [{ imageId: 'i1', originalFileName: 'r.jpg', relativePath: 'images/01-r.jpg', reviewStatus: 'accepted', sortOrder: 1 }],
      review: { lastBatchId: 'batch_20260703_old', approvedAt: '2026-07-03T07:00:00.000Z' },
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'),
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '260703-小票06', batchName: '260705-小票06', scenario: 'FullProcess', allowEmpty: true,
    });
    assert.equal(batch.tasks.length, 0, '空批次必须真空:一个存量客户都不导');
    const after = customerLibraryRepository.loadCustomer('260703-小票06', customer.customerId);
    assert.equal(after.review.lastBatchId, 'batch_20260703_old', '存量客户 lastBatchId 不能被改写');
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch 同工作区手填批次名不能重复(enforceUniqueName)', async () => {
  const tempRoot = makeTempDir();
  try {
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-01T10:00:00+09:00'),
    });
    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'),
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });

    await service.importWorkspaceToBatch({
      workspaceKey: '0701-梓陌', batchName: '重名批次', allowEmpty: true, enforceUniqueName: true,
    });
    // 同工作区 + 同名 + 校验开 → 拒
    await assert.rejects(
      () => service.importWorkspaceToBatch({
        workspaceKey: '0701-梓陌', batchName: '重名批次', allowEmpty: true, enforceUniqueName: true,
      }),
      /已存在/,
    );
    // 不校验(留空自动名走这条)→ 同名放行
    const dup = await service.importWorkspaceToBatch({
      workspaceKey: '0701-梓陌', batchName: '重名批次', allowEmpty: true, enforceUniqueName: false,
    });
    assert.ok(batchRepository.hasBatch(dup.batch.id));
    // 不同工作区 + 同名 → 放行
    const other = await service.importWorkspaceToBatch({
      workspaceKey: '0701-别的店', batchName: '重名批次', allowEmpty: true, enforceUniqueName: true,
    });
    assert.ok(batchRepository.hasBatch(other.batch.id));
  } finally {
    cleanup(tempRoot);
  }
});

test('replaceBatchGroupCode backgrounds the parse (new flow: empty batch first, team table uploaded later)', async () => {
  const tempRoot = makeTempDir();
  try {
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-01T10:00:00+09:00'),
    });
    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'),
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    let importFileCalls = 0;
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
      batchGroupCodeImportService: {
        async importFile({ sourceWorkspaceKey }) {
          importFileCalls += 1;
          assert.equal(sourceWorkspaceKey, '0701-梓陌');
          return {
            sourceFile: '团号汇总.xlsx',
            importedAt: '2026-07-01T10:20:00.000Z',
            rowsTotal: 3,
            rowsInserted: 3,
            rowsSkipped: 0,
          };
        },
      },
    });

    // ① 先建空批次(不带团号表):应记下来源工作区,供后台上传团号表时定匹配范围。
    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '0701-梓陌', batchName: '空批次', scenario: 'FullProcess', allowEmpty: true,
    });
    assert.equal(batch.monthlyWorkspaceKey, '0701-梓陌');

    // ② 后台上传团号表:只标 parsing 并返回 pendingGroupCode,绝不在请求里同步解析。
    const groupCodePath = path.join(tempRoot, '团号汇总.xlsx');
    fs.writeFileSync(groupCodePath, 'xlsx-bytes', 'utf8');
    const res = await service.replaceBatchGroupCode({
      batchId: batch.id,
      sourceWorkspaceKey: '0701-梓陌',
      filePath: groupCodePath,
      sourceFileName: '团号汇总.xlsx',
    });
    assert.equal(res.groupCodeStatus, 'parsing');
    assert.ok(res.pendingGroupCode, '应返回待后台解析的团号表信息');
    assert.equal(importFileCalls, 0, '上传阶段不能同步解析(解析必须挪到后台)');
    assert.equal(batchRepository.loadBatch(batch.id).groupCodeImport.status, 'parsing');

    // ③ 后台解析跑完 → ready 且带行数。
    await service.runBatchGroupCodeParse(res.pendingGroupCode);
    assert.equal(importFileCalls, 1);
    const reloaded = batchRepository.loadBatch(batch.id);
    assert.equal(reloaded.groupCodeImport.status, 'ready');
    assert.equal(reloaded.groupCodeImport.rowsInserted, 3);
    // 解析完应删掉 multer 临时团号表,防止 tmp_uploads 堆积。
    assert.equal(fs.existsSync(groupCodePath), false, '解析后临时团号表应被删除');
  } finally {
    cleanup(tempRoot);
  }
});

test('importMonthToBatch remains as a compatibility wrapper around workspace imports', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '20260421-第一批',
      agentName: 'Agent Han',
      files: [{ path: uploadA, originalname: 'passport.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, '20260421-第一批', 'CL20260420-001');

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importMonthToBatch({
      monthKey: '20260421-第一批',
      scenario: 'FullProcess',
    });

    assert.equal(batch.sourceGroups.length, 1);
    assert.match(batch.name, /20260421-第一批/);
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch imports only the current reviewer owned customer folders', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'alice.jpg');
    const uploadB = path.join(tempRoot, 'bob.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');
    await createImage(uploadB, 120, 80, '#00ff00');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const aliceCustomer = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Alice',
      ownerUser: { id: 11, userId: 11, username: 'alice', role: 'reviewer' },
      files: [{ path: uploadA, originalname: 'alice.jpg' }],
    });
    const bobCustomer = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Bob',
      ownerUser: { id: 12, userId: 12, username: 'bob', role: 'reviewer' },
      files: [{ path: uploadB, originalname: 'bob.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, 'wechat-receipts-wed', aliceCustomer.customer.customerId);
    acceptAllCustomerImages(customerLibraryRepository, 'wechat-receipts-wed', bobCustomer.customer.customerId);

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: 'wechat-receipts-wed',
      batchName: 'workspace import',
      operatorUser: { id: 11, userId: 11, username: 'alice', role: 'reviewer' },
    });

    assert.equal(batch.sourceGroups.length, 1);
    assert.equal(batch.tasks.length, 1);
    assert.equal(batch.tasks[0].sourceFolderName, aliceCustomer.customer.customerId);
    assert.equal(batch.tasks[0].customerOwnerUsername, 'alice');
  } finally {
    cleanup(tempRoot);
  }
});

test('appendWorkspaceToBatch adds only new customers to an existing batch', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    const uploadB = path.join(tempRoot, 'upload-b.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');
    await createImage(uploadB, 120, 80, '#00ff00');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService: createCustomerImagePrepService(),
    });

    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Han',
      files: [{ path: uploadA, originalname: 'first.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, '0426-test', 'CL20260420-001');

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const imported = await service.importWorkspaceToBatch({
      workspaceKey: '0426-test',
      batchName: 'current batch',
      scenario: 'FullProcess',
    });

    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Han',
      files: [{ path: uploadB, originalname: 'second.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, '0426-test', 'CL20260420-002');

    const appended = await service.appendWorkspaceToBatch({
      workspaceKey: '0426-test',
      batchId: imported.batch.id,
    });

    assert.equal(appended.appendedCustomers, 1);
    assert.equal(appended.appendedTasks, 1);
    assert.equal(appended.batch.id, imported.batch.id);
    assert.equal(appended.batch.tasks.length, 2);
    assert.equal(appended.batch.tasks[1].id, 'task_0002');

    const duplicate = await service.appendWorkspaceToBatch({
      workspaceKey: '0426-test',
      batchId: imported.batch.id,
    });
    assert.equal(duplicate.appendedCustomers, 0);
    assert.equal(duplicate.batch.tasks.length, 2);
  } finally {
    cleanup(tempRoot);
  }
});

test('L714 拷图失败但源图仍在:不打 lastBatchId → 前端自动追加会重挑本客户重试补齐', async () => {
  const tempRoot = makeTempDir();
  const fsPromises = require('node:fs/promises');
  const realLink = fsPromises.link;
  const realCopyFile = fsPromises.copyFile;
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    const uploadB = path.join(tempRoot, 'upload-b.jpg');
    const uploadC = path.join(tempRoot, 'upload-c.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');
    await createImage(uploadB, 120, 80, '#00ff00');
    await createImage(uploadC, 120, 80, '#0000ff');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService: createCustomerImagePrepService(),
    });

    // 客户1建档进批次(让批次非空)
    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Han',
      files: [{ path: uploadA, originalname: 'first.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, '0426-test', 'CL20260420-001');

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });
    const imported = await service.importWorkspaceToBatch({
      workspaceKey: '0426-test', batchName: 'current batch', scenario: 'FullProcess',
    });

    // 客户2建档:两张图,尚未进任何批次(!lastBatchId → 前端自动追加会挑它)
    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Han',
      files: [{ path: uploadB, originalname: 'second.jpg' }, { path: uploadC, originalname: 'third.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, '0426-test', 'CL20260420-002');

    // 注入「源图仍在却拷失败」:挑客户2的第二张切片,link + copyFile 都抛 ENOSPC
    const c2 = customerLibraryRepository.loadCustomer('0426-test', 'CL20260420-002');
    const c2Dir = customerLibraryRepository.customerDir('0426-test', 'CL20260420-002');
    const eligible = c2.images.filter((img) => img.autoSplitRole !== 'original');
    assert.equal(eligible.length, 2, '客户2应有两张可入批切片');
    const failSrc = path.join(c2Dir, String(eligible[1].relativePath || '').replaceAll('/', path.sep));
    const failIfTarget = (src) => {
      if (src === failSrc) { const e = new Error('ENOSPC injected'); e.code = 'ENOSPC'; throw e; }
    };
    fsPromises.link = async (src, dest) => { failIfTarget(src); return realLink(src, dest); };
    fsPromises.copyFile = async (src, dest, ...rest) => { failIfTarget(src); return realCopyFile(src, dest, ...rest); };

    const first = await service.appendWorkspaceToBatch({ workspaceKey: '0426-test', batchId: imported.batch.id });

    assert.equal(first.appendedTasks, 1, '两张里成功一张(另一张源在却拷失败)');
    const c2AfterFail = customerLibraryRepository.loadCustomer('0426-test', 'CL20260420-002');
    assert.equal(c2AfterFail.review?.lastBatchId ?? null, null, '有「源在却拷失败」的切片→不打 lastBatchId(留给自动追加重试)');
    assert.ok(c2AfterFail.review?.lastSourceGroupId, '来源组仍落定(部分进度可见)');

    // 恢复文件系统 → 重试(模拟前端自动追加再挑一轮)
    fsPromises.link = realLink;
    fsPromises.copyFile = realCopyFile;
    const retry = await service.appendWorkspaceToBatch({ workspaceKey: '0426-test', batchId: imported.batch.id });

    assert.equal(retry.appendedTasks, 1, '重试只补漏的那一张(幂等,不重复已入批的)');
    assert.equal(retry.batch.tasks.length, 3, '客户1一张 + 客户2两张');
    const c2AfterRetry = customerLibraryRepository.loadCustomer('0426-test', 'CL20260420-002');
    assert.equal(c2AfterRetry.review.lastBatchId, imported.batch.id, '补齐后才落定 lastBatchId');
  } finally {
    fsPromises.link = realLink;
    fsPromises.copyFile = realCopyFile;
    cleanup(tempRoot);
  }
});

test('L714 反向:源图确已被删(审图删图)→ 静默跳过并照打 lastBatchId,不无限重挑', async () => {
  const tempRoot = makeTempDir();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    const uploadB = path.join(tempRoot, 'upload-b.jpg');
    const uploadC = path.join(tempRoot, 'upload-c.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');
    await createImage(uploadB, 120, 80, '#00ff00');
    await createImage(uploadC, 120, 80, '#0000ff');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService: createCustomerImagePrepService(),
    });

    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Han',
      files: [{ path: uploadA, originalname: 'first.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, '0426-test', 'CL20260420-001');

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });
    const imported = await service.importWorkspaceToBatch({
      workspaceKey: '0426-test', batchName: 'current batch', scenario: 'FullProcess',
    });

    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Han',
      files: [{ path: uploadB, originalname: 'second.jpg' }, { path: uploadC, originalname: 'third.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, '0426-test', 'CL20260420-002');

    // 物理删掉客户2的第二张源切片(模拟审图删图):existsSync=false → 判为「源已不在」
    const c2 = customerLibraryRepository.loadCustomer('0426-test', 'CL20260420-002');
    const c2Dir = customerLibraryRepository.customerDir('0426-test', 'CL20260420-002');
    const eligible = c2.images.filter((img) => img.autoSplitRole !== 'original');
    fs.rmSync(path.join(c2Dir, String(eligible[1].relativePath || '').replaceAll('/', path.sep)), { force: true });

    const res = await service.appendWorkspaceToBatch({ workspaceKey: '0426-test', batchId: imported.batch.id });

    assert.equal(res.appendedTasks, 1, '存在的那张入批,已删那张静默跳过');
    const c2After = customerLibraryRepository.loadCustomer('0426-test', 'CL20260420-002');
    assert.equal(c2After.review.lastBatchId, imported.batch.id, '源图确已删→照打 lastBatchId,不留客户反复重挑');
  } finally {
    cleanup(tempRoot);
  }
});

test('appendWorkspaceToBatch 串台护栏:已属别的批次的客户不被重复追加', async () => {
  const tempRoot = makeTempDir();
  try {
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    const uploadA = path.join(tempRoot, 'a.jpg');
    fs.writeFileSync(sourceTemplatePath, 'tpl', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository: createCustomerTemplateRepository({ sourceTemplatePath }),
      customerImagePrepService: createCustomerImagePrepService(),
    });
    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'), normalizeBatch: (b) => b, summarizeBatch: (b) => b,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });

    // 客户 A 建在 wsA(先不接受图片,好让 b2 建成空的、且绑 wsA,避免撞跨工作区护栏)
    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wsA', agentName: 'H', files: [{ path: uploadA, originalname: 'a.jpg' }],
    });
    // 空 b2 绑 wsA(此时 A 图未接受,不会被 import 抓进来)
    const b2 = await service.importWorkspaceToBatch({ workspaceKey: 'wsA', batchName: 'b2', scenario: 'FullProcess', allowEmpty: true });
    // 接受 A 的图 → 就绪;导入 b1(也绑 wsA)→ A.review.lastBatchId = b1
    acceptAllCustomerImages(customerLibraryRepository, 'wsA', 'CL20260420-001');
    await service.importWorkspaceToBatch({ workspaceKey: 'wsA', batchName: 'b1', scenario: 'FullProcess' }); // 只要副作用(建批次),返回值不用

    // 同工作区再把 wsA 追加进 b2:A 已属于别的批次 → 不该被重复吸进(lastBatchId 护栏 + 源路径去重)
    const r1 = await service.appendWorkspaceToBatch({ workspaceKey: 'wsA', batchId: b2.batch.id });
    assert.equal(r1.appendedCustomers, 0, 'A 已属别的批次,不该被重复吸进 b2');
  } finally {
    cleanup(tempRoot);
  }
});

test('T6-B 归属修正:sweep 按 intendedBatchId 改道到意向批次,不吸进当下批次;意向已删回落当前(8模块审计HIGH)', async () => {
  const tempRoot = makeTempDir();
  try {
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    const uploadA = path.join(tempRoot, 'a.jpg');
    const uploadB = path.join(tempRoot, 'b.jpg');
    fs.writeFileSync(sourceTemplatePath, 'tpl', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');
    await createImage(uploadB, 120, 80, '#00ff00');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository: createCustomerTemplateRepository({ sourceTemplatePath }),
      customerImagePrepService: createCustomerImagePrepService(),
    });
    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'), normalizeBatch: (b) => b, summarizeBatch: (b) => b,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });

    // 两个空批次都绑 wsT:bOld=上传时的批次(意向),bNew=sweep 触发时的「当下」批次
    const bOld = await service.importWorkspaceToBatch({ workspaceKey: 'wsT', batchName: 'old', scenario: 'FullProcess', allowEmpty: true });
    const bNew = await service.importWorkspaceToBatch({ workspaceKey: 'wsT', batchName: 'new', scenario: 'FullProcess', allowEmpty: true });

    // 客户1:T6-B 队列快照意向=bOld;客户2:意向批次已不存在(被删)→ 应回落当前批次不搁浅
    const c1 = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wsT', agentName: 'H', files: [{ path: uploadA, originalname: 'a.jpg' }],
      intendedBatchId: bOld.batch.id,
    });
    const c2 = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wsT', agentName: 'H', files: [{ path: uploadB, originalname: 'b.jpg' }],
      intendedBatchId: 'batch_gone_999',
    });
    assert.equal(c1.customer.review?.intendedBatchId, bOld.batch.id, '建档即落盘归属快照');
    acceptAllCustomerImages(customerLibraryRepository, 'wsT', c1.customer.customerId);
    acceptAllCustomerImages(customerLibraryRepository, 'wsT', c2.customer.customerId);

    // 操作员已切到 bNew,自动追加按「当下」批次触发 → 客户1必须改道 bOld,客户2回落 bNew
    const res = await service.appendWorkspaceToBatch({ workspaceKey: 'wsT', batchId: bNew.batch.id });
    assert.equal(res.appendedCustomers, 1, '只有意向已死的客户2进当下批次');
    // 死锁修复(审计 HIGH line 510):service 不再就地执行改道(会与 handler 的 withBatchWrite(当前)
    // 嵌套死锁),改为返回 pendingRedirects 交回 handler 在当前锁释放后逐个 withBatchWrite(intended) 执行。
    assert.deepEqual(
      res.pendingRedirects,
      [{ customerId: c1.customer.customerId, intended: bOld.batch.id }],
      '客户1挂起改道到意向批次(待 handler 锁外执行)'
    );
    // 此刻客户1尚未落 bOld(handler 才执行);模拟 handler 释放当前锁后逐个执行改道
    assert.equal(batchRepository.loadBatch(bOld.batch.id).tasks.length, 0, 'service 阶段不就地改道');
    for (const r of res.pendingRedirects) {
      await service.appendCustomerToBatch({ workspaceKey: 'wsT', customerId: r.customerId, batchId: r.intended });
    }
    const oldReloaded = batchRepository.loadBatch(bOld.batch.id);
    const newReloaded = batchRepository.loadBatch(bNew.batch.id);
    assert.deepEqual(oldReloaded.tasks.map((t) => t.sourceFolderName), [c1.customer.customerId]);
    assert.deepEqual(newReloaded.tasks.map((t) => t.sourceFolderName), [c2.customer.customerId]);
    const c1Reloaded = customerLibraryRepository.loadCustomer('wsT', c1.customer.customerId);
    assert.equal(c1Reloaded.review.lastBatchId, bOld.batch.id, '归属落账到意向批次');
    // 二次 sweep 幂等:都已归属,不再动任何批次
    const res2 = await service.appendWorkspaceToBatch({ workspaceKey: 'wsT', batchId: bNew.batch.id });
    assert.equal((res2.appendedCustomers || 0) + (res2.pendingRedirects?.length || 0), 0, '二次 sweep 无重复吸入');
  } finally {
    cleanup(tempRoot);
  }
});

test('appendWorkspaceToBatch 跨工作区护栏:批次绑A工作区,追加B工作区客户被拒(admin串台防线)', async () => {
  const tempRoot = makeTempDir();
  try {
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    const uploadA = path.join(tempRoot, 'a.jpg');
    fs.writeFileSync(sourceTemplatePath, 'tpl', 'utf8');
    await createImage(uploadA, 120, 80, '#ff0000');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository: createCustomerTemplateRepository({ sourceTemplatePath }),
      customerImagePrepService: createCustomerImagePrepService(),
    });
    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'), normalizeBatch: (b) => b, summarizeBatch: (b) => b,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });

    // wsB 有客户 C;批次 bA 绑 wsA(空)
    await customerIntakeService.createCustomerFromFiles({ workspaceKey: 'wsB', agentName: 'H', files: [{ path: uploadA, originalname: 'a.jpg' }] });
    acceptAllCustomerImages(customerLibraryRepository, 'wsB', 'CL20260420-001');
    const bA = await service.importWorkspaceToBatch({ workspaceKey: 'wsA', batchName: 'bA', scenario: 'FullProcess', allowEmpty: true });

    // 把 wsB 追加进 wsA 的批次 → 跨工作区,拒绝(0 且标记 crossWorkspaceSkipped)
    const r = await service.appendWorkspaceToBatch({ workspaceKey: 'wsB', batchId: bA.batch.id });
    assert.equal(r.appendedCustomers, 0, 'wsB 客户不该进 wsA 的批次');
    assert.equal(r.crossWorkspaceSkipped, true);
  } finally {
    cleanup(tempRoot);
  }
});

test('appendWorkspaceToBatch adds newly accepted images from an already imported customer', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0429-image-append',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0429-image-append', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, '01-original.jpg'), 'original');
    fs.writeFileSync(path.join(imagesDir, '02-region.jpg'), 'region');
    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        {
          imageId: 'img_001',
          originalFileName: 'first.jpg',
          relativePath: 'images/01-original.jpg',
          autoSplitRole: 'original',
          reviewStatus: 'accepted',
          sortOrder: 1,
        },
        {
          imageId: 'img_002',
          originalFileName: 'first.jpg',
          relativePath: 'images/02-region.jpg',
          autoSplitRole: 'region',
          reviewStatus: 'accepted',
          sortOrder: 2,
        },
      ],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const imported = await service.importWorkspaceToBatch({
      workspaceKey: '0429-image-append',
      batchName: 'current batch',
      scenario: 'FullProcess',
    });

    assert.deepEqual(
      imported.batch.tasks.map((task) => task.sourceFileName),
      ['02-region.jpg']
    );

    fs.writeFileSync(path.join(imagesDir, '03-new-original.jpg'), 'new original');
    fs.writeFileSync(path.join(imagesDir, '04-new-region.jpg'), 'new region');
    const currentCustomer = customerLibraryRepository.loadCustomer('0429-image-append', customer.customerId);
    customerLibraryRepository.saveCustomer({
      ...currentCustomer,
      images: [
        ...currentCustomer.images,
        {
          imageId: 'img_003',
          originalFileName: 'second.jpg',
          relativePath: 'images/03-new-original.jpg',
          autoSplitRole: 'original',
          reviewStatus: 'accepted',
          sortOrder: 3,
        },
        {
          imageId: 'img_004',
          originalFileName: 'second.jpg',
          relativePath: 'images/04-new-region.jpg',
          autoSplitRole: 'region',
          reviewStatus: 'accepted',
          sortOrder: 4,
        },
      ],
    });

    const appended = await service.appendWorkspaceToBatch({
      workspaceKey: '0429-image-append',
      batchId: imported.batch.id,
    });

    assert.equal(appended.appendedCustomers, 1);
    assert.equal(appended.appendedTasks, 1);
    assert.deepEqual(
      appended.batch.tasks.map((task) => task.sourceFileName),
      ['02-region.jpg', '04-new-region.jpg']
    );

    const duplicate = await service.appendWorkspaceToBatch({
      workspaceKey: '0429-image-append',
      batchId: imported.batch.id,
    });
    assert.equal(duplicate.appendedCustomers, 0);
    assert.equal(duplicate.appendedTasks, 0);
    assert.equal(duplicate.batch.tasks.length, 2);
  } finally {
    cleanup(tempRoot);
  }
});

test('图片进批次用硬链接(省存储):内容与客户库一致;删批次侧不影响客户库原件', async () => {
  const tempRoot = makeTempDir();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-04T10:00:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0704-hardlink',
      customerId: 'CL20260704-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0704-hardlink', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const srcFile = path.join(imagesDir, '01-receipt.jpg');
    fs.writeFileSync(srcFile, 'receipt-bytes-payload');
    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [{ imageId: 'img_001', originalFileName: 'r.jpg', relativePath: 'images/01-receipt.jpg', reviewStatus: 'accepted', sortOrder: 1 }],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });
    const imported = await service.importWorkspaceToBatch({
      workspaceKey: '0704-hardlink', batchName: 'hardlink batch', scenario: 'FullProcess',
    });

    const task = imported.batch.tasks[0];
    const batchFile = path.join(batchesRoot, imported.batch.id, task.sourceImagePath);
    assert.ok(fs.existsSync(batchFile), '批次侧文件应存在');
    assert.equal(fs.readFileSync(batchFile, 'utf8'), 'receipt-bytes-payload', '内容与客户库一致');
    // 同卷时应为硬链接(inode 相同);跨卷/不支持时退回拷贝也合法 → 只在两边 ino 有效时断言
    const a = fs.statSync(srcFile); const b = fs.statSync(batchFile);
    if (a.ino && b.ino) assert.equal(a.ino, b.ino, '同卷应硬链接共享 inode');
    // 删批次侧 = 只解开批次这个名字,客户库原件必须完好
    fs.rmSync(batchFile);
    assert.ok(fs.existsSync(srcFile), '客户库原件不受影响');
    assert.equal(fs.readFileSync(srcFile, 'utf8'), 'receipt-bytes-payload');
  } finally {
    cleanup(tempRoot);
  }
});

test('原图残留自动清理:切图改名后,批次里指向旧文件名的未审任务被清掉并进墓碑', async () => {
  // 生产复现(2026-07-03 蜜蜂组):建档即建任务(01-photo.jpg)→ 切图把原图改名 _original 并加切片
  // → 旧任务指向不存在的文件名,滞留成审核台"废图"。追加切片时应顺手清掉。
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-03T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0703-stale-clean',
      customerId: 'CL20260703-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0703-stale-clean', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, '01-photo.jpg'), 'multi receipt photo');
    fs.writeFileSync(path.join(imagesDir, '02-keep.jpg'), 'reviewed keeps');
    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        { imageId: 'img_001', originalFileName: 'p.jpg', relativePath: 'images/01-photo.jpg', reviewStatus: 'accepted', sortOrder: 1 },
        { imageId: 'img_002', originalFileName: 'k.jpg', relativePath: 'images/02-keep.jpg', reviewStatus: 'accepted', sortOrder: 2 },
      ],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const imported = await service.importWorkspaceToBatch({
      workspaceKey: '0703-stale-clean',
      batchName: 'stale clean batch',
      scenario: 'FullProcess',
    });
    assert.deepEqual(
      imported.batch.tasks.map((t) => t.sourceFileName).sort(),
      ['01-photo.jpg', '02-keep.jpg']
    );

    // 模拟切图:01-photo.jpg 改名 _original(排除出批次),生成两张切片;02-keep 已审保护
    const keepTask = imported.batch.tasks.find((t) => t.sourceFileName === '02-keep.jpg');
    keepTask.reviewed = true;
    await batchRepository.saveBatchAsync(imported.batch);
    fs.renameSync(path.join(imagesDir, '01-photo.jpg'), path.join(imagesDir, '01-photo_original.jpg'));
    fs.writeFileSync(path.join(imagesDir, '03-photo_receipt_1.jpg'), 'crop1');
    fs.writeFileSync(path.join(imagesDir, '04-photo_receipt_2.jpg'), 'crop2');
    const current = customerLibraryRepository.loadCustomer('0703-stale-clean', customer.customerId);
    customerLibraryRepository.saveCustomer({
      ...current,
      images: [
        { imageId: 'img_001', originalFileName: 'p.jpg', relativePath: 'images/01-photo_original.jpg', autoSplitRole: 'original', reviewStatus: 'accepted', sortOrder: 1 },
        { imageId: 'img_002', originalFileName: 'k.jpg', relativePath: 'images/02-keep.jpg', reviewStatus: 'accepted', sortOrder: 2 },
        { imageId: 'img_003', originalFileName: 'p.jpg', relativePath: 'images/03-photo_receipt_1.jpg', autoSplitRole: 'region', reviewStatus: 'accepted', sortOrder: 3 },
        { imageId: 'img_004', originalFileName: 'p.jpg', relativePath: 'images/04-photo_receipt_2.jpg', autoSplitRole: 'region', reviewStatus: 'accepted', sortOrder: 4 },
      ],
    });

    const appended = await service.appendCustomerToBatch({
      workspaceKey: '0703-stale-clean',
      customerId: customer.customerId,
      batchId: imported.batch.id,
    });

    assert.equal(appended.appendedTasks, 2, '两张切片追加进批次');
    assert.equal(appended.staleRemoved, 1, '旧原图任务被清掉');
    assert.deepEqual(
      appended.batch.tasks.map((t) => t.sourceFileName).sort(),
      ['02-keep.jpg', '03-photo_receipt_1.jpg', '04-photo_receipt_2.jpg'],
      '废图任务不再滞留;已审任务不动'
    );
    const tombs = appended.batch.deletedSourcePaths || [];
    assert.ok(
      tombs.includes('0703-stale-clean/CL20260703-001/01-photo.jpg'),
      '被清路径进墓碑,追加不会再加回来'
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('appendCustomerToBatch adds new images for only the selected customer', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerA = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0429-selected-append',
      customerId: 'CL20260420-001',
      agentName: 'Agent A',
      images: [],
    });
    const customerB = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0429-selected-append',
      customerId: 'CL20260420-002',
      agentName: 'Agent B',
      images: [],
    });
    for (const customer of [customerA, customerB]) {
      const customerDir = customerLibraryRepository.customerDir('0429-selected-append', customer.customerId);
      const imagesDir = path.join(customerDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(path.join(imagesDir, '01-first.jpg'), `${customer.customerId}-first`);
      customerLibraryRepository.saveCustomer({
        ...customer,
        images: [{
          imageId: 'img_001',
          originalFileName: 'first.jpg',
          relativePath: 'images/01-first.jpg',
          reviewStatus: 'accepted',
          sortOrder: 1,
        }],
      });
    }

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const imported = await service.importWorkspaceToBatch({
      workspaceKey: '0429-selected-append',
      batchName: 'current batch',
      scenario: 'FullProcess',
    });

    const customerADir = customerLibraryRepository.customerDir('0429-selected-append', customerA.customerId);
    fs.writeFileSync(path.join(customerADir, 'images', '02-new-a.jpg'), 'new a');
    const savedA = customerLibraryRepository.loadCustomer('0429-selected-append', customerA.customerId);
    customerLibraryRepository.saveCustomer({
      ...savedA,
      images: [
        ...savedA.images,
        {
          imageId: 'img_002',
          originalFileName: 'new-a.jpg',
          relativePath: 'images/02-new-a.jpg',
          reviewStatus: 'accepted',
          sortOrder: 2,
        },
      ],
    });

    const customerBDir = customerLibraryRepository.customerDir('0429-selected-append', customerB.customerId);
    fs.writeFileSync(path.join(customerBDir, 'images', '02-new-b.jpg'), 'new b');
    const savedB = customerLibraryRepository.loadCustomer('0429-selected-append', customerB.customerId);
    customerLibraryRepository.saveCustomer({
      ...savedB,
      images: [
        ...savedB.images,
        {
          imageId: 'img_002',
          originalFileName: 'new-b.jpg',
          relativePath: 'images/02-new-b.jpg',
          reviewStatus: 'accepted',
          sortOrder: 2,
        },
      ],
    });

    const appended = await service.appendCustomerToBatch({
      workspaceKey: '0429-selected-append',
      customerId: customerA.customerId,
      batchId: imported.batch.id,
    });

    assert.equal(appended.appendedCustomers, 1);
    assert.equal(appended.appendedTasks, 1);
    assert.deepEqual(
      appended.batch.tasks.map((task) => task.sourceOriginalPath),
      [
        '0429-selected-append/CL20260420-001/01-first.jpg',
        '0429-selected-append/CL20260420-002/01-first.jpg',
        '0429-selected-append/CL20260420-001/02-new-a.jpg',
      ]
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch sends low-confidence images to review batch without intake confirmation', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0427-review',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0427-review', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, '01-original.jpg'), 'original');
    fs.writeFileSync(path.join(imagesDir, '02-approved.jpg'), 'approved');
    fs.writeFileSync(path.join(imagesDir, '03-pending.jpg'), 'pending');
    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        {
          imageId: 'img_001',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/01-original.jpg',
          autoSplitRole: 'original',
          sortOrder: 1,
        },
        {
          imageId: 'img_002',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/02-approved.jpg',
          autoSplitRole: 'region',
          reviewStatus: 'accepted',
          sortOrder: 2,
        },
        {
          imageId: 'img_003',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/03-pending.jpg',
          autoSplitRole: 'region',
          docTypeConfidence: 0.74,
          sortOrder: 3,
        },
      ],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '0427-review',
      batchName: 'approved only',
      scenario: 'FullProcess',
    });

    assert.equal(batch.tasks.length, 2);
    assert.equal(batch.tasks[0].sourceFileName, '02-approved.jpg');
    assert.equal(batch.tasks[1].sourceFileName, '03-pending.jpg');
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch excludes accepted archive originals from review tasks', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0429-archive-original',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0429-archive-original', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, '01-original.jpg'), 'original');
    fs.writeFileSync(path.join(imagesDir, '02-region.jpg'), 'region');
    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        {
          imageId: 'img_001',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/01-original.jpg',
          autoSplitRole: 'original',
          reviewStatus: 'accepted',
          sortOrder: 1,
        },
        {
          imageId: 'img_002',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/02-region.jpg',
          autoSplitRole: 'region',
          reviewStatus: 'accepted',
          sortOrder: 2,
        },
      ],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '0429-archive-original',
      batchName: 'archive originals stay out',
      scenario: 'FullProcess',
    });

    assert.equal(batch.tasks.length, 1);
    assert.equal(batch.tasks[0].sourceFileName, '02-region.jpg');
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch auto-accepts non-low-confidence split images before import', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0429-auto-pass',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0429-auto-pass', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, '01-original.jpg'), 'original');
    fs.writeFileSync(path.join(imagesDir, '02-high.jpg'), 'high');
    fs.writeFileSync(path.join(imagesDir, '03-low.jpg'), 'low');
    fs.writeFileSync(path.join(imagesDir, '04-low-accepted.jpg'), 'low accepted');
    fs.writeFileSync(path.join(imagesDir, '05-failed.jpg'), 'failed');

    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        {
          imageId: 'img_001',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/01-original.jpg',
          autoSplitRole: 'original',
          sortOrder: 1,
        },
        {
          imageId: 'img_002',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/02-high.jpg',
          autoSplitRole: 'region',
          preprocessStatus: 'processed',
          docTypeConfidence: 0.84,
          sortOrder: 2,
        },
        {
          imageId: 'img_003',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/03-low.jpg',
          autoSplitRole: 'region',
          preprocessStatus: 'processed',
          docTypeConfidence: 0.74,
          sortOrder: 3,
        },
        {
          imageId: 'img_004',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/04-low-accepted.jpg',
          autoSplitRole: 'region',
          preprocessStatus: 'processed',
          docTypeConfidence: 0.62,
          reviewStatus: 'accepted',
          sortOrder: 4,
        },
        {
          imageId: 'img_005',
          originalFileName: 'mixed.jpg',
          relativePath: 'images/05-failed.jpg',
          autoSplitRole: 'region',
          preprocessStatus: 'failed',
          sortOrder: 5,
        },
      ],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '0429-auto-pass',
      batchName: 'auto pass',
      scenario: 'FullProcess',
    });

    assert.deepEqual(
      batch.tasks.map((task) => task.sourceFileName),
      ['02-high.jpg', '03-low.jpg', '04-low-accepted.jpg', '05-failed.jpg']
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch imports raw direct uploads without manual image approval', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0429-raw-upload',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0429-raw-upload', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'raw-upload.jpg'), 'raw upload');

    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        {
          imageId: 'img_001',
          originalFileName: 'raw-upload.jpg',
          relativePath: 'images/raw-upload.jpg',
          sortOrder: 1,
        },
      ],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '0429-raw-upload',
      batchName: 'raw upload',
      scenario: 'FullProcess',
    });

    assert.equal(batch.tasks.length, 1);
    assert.equal(batch.tasks[0].sourceFileName, 'raw-upload.jpg');
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch can append approved customers to a new review batch without reopening customer status', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: 'approved-append',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('approved-append', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'approved-receipt.jpg'), 'approved receipt');

    customerLibraryRepository.saveCustomer({
      ...customer,
      status: 'in_review',
      images: [
        {
          imageId: 'img_001',
          originalFileName: 'approved-receipt.jpg',
          relativePath: 'images/approved-receipt.jpg',
          reviewStatus: 'accepted',
          sortOrder: 1,
        },
      ],
    });
    customerLibraryRepository.saveCustomer({
      ...customerLibraryRepository.loadCustomer('approved-append', customer.customerId),
      status: 'approved',
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: 'approved-append',
      batchName: 'approved append',
      scenario: 'FullProcess',
    });

    assert.equal(batch.tasks.length, 1);
    const saved = customerLibraryRepository.loadCustomer('approved-append', customer.customerId);
    assert.equal(saved.status, 'approved');
    assert.equal(saved.review.lastBatchId, batch.id);
    assert.equal(saved.review.lastSourceGroupId, batch.sourceGroups[0].key);
  } finally {
    cleanup(tempRoot);
  }
});

test('importWorkspaceToBatch auto-accepts preprocessed images when no low confidence exists', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '0429-no-split',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    const customerDir = customerLibraryRepository.customerDir('0429-no-split', customer.customerId);
    const imagesDir = path.join(customerDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, 'mixed-no-split.jpg'), 'mixed no split');

    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [
        {
          imageId: 'img_001',
          originalFileName: 'mixed-no-split.jpg',
          relativePath: 'images/mixed-no-split.jpg',
          preprocessStatus: 'processed',
          preprocessMessage: 'no_split_detected',
          sortOrder: 1,
        },
      ],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
    });

    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: '0429-no-split',
      batchName: 'no split',
      scenario: 'FullProcess',
    });

    assert.equal(batch.tasks.length, 1);
    assert.equal(batch.tasks[0].sourceFileName, 'mixed-no-split.jpg');
  } finally {
    cleanup(tempRoot);
  }
});

test('已删路径墓碑:删掉的图补图/追加时不再自动加回(删了又回到待处理 bug)', async () => {
  const tempRoot = makeTempDir();
  try {
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    const up = path.join(tempRoot, 'p.jpg');
    fs.writeFileSync(sourceTemplatePath, 'x', 'utf8');
    await createImage(up, 100, 60, '#ff0000');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 's.json'),
      nowProvider: () => new Date('2026-07-02T10:00:00+09:00'),
    });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository: createCustomerTemplateRepository({ sourceTemplatePath }),
      customerImagePrepService: createCustomerImagePrepService(),
    });
    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wsT', agentName: 'Han', files: [{ path: up, originalname: 'passport.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, 'wsT', 'CL20260702-001');

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'),
      normalizeBatch: (b) => b, summarizeBatch: (b) => b,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });
    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: 'wsT', batchName: 'T批次', monthlyWorkspaceKey: 'wsT',
    });
    assert.equal(batch.tasks.length, 1);
    const deletedPath = batch.tasks[0].sourceOriginalPath;

    // 模拟审核台删除该任务(deleteTask 会记墓碑)
    const stored = batchRepository.loadBatch(batch.id);
    stored.tasks = [];
    stored.deletedSourcePaths = [deletedPath];
    await batchRepository.saveBatchAsync(stored);

    // 再追加同客户 → 墓碑路径不回魂
    const r = await service.appendCustomerToBatch({
      workspaceKey: 'wsT', customerId: 'CL20260702-001', batchId: batch.id,
    });
    assert.equal(r.appendedTasks, 0, '被删路径不应被重新追加');
    assert.equal(batchRepository.loadBatch(batch.id).tasks.length, 0);
  } finally {
    cleanup(tempRoot);
  }
});

test('appendCustomerToBatch 跨工作区护栏:批次工作区≠客户工作区则跳过,不串台', async () => {
  const tempRoot = makeTempDir();
  try {
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    const up = path.join(tempRoot, 'p.jpg');
    const up2 = path.join(tempRoot, 'p2.jpg');
    fs.writeFileSync(sourceTemplatePath, 'x', 'utf8');
    await createImage(up, 100, 60, '#ff0000');
    await createImage(up2, 100, 60, '#00ff00');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 's.json'),
      nowProvider: () => new Date('2026-07-01T10:00:00+09:00'),
    });
    const customerIntakeService = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository: createCustomerTemplateRepository({ sourceTemplatePath }),
      customerImagePrepService: createCustomerImagePrepService(),
    });
    // 客户建在工作区 wsA
    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wsA', agentName: 'Han', files: [{ path: up, originalname: 'passport.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, 'wsA', 'CL20260701-001');

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot: path.join(tempRoot, 'batches'),
      normalizeBatch: (b) => b, summarizeBatch: (b) => b,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });
    // 批次绑到工作区 wsB(空)
    const { batch } = await service.importWorkspaceToBatch({
      workspaceKey: 'wsB', batchName: 'B批次', allowEmpty: true, monthlyWorkspaceKey: 'wsB',
    });
    // 把 wsA 客户追进 wsB 批次 → 护栏跳过,批次仍为空
    const r = await service.appendCustomerToBatch({
      workspaceKey: 'wsA', customerId: 'CL20260701-001', batchId: batch.id,
    });
    assert.equal(r.crossWorkspaceSkipped, true);
    assert.equal(r.appendedTasks, 0);
    assert.equal(batchRepository.loadBatch(batch.id).tasks.length, 0);

    // 同工作区(wsB 自己的客户)则正常追加(对照)
    await customerIntakeService.createCustomerFromFiles({
      workspaceKey: 'wsB', agentName: 'Han', files: [{ path: up2, originalname: 'passport.jpg' }],
    });
    acceptAllCustomerImages(customerLibraryRepository, 'wsB', 'CL20260701-001');
    const ok = await service.appendCustomerToBatch({
      workspaceKey: 'wsB', customerId: 'CL20260701-001', batchId: batch.id,
    });
    assert.ok(ok.appendedTasks > 0, '同工作区应正常追加');
  } finally {
    cleanup(tempRoot);
  }
});

// ── 2026-07-12 审计 HIGH:团号表后台解析的落状态段必须进批次写队列 ─────────────
// 原先 fire-and-forget 的 loadBatch→改→save 绕开 withBatchWrite,与队列内写窗口交错互吞。
// 断言:①落状态经 withBatchWrite(label 可见);②importFile 长跑期间别人落盘的写入存活。
test('runBatchGroupCodeParse: 落状态走批次写队列,长跑期间并发写入不被吞', async () => {
  const tempRoot = makeTempDir();
  try {
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
    });
    const batchesRoot = path.join(tempRoot, 'batches');
    const realRepo = createWorkbenchBatchRepository({
      batchesRoot,
      normalizeBatch: (batch) => batch,
      summarizeBatch: (batch) => batch,
    });
    const queueLabels = [];
    const batchRepository = {
      ...realRepo,
      withBatchWrite: (batchId, action, options = {}) => {
        queueLabels.push(String(options.label || ''));
        return realRepo.withBatchWrite(batchId, action, options);
      },
    };

    const groupCodePath = path.join(tempRoot, 'group-code.xlsx');
    fs.writeFileSync(groupCodePath, 'stub');
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository,
      batchRepository,
      buildBatchSkeleton,
      createImportedImageTask,
      nowStamp,
      batchGroupCodeImportService: {
        async importFile() {
          // 长跑窗口:另一个写入者(走队列)落盘了字段编辑
          await realRepo.withBatchWrite(seeded.id, async () => {
            const other = realRepo.loadBatch(seeded.id);
            other.tasks.push({ id: 'concurrent_task', reviewed: true });
            await realRepo.saveBatchAsync(other);
          }, { label: 'concurrentWriter' });
          return {
            sourceFile: 'group-code.xlsx', importedAt: '2026-07-12T00:00:00.000Z',
            rowsTotal: 2, rowsInserted: 2, rowsSkipped: 0,
          };
        },
      },
    });

    const { batch: seeded, pendingGroupCode } = await service.importWorkspaceToBatch({
      workspaceKey: 'demo-2026-07-race',
      batchName: 'race batch',
      scenario: 'FullProcess',
      groupCodeFilePath: groupCodePath,
      groupCodeSourceFile: 'group-code.xlsx',
      allowEmpty: true,
    });

    await service.runBatchGroupCodeParse(pendingGroupCode);

    assert.ok(queueLabels.includes('groupCodeParseReady'), `落状态未走批次写队列(labels=${queueLabels})`);
    const reloaded = realRepo.loadBatch(seeded.id);
    assert.equal(reloaded.groupCodeImport.status, 'ready');
    assert.ok(
      reloaded.tasks.some((t) => t.id === 'concurrent_task'),
      '解析长跑期间并发落盘的任务被旧快照吞掉了'
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('追加进批次持客户写锁:排队等审图写完、锁内重载fresh不覆盖并发写(2026-07-14 复审 CRITICAL 回归)', async () => {
  const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');
  const tempRoot = makeTempDir();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const batchesRoot = path.join(tempRoot, 'batches');
    const ws = '0714-lock-append';
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-14T10:15:00+09:00'),
    });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: ws, customerId: 'CL20260714-001', agentName: 'Agent A', images: [],
    });
    const customerDir = customerLibraryRepository.customerDir(ws, customer.customerId);
    fs.mkdirSync(path.join(customerDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(customerDir, 'images', '01-first.jpg'), 'first');
    customerLibraryRepository.saveCustomer({
      ...customer,
      images: [{ imageId: 'img_001', originalFileName: 'first.jpg', relativePath: 'images/01-first.jpg', reviewStatus: 'accepted', sortOrder: 1 }],
    });

    const batchRepository = createWorkbenchBatchRepository({
      batchesRoot, normalizeBatch: (b) => b, summarizeBatch: (b) => b,
    });
    const service = createCustomerBatchBridgeService({
      customerLibraryRepository, batchRepository, buildBatchSkeleton, createImportedImageTask, nowStamp,
    });
    const imported = await service.importWorkspaceToBatch({ workspaceKey: ws, batchName: 'lock batch', scenario: 'FullProcess' });
    const batchId = imported.batch.id;
    const baseTaskCount = batchRepository.loadBatch(batchId).tasks.length;

    // 客户库新增一张已接受图(待追加素材)
    fs.writeFileSync(path.join(customerDir, 'images', '02-new.jpg'), 'new');
    const saved = customerLibraryRepository.loadCustomer(ws, customer.customerId);
    customerLibraryRepository.saveCustomer({
      ...saved,
      images: [...saved.images, { imageId: 'img_002', originalFileName: 'new.jpg', relativePath: 'images/02-new.jpg', reviewStatus: 'accepted', sortOrder: 2 }],
    });

    // 模拟并发审图操作:持同客户写锁,在锁内改 customer.json(agentName 作探针),占住锁不放
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const held = withCustomerWriteLock(customerLockKey(ws, customer.customerId), async () => {
      const c = customerLibraryRepository.loadCustomer(ws, customer.customerId);
      customerLibraryRepository.saveCustomer({ ...c, agentName: 'Agent A CHANGED' });
      await gate; // 占锁直到测试放行
    });
    await new Promise((r) => setTimeout(r, 10)); // 让持锁回调先跑起来

    // 锁被占期间发起追加:必须排队,不得落盘
    const appendP = service.appendCustomerToBatch({ workspaceKey: ws, customerId: customer.customerId, batchId });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(
      batchRepository.loadBatch(batchId).tasks.length, baseTaskCount,
      '客户锁被占时追加必须排队——曾经无锁直冲,与审图并发互吞 customer.json'
    );

    release();
    await held;
    const appended = await appendP;
    assert.equal(appended.appendedTasks, 1, '放锁后追加完成');

    // 锁内重载 fresh:并发审图写入(agentName 改名)必须存活,追加自己的 review 章也在
    const after = customerLibraryRepository.loadCustomer(ws, customer.customerId);
    assert.equal(after.agentName, 'Agent A CHANGED', '追加不得用旧快照覆盖并发审图写入');
    assert.equal(after.review.lastBatchId, batchId, '追加自己的 review 章照常落盘');
  } finally {
    cleanup(tempRoot);
  }
});
