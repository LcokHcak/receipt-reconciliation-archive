'use strict';

// 批次客户数据导出 service:验证客户解析(去重)+ 图片筛选(排除 json/xlsx)。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createBatchCustomerDataExportService,
  parseCustomerReferenceFromTask,
} = require('../services/batch_customer_data_export_service');

function makeTempCustomerDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-'));
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
  return dir;
}

function makeTempCustomerDirWithRecord(record, filesByRelativePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-'));
  fs.writeFileSync(path.join(dir, 'customer.json'), JSON.stringify(record, null, 2));
  for (const [relativePath, content] of Object.entries(filesByRelativePath)) {
    const filePath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content || 'x');
  }
  return dir;
}

test('parseCustomerReferenceFromTask 从 sourceOriginalPath 解出 workspaceKey + customerId', () => {
  const ref = parseCustomerReferenceFromTask({
    sourceOriginalPath: 'D:/data/2026-1月济州新罗/CL20260105-001/护照.jpg',
  });
  assert.equal(ref.workspaceKey, '2026-1月济州新罗');
  assert.equal(ref.customerId, 'CL20260105-001');
});

test('parseCustomerReferenceFromTask 无客户号时返回空', () => {
  const ref = parseCustomerReferenceFromTask({ sourceOriginalPath: 'D:/data/random/file.jpg' });
  assert.equal(ref.customerId, '');
  assert.equal(ref.workspaceKey, '');
});

test('planExport 去重客户 + 只列图片(排除 customer.json 与 xlsx)', () => {
  const dirA = makeTempCustomerDir(['护照.jpg', '小票.png', 'customer.json', '账单.xlsx', '备注.txt']);
  const dirB = makeTempCustomerDir(['p1.jpeg', 'p2.webp']);

  const repo = {
    customerDir(workspaceKey, customerId) {
      if (customerId === 'CL20260105-001') return dirA;
      if (customerId === 'CL20260105-002') return dirB;
      throw new Error('unknown customer');
    },
  };
  const svc = createBatchCustomerDataExportService({ customerLibraryRepository: repo });

  const batch = {
    id: 'B1',
    name: '测试批次',
    tasks: [
      { sourceOriginalPath: 'D:/x/WS1/CL20260105-001/护照.jpg' },
      { sourceOriginalPath: 'D:/x/WS1/CL20260105-001/小票.png' }, // 同客户 → 去重
      { sourceOriginalPath: 'D:/x/WS1/CL20260105-002/p1.jpeg' },
      { sourceOriginalPath: 'D:/x/no-customer/file.jpg' }, // 无客户号 → 忽略
    ],
  };

  const plan = svc.planExport(batch);
  assert.equal(plan.customerCount, 2, '应去重为 2 个客户');

  const a = plan.items.find((it) => it.customerId === 'CL20260105-001');
  assert.deepEqual(
    a.files.map((f) => path.basename(f)).sort(),
    ['小票.png', '护照.jpg'].sort(),
    '只保留图片,排除 customer.json/xlsx/txt',
  );
  assert.equal(plan.imageCount, 4, '2 + 2 张图片');

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('planExport reads current batch images from customer.json images subdirectory', () => {
  const dir = makeTempCustomerDirWithRecord({
    customerId: 'CL20260105-001',
    images: [
      { relativePath: 'images/passport.jpg', autoSplitRole: 'region' },
      { relativePath: 'images/receipt.png', autoSplitRole: 'region' },
      { relativePath: 'images/not-in-this-batch.webp', autoSplitRole: 'region' },
      { relativePath: 'generated/signature.png', kind: 'signature' },
    ],
  }, {
    'images/passport.jpg': 'passport',
    'images/receipt.png': 'receipt',
    'images/not-in-this-batch.webp': 'extra',
    'generated/signature.png': 'signature',
  });

  const repo = { customerDir() { return dir; } };
  const svc = createBatchCustomerDataExportService({ customerLibraryRepository: repo });
  const plan = svc.planExport({
    id: 'B1',
    name: 'batch',
    tasks: [
      { sourceOriginalPath: 'WS1/CL20260105-001/passport.jpg' },
      { sourceOriginalPath: 'WS1/CL20260105-001/receipt.png' },
    ],
  });

  assert.equal(plan.customerCount, 1);
  assert.deepEqual(
    plan.items[0].files.map((f) => path.relative(dir, f).split(path.sep).join('/')).sort(),
    ['images/passport.jpg', 'images/receipt.png'].sort(),
  );
  assert.equal(plan.imageCount, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('planExport prefers current batch source images when available', () => {
  const customerDir = makeTempCustomerDirWithRecord({
    customerId: 'CL20260105-001',
    images: [
      { relativePath: 'images/old-name.jpg' },
    ],
  }, {
    'images/old-name.jpg': 'old',
  });
  const batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
  fs.mkdirSync(path.join(batchRoot, 'source'), { recursive: true });
  fs.writeFileSync(path.join(batchRoot, 'source', 'task_0001__receipt-a.jpg'), 'a');
  fs.writeFileSync(path.join(batchRoot, 'source', 'task_0002__passport-b.png'), 'b');

  const repo = { customerDir() { return customerDir; } };
  const svc = createBatchCustomerDataExportService({
    customerLibraryRepository: repo,
    resolveBatchRelativePath(batchId, relativePath) {
      assert.equal(batchId, 'B1');
      return path.join(batchRoot, relativePath);
    },
  });
  const plan = svc.planExport({
    id: 'B1',
    name: 'batch',
    tasks: [
      {
        sourceOriginalPath: 'WS1/CL20260105-001/receipt-a.jpg',
        sourceImagePath: 'source/task_0001__receipt-a.jpg',
        sourceFileName: 'receipt-a.jpg',
      },
      {
        sourceOriginalPath: 'WS1/CL20260105-001/passport-b.png',
        sourceImagePath: 'source/task_0002__passport-b.png',
        sourceFileName: 'passport-b.png',
      },
    ],
  });

  assert.equal(plan.customerCount, 1);
  assert.equal(plan.imageCount, 2);
  assert.deepEqual(
    plan.items[0].fileEntries.map((entry) => entry.exportName).sort(),
    ['passport-b.png', 'receipt-a.jpg'].sort(),
  );

  fs.rmSync(customerDir, { recursive: true, force: true });
  fs.rmSync(batchRoot, { recursive: true, force: true });
});

test('exportZip 在没有可导出图片时抛 NO_CUSTOMER_IMAGES', async () => {
  const repo = { customerDir() { throw new Error('none'); } };
  const svc = createBatchCustomerDataExportService({ customerLibraryRepository: repo });
  await assert.rejects(
    () => svc.exportZip({ id: 'B', tasks: [{ sourceOriginalPath: 'D:/x/WS/CL20260105-009/a.jpg' }] }),
    /没有可导出/,
  );
});
