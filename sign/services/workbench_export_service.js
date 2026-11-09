const defaultFs = require('node:fs');
const defaultPath = require('node:path');

const defaultExcelJS = require('exceljs');
const { applyExcelStyle } = require('../lib/excel_style');
const {
  RECEIPT_EXPORT_COLUMNS,
  RECEIPT_EXPORT_HEADERS,
  buildReceiptExportRows: defaultBuildReceiptExportRows,
} = require('../lib/workbench_receipt_export');
const { ROOT_SOURCE_GROUP_KEY, normalizeSourceGroups } = require('../lib/source_group_utils');
const { PROCESS_RESULTS } = require('../lib/workbench_task_flow');

// 客户引用解析收敛到 lib/customer_ref(原同款逻辑散在 4 处)。
const { parseCustomerRefFromTask: parseCustomerReferenceFromTask } = require('../lib/customer_ref');

// 1→A, 12→L, 27→AA(Excel 列号转字母,不依赖 worksheet 实例,测试 mock 也能跑)
function columnLetter(n) {
  let s = '';
  for (let i = Number(n); i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

function createWorkbenchExportService({
  ExcelJS = defaultExcelJS,
  fs = defaultFs,
  path = defaultPath,
  batchDir,
  batchSubdirs,
  toStorageUrl,
  applyComputedFields,
  receiptExportColumns = RECEIPT_EXPORT_COLUMNS,
  receiptExportHeaders = RECEIPT_EXPORT_HEADERS,
  buildReceiptExportRows = defaultBuildReceiptExportRows,
  customerLibraryRepository,
  customerFinalizeService,
  normalizeSourceGroups: normalizeGroups = normalizeSourceGroups,
  rootSourceGroupKey = ROOT_SOURCE_GROUP_KEY,
  processResults = PROCESS_RESULTS,
} = {}) {
  if (typeof batchDir !== 'function') {
    throw new Error('batchDir is required');
  }
  if (typeof batchSubdirs !== 'function') {
    throw new Error('batchSubdirs is required');
  }
  if (typeof toStorageUrl !== 'function') {
    throw new Error('toStorageUrl is required');
  }
  if (typeof applyComputedFields !== 'function') {
    throw new Error('applyComputedFields is required');
  }
  if (!customerLibraryRepository) {
    throw new Error('customerLibraryRepository is required');
  }
  if (!customerFinalizeService) {
    throw new Error('customerFinalizeService is required');
  }

  function resolveCustomerExportContext(task = {}) {
    const { workspaceKey, customerId } = parseCustomerReferenceFromTask(task);
    if (!workspaceKey || !customerId) {
      return { workspaceKey, customerId };
    }

    try {
      const customer = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
      return {
        workspaceKey,
        customerId,
        agentName: customer.agentName || '',
        createdAt: customer.createdAt || '',
      };
    } catch (_error) {
      return { workspaceKey, customerId };
    }
  }

  function buildCustomerExportContextByGroup(tasks = []) {
    const contextByGroup = new Map();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const groupKey = String(task?.sourceGroupKey || rootSourceGroupKey).trim() || rootSourceGroupKey;
      if (contextByGroup.has(groupKey)) {
        continue;
      }
      contextByGroup.set(groupKey, resolveCustomerExportContext(task));
    }
    return contextByGroup;
  }

  function isExportApprovedTask(task = {}) {
    return task.reviewed === true
      || task.processResult === processResults.APPROVED
      || task.processResult === 'approved';
  }

  function buildSourceGroupByKey(sourceGroups = []) {
    const sourceGroupByKey = new Map();
    for (const group of sourceGroups) {
      const groupKey = String(group?.key || '').trim();
      if (groupKey && !sourceGroupByKey.has(groupKey)) {
        sourceGroupByKey.set(groupKey, group);
      }
    }
    return sourceGroupByKey;
  }

  function buildBatchExportFinalizationGroups(batch = {}) {
    const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
    const sourceGroups = normalizeGroups(batch.sourceGroups || []);
    const sourceGroupByKey = buildSourceGroupByKey(sourceGroups);
    const groupMap = new Map();

    for (const task of tasks) {
      const groupKey = String(task?.sourceGroupKey || rootSourceGroupKey).trim() || rootSourceGroupKey;
      if (!groupMap.has(groupKey)) {
        const sourceGroup = sourceGroupByKey.get(groupKey) || {};
        groupMap.set(groupKey, {
          key: groupKey,
          label: sourceGroup.label || '',
          folderPath: sourceGroup.folderPath || '',
          tasks: [],
        });
      }
      groupMap.get(groupKey).tasks.push(task);
    }

    return [...groupMap.values()];
  }

  async function finalizeApprovedGroupsAfterBatchExport(batch, { batchRootDir = batchDir(batch.id) } = {}) {
    const finalized = [];
    const skipped = [];
    const errors = [];

    for (const group of buildBatchExportFinalizationGroups(batch)) {
      if (!group.tasks.length) {
        skipped.push({ groupKey: group.key, reason: 'empty_group' });
        continue;
      }
      if (group.tasks.some((task) => task.rephotoRequested || task.processResult === processResults.REPHOTO)) {
        skipped.push({ groupKey: group.key, reason: 'rephoto_requested' });
        continue;
      }
      if (!group.tasks.every(isExportApprovedTask)) {
        skipped.push({ groupKey: group.key, reason: 'not_all_approved' });
        continue;
      }

      try {
        const finalization = await customerFinalizeService.finalizeApprovedGroup({
          batchId: batch.id,
          batchRootDir,
          groupKey: group.key,
          sourceGroupLabel: group.label,
          sourceGroupFolderPath: group.folderPath,
          groupTasks: group.tasks,
        });
        if (finalization) {
          finalized.push({
            groupKey: group.key,
            folderNameFinal: finalization.folderNameFinal,
            alreadyGenerated: Boolean(finalization.alreadyGenerated),
          });
        } else {
          skipped.push({ groupKey: group.key, reason: 'no_customer_record' });
        }
      } catch (error) {
        errors.push({
          groupKey: group.key,
          error: String(error?.message || error),
        });
      }
    }

    return { finalized, skipped, errors };
  }

  async function generateWorkbook(batch, { batchRootDir = batchDir(batch.id), excludeNoRecord = false } = {}) {
    const dirs = batchSubdirs(batch.id);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('\u6bcf\u65e5\u6536\u7968');
    const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
    const computedTasks = tasks.map((task) => applyComputedFields(batch, task));
    const exportRows = buildReceiptExportRows(computedTasks, {
      customerContextByGroup: buildCustomerExportContextByGroup(computedTasks),
      excludeNoRecord, // 隐藏不用记行(默认关;勾选才整行不进表,防"丢票"错觉)
    });

    sheet.columns = receiptExportColumns.map((column) => ({ ...column }));

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    // 筛选范围按实际列数动态算(曾硬编码 K1,加"备注"列后漏更新导致筛选缺列)
    sheet.autoFilter = { from: 'A1', to: `${columnLetter(receiptExportColumns.length)}1` };

    for (const row of exportRows) {
      sheet.addRow(row);
    }

    // 统一表格样式(视觉层):列已设、行已加完毕后一次性上样式。只加字体/表头色/隔行/
    // 边框/对齐/文本格式/冻结/打印;绝不改列序/列数/单元格值/表头文本/已设的 autoFilter。
    // freezeCols=0:每日收票首两列非「序号/客户组/客户编号」定位列,仅冻结表头。
    applyExcelStyle(sheet, { headerRow: 1, freezeCols: 0 });

    const csvPath = path.join(dirs.exports, 'daily_receipts.csv');
    const xlsxPath = path.join(dirs.exports, 'daily_receipts.xlsx');
    const csvLines = [[...receiptExportHeaders].join(',')];

    for (const row of exportRows) {
      csvLines.push(
        receiptExportColumns
          .map((column) => {
            const text = String(row[column.key] ?? '');
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(',')
      );
    }

    fs.writeFileSync(csvPath, `${csvLines.join('\n')}\n`, 'utf8');
    await workbook.xlsx.writeFile(xlsxPath);

    return {
      csvUrl: toStorageUrl(batch.id, path.relative(batchRootDir, csvPath)),
      xlsxUrl: toStorageUrl(batch.id, path.relative(batchRootDir, xlsxPath)),
      // 0729 静默排查 B1:被剔除的「不用记」行数。剔除合法(0724 拍板),
      // 不说清楚不合法 —— 操作员对不上"今天收了多少票"时,这个数字就是答案。
      noRecordExcluded: exportRows.noRecordExcluded || 0,
    };
  }

  async function exportBatch(batch, { excludeNoRecord = false } = {}) {
    const batchRootDir = batchDir(batch.id);
    const exported = await generateWorkbook(batch, { batchRootDir, excludeNoRecord });
    const finalizations = await finalizeApprovedGroupsAfterBatchExport(batch, { batchRootDir });
    return {
      ...exported,
      finalizations,
    };
  }

  return {
    exportBatch,
  };
}

module.exports = {
  createWorkbenchExportService,
};
