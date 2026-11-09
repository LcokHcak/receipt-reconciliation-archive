'use strict';

const { runSqliteTransaction } = require('../../lib/storage/sqlite_transaction');
const { allFolders, classifyBillFolder } = require('../../lib/monthly_pipeline/mode_folder_classifier');

function createBillMatchBucketService({
  db,
  storeBillRepo,
  dailyReceiptRepo,
  billMatchLogRepo,
  pendingReviewRepo = null,
  matchBadcaseRepo = null,
  monthlyDataRepo = null,
  modeDeductConfigRepo,
  modeFolderMappingRepo,
  importJobRepo,
}) {
  if (!storeBillRepo || !dailyReceiptRepo || !modeDeductConfigRepo || !modeFolderMappingRepo) {
    throw new Error('bill_match_bucket_service: missing repositories');
  }

  function folderOfBill(bill) {
    return classifyBillFolder({
      modeRaw: bill?.mode,
      storeFamily: bill?.storeFamily,
      storeBranch: bill?.storeBranch,
      sourceFile: bill?.sourceFile,
      sourceSheet: bill?.sourceSheet,
    });
  }

  function getBucketsOverview(workspaceKey) {
    if (!workspaceKey) throw new Error('workspaceKey required');

    const mappings = modeFolderMappingRepo.listByWorkspace(workspaceKey);
    const deductRows = modeDeductConfigRepo.listByWorkspace(workspaceKey);
    const deductMap = new Map(deductRows.map((row) => [row.modeFolder, row]));

    // 大数据量(18 万行)性能:不再 SELECT * 全量 load + 4×filter。
    // 改为:轻量列单遍归桶(bill→folder Map)、SQL 聚合台账、日志全量不截断单遍。
    const lightBills = typeof storeBillRepo.iterateDetailLight === 'function'
      ? storeBillRepo.iterateDetailLight(workspaceKey)
      : (typeof storeBillRepo.iterateDetail === 'function' ? storeBillRepo.iterateDetail(workspaceKey) : []);
    const lightLogs = typeof billMatchLogRepo?.iterateLight === 'function'
      ? billMatchLogRepo.iterateLight(workspaceKey)
      : (typeof billMatchLogRepo?.list === 'function' ? billMatchLogRepo.list({ workspaceKey, limit: 1_000_000, offset: 0 }) : []);
    const dailyMatchedRows = typeof dailyReceiptRepo.countMatchedByFolder === 'function'
      ? dailyReceiptRepo.countMatchedByFolder(workspaceKey)
      : [];
    const dailyCountByFolder = new Map(dailyMatchedRows.map((r) => [r.folder, Number(r.n || 0)]));
    const importJobs = typeof importJobRepo?.listByWorkspace === 'function'
      ? importJobRepo.listByWorkspace({ workspaceKey, jobType: 'store_bill', limit: 1000, offset: 0 })
      : [];

    // 单遍:每张账单算一次 folder,记 billId→folder + 每桶账单数。
    const billFolderById = new Map();
    const billCountByFolder = new Map();
    for (const bill of lightBills) {
      const folder = folderOfBill(bill);
      if (!folder) continue;
      billFolderById.set(bill.id, folder);
      billCountByFolder.set(folder, (billCountByFolder.get(folder) || 0) + 1);
    }
    // 单遍日志:按账单所属桶聚合 matched(去重账单)/ pending / 优先级。
    const latestLogByBill = new Map();
    for (const log of lightLogs) {
      if (log.storeBillId == null) continue;
      latestLogByBill.set(Number(log.storeBillId), log);
    }

    const matchedBillIdsByFolder = new Map();
    const matchedDailyIdsByFolder = new Map();
    const pendingByFolder = new Map();
    const priorityByFolder = new Map();
    for (const log of latestLogByBill.values()) {
      const folder = billFolderById.get(log.storeBillId);
      if (!folder) continue;
      if (log.matchStatus === 'matched') {
        if (!matchedBillIdsByFolder.has(folder)) matchedBillIdsByFolder.set(folder, new Set());
        matchedBillIdsByFolder.get(folder).add(log.storeBillId);
        if (log.dailyReceiptId != null) {
          if (!matchedDailyIdsByFolder.has(folder)) matchedDailyIdsByFolder.set(folder, new Set());
          matchedDailyIdsByFolder.get(folder).add(log.dailyReceiptId);
        }
        const pb = priorityByFolder.get(folder) || {};
        const key = String(log.matchPriority || 0);
        pb[key] = (pb[key] || 0) + 1;
        priorityByFolder.set(folder, pb);
      } else if (log.matchStatus === 'pending_review' || log.matchStatus === 'conflict') {
        pendingByFolder.set(folder, (pendingByFolder.get(folder) || 0) + 1);
      }
    }

    const buckets = allFolders().map((folder) => {
      const billCount = billCountByFolder.get(folder) || 0;
      const dailyCount = dailyCountByFolder.get(folder) || 0;
      const matchedBillRows = (matchedBillIdsByFolder.get(folder) || new Set()).size;
      const matched = (matchedDailyIdsByFolder.get(folder) || new Set()).size;
      const deduct = deductMap.get(folder) || null;
      const billDetailCoverageRate = billCount > 0 ? matchedBillRows / billCount : 0;
      const matchRate = dailyCount > 0 ? matched / dailyCount : 0;
      const folderJobs = importJobs.filter((job) => job.bucketFolder === folder && job.status !== 'replaced');
      const billFiles = folderJobs.map((job) => ({
        sourceFile: job.sourceFile,
        rows: Number(job.rowsInserted || 0),
        importedAt: job.startedAt || job.finishedAt || null,
        importJobId: job.id,
      }));
      // 有导入文件但 0 明细 = 行可能被按购买月分流到了别的月份工作区(常见误操作)。
      // 提取作业记录的分流目标月份,供 UI 明确提示去哪看。
      const filesButNoDetail = billFiles.length > 0 && billCount === 0;
      const routedWorkspaces = [];
      if (filesButNoDetail) {
        for (const job of folderJobs) {
          let det = job.details;
          if (typeof det === 'string') { try { det = JSON.parse(det); } catch { det = null; } }
          const sw = det && det.splitByWorkspace;
          if (sw) {
            for (const k of Object.keys(sw)) {
              if (k !== workspaceKey && !routedWorkspaces.includes(k)) routedWorkspaces.push(k);
            }
          }
        }
      }
      return {
        folder,
        deductValue: deduct?.deductValue ?? null,
        deductConfirmedAt: deduct?.confirmedAt || null,
        modeRaws: mappings.filter((row) => row.modeFolder === folder).map((row) => row.modeRaw),
        billCount,
        dailyCount,
        billFiles,
        filesButNoDetail,
        routedWorkspaces,
        matchStats: {
          matched,
          matchedBillRows,
          unmatched: Math.max(0, billCount - matchedBillRows),
          matchRate,
          billDetailCoverageRate,
          pendingReview: pendingByFolder.get(folder) || 0,
          priorityBreakdown: priorityByFolder.get(folder) || {},
        },
        isEmpty: billCount === 0 && dailyCount === 0,
      };
    });

    const totalBills = buckets.reduce((sum, bucket) => sum + bucket.billCount, 0);
    const totalDaily = buckets.reduce((sum, bucket) => sum + bucket.dailyCount, 0);
    const matched = buckets.reduce((sum, bucket) => sum + bucket.matchStats.matched, 0);
    const matchedBillRows = buckets.reduce((sum, bucket) => sum + bucket.matchStats.matchedBillRows, 0);

    return {
      buckets,
      global: {
        totalBills,
        totalDaily,
        matched,
        matchedBillRows,
        matchRate: totalDaily > 0 ? matched / totalDaily : 0,
        billDetailCoverageRate: totalBills > 0 ? matchedBillRows / totalBills : 0,
      },
    };
  }

  function clearBucketBills({ workspaceKey, folder, operator = 'system' }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    if (!allFolders().includes(folder)) {
      const error = new Error('invalid bill bucket folder');
      error.statusCode = 400;
      error.code = 'invalid_bucket_folder';
      throw error;
    }
    const execute = () => {
      const storeBillIds = typeof storeBillRepo.listIdsByImportBucket === 'function'
        ? storeBillRepo.listIdsByImportBucket({ workspaceKey, bucketFolder: folder })
        : [];
      const dailyIds = typeof billMatchLogRepo?.listDailyIdsByStoreBillIds === 'function'
        ? billMatchLogRepo.listDailyIdsByStoreBillIds({ workspaceKey, storeBillIds })
        : [];
      const deletedLogs = typeof billMatchLogRepo?.deleteByStoreBillIds === 'function'
        ? billMatchLogRepo.deleteByStoreBillIds({ workspaceKey, storeBillIds })
        : 0;
      const closedPending = typeof pendingReviewRepo?.closeByStoreBillIds === 'function'
        ? pendingReviewRepo.closeByStoreBillIds({ workspaceKey, storeBillIds, operator })
        : 0;
      const deletedBadcases = typeof matchBadcaseRepo?.deleteByStoreBillIds === 'function'
        ? matchBadcaseRepo.deleteByStoreBillIds({ workspaceKey, storeBillIds })
        : 0;
      // A1复核HIGH(2026-07-16):整桶作废重来——人工锁定 bill_match 的行,其结论依据(旧账单)
      // 已随桶删除,先解除账单三列锁再统一重置(锁着不重置=僵尸锁永远匹不上;锁着重置=绕锁老病)。
      // 其它人工锁(团号/字段)原样保留。
      const clearedLocks = typeof dailyReceiptRepo?.clearBillMatchLocksForIds === 'function'
        ? dailyReceiptRepo.clearBillMatchLocksForIds({ workspaceKey, ids: dailyIds })
        : 0;
      const resetDaily = typeof dailyReceiptRepo?.resetBillMatchForIds === 'function'
        ? dailyReceiptRepo.resetBillMatchForIds({ workspaceKey, ids: dailyIds })
        : 0;
      const deletedBills = typeof storeBillRepo.deleteMany === 'function'
        ? storeBillRepo.deleteMany({ workspaceKey, ids: storeBillIds })
        : 0;
      const clearedMonthlyRows = storeBillIds.length && typeof monthlyDataRepo?.deleteByWorkspace === 'function'
        ? monthlyDataRepo.deleteByWorkspace(workspaceKey)
        : 0;
      const markedJobs = typeof importJobRepo?.markBucketReplaced === 'function'
        ? importJobRepo.markBucketReplaced({ workspaceKey, bucketFolder: folder })
        : 0;

      return {
        workspaceKey,
        folder,
        deletedBills,
        deletedLogs,
        closedPending,
        deletedBadcases,
        resetDaily,
        clearedLocks, // A1复核HIGH:解除了几行的人工账单锁(运维可核对)
        clearedMonthlyRows,
        markedJobs,
      };
    };

    if (!db) return execute();
    return runSqliteTransaction(db, execute, {
      savepointName: 'bill_match_clear_bucket',
      preferSavepoint: true,
    });
  }

  return { getBucketsOverview, folderOfBill, clearBucketBills };
}

module.exports = { createBillMatchBucketService };
