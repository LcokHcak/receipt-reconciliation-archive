'use strict';

const { DOC_TYPES } = require('../lib/package_constants');
const { normalizeReceiptNoDigits } = require('../lib/workbench_field_normalizer');
const { groupPassportIssue } = require('../lib/validation/group_passport_rule');

function normalize(value) {
  return String(value || '').trim();
}

function normalizeDocType(task = {}) {
  return normalize(task.docTypeFinal || task.docTypeAuto || task.docType).toLowerCase();
}

function groupKeyOf(task = {}) {
  return normalize(task.sourceGroupKey)
    || normalize(task.sourceFolderPath)
    || normalize(task.sourceGroupLabel)
    || normalize(task.folderName)
    || '__ungrouped__';
}

function groupLabelOf(task = {}) {
  return normalize(task.sourceGroupLabel)
    || normalize(task.folderName)
    || normalize(task.sourceFolderPath)
    || normalize(task.sourceGroupKey)
    || '未归组';
}

function isReceiptTask(task = {}) {
  return normalizeDocType(task) === DOC_TYPES.RECEIPT;
}

function isPassportTask(task = {}) {
  return normalizeDocType(task) === DOC_TYPES.PASSPORT;
}

function isRephotoTask(task = {}) {
  const processResult = normalize(task.processResult).toLowerCase();
  return Boolean(task.rephotoRequested)
    || processResult.includes('rephoto')
    || processResult.includes('重拍');
}

function isApprovedTask(task = {}) {
  const processResult = normalize(task.processResult).toLowerCase();
  return Boolean(task.reviewed)
    || processResult === 'approved'
    || processResult.includes('通过');
}

function receiptBusinessKey(task = {}) {
  const receiptNo = normalizeReceiptNoDigits(normalize(task.receiptNoFinal || task.receiptNoAuto));
  const shop = normalize(task.receiptStoreFinal || task.receiptStoreAuto).toUpperCase();
  const purchaseDate = normalize(task.purchaseDateFinal || task.purchaseDateAuto);
  if (!receiptNo || !shop || !purchaseDate) {
    return '';
  }
  return `${shop}|${receiptNo}|${purchaseDate}`;
}

function groupBatchTasks(tasks = []) {
  const groups = new Map();
  for (const task of tasks) {
    const key = groupKeyOf(task);
    if (!groups.has(key)) {
      groups.set(key, {
        groupKey: key,
        groupLabel: groupLabelOf(task),
        tasks: [],
      });
    }
    groups.get(key).tasks.push(task);
  }
  return Array.from(groups.values());
}

function classifyGroup(group) {
  if (group.tasks.some((task) => isRephotoTask(task))) {
    return 'rephoto_requested';
  }
  const receiptTasks = group.tasks.filter((task) => isReceiptTask(task));
  if (receiptTasks.length === 0) {
    return 'no_receipts';
  }
  // 护照数量:普通组恰好1本;百货组护照落在小票任务上(同框),允许0独立护照——统一口径,防副本漂移。
  const passportTasks = group.tasks.filter((task) => isPassportTask(task) && !isRephotoTask(task));
  const passportIssue = groupPassportIssue({
    passportTasks,
    receiptTasks: receiptTasks.filter((task) => !isRephotoTask(task)),
  });
  if (passportIssue) {
    return passportIssue;
  }
  if (!group.tasks.every((task) => isApprovedTask(task))) {
    return 'not_approved';
  }
  return '';
}

function createWorkbenchBatchLedgerImportService({
  ledgerBridgeService,
  tourMatchService = null,
}) {
  if (!ledgerBridgeService || typeof ledgerBridgeService.syncApprovedGroup !== 'function') {
    throw new Error('ledgerBridgeService required');
  }

  async function importBatchToLedger({ batch, operator = null }) {
    if (!batch?.id) {
      throw new Error('batch required');
    }

    const groups = groupBatchTasks(batch.tasks || []);
    const requestedWorkspaceKey = normalize(batch.monthlyWorkspaceKey) || null;
    const result = {
      workspaceKey: requestedWorkspaceKey,
      totalGroups: groups.length,
      eligibleGroups: 0,
      importedGroups: 0,
      // 成功导入台账的组键(B5:导入台账=写了台账证据,handler 据此补盖组级结算章,
      // 否则删除守卫只认盖章、对这条路失明,可物理删已入账证据。审计 HIGH 短期最小修)。
      importedGroupKeys: [],
      insertedRows: 0,
      skippedRows: 0,
      skippedGroups: [],
      failedGroups: [],
      tourMatch: null,
      tourMatchResults: [],
      affectedWorkspaces: [],
    };
    const seenReceiptKeys = new Set();
    // 记住每个业务键**先被谁占了**:撞键时要能说清"和谁撞的",否则操作员拿到一个
    // 孤零零的票号,还得自己翻遍全批去找另一半。
    const keyOwner = new Map();
    const suppressedReceipts = [];
    const affectedWorkspaceSet = new Set();

    for (const group of groups) {
      const reason = classifyGroup(group);
      if (reason) {
        result.skippedGroups.push({
          groupKey: group.groupKey,
          groupLabel: group.groupLabel,
          reason,
        });
        continue;
      }

      const receiptTaskIdsToImport = new Set();
      for (const task of group.tasks.filter((item) => isReceiptTask(item))) {
        const key = receiptBusinessKey(task);
        if (key && seenReceiptKeys.has(key)) {
          // 0729 静默排查:此处原是裸 continue。整组都撞键时会报 duplicate_receipts_in_batch
          // (可见),但**组里只有部分票撞键**时,那张票被悄悄排除,该组照样计入
          // importedGroups,操作员看到的是"导入成功"。
          //
          // 而这个撞键**不是良性去重,是数据错误的信号**:业务键与库里的
          // UNIQUE(workspace_key, row_hash) 同口径 —— row_hash = {工作区,店,票号,购买日},
          // **不含客户**。一个店一天一个票号只能对应一笔交易,所以两个客户组撞上同一个键,
          // 只可能是 OCR 把票号读错了,或者建档时串了客户。
          // 悄悄丢掉 = 把一个真实错误藏起来,而且丢掉的那张票**不进台账 = 少一笔返点**。
          const owner = keyOwner.get(key);
          suppressedReceipts.push({
            groupKey: group.groupKey,
            groupLabel: group.groupLabel,
            taskId: task.id,
            receiptKey: key,
            conflictWithGroupKey: owner?.groupKey || '',
            conflictWithGroupLabel: owner?.groupLabel || '',
          });
          continue;
        }
        if (key) {
          seenReceiptKeys.add(key);
          keyOwner.set(key, { groupKey: group.groupKey, groupLabel: group.groupLabel });
        }
        receiptTaskIdsToImport.add(task.id);
      }
      if (receiptTaskIdsToImport.size === 0) {
        result.skippedGroups.push({
          groupKey: group.groupKey,
          groupLabel: group.groupLabel,
          reason: 'duplicate_receipts_in_batch',
        });
        continue;
      }
      const groupTasksToImport = group.tasks.filter((task) => !isReceiptTask(task) || receiptTaskIdsToImport.has(task.id));
      result.eligibleGroups += 1;
      // 兜底 try/catch(2026-07-14 审计#9):桥接的日期落月解析会 throw(如购买日期超窗),
      // 曾让一个坏组把整个导入循环炸死——排在它后面的所有组连尝试都没有。坏组进 failedGroups
      // 显式回报,其余组照常导入。
      let sync;
      try {
        sync = await ledgerBridgeService.syncApprovedGroup({
          groupTasks: groupTasksToImport,
          groupKey: group.groupKey,
          batchId: batch.id,
          operator,
          workspaceKey: requestedWorkspaceKey,
        });
      } catch (syncError) {
        result.failedGroups.push({
          groupKey: group.groupKey,
          groupLabel: group.groupLabel,
          error: String(syncError?.message || syncError),
        });
        continue;
      }
      if (sync?.error) {
        // 桥接失败不能计为成功,否则前端显示"已导入N组"但台账实际没写入,
        // 数据静默丢失。记入 failedGroups 让调用方/前端显式感知。
        result.failedGroups.push({
          groupKey: group.groupKey,
          groupLabel: group.groupLabel,
          error: sync.error,
        });
        continue;
      }
      result.importedGroups += 1;
      result.importedGroupKeys.push(group.groupKey);
      result.insertedRows += Number(sync?.inserted || 0);
      result.skippedRows += Number(sync?.skipped || 0);
      result.workspaceKey = result.workspaceKey || sync?.workspaceKey || null;
      const syncWorkspaces = Array.isArray(sync?.affectedWorkspaces) && sync.affectedWorkspaces.length
        ? sync.affectedWorkspaces
        : (sync?.workspaceKey ? [sync.workspaceKey] : []);
      for (const ws of syncWorkspaces) {
        if (ws) affectedWorkspaceSet.add(ws);
      }
    }

    // 撞键被压掉的票:必须交出去。这不是"已去重"的例行统计,而是**待人核实的数据错误**
    // (同店同日同票号只能是一笔交易,两个客户组都有 = 票号读错或客户串了)。
    result.suppressedReceipts = suppressedReceipts;
    result.affectedWorkspaces = Array.from(affectedWorkspaceSet);
    if (result.affectedWorkspaces.length && tourMatchService && typeof tourMatchService.run === 'function') {
      for (const workspaceKey of result.affectedWorkspaces) {
        const tourResult = await tourMatchService.run({
          workspaceKey,
          operator: operator || 'workbench_ledger_import',
          batchId: batch.id,
        });
        result.tourMatchResults.push({ workspaceKey, ...tourResult });
      }
      result.tourMatch = result.tourMatchResults[0] || null;
    }

    return result;
  }

  return {
    importBatchToLedger,
    _classifyGroup: classifyGroup,
    _groupBatchTasks: groupBatchTasks,
  };
}

module.exports = {
  createWorkbenchBatchLedgerImportService,
};
