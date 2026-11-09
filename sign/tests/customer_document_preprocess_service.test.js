const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');

const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');
const { createCustomerTemplateRepository } = require('../repositories/customer_template_repository');
const { createCustomerImagePrepService } = require('../services/customer_image_prep_service');
const { createCustomerIntakeService } = require('../services/customer_intake_service');
const { createCustomerDocumentPreprocessService } = require('../services/customer_document_preprocess_service');
const { DOC_TYPES } = require('../lib/package_constants');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-doc-preprocess-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

async function createImage(filePath, width, height, color) {
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  }).jpeg().toFile(filePath);
}

function createServices(tempRoot) {
  const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
  fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
  const customerLibraryRepository = createCustomerLibraryRepository({
    defaultRoot: path.join(tempRoot, 'library'),
    settingsPath: path.join(tempRoot, 'settings.json'),
    nowProvider: () => new Date('2026-04-26T10:00:00+09:00'),
  });
  const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
  const customerIntakeService = createCustomerIntakeService({
    customerLibraryRepository,
    customerTemplateRepository,
    customerImagePrepService: createCustomerImagePrepService(),
  });
  return { customerLibraryRepository, customerIntakeService };
}

test('preprocessCustomer replaces an uploaded image with original plus detected region crops', async () => {
  const tempRoot = makeTempDir();

  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const uploadPath = path.join(tempRoot, 'mixed.jpg');
    await createImage(uploadPath, 120, 80, '#dddddd');

    const created = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Kim',
      files: [{ path: uploadPath, originalname: 'mixed.jpg' }],
    });

    let splitCalls = 0;
    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository,
      documentSplitService: {
        splitImage: async (options) => {
          splitCalls += 1;
          const originalName = options.buildFileName(options.startIndex, options.originalFileName, '_original');
          const passportName = options.buildFileName(options.startIndex + 1, options.originalFileName, '_passport_1');
          const receiptName = options.buildFileName(options.startIndex + 2, options.originalFileName, '_receipt_2');
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, originalName));
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, passportName));
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, receiptName));
          return {
            splitApplied: true,
            outputs: [
              { fileName: originalName, originalFileName: options.originalFileName, source: 'uploaded_original', autoSplitRole: 'original' },
              { fileName: passportName, originalFileName: options.originalFileName, source: 'uploaded_split', autoSplitRole: 'region', docTypeHint: DOC_TYPES.PASSPORT, docTypeConfidence: 0.97 },
              { fileName: receiptName, originalFileName: options.originalFileName, source: 'uploaded_split', autoSplitRole: 'region', docTypeHint: DOC_TYPES.RECEIPT, docTypeConfidence: 0.91 },
            ],
          };
        },
      },
    });

    const result = await service.preprocessCustomer({
      workspaceKey: '0426-test',
      customerId: created.customer.customerId,
    });

    assert.equal(result.summary.inputImages, 1);
    assert.equal(result.summary.outputImages, 3);
    assert.equal(result.summary.splitImages, 2);
    assert.equal(result.customer.images.length, 3);
    assert.deepEqual(
      result.customer.images.map((image) => image.autoSplitRole),
      ['original', 'region', 'region']
    );
    assert.deepEqual(
      result.customer.images.map((image) => image.docTypeHint || ''),
      ['', DOC_TYPES.PASSPORT, DOC_TYPES.RECEIPT]
    );
    assert.equal(result.customer.preprocess.status, 'processed');
    assert.equal(result.customer.preprocess.splitImages, 2);

    const secondResult = await service.preprocessCustomer({
      workspaceKey: '0426-test',
      customerId: created.customer.customerId,
    });

    assert.equal(splitCalls, 1);
    assert.equal(secondResult.summary.inputImages, 3);
    assert.equal(secondResult.summary.outputImages, 3);
    assert.equal(secondResult.summary.splitImages, 2);
    assert.deepEqual(
      secondResult.customer.images.map((image) => image.autoSplitRole),
      ['original', 'region', 'region']
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('preprocessCustomer 强制 forceRefresh(重新识别绕过进程内缓存,深度审计MEDIUM:误读能纠)', async () => {
  const tempRoot = makeTempDir();
  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const uploadPath = path.join(tempRoot, 'a.jpg');
    await createImage(uploadPath, 120, 80, '#cccccc');
    const created = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test', agentName: 'K', files: [{ path: uploadPath, originalname: 'a.jpg' }],
    });

    const forceRefreshSeen = [];
    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository,
      documentSplitService: {
        splitImage: async (options) => {
          forceRefreshSeen.push(options.forceRefresh);
          return { splitApplied: false, outputs: [] }; // keep 原图,不影响断言
        },
      },
    });

    await service.preprocessCustomer({ workspaceKey: '0426-test', customerId: created.customer.customerId });
    assert.ok(forceRefreshSeen.length >= 1, 'splitImage 被调用');
    assert.ok(forceRefreshSeen.every((v) => v === true),
      'preprocessCustomer 必须传 forceRefresh:true——否则重新识别命中进程内 cache 回放旧 OCR,误读修不掉');
  } finally {
    cleanup(tempRoot);
  }
});

test('preprocessCustomer keeps the uploaded image when model splitting fails', async () => {
  const tempRoot = makeTempDir();

  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const uploadPath = path.join(tempRoot, 'single.jpg');
    await createImage(uploadPath, 80, 80, '#eeeeee');

    const created = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Kim',
      files: [{ path: uploadPath, originalname: 'single.jpg' }],
    });

    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository,
      documentSplitService: {
        splitImage: async () => {
          throw new Error('model unavailable');
        },
      },
    });

    const result = await service.preprocessCustomer({
      workspaceKey: '0426-test',
      customerId: created.customer.customerId,
    });

    assert.equal(result.customer.images.length, 1);
    assert.equal(result.customer.images[0].preprocessStatus, 'processed');
    assert.match(result.customer.images[0].preprocessMessage, /model unavailable/);
    assert.equal(result.customer.preprocess.status, 'needs_review');
    assert.equal(result.customer.preprocess.failedImages, 0);
    assert.equal(result.customer.preprocess.warningImages, 1);
  } finally {
    cleanup(tempRoot);
  }
});

test('preprocessCustomer persists per-image progress while running', async () => {
  const tempRoot = makeTempDir();

  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const uploadA = path.join(tempRoot, 'progress-a.jpg');
    const uploadB = path.join(tempRoot, 'progress-b.jpg');
    await createImage(uploadA, 80, 80, '#dddddd');
    await createImage(uploadB, 80, 80, '#eeeeee');

    const created = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Kim',
      files: [
        { path: uploadA, originalname: 'progress-a.jpg' },
        { path: uploadB, originalname: 'progress-b.jpg' },
      ],
    });

    const snapshots = [];
    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository,
      documentSplitService: {
        splitImage: async () => {
          snapshots.push(customerLibraryRepository.loadCustomer(
            '0426-test',
            created.customer.customerId
          ).preprocess);
          return { splitApplied: false, outputs: [] };
        },
      },
    });

    const result = await service.preprocessCustomer({
      workspaceKey: '0426-test',
      customerId: created.customer.customerId,
    });

    // 并行化后进度在每图完成时更新(反映已完成数),不再是串行的 currentImage=1/2。
    // 只断言:处理中确有进度写入、总数正确、最终 currentImage=totalImages。
    assert.equal(snapshots.length, 2);
    for (const snap of snapshots) {
      assert.equal(snap.status, 'processing');
      assert.equal(snap.totalImages, 2);
      assert.ok(snap.currentImage >= 0 && snap.currentImage <= 2);
    }
    assert.equal(result.customer.preprocess.status, 'processed');
    assert.equal(result.customer.preprocess.currentImage, 2);
    assert.equal(result.customer.preprocess.totalImages, 2);
  } finally {
    cleanup(tempRoot);
  }
});

test('preprocessCustomer does not recreate a customer deleted while preprocessing', async () => {
  const tempRoot = makeTempDir();

  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const uploadPath = path.join(tempRoot, 'delete-while-processing.jpg');
    await createImage(uploadPath, 80, 80, '#dddddd');

    const created = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test',
      agentName: 'Agent Kim',
      files: [{ path: uploadPath, originalname: 'delete-while-processing.jpg' }],
    });

    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository,
      documentSplitService: {
        splitImage: async () => {
          customerLibraryRepository.deleteCustomer('0426-test', created.customer.customerId, { force: true });
          return { splitApplied: false, outputs: [] };
        },
      },
    });

    const result = await service.preprocessCustomer({
      workspaceKey: '0426-test',
      customerId: created.customer.customerId,
    });

    assert.equal(result.customer, null);
    assert.equal(result.summary.status, 'deleted_during_preprocess');
    assert.deepEqual(customerLibraryRepository.listCustomers('0426-test'), []);
    assert.equal(
      fs.existsSync(customerLibraryRepository.findExistingCustomerDirectory('0426-test', created.customer.customerId) || ''),
      false
    );
  } finally {
    cleanup(tempRoot);
  }
});

// 建档并行提速(2026-07-07):单客户多图并行切图 + 独立startIndex块防撞名 + 全局闸。
test('preprocessCustomer:多图并行不撞文件名、按原图顺序重排、全局闸限并发', async () => {
  const tempRoot = makeTempDir();
  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const files = [];
    for (let i = 0; i < 6; i++) {
      const p = path.join(tempRoot, `p${i}.jpg`);
      await createImage(p, 80, 80, { r: 100 + i * 20, g: 100, b: 100 });
      files.push({ path: p, originalname: `p${i}.jpg` });
    }
    const created = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test', agentName: 'Agent Kim', files,
    });

    let active = 0; let peak = 0;
    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository,
      imageConcurrency: 3,
      maxConcurrentSplits: 2, // 全局闸=2:峰值并发绝不超过2
      documentSplitService: {
        splitImage: async (options) => {
          active += 1; peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 15));
          // 每图切成 original + 1 region(用 startIndex 块命名 → 并行不撞)
          const originalName = options.buildFileName(options.startIndex, options.originalFileName, '_original');
          const regionName = options.buildFileName(options.startIndex + 1, options.originalFileName, '_receipt_1');
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, originalName));
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, regionName));
          active -= 1;
          return {
            splitApplied: true,
            outputs: [
              { fileName: originalName, originalFileName: options.originalFileName, autoSplitRole: 'original', source: 'uploaded_original' },
              { fileName: regionName, originalFileName: options.originalFileName, autoSplitRole: 'region', source: 'uploaded_split' },
            ],
          };
        },
      },
    });

    const result = await service.preprocessCustomer({ workspaceKey: '0426-test', customerId: created.customer.customerId });

    // 全局闸生效:峰值≤2
    assert.ok(peak <= 2, `峰值并发应≤2,实际${peak}`);
    // 6图×2产出=12,imageId/sortOrder 连续无洞、无重复
    const imgs = result.customer.images;
    assert.equal(imgs.length, 12);
    const sorts = imgs.map((x) => x.sortOrder);
    assert.deepEqual(sorts, Array.from({ length: 12 }, (_, i) => i + 1), '排序应连续1..12');
    // 文件名唯一(并行不撞)
    const names = imgs.map((x) => x.relativePath);
    assert.equal(new Set(names).size, 12, '文件名应全唯一');
    // 原图顺序保持:每张原图的 region 紧跟其 original(块内成对)
    assert.equal(result.summary.splitImages, 6);
    assert.equal(result.summary.status, 'processed');
  } finally {
    cleanup(tempRoot);
  }
});

// preprocessWorkspace 的 per-customer 隔离:单个客户预处理抛错不能掀翻整批,否则 CL019「缺护照」
// 放大复发(cae1ee8 的批次回灌安全网被一个无关坏客户整段跳过)。
test('preprocessWorkspace:单个客户预处理抛错不掀翻整批,兄弟客户照常切图+失败清单上报', async () => {
  const tempRoot = makeTempDir();
  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const upA = path.join(tempRoot, 'a.jpg');
    const upB = path.join(tempRoot, 'b.jpg');
    await createImage(upA, 120, 80, '#cccccc');
    await createImage(upB, 120, 80, '#dddddd');
    const a = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test', agentName: 'Agent Kim', files: [{ path: upA, originalname: 'a.jpg' }],
    });
    const b = await customerIntakeService.createCustomerFromFiles({
      workspaceKey: '0426-test', agentName: 'Agent Lee', files: [{ path: upB, originalname: 'b.jpg' }],
    });
    const badId = b.customer.customerId;

    // 包一层 repo:让坏客户的 saveCustomer 抛错(模拟落盘 EBUSY/磁盘满)
    const wrappedRepo = {
      ...customerLibraryRepository,
      saveCustomer: (payload) => {
        if (payload && payload.customerId === badId) throw new Error('磁盘满 ENOSPC');
        return customerLibraryRepository.saveCustomer(payload);
      },
    };

    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository: wrappedRepo,
      documentSplitService: {
        splitImage: async (options) => {
          const originalName = options.buildFileName(options.startIndex, options.originalFileName, '_original');
          const passportName = options.buildFileName(options.startIndex + 1, options.originalFileName, '_passport_1');
          const receiptName = options.buildFileName(options.startIndex + 2, options.originalFileName, '_receipt_2');
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, originalName));
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, passportName));
          fs.copyFileSync(options.sourcePath, path.join(options.imagesDir, receiptName));
          return {
            splitApplied: true,
            outputs: [
              { fileName: originalName, originalFileName: options.originalFileName, source: 'uploaded_original', autoSplitRole: 'original' },
              { fileName: passportName, originalFileName: options.originalFileName, source: 'uploaded_split', autoSplitRole: 'region', docTypeHint: DOC_TYPES.PASSPORT, docTypeConfidence: 0.97 },
              { fileName: receiptName, originalFileName: options.originalFileName, source: 'uploaded_split', autoSplitRole: 'region', docTypeHint: DOC_TYPES.RECEIPT, docTypeConfidence: 0.91 },
            ],
          };
        },
      },
    });

    // 整批不抛(旧代码这里会 Promise.all reject → 抛到 handler → 回灌循环整段不执行)
    const result = await service.preprocessWorkspace({ workspaceKey: '0426-test' });

    assert.equal(result.results.length, 2, '两个客户都在 results 里');
    const goodResult = result.results.find((r) => r && r.customer && r.customer.customerId === a.customer.customerId);
    assert.ok(goodResult, '好客户有结果');
    assert.equal(goodResult.summary.splitImages, 2, '好客户照常切图(不受坏客户拖累)');
    const badResult = result.results.find((r) => r && r.error && r.customerId === badId);
    assert.ok(badResult, '坏客户记为错误占位而非 undefined');
    assert.match(String(badResult.error), /ENOSPC/);
    assert.equal(badResult.customer, null);
    assert.deepEqual(result.failedCustomers, [{ customerId: badId, error: badResult.error }], '失败清单上报供操作员感知');
    assert.equal(result.summary.failedCustomers, 1);
    assert.equal(result.summary.splitImages, 2, '汇总只计好客户的切图,数值不炸');
  } finally {
    cleanup(tempRoot);
  }
});

// 启动恢复:重启杀死飞行中的预处理后,残留 'processing' 客户永挂「识别中」永不入批次(审计MEDIUM)。
test('recoverInterruptedPreprocess:残留 processing → error 待重识别;已完成的不动;幂等', async () => {
  const tempRoot = makeTempDir();
  try {
    const { customerLibraryRepository, customerIntakeService } = createServices(tempRoot);
    const upA = path.join(tempRoot, 'xa.jpg');
    const upB = path.join(tempRoot, 'xb.jpg');
    await createImage(upA, 100, 100, '#cccccc');
    await createImage(upB, 100, 100, '#dddddd');
    const a = await customerIntakeService.createCustomerFromFiles({ workspaceKey: '0426-test', agentName: 'A', files: [{ path: upA, originalname: 'xa.jpg' }] });
    const b = await customerIntakeService.createCustomerFromFiles({ workspaceKey: '0426-test', agentName: 'B', files: [{ path: upB, originalname: 'xb.jpg' }] });
    // A 卡在 processing(模拟重启前正在识别);B 已 processed(不该动)
    const aFull = customerLibraryRepository.loadCustomer('0426-test', a.customer.customerId);
    customerLibraryRepository.saveCustomer({ ...aFull, preprocess: { status: 'processing', current: 1, total: 3 } });
    const bFull = customerLibraryRepository.loadCustomer('0426-test', b.customer.customerId);
    customerLibraryRepository.saveCustomer({ ...bFull, preprocess: { status: 'processed' } });

    const service = createCustomerDocumentPreprocessService({
      customerLibraryRepository,
      documentSplitService: { splitImage: async () => ({ splitApplied: false, outputs: [] }) },
    });

    assert.equal(service.recoverInterruptedPreprocess(), 1, '只恢复 1 个卡住的');
    const aAfter = customerLibraryRepository.loadCustomer('0426-test', a.customer.customerId);
    assert.equal(aAfter.preprocess.status, 'error', 'processing → error');
    assert.match(aAfter.preprocess.error, /重启|重新识别/, '带人话原因');
    const bAfter = customerLibraryRepository.loadCustomer('0426-test', b.customer.customerId);
    assert.equal(bAfter.preprocess.status, 'processed', '已完成的不动');

    assert.equal(service.recoverInterruptedPreprocess(), 0, '幂等:再跑不再改(A 已非 processing)');
  } finally {
    cleanup(tempRoot);
  }
});
