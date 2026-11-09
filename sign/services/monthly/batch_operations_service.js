'use strict';

/**
 * batch_operations_service — 批量操作服务（Sprint 2 W4）。
 *
 * 支持的批量操作：
 *   1. 批量解决 pending_review（按条件筛选后一键解决）
 *   2. 批量删除 daily_receipt_export 行（按条件筛选）
 *   3. 批量删除 store_bill 行（按条件筛选）
 *   4. 批量更新 daily_receipt_export 字段（如 mode_folder）
 *   5. 批量标记 match_badcase 为已处理
 *
 * 每个操作返回：
 *   - affected: 影响的行数
 *   - errors: 失败的记录（如果有）
 *   - summary: 操作摘要
 */

function createBatchOperationsService({
  dailyReceiptRepo,
  storeBillRepo,
  groupCodeRepo,
  missingReceiptRepo,
  receivedReceiptRepo,
  pendingReviewRepo,
  matchBadcaseRepo,
  pendingReviewResolutionService,
}) {
  if (!dailyReceiptRepo || !storeBillRepo || !pendingReviewRepo) {
    throw new Error('batch_operations_service: missing repos');
  }

  /**
   * 批量解决 pending_review
   * @param {Object} params
   * @param {string} params.workspaceKey
   * @param {string[]} params.ids - pending_review IDs
   * @param {string} params.resolution - 'accept' | 'reject' | 'skip'
   * @param {string} params.operator
   * @returns {Promise<{affected: number, errors: Array, summary: Object}>}
   */
  async function batchResolvePendingReview({ workspaceKey, ids, resolution, operator }) {
    if (!workspaceKey || !ids || !Array.isArray(ids) || !resolution || !operator) {
      throw new Error('workspaceKey, ids, resolution, operator required');
    }

    const results = {
      affected: 0,
      errors: [],
      summary: { succeeded: 0, failed: 0 },
    };

    for (const id of ids) {
      try {
        if (pendingReviewResolutionService) {
          // 复核附带发现(2026-07-16):此前参数名错位(pendingReviewId/operator vs 服务解构的
          // id/resolvedBy),这条路径恒抛 'id and workspaceKey required' 全数计入 errors。
          // 修正为服务真实签名,status 口径与下方 fallback 一致;ok:false(没真正落库)不计成功。
          const result = await pendingReviewResolutionService.resolve({
            id,
            workspaceKey,
            status: resolution === 'accept' ? 'resolved' : 'rejected',
            resolution,
            resolvedBy: operator,
          });
          if (result && result.ok === false) {
            results.errors.push({ id, error: (result.warnings || []).join('、') || 'not_applied' });
            results.summary.failed += 1;
          } else {
            results.affected += 1;
            results.summary.succeeded += 1;
          }
        } else {
          // Fallback: update status directly through the repository resolve path.
          pendingReviewRepo.resolve({
            id,
            workspaceKey,
            status: resolution === 'accept' ? 'resolved' : 'rejected',
            resolution,
            resolvedBy: operator,
            resolvedAt: new Date().toISOString(),
          });
          results.affected += 1;
          results.summary.succeeded += 1;
        }
      } catch (error) {
        results.errors.push({
          id,
          error: error?.message || String(error),
        });
        results.summary.failed += 1;
      }
    }

    return results;
  }

  /**
   * 批量删除 daily_receipt_export
   * @param {Object} params
   * @param {string} params.workspaceKey
   * @param {string[]} params.ids
   * @returns {Promise<{affected: number, errors: Array}>}
   */
  async function batchDeleteDailyReceipt({ workspaceKey, ids }) {
    if (!workspaceKey || !ids || !Array.isArray(ids)) {
      throw new Error('workspaceKey and ids required');
    }

    const results = {
      affected: 0,
      errors: [],
    };

    if (typeof dailyReceiptRepo.deleteMany === 'function') {
      try {
        const deleted = dailyReceiptRepo.deleteMany({ workspaceKey, ids });
        results.affected = deleted;
      } catch (error) {
        results.errors.push({ error: error?.message || String(error) });
      }
    } else {
      // Fallback: 逐个删除
      for (const id of ids) {
        try {
          dailyReceiptRepo.delete({ workspaceKey, id });
          results.affected += 1;
        } catch (error) {
          results.errors.push({ id, error: error?.message || String(error) });
        }
      }
    }

    return results;
  }

  /**
   * 批量删除 store_bill
   * @param {Object} params
   * @param {string} params.workspaceKey
   * @param {string[]} params.ids
   * @returns {Promise<{affected: number, errors: Array}>}
   */
  async function batchDeleteStoreBill({ workspaceKey, ids }) {
    if (!workspaceKey || !ids || !Array.isArray(ids)) {
      throw new Error('workspaceKey and ids required');
    }

    const results = {
      affected: 0,
      errors: [],
    };

    if (typeof storeBillRepo.deleteMany === 'function') {
      try {
        const deleted = storeBillRepo.deleteMany({ workspaceKey, ids });
        results.affected = deleted;
      } catch (error) {
        results.errors.push({ error: error?.message || String(error) });
      }
    } else {
      // Fallback: 逐个删除
      for (const id of ids) {
        try {
          storeBillRepo.delete({ workspaceKey, id });
          results.affected += 1;
        } catch (error) {
          results.errors.push({ id, error: error?.message || String(error) });
        }
      }
    }

    return results;
  }

  async function batchDeleteGroupCodes({ workspaceKey, ids }) {
    return batchDeleteRows({
      repo: groupCodeRepo,
      workspaceKey,
      ids,
      label: 'group_code',
    });
  }

  async function batchDeleteMissingReceipts({ workspaceKey, ids }) {
    return batchDeleteRows({
      repo: missingReceiptRepo,
      workspaceKey,
      ids,
      label: 'missing_receipt',
    });
  }

  async function batchDeleteReceivedReceipts({ workspaceKey, ids }) {
    return batchDeleteRows({
      repo: receivedReceiptRepo,
      workspaceKey,
      ids,
      label: 'received_receipt',
    });
  }

  /**
   * 批量更新 daily_receipt_export 字段
   * @param {Object} params
   * @param {string} params.workspaceKey
   * @param {string[]} params.ids
   * @param {Object} params.updates - 要更新的字段 { modeFolder: 'xxx', ... }
   * @returns {Promise<{affected: number, errors: Array}>}
   */
  async function batchUpdateDailyReceipt({ workspaceKey, ids, updates }) {
    if (!workspaceKey || !ids || !Array.isArray(ids) || !updates) {
      throw new Error('workspaceKey, ids, updates required');
    }

    const results = {
      affected: 0,
      errors: [],
    };

    for (const id of ids) {
      try {
        const result = dailyReceiptRepo.applyFieldUpdates({
          workspaceKey, id, updates, manualLock: true,
        });
        results.affected += typeof result === 'number' ? result : Number(result?.changes || 0);
      } catch (error) {
        results.errors.push({ id, error: error?.message || String(error) });
      }
    }

    return results;
  }

  /**
   * 批量标记 match_badcase 为已处理
   * @param {Object} params
   * @param {string} params.workspaceKey
   * @param {string[]} params.ids
   * @param {string} params.operator
   * @returns {Promise<{affected: number, errors: Array}>}
   */
  async function batchMarkBadcaseHandled({ workspaceKey, ids, operator }) {
    if (!matchBadcaseRepo) {
      throw new Error('matchBadcaseRepo not available');
    }
    if (!workspaceKey || !ids || !Array.isArray(ids) || !operator) {
      throw new Error('workspaceKey, ids, operator required');
    }

    const results = {
      affected: 0,
      errors: [],
    };

    if (typeof matchBadcaseRepo.markHandledMany === 'function') {
      try {
        const marked = matchBadcaseRepo.markHandledMany({ workspaceKey, ids, operator });
        results.affected = marked;
      } catch (error) {
        results.errors.push({ error: error?.message || String(error) });
      }
    } else {
      // Fallback: 逐个标记
      for (const id of ids) {
        try {
          matchBadcaseRepo.markHandled({ workspaceKey, id, operator });
          results.affected += 1;
        } catch (error) {
          results.errors.push({ id, error: error?.message || String(error) });
        }
      }
    }

    return results;
  }

  return {
    batchResolvePendingReview,
    batchDeleteDailyReceipt,
    batchDeleteStoreBill,
    batchDeleteGroupCodes,
    batchDeleteMissingReceipts,
    batchDeleteReceivedReceipts,
    batchUpdateDailyReceipt,
    batchMarkBadcaseHandled,
  };
}

function batchDeleteRows({ repo, workspaceKey, ids, label }) {
  if (!workspaceKey || !ids || !Array.isArray(ids)) {
    throw new Error('workspaceKey and ids required');
  }
  if (!repo || typeof repo.deleteMany !== 'function') {
    throw new Error(`${label} delete is not available`);
  }

  const results = {
    affected: 0,
    errors: [],
  };

  try {
    results.affected = repo.deleteMany({ workspaceKey, ids });
  } catch (error) {
    results.errors.push({ error: error?.message || String(error) });
  }

  return results;
}

module.exports = { createBatchOperationsService };
