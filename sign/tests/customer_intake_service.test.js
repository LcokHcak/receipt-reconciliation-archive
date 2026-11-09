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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-intake-service-'));
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
  if (path.extname(filePath).toLowerCase() === '.jpg' || path.extname(filePath).toLowerCase() === '.jpeg') {
    await image.jpeg().toFile(filePath);
    return;
  }
  await image.png().toFile(filePath);
}

test('createCustomer creates a customer folder, metadata, and working template copy in the selected workspace', () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const result = service.createCustomer({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Choi',
      images: [
        {
          imageId: 'img_001',
          relativePath: 'images/01-passport.jpg',
          kind: 'passport',
          source: 'cropped',
          sortOrder: 1,
        },
      ],
    });

    const workingTemplatePath = path.join(
      libraryRoot,
      'wechat-receipts-wed',
      'CL20260420-001',
      ...String(result.customer.template.workingCopyPath || '').split('/')
    );

    assert.equal(result.customer.customerId, 'CL20260420-001');
    assert.equal(result.customer.workspaceKey, 'wechat-receipts-wed');
    assert.equal(result.customer.monthKey, 'wechat-receipts-wed');
    assert.equal(result.customer.agentName, 'Agent Choi');
    assert.equal(result.customers.length, 1);
    assert.equal(fs.readFileSync(workingTemplatePath, 'utf8'), 'template-bytes');
  } finally {
    cleanup(tempRoot);
  }
});

test('customer intake service can switch root, manage workspaces, and expose month compatibility aliases', () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({
      sourceTemplatePath: path.join(tempRoot, 'customer-receipt-template.xlsx'),
    });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const nextRoot = path.join(tempRoot, 'other-library');
    service.setActiveRoot(nextRoot);
    service.ensureWorkspace('korea-visa-0421');

    assert.equal(service.getState().activeRoot, path.resolve(nextRoot));
    assert.deepEqual(service.listWorkspaces(), ['korea-visa-0421']);
    assert.deepEqual(service.listMonths(), ['korea-visa-0421']);
    assert.deepEqual(service.listCustomers('korea-visa-0421'), []);
    assert.equal(
      service.ensureMonth('wechat-receipts-wed'),
      path.join(path.resolve(nextRoot), 'wechat-receipts-wed')
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('createCustomerFromFiles stores uploaded images into the customer folder and records them in metadata', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    const uploadB = path.join(tempRoot, 'upload-b.png');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 80, 60, '#ff0000');
    await createImage(uploadB, 80, 60, '#00ff00');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const result = await service.createCustomerFromFiles({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Lee',
      files: [
        { path: uploadA, originalname: 'passport.jpg' },
        { path: uploadB, originalname: 'receipt top.png' },
      ],
      editManifest: [
        {
          mode: 'single',
          crop: { leftPct: 0, rightPct: 0, topPct: 0, bottomPct: 0 },
        },
        {
          mode: 'delete',
        },
      ],
    });

    assert.equal(result.customer.images.length, 1);
    assert.equal(result.customer.workspaceKey, 'wechat-receipts-wed');
    assert.equal(result.customer.images[0].relativePath, 'images/01-passport.jpg');
    assert.equal(
      fs.existsSync(path.join(libraryRoot, 'wechat-receipts-wed', 'CL20260420-001', 'images', '01-passport.jpg')),
      true
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('appendCustomerImagesFromFiles adds new images without overwriting existing customer files', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    const uploadB = path.join(tempRoot, 'upload-b.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 80, 60, '#ff0000');
    await createImage(uploadB, 80, 60, '#00ff00');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const created = await service.createCustomerFromFiles({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Lee',
      files: [{ path: uploadA, originalname: 'passport.jpg' }],
    });

    const appended = await service.appendCustomerImagesFromFiles({
      workspaceKey: 'wechat-receipts-wed',
      customerId: created.customer.customerId,
      files: [{ path: uploadB, originalname: 'new receipt.jpg' }],
    });

    assert.equal(appended.customer.images.length, 2);
    assert.equal(appended.customer.images[0].imageId, 'img_001');
    assert.equal(appended.customer.images[1].imageId, 'img_002');
    assert.equal(appended.customer.images[0].relativePath, 'images/01-passport.jpg');
    assert.equal(appended.customer.images[1].relativePath, 'images/02-new_receipt.jpg');
    assert.equal(
      fs.existsSync(path.join(libraryRoot, 'wechat-receipts-wed', created.customer.customerId, 'images', '01-passport.jpg')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(libraryRoot, 'wechat-receipts-wed', created.customer.customerId, 'images', '02-new_receipt.jpg')),
      true
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('createCustomerFromFiles reserves the customer folder before async image prep', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-05-18T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });

    let firstPrepStarted;
    const firstPrepReady = new Promise((resolve) => {
      firstPrepStarted = resolve;
    });
    let releaseFirstPrep;
    const firstPrepRelease = new Promise((resolve) => {
      releaseFirstPrep = resolve;
    });
    let prepCalls = 0;
    const customerImagePrepService = {
      async prepareCustomerImages() {
        prepCalls += 1;
        if (prepCalls === 1) {
          firstPrepStarted();
          await firstPrepRelease;
        }
        return [
          {
            imageId: 'img_001',
            relativePath: 'images/upload.jpg',
            kind: 'original',
            source: 'upload',
            sortOrder: 1,
          },
        ];
      },
    };

    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const first = service.createCustomerFromFiles({
      workspaceKey: 'shared-workspace',
      agentName: 'Agent A',
      files: [{ originalname: 'a.jpg' }],
    });
    await firstPrepReady;

    const second = service.createCustomerFromFiles({
      workspaceKey: 'shared-workspace',
      agentName: 'Agent B',
      files: [{ originalname: 'b.jpg' }],
    });
    releaseFirstPrep();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.customer.customerId, 'CL20260518-001');
    assert.equal(secondResult.customer.customerId, 'CL20260518-002');
  } finally {
    cleanup(tempRoot);
  }
});

test('customer intake service stores owner metadata and filters customers for reviewers', () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const alice = service.createCustomer({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Alice',
      ownerUser: { id: 11, userId: 11, username: 'alice', role: 'reviewer' },
    });
    const bob = service.createCustomer({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Bob',
      ownerUser: { id: 12, userId: 12, username: 'bob', role: 'reviewer' },
    });

    assert.equal(alice.customer.ownerUsername, 'alice');
    assert.equal(alice.customer.ownerUserId, 11);
    assert.equal(bob.customer.ownerUsername, 'bob');

    const aliceCustomers = service.listCustomers('wechat-receipts-wed', {
      id: 11,
      userId: 11,
      username: 'alice',
      role: 'reviewer',
    });
    assert.deepEqual(aliceCustomers.map((customer) => customer.customerId), [alice.customer.customerId]);

    const financeCustomers = service.listCustomers('wechat-receipts-wed', {
      id: 20,
      userId: 20,
      username: 'finance',
      role: 'finance',
    });
    assert.deepEqual(
      financeCustomers.map((customer) => customer.customerId),
      [alice.customer.customerId, bob.customer.customerId]
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('customer intake service filters workspaces by the current reviewer owner', () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });
    const alice = { id: 11, userId: 11, username: 'alice', role: 'reviewer' };
    const bob = { id: 12, userId: 12, username: 'bob', role: 'reviewer' };

    service.ensureWorkspace('alice-empty-workspace', { ownerUser: alice });
    service.ensureWorkspace('bob-empty-workspace', { ownerUser: bob });
    service.createCustomer({
      workspaceKey: 'alice-customer-workspace',
      agentName: 'Agent Alice',
      ownerUser: alice,
    });
    service.createCustomer({
      workspaceKey: 'bob-customer-workspace',
      agentName: 'Agent Bob',
      ownerUser: bob,
    });

    assert.deepEqual(service.listWorkspaces(alice), [
      'alice-customer-workspace',
      'alice-empty-workspace',
    ]);
    assert.deepEqual(service.listMonths(bob), [
      'bob-customer-workspace',
      'bob-empty-workspace',
    ]);
    assert.deepEqual(service.listWorkspaces({ username: 'finance', role: 'finance' }), [
      'alice-customer-workspace',
      'alice-empty-workspace',
      'bob-customer-workspace',
      'bob-empty-workspace',
    ]);
  } finally {
    cleanup(tempRoot);
  }
});

test('customer intake service blocks reviewers from appending to or deleting another operator customer', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const uploadA = path.join(tempRoot, 'upload-a.jpg');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');
    await createImage(uploadA, 80, 60, '#ff0000');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const created = service.createCustomer({
      workspaceKey: 'wechat-receipts-wed',
      agentName: 'Agent Alice',
      ownerUser: { id: 11, userId: 11, username: 'alice', role: 'reviewer' },
    });

    await assert.rejects(
      service.appendCustomerImagesFromFiles({
        workspaceKey: 'wechat-receipts-wed',
        customerId: created.customer.customerId,
        files: [{ path: uploadA, originalname: 'receipt.jpg' }],
        operatorUser: { id: 12, userId: 12, username: 'bob', role: 'reviewer' },
      }),
      /customer access denied/
    );

    await assert.rejects(
      () => service.deleteCustomer({
        workspaceKey: 'wechat-receipts-wed',
        customerId: created.customer.customerId,
        force: true,
        operatorUser: { id: 12, userId: 12, username: 'bob', role: 'reviewer' },
      }),
      /customer access denied/
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('deleteCustomer 进客户写锁:与并发同客户持锁者串行(深度审计HIGH:防补图让点间隙删致复活)', async () => {
  const tempRoot = makeTempDir();
  try {
    const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'tpl', 'utf8');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: path.join(tempRoot, 'library'),
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository: createCustomerTemplateRepository({ sourceTemplatePath }),
      customerImagePrepService: createCustomerImagePrepService(),
    });
    const WS = '0420-lock';
    const created = service.createCustomer({ workspaceKey: WS, agentName: 'P', images: [] });
    const cid = created.customer.customerId;

    const order = [];
    // 外部持锁模拟补图 appendCustomerImagesFromFiles 的 await prepareCustomerImages 让点
    const holder = withCustomerWriteLock(customerLockKey(WS, cid), async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('holder-done');
    });
    // 并发物理删:进了同一把锁就必须排队在持锁者之后,不在其让点间隙 rmSync
    const del = service.deleteCustomer({ workspaceKey: WS, customerId: cid, force: true })
      .then(() => order.push('delete-done'));
    await Promise.all([holder, del]);
    assert.deepEqual(order, ['holder-done', 'delete-done'], '删除排在持锁者之后=进了客户写锁(无锁则会抢先删)');
  } finally {
    cleanup(tempRoot);
  }
});

test('customer intake service can force-delete a customer folder and an entire workspace', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'template-bytes', 'utf8');

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customerImagePrepService = createCustomerImagePrepService();
    const service = createCustomerIntakeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerImagePrepService,
    });

    const created = service.createCustomer({
      workspaceKey: '20260421-first-batch',
      agentName: 'Agent Park',
      images: [],
    });

    const customerDeleteResult = await service.deleteCustomer({
      workspaceKey: '20260421-first-batch',
      customerId: created.customer.customerId,
      force: true,
    });
    assert.equal(customerDeleteResult.deleted, true);

    service.ensureWorkspace('20260421-second-batch');
    const workspaceDeleteResult = await service.deleteWorkspace({ // L631:deleteWorkspace 现走 exclusive→async
      workspaceKey: '20260421-second-batch',
      force: true,
    });
    assert.equal(workspaceDeleteResult.deleted, true);
    assert.equal(fs.existsSync(path.join(libraryRoot, '20260421-second-batch')), false);
  } finally {
    cleanup(tempRoot);
  }
});

// L631 集成:deleteWorkspace(workspace-exclusive)必须等在飞 append(workspace-shared)drain 后才 rmSync,
// 杜绝「rmSync 删一半 / append 让点后尾部 saveCustomer 复活残壳」竞态。
test('L631 集成:deleteWorkspace 等在飞 append drain 后才删,不半删/复活', async () => {
  const tempRoot = makeTempDir();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    fs.writeFileSync(sourceTemplatePath, 'x', 'utf8');
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot, settingsPath: path.join(tempRoot, 's.json'),
      nowProvider: () => new Date('2026-04-20T10:00:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });

    // 可控 prep:append 调 prepareCustomerImages 时卡在让点(持 shared 锁),直到 releaseAppend()
    const order = [];
    let releaseAppend;
    const gate = new Promise((r) => { releaseAppend = r; });
    const customerImagePrepService = {
      prepareCustomerImages: async () => {
        order.push('append-let-in');
        await gate;
        order.push('append-let-out');
        return [{ imageId: 'img_1', sortOrder: 1, originalPath: 'x', autoSplitRole: 'receipt' }];
      },
    };
    const service = createCustomerIntakeService({ customerLibraryRepository, customerTemplateRepository, customerImagePrepService });

    const WSK = '2026-04';
    service.ensureWorkspace(WSK);
    const created = service.createCustomer({ workspaceKey: WSK, agentName: 'A', images: [] });
    const custId = created.customer.customerId;

    // append(shared)启动 → 卡在 prepareCustomerImages 让点(持 shared 锁不放)
    const appendP = service.appendCustomerImagesFromFiles({ workspaceKey: WSK, customerId: custId, files: [{ path: 'dummy' }] });
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(order.includes('append-let-in'), 'append 已进入让点(持 shared 锁)');

    // deleteWorkspace(exclusive)启动 → 必须等 append drain,不得在让点期间抢先删
    let deleteDone = false;
    const deleteP = service.deleteWorkspace({ workspaceKey: WSK, force: true }).then(() => { deleteDone = true; order.push('delete-done'); });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deleteDone, false, 'deleteWorkspace 必须等在飞 append drain,不得在 append 让点期间就 rmSync');
    assert.equal(fs.existsSync(path.join(libraryRoot, WSK)), true, '让点期间工作区还在(没被抢先删)');

    // 放行 append → 写盘完成 → deleteWorkspace 才独占删
    releaseAppend();
    await appendP;
    await deleteP;
    assert.ok(order.indexOf('append-let-out') < order.indexOf('delete-done'), 'append 写盘完成早于 delete(不交错)');
    assert.equal(fs.existsSync(path.join(libraryRoot, WSK)), false, '删后工作区干净不存在,无残壳复活');
  } finally {
    cleanup(tempRoot);
  }
});
