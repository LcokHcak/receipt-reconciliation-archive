'use strict';

function createBatchOperations({
  common,
  clearActiveBatch,
  removeBatchDirectory,
  workbenchGroupApprovalService,
}) {
  const {
    error,
    hasBatch,
    loadBatch,
    ok,
    removeProjectionSafely,
    saveBatchAsync,
    summarizeBatch,
    withBatchWrite,
  } = common;

  // 导出留痕(P1,2026-07-18 拍板#3):任一导出动作成功后盖章,最后一次为准。
  // 必须走 withBatchWrite——导出与审核写并发时,锁外裸写会互吞对方落盘(批次写锁铁律)。
  // 字段已进 normalizeBatch 白名单(exportedAt/exportedBy/exportKind),存盘不会被抹。
  async function markBatchExported({ batchId, kind, operator = null }) {
    return withBatchWrite(batchId, async () => { // label: markBatchExported
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }
      const batch = loadBatch(batchId);
      const stampedAt = new Date().toISOString();
      batch.exportedAt = stampedAt;
      batch.exportedBy = String(operator?.username || '').trim() || null;
      batch.exportKind = String(kind || '').trim();
      // 导出成功即清失败戳(2026-07-26):重试成功后不该继续挂在「导出失败」待办里。
      // 四个字段一起清——留着 exportFailedBy 会让后续排查看到"谁导失败过"却没有失败时间,自相矛盾。
      batch.exportFailedAt = '';
      batch.exportFailedKind = '';
      batch.exportFailedError = '';
      batch.exportFailedBy = null;
      // updatedAt 不手动赋:saveBatchAsync 落盘时无条件盖新时间戳,
      // 导出天然算一次"有人动过",超时未处理判定随之复位。
      await saveBatchAsync(batch);
      return ok({ ok: true, batchId, exportedAt: stampedAt, exportKind: batch.exportKind });
    }, { label: 'markBatchExported' });
  }

  // 导出失败留痕(2026-07-26 用户需求②「待管理事项·导出失败」):
  // 此前导出失败只回 HTTP 错误、不落任何痕迹 —— 操作员关掉弹窗后没人知道这批还没导出成功。
  // 盖 exportFailedAt 让首页能把它列成待办;下次导出成功由 markBatchExported 清戳。
  async function markBatchExportFailed({ batchId, kind, reason = '', operator = null }) {
    return withBatchWrite(batchId, async () => { // label: markBatchExportFailed
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }
      const batch = loadBatch(batchId);
      const stampedAt = new Date().toISOString();
      batch.exportFailedAt = stampedAt;
      batch.exportFailedKind = String(kind || '').trim();
      batch.exportFailedError = String(reason || '').trim().slice(0, 300); // 截断防 batch.json 膨胀
      batch.exportFailedBy = String(operator?.username || '').trim() || null;
      await saveBatchAsync(batch);
      return ok({ ok: true, batchId, exportFailedAt: stampedAt });
    }, { label: 'markBatchExportFailed' });
  }

  async function deleteBatch({ batchId }) {
    // B5 批次级收口(8模块审计 HIGH):整批删除必须进批次写锁 + 已结算守卫。
    // 原来无锁裸删:与在飞结算并发时 rmSync 整目录会把结算闭包腰斩;且不查 settled 组,
    // 一键就把已结算组的台账证据图物理删掉、台账行 source_task_id 悬空(与票级/组级 B5 冲突)。
    return withBatchWrite(batchId, async () => { // label: deleteBatch
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);
      // 已结算组守卫:与票级 task.js / 组级 task_handlers.js 同码同文案。
      // 确需整批删 → 先对每个已结算组走台账侧订正(ledger-correction 会清结算章)再删。
      const settledGroup = (Array.isArray(batch.sourceGroups) ? batch.sourceGroups : []).find(
        (g) => g?.settledAt || String(g?.settlementStatus || '') === 'settled'
      );
      if (settledGroup) {
        return error(409, {
          error: '本批含已结算组,台账证据图不可随批删除。请先对已结算组走台账侧订正(撤销结算)再删除整批。',
          code: 'delete_blocked_settled',
          details: {
            groupKey: String(settledGroup.key || settledGroup.groupKey || '').trim(),
            groupLabel: String(settledGroup.label || settledGroup.folderPath || '').trim(),
          },
        });
      }

      clearActiveBatch(batchId);
      removeProjectionSafely(batchId);
      removeBatchDirectory(batchId);

      return ok({
        ok: true,
        batchDeleted: true,
        batchId,
      });
    }, { label: 'deleteBatch' });
  }

  async function approveSourceGroup({ batchId, groupKey, operator = null, preApproveCheck = null }) {
    return withBatchWrite(batchId, async () => { // label: approveSourceGroup
      if (!hasBatch(batchId)) {
        return error(404, { error: 'Batch not found' });
      }

      const batch = loadBatch(batchId);

      // 锁内前置闸(团号确认硬闸等):用锁内最新快照校验,消除 handler 层先查后写的
      // TOCTOU 窗口(reviewer MEDIUM:并发撤销确认会让锁外校验拿过期数据放行)。
      if (typeof preApproveCheck === 'function') {
        try {
          preApproveCheck(batch);
        } catch (gateError) {
          return error(Number(gateError?.status) || 409, {
            error: String(gateError?.message || gateError),
            // 闸错误若带结构化定位(taskId 等)原样透传,前端红条可出「定位到这张图」
            ...(gateError?.details ? { details: gateError.details } : {}),
          });
        }
      }

      try {
        const { approvedTaskIds, finalization, ledgerSync } = await workbenchGroupApprovalService.approveGroup({
          batch,
          groupKey,
          operator,
        });
        return ok({
          ok: true,
          batchId: batch.id,
          groupKey,
          approvedTaskIds,
          finalization,
          ledgerSync,
          batch: summarizeBatch(batch, { includeTasks: true }),
        });
      } catch (approvalError) {
        if (approvalError?.code === 'GROUP_NOT_FOUND') {
          return error(404, { error: String(approvalError.message || approvalError) });
        }
        if (approvalError?.code === 'GROUP_APPROVAL_INVALID') {
          return error(409, {
            error: String(approvalError.message || approvalError),
            taskId: approvalError.taskId || '',
            issue: approvalError.issue || '',
            // 前端红条「定位到这张图」只认 details.taskId(与结算路径 task_handlers 同形状);
            // 顶层 taskId 是历史形状,保留兼容但别再让新消费方依赖它。
            details: {
              taskId: approvalError.taskId || null,
              issue: approvalError.issue || '',
              markedRephoto: Boolean(approvalError.markedRephoto),
            },
          });
        }
        if (approvalError?.code === 'CUSTOMER_FOLDER_EXISTS') {
          // 走到这里 = 冲突分流后仍拦下:票号与该护照已入台账的票号重叠(真重复建档)。
          // 合法二次收票(全新票号)已在 finalize 自动加 _2/_3 后缀放行,不会到这。
          const dupes = Array.isArray(approvalError.duplicateReceiptNos) ? approvalError.duplicateReceiptNos : [];
          // details 与结算路径(task_handlers)同形状:组名+可定位 taskId+撞的票号,
          // 让「定位到这张图」和「删除这组重复客户」在组通过路径同样可用。
          const dupGroup = (batch.sourceGroups || []).find(
            (g) => String(g?.key || '').trim() === String(groupKey || '').trim()
          );
          const dupGroupLabel = String(dupGroup?.label || dupGroup?.folderPath || '').trim();
          const dupTaskId = (batch.tasks || []).find(
            (t) => String(t?.sourceGroupKey || '').trim() === String(groupKey || '').trim()
          )?.id || '';
          const groupTag = dupGroupLabel ? `【${dupGroupLabel}】` : '';
          return error(409, {
            error: dupes.length
              ? `重复建档${groupTag}:小票 ${dupes.join('、')} 已入过台账(同护照)。请删除这组重复的客户,不要重复通过。`
              : `客户归档文件夹已存在${groupTag}:${approvalError.folderName || ''} —— 疑似重复建档(或同名归档过多)。请检查该工作区同名客户组。`,
            code: 'CUSTOMER_FOLDER_EXISTS',
            duplicateReceiptNos: dupes,
            details: {
              duplicateReceiptNos: dupes,
              groupKey: String(groupKey || '').trim(),
              groupLabel: dupGroupLabel,
              taskId: dupTaskId,
            },
          });
        }
        throw approvalError;
      }
    // 300s(L234):approve 闭包内 saveBatchAsync(8MB batch.json)+ finalizeApprovedGroup(客户夹
    // rename-with-collision-fork + xlsx 模板填充),大客户组叠加磁盘/导出并发时可超默认 30s。超时=
    // 假 500 而定稿其实已完成(夹已改名/xlsx 已写)→ 重试触发 CUSTOMER_FOLDER_EXISTS 假 409;且锁
    // 提前放行下一个写与仍在跑的 finalize 折叠,破坏批次写锁串行。与 settle/append(300s)同防线。
    }, { label: 'approveSourceGroup', timeoutMs: 300_000 });
  }

  return {
    approveSourceGroup,
    deleteBatch,
    markBatchExported,
    markBatchExportFailed,
  };
}

module.exports = {
  createBatchOperations,
};
