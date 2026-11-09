const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ExcelJS = require('exceljs');
const { createWorkbenchExportService } = require('../services/workbench_export_service');

class FakeWorkbook {
  constructor() {
    this.sheets = [];
    this.xlsx = {
      writeFile: async (targetPath) => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, 'xlsx-output', 'utf8');
      },
    };
  }

  addWorksheet(name) {
    const sheet = {
      name,
      columns: [],
      rows: [],
      views: [],
      autoFilter: null,
      getRow: () => ({}),
      addRow(row) {
        this.rows.push(row);
      },
    };
    this.sheets.push(sheet);
    return sheet;
  }
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-export-service-'));
}

test('exportBatch writes receipt files and finalizes only fully approved source groups', async () => {
  const tempRoot = createTempRoot();
  const finalizedCalls = [];
  const batchDir = (batchId) => path.join(tempRoot, batchId);
  const batchSubdirs = (batchId) => {
    const root = batchDir(batchId);
    const dirs = {
      root,
      exports: path.join(root, 'exports'),
    };
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    return dirs;
  };

  const service = createWorkbenchExportService({
    ExcelJS: { Workbook: FakeWorkbook },
    fs,
    path,
    batchDir,
    batchSubdirs,
    toStorageUrl: (batchId, relativePath) => `/storage/${batchId}/${relativePath.split(path.sep).join('/')}`,
    applyComputedFields: (_batch, task) => ({ ...task, computed: true }),
    receiptExportColumns: [
      { header: 'Name', key: 'name' },
      { header: 'Agent', key: 'agent' },
    ],
    receiptExportHeaders: ['Name', 'Agent'],
    buildReceiptExportRows: (tasks, { customerContextByGroup }) => {
      assert.equal(tasks.every((task) => task.computed), true);
      return [
        {
          name: tasks.find((task) => task.sourceGroupKey === 'group-a')?.extractedNameFinal,
          agent: customerContextByGroup.get('group-a')?.agentName,
        },
      ];
    },
    customerLibraryRepository: {
      loadCustomer: (workspaceKey, customerId) => {
        assert.equal(workspaceKey, '0505test');
        assert.equal(customerId, 'CL20260505-001');
        return { agentName: 'Agent Lee', createdAt: '2026-05-05T01:02:03.000Z' };
      },
    },
    customerFinalizeService: {
      finalizeApprovedGroup: async (input) => {
        finalizedCalls.push(input);
        return { folderNameFinal: `${input.groupKey}-done`, alreadyGenerated: false };
      },
    },
    normalizeSourceGroups: (groups) => groups,
    rootSourceGroupKey: 'root',
    processResults: {
      APPROVED: 'approved',
      REPHOTO: 'needs_rephoto',
    },
  });

  const result = await service.exportBatch({
    id: 'batch_1',
    sourceGroups: [
      { key: 'group-a', label: 'Customer A', folderPath: 'folder-a' },
      { key: 'group-b', label: 'Customer B', folderPath: 'folder-b' },
      { key: 'group-c', label: 'Customer C', folderPath: 'folder-c' },
    ],
    tasks: [
      {
        id: 'passport-a',
        sourceGroupKey: 'group-a',
        sourceOriginalPath: '0505test/CL20260505-001/passport.jpg',
        docTypeFinal: 'passport',
        extractedNameFinal: 'KIM MIN',
        processResult: 'approved',
      },
      {
        id: 'receipt-a',
        sourceGroupKey: 'group-a',
        sourceOriginalPath: '0505test/CL20260505-001/receipt.jpg',
        docTypeFinal: 'receipt',
        reviewed: true,
      },
      {
        id: 'passport-b',
        sourceGroupKey: 'group-b',
        processResult: 'needs_rephoto',
      },
      {
        id: 'passport-c',
        sourceGroupKey: 'group-c',
        processResult: 'needs_fields',
      },
    ],
  });

  assert.equal(result.csvUrl, '/storage/batch_1/exports/daily_receipts.csv');
  assert.equal(result.xlsxUrl, '/storage/batch_1/exports/daily_receipts.xlsx');
  assert.deepEqual(result.finalizations, {
    finalized: [{ groupKey: 'group-a', folderNameFinal: 'group-a-done', alreadyGenerated: false }],
    skipped: [
      { groupKey: 'group-b', reason: 'rephoto_requested' },
      { groupKey: 'group-c', reason: 'not_all_approved' },
    ],
    errors: [],
  });
  assert.equal(finalizedCalls.length, 1);
  assert.equal(finalizedCalls[0].batchRootDir, batchDir('batch_1'));
  assert.equal(finalizedCalls[0].sourceGroupLabel, 'Customer A');
  assert.equal(finalizedCalls[0].sourceGroupFolderPath, 'folder-a');
  assert.equal(finalizedCalls[0].groupTasks.length, 2);
  assert.equal(fs.readFileSync(path.join(batchDir('batch_1'), 'exports', 'daily_receipts.csv'), 'utf8'), 'Name,Agent\nKIM MIN,Agent Lee\n');
  assert.equal(fs.readFileSync(path.join(batchDir('batch_1'), 'exports', 'daily_receipts.xlsx'), 'utf8'), 'xlsx-output');
});

test('exportBatch resolves source group metadata with linear lookup work', async () => {
  const tempRoot = createTempRoot();
  const batchDir = (batchId) => path.join(tempRoot, batchId);
  const batchSubdirs = (batchId) => {
    const root = batchDir(batchId);
    const dirs = {
      root,
      exports: path.join(root, 'exports'),
    };
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    return dirs;
  };
  const groupCount = 80;
  let sourceGroupKeyReads = 0;
  const sourceGroups = Array.from({ length: groupCount }, (_, index) => ({
    get key() {
      sourceGroupKeyReads += 1;
      return `group-${index}`;
    },
    label: `Customer ${index}`,
    folderPath: `folder-${index}`,
  }));
  const tasks = Array.from({ length: groupCount }, (_, index) => ({
    id: `task-${index}`,
    sourceGroupKey: `group-${index}`,
    processResult: 'needs_fields',
  }));

  const service = createWorkbenchExportService({
    ExcelJS: { Workbook: FakeWorkbook },
    fs,
    path,
    batchDir,
    batchSubdirs,
    toStorageUrl: (batchId, relativePath) => `/storage/${batchId}/${relativePath.split(path.sep).join('/')}`,
    applyComputedFields: (_batch, task) => task,
    receiptExportColumns: [{ header: 'Name', key: 'name' }],
    receiptExportHeaders: ['Name'],
    buildReceiptExportRows: () => [],
    customerLibraryRepository: {
      loadCustomer: () => {
        throw new Error('customer lookup should not run for tasks without customer references');
      },
    },
    customerFinalizeService: {
      finalizeApprovedGroup: async () => {
        throw new Error('finalization should not run for unapproved groups');
      },
    },
    normalizeSourceGroups: (groups) => groups,
    rootSourceGroupKey: 'root',
    processResults: {
      APPROVED: 'approved',
      REPHOTO: 'needs_rephoto',
    },
  });

  await service.exportBatch({
    id: 'batch_source_group_perf',
    sourceGroups,
    tasks,
  });

  assert.ok(
    sourceGroupKeyReads <= groupCount + 5,
    `expected source group key reads to stay linear, got ${sourceGroupKeyReads} for ${groupCount} groups`
  );
});

test('exportBatch reuses the batch root while finalizing many approved groups', async () => {
  const tempRoot = createTempRoot();
  let batchDirCalls = 0;
  const batchDir = (batchId) => {
    batchDirCalls += 1;
    return path.join(tempRoot, batchId);
  };
  const batchSubdirs = (batchId) => {
    const root = batchDir(batchId);
    const dirs = {
      root,
      exports: path.join(root, 'exports'),
    };
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    return dirs;
  };
  const groupCount = 40;
  const sourceGroups = Array.from({ length: groupCount }, (_, index) => ({
    key: `group-${index}`,
    label: `Customer ${index}`,
    folderPath: `folder-${index}`,
  }));
  const tasks = sourceGroups.map((group) => ({
    id: `${group.key}-passport`,
    sourceGroupKey: group.key,
    processResult: 'approved',
  }));

  const service = createWorkbenchExportService({
    ExcelJS: { Workbook: FakeWorkbook },
    fs,
    path,
    batchDir,
    batchSubdirs,
    toStorageUrl: (batchId, relativePath) => `/storage/${batchId}/${relativePath.split(path.sep).join('/')}`,
    applyComputedFields: (_batch, task) => task,
    receiptExportColumns: [{ header: 'Name', key: 'name' }],
    receiptExportHeaders: ['Name'],
    buildReceiptExportRows: () => [],
    customerLibraryRepository: {
      loadCustomer: () => {
        throw new Error('customer lookup should not run for tasks without customer references');
      },
    },
    customerFinalizeService: {
      finalizeApprovedGroup: async (input) => ({ folderNameFinal: `${input.groupKey}-done` }),
    },
    normalizeSourceGroups: (groups) => groups,
    rootSourceGroupKey: 'root',
    processResults: {
      APPROVED: 'approved',
      REPHOTO: 'needs_rephoto',
    },
  });

  await service.exportBatch({
    id: 'batch_root_reuse',
    sourceGroups,
    tasks,
  });

  assert.ok(
    batchDirCalls <= 3,
    `expected batchDir to be reused instead of called per group, got ${batchDirCalls} calls`
  );
});

test('exportBatch applies the unified table style to the receipt sheet (real ExcelJS round-trip)', async (t) => {
  const tempRoot = createTempRoot();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const batchDir = (batchId) => path.join(tempRoot, batchId);
  const batchSubdirs = (batchId) => {
    const root = batchDir(batchId);
    const dirs = { root, exports: path.join(root, 'exports') };
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    return dirs;
  };

  const service = createWorkbenchExportService({
    ExcelJS, // 真实 ExcelJS:applyExcelStyle 才真正生效(mock 因 columnCount=0 早返回)
    fs,
    path,
    batchDir,
    batchSubdirs,
    toStorageUrl: (batchId, relativePath) => `/storage/${batchId}/${relativePath.split(path.sep).join('/')}`,
    applyComputedFields: (_batch, task) => task,
    receiptExportColumns: [
      { header: '中文姓名', key: 'chinese_name' },
      { header: '收票日期', key: 'receipt_date' },
      { header: '备注', key: 'note' },
    ],
    receiptExportHeaders: ['中文姓名', '收票日期', '备注'],
    buildReceiptExportRows: () => [
      { chinese_name: '金民秀', receipt_date: '2026-07-01', note: 'A' },
      { chinese_name: '李慧', receipt_date: '2026-07-02', note: 'B' },
    ],
    customerLibraryRepository: { loadCustomer: () => ({}) },
    customerFinalizeService: { finalizeApprovedGroup: async () => null },
    normalizeSourceGroups: (groups) => groups,
    rootSourceGroupKey: 'root',
    processResults: { APPROVED: 'approved', REPHOTO: 'needs_rephoto' },
  });

  await service.exportBatch({ id: 'batch_style', sourceGroups: [], tasks: [] });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(batchDir('batch_style'), 'exports', 'daily_receipts.xlsx'));
  const sheet = workbook.getWorksheet('每日收票');

  // 视觉层断言:表头深蓝灰底 + 白字雅黑;首行冻结;列数/表头文本未被样式改动。
  const headerCell = sheet.getRow(1).getCell(1);
  assert.equal(headerCell.font.name, '微软雅黑', '表头字体=微软雅黑');
  assert.equal(headerCell.fill.fgColor.argb, 'FF44546A', '表头填充=深蓝灰');
  assert.equal(sheet.getRow(2).getCell(1).font.name, '微软雅黑', '正文字体=微软雅黑');
  assert.equal(sheet.views[0].state, 'frozen', '首行冻结');
  assert.equal(sheet.views[0].ySplit, 1, '冻结表头行');
  assert.equal(sheet.views[0].xSplit, 0, 'freezeCols=0:不额外冻结左侧列');
  // 契约不变:列数与表头文本未被样式层改动
  assert.equal(sheet.columnCount, 3);
  assert.deepEqual([1, 2, 3].map((c) => sheet.getRow(1).getCell(c).value), ['中文姓名', '收票日期', '备注']);
  assert.equal(sheet.autoFilter, 'A1:C1', '调用方已设的 autoFilter 范围保留');
});
