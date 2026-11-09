const path = require('path');

const { DOC_TYPES } = require('../lib/package_constants');
const { ROOT_SOURCE_GROUP_KEY, ROOT_SOURCE_GROUP_LABEL } = require('../lib/source_group_utils');
const { PROCESS_RESULTS, normalizeDocType } = require('../lib/workbench_task_flow');
const { buildTaskWorkflowState } = require('../lib/workbench_workflow_state');

const { buildBatchOverlayEntries } = require('../lib/agent_workspace/customer_projection');
const { deriveCustomerStatus } = require('../lib/agent_workspace/status_policy');

function createWorkbenchSqliteSyncService({ sqliteRepository, agentWorkspaceRepository = null, projectionLogger = null }) {
  if (!sqliteRepository) {
    throw new Error('sqliteRepository is required');
  }

  // 代理工作台V2(Task4):批次保存后,把审核覆盖层投影到客户级读模型。
  // 规则:①只更新 workspaceKey+customerId 对应的行,找不到=orphan 记日志;
  // ②活动关联守卫在仓库层(anchor.active_batch_id):旧批次覆盖不了新批次的行(stale);
  // ③投影失败绝不阻断批次主同步(advisory)。
  function projectAgentOverlays(batch) {
    if (!agentWorkspaceRepository) return { projected: 0, orphans: 0, stale: 0, skippedNoRef: 0 };
    const { entries, skippedNoRef } = buildBatchOverlayEntries(batch);
    let projected = 0; let orphans = 0; let stale = 0;
    const runAll = () => {
    for (const entry of entries) {
      try {
        const status = deriveCustomerStatus({
          hasActiveBatch: true,
          overlay: entry.overlay,
          settlementStatus: entry.settlementStatus,
        });
        const result = agentWorkspaceRepository.upsertReviewOverlay({
          customerPk: entry.customerPk,
          batchId: batch.id,
          groupKey: entry.groupKey,
          monthlyWorkspaceKey: null, // 只能来自台账桥接实际落入,批次字段是客户库ws,禁止填
          storeKeys: entry.storeKeys,
          candidateModes: entry.overlay.candidateModes,
          confirmedModes: entry.overlay.confirmedModes,
          reviewStatus: status.reviewStatus,
          nextAction: status.nextAction,
          reasonCodes: status.reasonCodes,
          settlementStatus: entry.settlementStatus,
          receiptCount: entry.overlay.receiptCount, // P3 真票数:该客户小票数(overlay 已算)
        });
        if (result.orphan) orphans += 1;
        else if (result.stale) stale += 1;
        else projected += 1;
      } catch (error) {
        projectionLogger?.warn?.('agent_workspace_overlay_failed', {
          customerPk: entry.customerPk, batchId: batch.id,
          error: String(error?.message || error),
        });
      }
    }
    };
    // 单事务包裹:大批次(生产峰值3256任务/数百客户)逐行自动提交会拖慢 PATCH 热路径
    if (typeof agentWorkspaceRepository.runInTransaction === 'function') {
      agentWorkspaceRepository.runInTransaction(runAll);
    } else {
      runAll();
    }
    if (orphans || stale) {
      projectionLogger?.info?.('agent_workspace_overlay_summary', {
        batchId: batch.id, projected, orphans, stale, skippedNoRef,
      });
    }
    return { projected, orphans, stale, skippedNoRef };
  }

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function makeScopedId(batchId, type, localId) {
    return `${batchId}::${type}::${String(localId || '').trim()}`;
  }

  // buildProjection 运行期间的 per-call 备忘录(2026-07-12 审计修复):
  // task.workflowState 的缓存短路在生产从不命中——normalizeTask 白名单没有 workflowState 键,
  // 每次 loadBatch 后全部任务都被剥掉,导致单次投影里每任务重算 8~10 次(占点击耗时 52%)。
  // 不把 workflowState 加回白名单(会落盘进 batch.json 且有磁盘陈旧风险),
  // 改为投影内 WeakMap 备忘:同步执行无重入,finally 置空,跨投影绝不复用。
  let projectionStateMemo = null;

  function getWorkflowState(task = {}) {
    if (task.workflowState?.processResult) return task.workflowState;
    if (projectionStateMemo) {
      let state = projectionStateMemo.get(task);
      if (!state) {
        state = buildTaskWorkflowState(task);
        projectionStateMemo.set(task, state);
      }
      return state;
    }
    return buildTaskWorkflowState(task);
  }

  function getProcessResult(task = {}) {
    return normalizeText(getWorkflowState(task).processResult || task.processResult);
  }

  function inferGroupStatus(tasks = []) {
    if (!tasks.length) {
      return 'pending';
    }

    const approvedCount = tasks.filter((task) => task.reviewed || getProcessResult(task) === PROCESS_RESULTS.APPROVED).length;
    const rephotoCount = tasks.filter((task) => task.rephotoRequested || getProcessResult(task) === PROCESS_RESULTS.REPHOTO).length;
    const finalReadyCount = tasks.filter((task) => [PROCESS_RESULTS.FINAL_REVIEW, PROCESS_RESULTS.APPROVED].includes(getProcessResult(task))).length;
    const touchedCount = tasks.filter((task) => getProcessResult(task) !== PROCESS_RESULTS.CLASSIFY).length;

    if (approvedCount === tasks.length) {
      return 'completed';
    }
    if (rephotoCount > 0) {
      return 'rephoto';
    }
    if (finalReadyCount === tasks.length) {
      return 'pending_final';
    }
    if (touchedCount > 0) {
      return 'in_review';
    }
    return 'pending';
  }

  function inferRecordStatus(task) {
    const processResult = getProcessResult(task);
    if (task.reviewed || processResult === PROCESS_RESULTS.APPROVED) {
      return 'completed';
    }
    if (task.rephotoRequested || processResult === PROCESS_RESULTS.REPHOTO) {
      return 'rephoto';
    }
    if ([PROCESS_RESULTS.FINAL_REVIEW, PROCESS_RESULTS.SIGNATURE].includes(processResult)) {
      return 'ready';
    }
    if (processResult === PROCESS_RESULTS.CLASSIFY) {
      return 'pending';
    }
    return 'draft';
  }

  function inferReviewStatus(task) {
    const processResult = getProcessResult(task);
    if (task.rephotoRequested || processResult === PROCESS_RESULTS.REPHOTO) {
      return 'rephoto';
    }
    if (task.reviewed || processResult === PROCESS_RESULTS.APPROVED) {
      return 'reviewed';
    }
    return 'pending';
  }

  function inferDocType(task) {
    return normalizeDocType(task.docTypeFinal || task.docTypeAuto || DOC_TYPES.PASSPORT);
  }

  function isPassportTask(task) {
    return inferDocType(task) === DOC_TYPES.PASSPORT;
  }

  function isReceiptTask(task) {
    const docType = inferDocType(task);
    return [DOC_TYPES.RECEIPT, DOC_TYPES.OTHER].includes(docType);
  }

  function classifyAttachmentKind(attachment) {
    const extension = normalizeText(attachment?.extension || path.extname(attachment?.originalFileName || '')).toLowerCase();
    if (extension === '.xlsx') return 'xlsx';
    if (extension === '.xls') return 'xls';
    if (extension === '.csv') return 'csv';
    return extension.replace(/^\./, '') || 'other';
  }

  function buildProjection(batch) {
    projectionStateMemo = new WeakMap();
    try {
      return buildProjectionInner(batch);
    } finally {
      projectionStateMemo = null;
    }
  }

  function buildProjectionInner(batch) {
    const sourceGroups = Array.isArray(batch?.sourceGroups) ? batch.sourceGroups : [];
    const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
    const sourceGroupMap = new Map();

    for (const sourceGroup of sourceGroups) {
      sourceGroupMap.set(sourceGroup.key, {
        ...sourceGroup,
        attachmentFiles: Array.isArray(sourceGroup.attachmentFiles) ? sourceGroup.attachmentFiles : [],
      });
    }

    // 一次分组(2026-07-12 审计修复):原先在组循环里对全部任务 .filter(),
    // O(组×任务)——生产峰值 1628 组×3256 任务时这一项就占单击耗时 72%(实测 830ms)。
    const tasksByGroup = new Map();
    for (const task of tasks) {
      const groupKey = normalizeText(task.sourceGroupKey) || ROOT_SOURCE_GROUP_KEY;
      let list = tasksByGroup.get(groupKey);
      if (!list) {
        list = [];
        tasksByGroup.set(groupKey, list);
      }
      list.push(task);
      if (!sourceGroupMap.has(groupKey)) {
        sourceGroupMap.set(groupKey, {
          key: groupKey,
          label: normalizeText(task.sourceGroupLabel || task.sourceFolderName) || ROOT_SOURCE_GROUP_LABEL,
          folderPath: normalizeText(task.sourceFolderPath),
          attachmentFiles: [],
        });
      }
    }

    const travelerGroups = [];
    const sourceImages = [];
    const passportRecords = [];
    const receiptRecords = [];
    const attachmentFiles = [];

    for (const sourceGroup of sourceGroupMap.values()) {
      const groupKey = normalizeText(sourceGroup.key) || ROOT_SOURCE_GROUP_KEY;
      const groupTasks = tasksByGroup.get(groupKey) || [];
      const groupId = makeScopedId(batch.id, 'group', groupKey);
      const attachmentList = Array.isArray(sourceGroup.attachmentFiles) ? sourceGroup.attachmentFiles : [];
      const passportTasks = groupTasks.filter(isPassportTask);
      const receiptTasks = groupTasks.filter((task) => isReceiptTask(task) || !isPassportTask(task));

      travelerGroups.push({
        group_id: groupId,
        batch_id: batch.id,
        folder_key: groupKey,
        folder_name: normalizeText(sourceGroup.label) || ROOT_SOURCE_GROUP_LABEL,
        folder_path: normalizeText(sourceGroup.folderPath),
        status: inferGroupStatus(groupTasks),
        task_count: groupTasks.length,
        source_image_count: groupTasks.filter((task) => normalizeText(task.sourceImagePath)).length,
        receipt_count: receiptTasks.length,
        passport_count: passportTasks.length,
        attachment_count: attachmentList.length,
      });

      for (const attachment of attachmentList) {
        attachmentFiles.push({
          attachment_id: makeScopedId(batch.id, 'attachment', attachment.id || attachment.originalFileName || cryptoRandomKey(groupId)),
          batch_id: batch.id,
          group_id: groupId,
          file_name: normalizeText(attachment.originalFileName),
          file_path: normalizeText(attachment.storedRelativePath),
          file_kind: classifyAttachmentKind(attachment),
        });
      }

      for (const task of groupTasks) {
        const sourceImageId = makeScopedId(batch.id, 'image', task.id);
        sourceImages.push({
          source_image_id: sourceImageId,
          batch_id: batch.id,
          group_id: groupId,
          legacy_task_id: task.id,
          file_name: normalizeText(task.originalFileName),
          file_path: normalizeText(task.sourceImagePath),
          original_path: normalizeText(task.sourceOriginalPath),
          raw_json_path: normalizeText(task.rawJsonPath || task.initialRawJsonPath),
          machine_state: normalizeText(task.machineState),
          doc_type: inferDocType(task),
          process_result: getProcessResult(task),
          review_status: inferReviewStatus(task),
          source_type: normalizeText(task.sourceType),
        });

        if (isPassportTask(task)) {
          passportRecords.push({
            passport_id: makeScopedId(batch.id, 'passport', task.id),
            batch_id: batch.id,
            group_id: groupId,
            source_image_id: sourceImageId,
            legacy_task_id: task.id,
            english_name: normalizeText(task.extractedNameFinal || task.extractedNameAuto),
            passport_no: normalizeText(task.passportNoFinal || task.passportNoAuto),
            departure_date: normalizeText(task.departureDateFinal || task.departureDateAuto),
            tour_no: normalizeText(task.groupNoFinal || task.groupNoAuto),
            status: inferRecordStatus(task),
            raw_payload_json: JSON.stringify({
              chineseName: normalizeText(task.chineseNameFinal || task.chineseNameAuto),
              processResult: getProcessResult(task),
              sourceType: normalizeText(task.sourceType),
            }),
          });
          continue;
        }

        receiptRecords.push({
          receipt_id: makeScopedId(batch.id, 'receipt', task.id),
          batch_id: batch.id,
          group_id: groupId,
          source_image_id: sourceImageId,
          legacy_task_id: task.id,
          purchase_date: normalizeText(task.purchaseDateFinal || task.purchaseDateAuto),
          statement_date: normalizeText(task.receiptDateAuto),
          payment_mode: '',
          rebate_mode: '',
          duty_free_shop: normalizeText(task.receiptStoreFinal || task.receiptStoreAuto),
          duty_free_branch: '',
          upstream_name: '',
          receipt_no: normalizeText(task.receiptNoFinal || task.receiptNoAuto),
          original_receipt_no: '',
          category: '',
          brand: '',
          is_manual_added: task.sourceType === 'manual' ? 1 : 0,
          status: inferRecordStatus(task),
          raw_payload_json: JSON.stringify({
            amount: normalizeText(task.receiptAmountAuto),
            flightNo: normalizeText(task.flightNoAuto),
            processResult: getProcessResult(task),
            docType: inferDocType(task),
          }),
        });
      }
    }

    return {
      batch: {
        batch_id: batch.id,
        batch_name: batch.name || batch.id,
        scenario: normalizeText(batch.scenario),
        created_at: normalizeText(batch.createdAt),
        updated_at: normalizeText(batch.updatedAt),
        machine_state: normalizeText(batch.machineState),
        status: inferGroupStatus(tasks),
        source_group_count: travelerGroups.length,
        task_count: tasks.length,
      },
      travelerGroups,
      sourceImages,
      passportRecords,
      receiptRecords,
      attachmentFiles,
    };
  }

  function cryptoRandomKey(seed) {
    return Buffer.from(seed).toString('base64url').slice(0, 12);
  }

  function syncBatch(batch) {
    const projection = buildProjection(batch);
    sqliteRepository.replaceBatchProjection(projection);
    // 代理工作台V2:批次镜像落定后投影客户级覆盖层(advisory,失败不阻断主同步)。
    try {
      projectAgentOverlays(batch);
    } catch (error) {
      // 静默失败审计 2026-07-12:整批投影级失败(事务/SAVEPOINT 本身炸)原先零日志,
      // 读模型悄悄脱钩只能靠手动 rebuild 才发现。逐客户失败另有 per-entry 日志。
      projectionLogger?.error?.('agent_workspace_overlay_batch_failed', {
        batchId: batch?.id, error: String(error?.message || error),
      });
    }
    return projection;
  }

  function syncBatches(batches = []) {
    let syncedBatchCount = 0;
    for (const batch of batches) {
      syncBatch(batch);
      syncedBatchCount += 1;
    }
    return {
      syncedBatchCount,
      counts: sqliteRepository.getCounts(),
    };
  }

  function removeBatch(batchId) {
    sqliteRepository.deleteBatch(batchId);
    // 批次删除/失联:该批次盖过的读模型行回 ready_for_sync(客户仍在,不丢行)。
    try {
      agentWorkspaceRepository?.clearOverlayByBatch?.(batchId);
    } catch (error) {
      projectionLogger?.error?.('agent_workspace_overlay_clear_failed', {
        batchId, error: String(error?.message || error),
      });
    }
  }

  return {
    buildProjection,
    removeBatch,
    syncBatch,
    syncBatches,
  };
}

module.exports = {
  createWorkbenchSqliteSyncService,
};
