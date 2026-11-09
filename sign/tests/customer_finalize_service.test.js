const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');

const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');
const { createCustomerTemplateRepository } = require('../repositories/customer_template_repository');
const { createCustomerTemplateFillService } = require('../services/customer_template_fill_service');
const { createCustomerFinalizeService } = require('../services/customer_finalize_service');
const { withCustomerWriteLock, customerLockKey } = require('../lib/customer_write_lock');

// 仓库内真实模板(跨平台:相对 __dirname 解析,不写死本机 D: 路径)
const REAL_TEMPLATE = path.join(__dirname, '..', 'passport_review_workbench', 'templates', 'customer-receipt-template.xlsx');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-finalize-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

async function createSignature(filePath) {
  await sharp({
    create: {
      width: 180,
      height: 60,
      channels: 4,
      background: '#111111',
    },
  }).png().toFile(filePath);
}

test('finalizeApprovedGroup renames the customer folder, copies signature, and writes the final workbook', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const batchRootDir = path.join(tempRoot, 'batch_1');
    const signaturePath = path.join(batchRootDir, 'final_signatures', 'passport-sign.png');
    fs.mkdirSync(path.dirname(signaturePath), { recursive: true });
    fs.copyFileSync(
      REAL_TEMPLATE,
      sourceTemplatePath
    );
    await createSignature(signaturePath);

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '20260421-第一批',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    customer.review.lastBatchId = 'batch_1';
    customer.review.lastSourceGroupId = 'group_123';
    customer.status = 'in_review';
    customerLibraryRepository.saveCustomer(customer);
    customerTemplateRepository.createWorkingTemplate(
      customerLibraryRepository.customerDir('20260421-第一批', 'CL20260420-001')
    );

    const templateFillService = createCustomerTemplateFillService();
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: templateFillService,
    });

    const result = await finalizeService.finalizeApprovedGroup({
      batchId: 'batch_1',
      batchRootDir,
      groupKey: 'group_123',
      groupTasks: [
        {
          docTypeFinal: 'passport',
          extractedNameFinal: 'HUANG YU',
          passportNoFinal: 'EM7242787',
          chineseNameFinal: '黄玉',
          finalSignaturePath: path.join('final_signatures', 'passport-sign.png'),
          reviewedAt: '2025-12-18T09:00:00.000Z',
        },
        {
          docTypeFinal: 'receipt',
          receiptAmountAuto: '56000',
          reviewedAt: '2025-12-18T09:00:00.000Z',
        },
      ],
    });

    const finalCustomerDir = path.join(libraryRoot, '20260421-第一批', 'HUANG YU_EM7242787');
    assert.equal(result.folderNameFinal, 'HUANG YU_EM7242787');
    assert.equal(fs.existsSync(finalCustomerDir), true);
    // 2026-06-13 中文签名下线:不再复制系统签名图进客户文件夹
    assert.equal(fs.existsSync(path.join(finalCustomerDir, 'generated', 'signature.png')), false);
    assert.equal(fs.existsSync(path.join(finalCustomerDir, 'template', '账单-HUANG YU.xlsx')), true);

    const finalizedCustomer = customerLibraryRepository.loadCustomer('20260421-第一批', 'CL20260420-001');
    assert.equal(finalizedCustomer.folderNameFinal, 'HUANG YU_EM7242787');
    assert.equal(finalizedCustomer.displayName, 'HUANG YU');
    assert.equal(finalizedCustomer.passportNumber, 'EM7242787');
    assert.equal(finalizedCustomer.status, 'template_generated');
    assert.equal(finalizedCustomer.review.approvedAt, '2025-12-18T09:00:00.000Z');
  } finally {
    cleanup(tempRoot);
  }
});

test('finalizeApprovedGroup skips non-customer review groups without failing the approval flow', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.copyFileSync(
      REAL_TEMPLATE,
      sourceTemplatePath
    );

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const templateFillService = createCustomerTemplateFillService();
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: templateFillService,
    });

    const result = await finalizeService.finalizeApprovedGroup({
      batchId: 'batch_misc',
      batchRootDir: path.join(tempRoot, 'batch_misc'),
      groupKey: 'group_misc',
      groupTasks: [
        {
          docTypeFinal: 'passport',
          extractedNameFinal: 'KIM YUNA',
          passportNoFinal: 'M1234567',
        },
      ],
    });

    assert.equal(result, null);
  } finally {
    cleanup(tempRoot);
  }
});

test('finalizeApprovedGroup falls back to source-group folder matching when review references are missing', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const batchRootDir = path.join(tempRoot, 'batch_1');
    const signaturePath = path.join(batchRootDir, 'final_signatures', 'passport-sign.png');
    fs.mkdirSync(path.dirname(signaturePath), { recursive: true });
    fs.copyFileSync(
      REAL_TEMPLATE,
      sourceTemplatePath
    );
    await createSignature(signaturePath);

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    customerLibraryRepository.createCustomerFolder({ // 只要副作用(建夹),返回值不用
      monthKey: '202604',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    customerTemplateRepository.createWorkingTemplate(
      customerLibraryRepository.customerDir('202604', 'CL20260420-001')
    );

    const templateFillService = createCustomerTemplateFillService();
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: templateFillService,
    });

    const result = await finalizeService.finalizeApprovedGroup({
      batchId: 'batch_1',
      batchRootDir,
      groupKey: 'group_123',
      sourceGroupLabel: 'CL20260420-001',
      sourceGroupFolderPath: 'CL20260420-001',
      groupTasks: [
        {
          docTypeFinal: 'passport',
          extractedNameFinal: 'HUO YAWEN',
          passportNoFinal: 'EP2178888',
          chineseNameFinal: '霍雅雯',
          finalSignaturePath: path.join('final_signatures', 'passport-sign.png'),
          reviewedAt: '2026-04-20T15:00:00.000Z',
        },
      ],
    });

    assert.equal(result.folderNameFinal, 'HUO YAWEN_EP2178888');
    assert.equal(
      fs.existsSync(path.join(libraryRoot, '202604', 'HUO YAWEN_EP2178888', 'customer.json')),
      true
    );

    const finalizedCustomer = customerLibraryRepository.loadCustomer('202604', 'CL20260420-001');
    assert.equal(finalizedCustomer.folderNameFinal, 'HUO YAWEN_EP2178888');
    assert.equal(finalizedCustomer.review.approvedAt, '2026-04-20T15:00:00.000Z');
  } finally {
    cleanup(tempRoot);
  }
});

test('finalizeApprovedGroup reports customer groups missing passport identity as approval validation errors', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    fs.copyFileSync(
      REAL_TEMPLATE,
      sourceTemplatePath
    );

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '20260421-第一批',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    customer.review.lastBatchId = 'batch_1';
    customer.review.lastSourceGroupId = 'group_123';
    customer.status = 'in_review';
    customerLibraryRepository.saveCustomer(customer);

    const templateFillService = createCustomerTemplateFillService();
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: templateFillService,
    });

    await assert.rejects(
      () => finalizeService.finalizeApprovedGroup({
        batchId: 'batch_1',
        batchRootDir: path.join(tempRoot, 'batch_1'),
        groupKey: 'group_123',
        groupTasks: [
          {
            id: 'other-1',
            docTypeFinal: 'other',
            reviewedAt: '2026-04-20T15:00:00.000Z',
          },
        ],
      }),
      (error) => {
        assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
        assert.equal(error.taskId, 'other-1');
        assert.equal(error.issue, 'passport_missing');
        return true;
      }
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('finalizeApprovedGroup delegates bill generation to the billing export service', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const batchRootDir = path.join(tempRoot, 'batch_1');
    const signaturePath = path.join(batchRootDir, 'final_signatures', 'passport-sign.png');
    fs.mkdirSync(path.dirname(signaturePath), { recursive: true });
    fs.copyFileSync(
      REAL_TEMPLATE,
      sourceTemplatePath
    );
    await createSignature(signaturePath);

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '202604',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    customer.contactPhone = '010-2222-3333';
    customer.review.lastBatchId = 'batch_1';
    customer.review.lastSourceGroupId = 'group_123';
    customer.status = 'in_review';
    customerLibraryRepository.saveCustomer(customer);
    customerTemplateRepository.createWorkingTemplate(
      customerLibraryRepository.customerDir('202604', 'CL20260420-001')
    );

    const billingCalls = [];
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: {
        fillTemplate: async () => {
          throw new Error('legacy template fill should not be called');
        },
      },
      billingExportService: {
        exportCustomerBill: async (input) => {
          billingCalls.push(input);
          fs.mkdirSync(input.outputDir, { recursive: true });
          const outputPath = path.join(input.outputDir, 'bill-output.xlsx');
          fs.writeFileSync(outputPath, 'bill');
          return { outputPath };
        },
      },
    });

    const result = await finalizeService.finalizeApprovedGroup({
      batchId: 'batch_1',
      batchRootDir,
      groupKey: 'group_123',
      groupTasks: [
        {
          docTypeFinal: 'passport',
          extractedNameFinal: 'HUO YAWEN',
          passportNoFinal: 'EP2178888',
          finalSignaturePath: path.join('final_signatures', 'passport-sign.png'),
          reviewedAt: '2026-04-20T15:00:00.000Z',
        },
        {
          docTypeFinal: 'receipt',
          receiptAmountFinal: '88000',
        },
      ],
    });

    assert.equal(billingCalls.length, 1);
    assert.equal(billingCalls[0].customer.travelerName, 'HUO YAWEN');
    assert.equal(billingCalls[0].customer.passportNumber, 'EP2178888');
    assert.equal(billingCalls[0].customer.contactPhone, '010-2222-3333');
    assert.equal(billingCalls[0].customer.receiptAmount, '88000');
    assert.equal(billingCalls[0].approvedAt, '2026-04-20T15:00:00.000Z');
    // 2026-06-13 中文签名彻底下线:signaturePath 参数已移除,账单导出不再涉及签名
    assert.equal('signaturePath' in billingCalls[0], false, '不应再向账单导出传 signaturePath');
    assert.equal(path.basename(result.finalTemplatePath), 'bill-output.xlsx');

    const finalizedCustomer = customerLibraryRepository.loadCustomer('202604', 'CL20260420-001');
    assert.equal(finalizedCustomer.template.finalOutputPath, 'template/bill-output.xlsx');
  } finally {
    cleanup(tempRoot);
  }
});

test('并发丢更新守卫(8模块审计HIGH):终审进客户写锁,补图在 exportCustomerBill 让点并发写不被整盘覆盖', async () => {
  const tempRoot = makeTempDir();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    fs.copyFileSync(REAL_TEMPLATE, sourceTemplatePath);
    const WS = '202607-并发';
    const CID = 'CL20260702-777';

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-02T10:00:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: WS, customerId: CID, agentName: '陈强', images: [],
    });
    customer.review.lastBatchId = 'b1';
    customer.review.lastSourceGroupId = 'g1';
    customer.status = 'in_review';
    customerLibraryRepository.saveCustomer(customer);
    customerTemplateRepository.createWorkingTemplate(customerLibraryRepository.customerDir(WS, CID));

    // 注入 billingExportService:在终审的 await 让点发起一次并发补图(走同一把客户写锁)。
    // 无锁时:补图在让点期间落盘 img_new,终审尾部 saveCustomer 用旧快照整盘覆盖→img_new 丢。
    // 有锁时:补图排队在终审之后串行执行→img_new 幸存,且终审的 template_generated 也在。
    let appendDone = Promise.resolve();
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: createCustomerTemplateFillService(),
      billingExportService: {
        exportCustomerBill: async (input) => {
          appendDone = withCustomerWriteLock(customerLockKey(WS, CID), async () => {
            const c = customerLibraryRepository.loadCustomer(WS, CID);
            c.images = [...(c.images || []), { imageId: 'img_new', sortOrder: 1, relativePath: 'new.jpg' }];
            customerLibraryRepository.saveCustomer(c);
          });
          await new Promise((r) => setTimeout(r, 25)); // 给并发补图落盘的机会(无锁时它会趁机插进来)
          fs.mkdirSync(input.outputDir, { recursive: true });
          const outputPath = path.join(input.outputDir, 'bill.xlsx');
          fs.writeFileSync(outputPath, 'bill');
          return { outputPath };
        },
      },
    });

    const result = await finalizeService.finalizeApprovedGroup({
      batchId: 'b1', batchRootDir: path.join(tempRoot, 'b1'), groupKey: 'g1',
      groupTasks: [
        { docTypeFinal: 'passport', extractedNameFinal: 'CHEN QIANG', passportNoFinal: 'EK1234567', reviewedAt: '2026-07-02T01:00:00.000Z' },
        { docTypeFinal: 'receipt', receiptNoFinal: '9999', reviewedAt: '2026-07-02T01:00:00.000Z' },
      ],
    });
    await appendDone;

    const final = customerLibraryRepository.loadCustomer(WS, CID);
    assert.equal(result.folderNameFinal, 'CHEN QIANG_EK1234567');
    assert.equal(final.status, 'template_generated', '终审结果保留');
    assert.ok(
      (final.images || []).some((im) => im.imageId === 'img_new'),
      '并发补图的图片记录必须幸存,不被终审旧快照整盘覆盖(丢更新守卫)',
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('finalizeApprovedGroup is idempotent for already generated templates', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const batchRootDir = path.join(tempRoot, 'batch_1');
    const signaturePath = path.join(batchRootDir, 'final_signatures', 'passport-sign.png');
    fs.mkdirSync(path.dirname(signaturePath), { recursive: true });
    fs.copyFileSync(
      REAL_TEMPLATE,
      sourceTemplatePath
    );
    await createSignature(signaturePath);

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-04-20T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '202604',
      customerId: 'CL20260420-001',
      agentName: 'Agent Han',
      images: [],
    });
    customer.review.lastBatchId = 'batch_1';
    customer.review.lastSourceGroupId = 'group_123';
    customer.status = 'in_review';
    customerLibraryRepository.saveCustomer(customer);
    customerTemplateRepository.createWorkingTemplate(
      customerLibraryRepository.customerDir('202604', 'CL20260420-001')
    );

    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: createCustomerTemplateFillService(),
    });
    const args = {
      batchId: 'batch_1',
      batchRootDir,
      groupKey: 'group_123',
      groupTasks: [
        {
          docTypeFinal: 'passport',
          extractedNameFinal: 'HUO YAWEN',
          passportNoFinal: 'EP2178888',
          chineseNameFinal: '\u970d\u96c5\u96ef',
          finalSignaturePath: path.join('final_signatures', 'passport-sign.png'),
          reviewedAt: '2026-04-20T15:00:00.000Z',
        },
      ],
    };

    const first = await finalizeService.finalizeApprovedGroup(args);
    const second = await finalizeService.finalizeApprovedGroup(args);

    assert.equal(first.folderNameFinal, 'HUO YAWEN_EP2178888');
    assert.equal(second.folderNameFinal, 'HUO YAWEN_EP2178888');
    assert.equal(second.alreadyGenerated, true);
  } finally {
    cleanup(tempRoot);
  }
});

test('归档改名冲突分流:二次收票(新票号)自动 _2 后缀;真重复(票号撞台账)拦下', async () => {
  const tempRoot = makeTempDir();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    fs.copyFileSync(REAL_TEMPLATE, sourceTemplatePath);

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-02T10:00:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: createCustomerTemplateFillService(),
    });

    const WS = '260702-小票08';
    function makeCustomer(customerId, batchId, groupKey) {
      const customer = customerLibraryRepository.createCustomerFolder({
        workspaceKey: WS, customerId, agentName: '陈强', images: [],
      });
      customer.review.lastBatchId = batchId;
      customer.review.lastSourceGroupId = groupKey;
      customer.status = 'in_review';
      customerLibraryRepository.saveCustomer(customer);
      customerTemplateRepository.createWorkingTemplate(customerLibraryRepository.customerDir(WS, customerId));
    }
    const passportTask = {
      docTypeFinal: 'passport', extractedNameFinal: 'CHEN WEIQING', passportNoFinal: 'EJ4797716',
      chineseNameFinal: '陈伟青', reviewedAt: '2026-07-02T01:00:00.000Z',
    };

    // 第一次收票:正常归档
    makeCustomer('CL20260702-001', 'b1', 'g1');
    const first = await finalizeService.finalizeApprovedGroup({
      batchId: 'b1', batchRootDir: path.join(tempRoot, 'b1'), groupKey: 'g1',
      groupTasks: [passportTask, { docTypeFinal: 'receipt', receiptNoFinal: '1111', reviewedAt: '2026-07-02T01:00:00.000Z' }],
    });
    assert.equal(first.folderNameFinal, 'CHEN WEIQING_EJ4797716');
    assert.equal(first.folderSuffixed, false);

    // 二次收票(全新票号,台账查重返回空)→ 自动 _2 后缀放行
    finalizeService.setSettledReceiptLookup((passportNo, _receiptNos) => {
      assert.equal(passportNo, 'EJ4797716');
      return []; // 无重叠 = 合法二次收票
    });
    makeCustomer('CL20260702-002', 'b2', 'g2');
    const second = await finalizeService.finalizeApprovedGroup({
      batchId: 'b2', batchRootDir: path.join(tempRoot, 'b2'), groupKey: 'g2',
      groupTasks: [passportTask, { docTypeFinal: 'receipt', receiptNoFinal: '2222', reviewedAt: '2026-07-02T02:00:00.000Z' }],
    });
    assert.equal(second.folderNameFinal, 'CHEN WEIQING_EJ4797716_2');
    assert.equal(second.folderSuffixed, true);
    assert.equal(fs.existsSync(path.join(libraryRoot, WS, 'CHEN WEIQING_EJ4797716_2')), true);
    assert.equal(
      customerLibraryRepository.loadCustomer(WS, 'CL20260702-002').folderNameFinal,
      'CHEN WEIQING_EJ4797716_2',
    );

    // 真重复(组里所有票都已在台账)→ 拦下并携带撞的票号
    finalizeService.setSettledReceiptLookup(() => ['1111']);
    makeCustomer('CL20260702-003', 'b3', 'g3');
    await assert.rejects(
      () => finalizeService.finalizeApprovedGroup({
        batchId: 'b3', batchRootDir: path.join(tempRoot, 'b3'), groupKey: 'g3',
        groupTasks: [passportTask, { docTypeFinal: 'receipt', receiptNoFinal: '1111', reviewedAt: '2026-07-02T03:00:00.000Z' }],
      }),
      (error) => error.code === 'CUSTOMER_FOLDER_EXISTS' && String(error.duplicateReceiptNos) === '1111',
    );

    // 部分撞·免税店小票(老票1111+新票3333 同组)→ **仍拦**(2026-07-14 二次修正:
    // 分家口径——免税店重传老票=操作失误早拦早清,放宽只给纯百货组)
    finalizeService.setSettledReceiptLookup(() => ['1111']);
    await assert.rejects(
      () => finalizeService.finalizeApprovedGroup({
        batchId: 'b3', batchRootDir: path.join(tempRoot, 'b3'), groupKey: 'g3',
        groupTasks: [passportTask,
          { docTypeFinal: 'receipt', receiptNoFinal: '1111', reviewedAt: '2026-07-02T03:00:00.000Z' },
          { docTypeFinal: 'receipt', receiptNoFinal: '3333', reviewedAt: '2026-07-02T03:05:00.000Z' }],
      }),
      (error) => error.code === 'CUSTOMER_FOLDER_EXISTS' && String(error.duplicateReceiptNos) === '1111',
    );

    // 部分撞·纯百货组(老交易+新交易同组=百货多笔常态)→ 放行走后缀归档
    finalizeService.setSettledReceiptLookup(() => ['1111']);
    const partial = await finalizeService.finalizeApprovedGroup({
      batchId: 'b3', batchRootDir: path.join(tempRoot, 'b3'), groupKey: 'g3',
      groupTasks: [passportTask,
        { docTypeFinal: 'receipt', receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '1111', reviewedAt: '2026-07-02T03:00:00.000Z' },
        { docTypeFinal: 'receipt', receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '3333', reviewedAt: '2026-07-02T03:05:00.000Z' }],
    });
    assert.equal(partial.folderSuffixed, true);
    assert.equal(partial.folderNameFinal, 'CHEN WEIQING_EJ4797716_3'); // _2 已被二次收票占

    // 跨形态判同一票:台账存带杠 '5801-0110',组里填纯数字 '58010110' → 数字投影视为同票,全撞仍拦
    finalizeService.setSettledReceiptLookup(() => ['5801-0110']);
    makeCustomer('CL20260702-004', 'b4', 'g4');
    await assert.rejects(
      () => finalizeService.finalizeApprovedGroup({
        batchId: 'b4', batchRootDir: path.join(tempRoot, 'b4'), groupKey: 'g4',
        groupTasks: [passportTask, { docTypeFinal: 'receipt', receiptNoFinal: '58010110', reviewedAt: '2026-07-02T04:00:00.000Z' }],
      }),
      (error) => error.code === 'CUSTOMER_FOLDER_EXISTS',
    );
  } finally {
    cleanup(tempRoot);
  }
});

test('finalizeApprovedGroup:纯百货(现代)无护照组免身份归档——文件夹保留原名,账单正常生成', async () => {
  const tempRoot = makeTempDir();

  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'customer-receipt-template.xlsx');
    const batchRootDir = path.join(tempRoot, 'batch_1');
    fs.mkdirSync(batchRootDir, { recursive: true });
    fs.copyFileSync(REAL_TEMPLATE, sourceTemplatePath);

    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-14T10:15:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: '20260714-百货批',
      customerId: 'CL20260714-001',
      agentName: '梁总百货',
      images: [],
    });
    customer.review.lastBatchId = 'batch_1';
    customer.review.lastSourceGroupId = 'group_dept';
    customer.status = 'in_review';
    customerLibraryRepository.saveCustomer(customer);
    customerTemplateRepository.createWorkingTemplate(
      customerLibraryRepository.customerDir('20260714-百货批', 'CL20260714-001')
    );

    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: createCustomerTemplateFillService(),
    });

    const before = customerLibraryRepository.loadCustomer('20260714-百货批', 'CL20260714-001');
    const beforeFolder = before.folderNameFinal || before.folderNameInitial || before.customerId;

    const result = await finalizeService.finalizeApprovedGroup({
      batchId: 'batch_1',
      batchRootDir,
      groupKey: 'group_dept',
      groupTasks: [
        {
          docTypeFinal: 'receipt',
          receiptStoreFinal: 'HYUNDAI_DEPT',
          receiptNoFinal: '1622-0011',
          receiptAmountFinal: '4500000',
          upstreamFinal: '东方',
          purchaseDateFinal: '2026-07-01',
          reviewedAt: '2026-07-14T09:00:00.000Z',
        },
      ],
    });

    // 免身份归档:不抛 passport_missing;文件夹不改名;账单文件照常生成
    assert.equal(result.folderNameFinal, beforeFolder);
    assert.equal(fs.existsSync(result.finalTemplatePath), true);
    const finalized = customerLibraryRepository.loadCustomer('20260714-百货批', 'CL20260714-001');
    assert.equal(finalized.status, 'template_generated');
    assert.equal(finalized.passportNumber || '', '');
    assert.equal(finalized.review.approvedAt, '2026-07-14T09:00:00.000Z');
  } finally {
    cleanup(tempRoot);
  }
});

test('归档后缀上限分家:纯百货组突破 _9(多笔常态给足 _2.._99),免税店维持 _2.._9', async () => {
  const tempRoot = makeTempDir();
  try {
    const libraryRoot = path.join(tempRoot, 'library');
    const sourceTemplatePath = path.join(tempRoot, 'tpl.xlsx');
    fs.copyFileSync(REAL_TEMPLATE, sourceTemplatePath);
    const customerLibraryRepository = createCustomerLibraryRepository({
      defaultRoot: libraryRoot,
      settingsPath: path.join(tempRoot, 'settings.json'),
      nowProvider: () => new Date('2026-07-14T10:00:00+09:00'),
    });
    const customerTemplateRepository = createCustomerTemplateRepository({ sourceTemplatePath });
    const finalizeService = createCustomerFinalizeService({
      customerLibraryRepository,
      customerTemplateRepository,
      customerTemplateFillService: createCustomerTemplateFillService(),
    });
    const WS = '260714-百货乙';
    const customer = customerLibraryRepository.createCustomerFolder({
      workspaceKey: WS, customerId: 'CL20260714-101', agentName: '梁总百货', images: [],
    });
    customer.review.lastBatchId = 'bx';
    customer.review.lastSourceGroupId = 'gx';
    customer.status = 'in_review';
    customerLibraryRepository.saveCustomer(customer);
    customerTemplateRepository.createWorkingTemplate(customerLibraryRepository.customerDir(WS, 'CL20260714-101'));

    // 预占 基名 + _2.._9(百货客人此前已归档 9 次的现场形态)
    fs.mkdirSync(path.join(libraryRoot, WS, 'LI SI_EA0000001'), { recursive: true });
    for (let n = 2; n <= 9; n += 1) {
      fs.mkdirSync(path.join(libraryRoot, WS, `LI SI_EA0000001_${n}`), { recursive: true });
    }
    finalizeService.setSettledReceiptLookup(() => []); // 全新交易

    const result = await finalizeService.finalizeApprovedGroup({
      batchId: 'bx', batchRootDir: path.join(tempRoot, 'bx'), groupKey: 'gx',
      groupTasks: [
        { docTypeFinal: 'passport', extractedNameFinal: 'LI SI', passportNoFinal: 'EA0000001', reviewedAt: '2026-07-14T01:00:00.000Z' },
        { docTypeFinal: 'receipt', receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '7777-0001', reviewedAt: '2026-07-14T01:05:00.000Z' },
      ],
    });
    assert.equal(result.folderNameFinal, 'LI SI_EA0000001_10'); // 免税店在这里就该炸,百货继续
  } finally {
    cleanup(tempRoot);
  }
});
