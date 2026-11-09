'use strict';

const { runSqliteTransaction } = require('../../lib/storage/sqlite_transaction');
const workspaceResolver = require('../../lib/monthly/workspace_resolver');

function createDailyWorkspaceMigrationService({
  db,
  dailyReceiptRepo,
  monthlyDataRepo,
  billMatchLogRepo,
  pendingReviewRepo,
  matchBadcaseRepo,
  errorRecordRepo = null,
  workspaceService,
  auditLogRepo = null,
  resolver = workspaceResolver,
}) {
  if (!db) throw new Error('db is required');
  if (!dailyReceiptRepo) throw new Error('dailyReceiptRepo is required');

  function migrateDailyByPurchaseDate({
    workspaceKey,
    dailyReceiptId,
    newPurchaseDate,
    operator = 'system',
  }) {
    const resolved = resolver.resolveWorkspaceForPurchaseDate({
      purchaseDate: newPurchaseDate,
      currentWorkspaceKey: workspaceKey,
    });
    if (!resolved.isCrossMonth) {
      return {
        migrated: false,
        sourceWorkspaceKey: workspaceKey,
        targetWorkspaceKey: workspaceKey,
        dailyReceiptId: Number(dailyReceiptId),
        purchaseDate: resolved.purchaseDate,
      };
    }

    const txResult = runSqliteTransaction(db, () => {
      ensureWorkspace(resolved.targetWorkspaceKey, operator);
      const current = dailyReceiptRepo._fetchFullById?.({
        workspaceKey,
        id: Number(dailyReceiptId),
      });
      if (!current) {
        const error = new Error('daily row not found');
        error.status = 404;
        error.statusCode = 404;
        error.code = 'daily_not_found';
        throw error;
      }

      monthlyDataRepo?.deleteByDaily?.({ workspaceKey, dailyReceiptId });
      billMatchLogRepo?.deleteByDaily?.({ workspaceKey, dailyReceiptId });
      pendingReviewRepo?.closeByDaily?.({ workspaceKey, dailyReceiptId, operator });
      matchBadcaseRepo?.deleteByDaily?.({ workspaceKey, dailyReceiptId });
      // L614:跨月迁移把行搬去目标月后,源月留下的 open TM_ error_record 变孤儿(源月已无此行→
      // count 守卫 EXISTS 假→源月错误台/待补救虚计,tour_match 不会再为已消失的行重跑=永不自愈)。
      // 用 L610 建的行级 source_id 精确清源月该行的 TM error;legacy(null)由 receiptNo 兜底。同事务,
      // 失败整体回滚。pending_review 那半已由上面 closeByDaily 收口,这里只补 error_record。
      errorRecordRepo?.deleteOpenBySourceIds?.({
        workspaceKey,
        sourceTable: 'daily_receipt_export',
        sourceIds: [Number(dailyReceiptId)],
        receiptNos: current.receiptNo ? [current.receiptNo] : [],
        typePrefix: 'TM',
      });
      const result = dailyReceiptRepo.migrateRow({
        sourceWorkspaceKey: workspaceKey,
        targetWorkspaceKey: resolved.targetWorkspaceKey,
        dailyReceiptId,
        newPurchaseDate: resolved.purchaseDate,
        modifiedBy: operator,
      });

      return {
        migrated: true,
        sourceWorkspaceKey: workspaceKey,
        targetWorkspaceKey: resolved.targetWorkspaceKey,
        dailyReceiptId: Number(dailyReceiptId),
        purchaseDate: resolved.purchaseDate,
        rowHash: result.rowHash,
      };
    }, { savepointName: 'daily_workspace_migration' });

    // Audit log written AFTER the transaction commits so it's never rolled back.
    if (auditLogRepo) {
      try {
        auditLogRepo.log({
          workspaceKey: txResult.sourceWorkspaceKey,
          userId: operator || 'system',
          action: 'migrate_daily_row',
          resourceType: 'daily_receipt',
          resourceId: String(txResult.dailyReceiptId),
          details: {
            sourceWorkspaceKey: txResult.sourceWorkspaceKey,
            targetWorkspaceKey: txResult.targetWorkspaceKey,
            purchaseDate: txResult.purchaseDate,
          },
        });
      } catch {
        // Audit log failure must not block the main flow
      }
    }

    return txResult;
  }

  function ensureWorkspace(workspaceKey, operator) {
    if (!workspaceService) return;
    try {
      workspaceService.getOrThrow(workspaceKey);
    } catch {
      workspaceService.open({ workspaceKey, operator: operator || 'daily_migration' });
    }
  }

  return { migrateDailyByPurchaseDate };
}

module.exports = { createDailyWorkspaceMigrationService };
