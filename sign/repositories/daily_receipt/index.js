'use strict';

const { CAMEL_BY_COL, FIELD_COLS } = require('./common');
const { createDailyReceiptQueries } = require('./queries');
const { createDailyReceiptWrites } = require('./writes');

function createDailyReceiptRepository({ db, fieldHistoryRepo = null }) {
  if (!db) throw new Error('db is required');

  const queries = createDailyReceiptQueries({ db });
  const writes = createDailyReceiptWrites({ db, fieldHistoryRepo });

  return {
    insertMany: writes.insertMany,
    countByWorkspace: queries.countByWorkspace,
    countByMode: queries.countByMode,
    countMatchedByFolder: queries.countMatchedByFolder,
    countByMatchStatus: queries.countByMatchStatus,
    listPendingTourMatch: queries.listPendingTourMatch,
    updateTourMatch: writes.updateTourMatch,
    updateBillMatch: writes.updateBillMatch,
    setConflictFields: writes.setConflictFields,
    applyFieldUpdates: writes.applyFieldUpdates,
    migrateRow: writes.migrateRow,
    _applyBillMatchBatch: writes._applyBillMatchBatch,
    listByMode: queries.listByMode,
    listBySourceGroup: queries.listBySourceGroup,
    listWorkspaceKeysForSourceGroup: queries.listWorkspaceKeysForSourceGroup,
    listModeRawBySourceBatch: queries.listModeRawBySourceBatch, // 交付包分桶台账优先(五问题#2)
    confirmModesByGroup: writes.confirmModesByGroup,
    listUsedGroupCodes: queries.listUsedGroupCodes,
    countUsedGroupCodes: queries.countUsedGroupCodes,
    listFiltered: queries.listFiltered,
    countFiltered: queries.countFiltered,
    findByReceipt: queries.findByReceipt,
    findByReceiptDate: queries.findByReceiptDate,
    findByReceiptTour: queries.findByReceiptTour,
    findByPassportDateShop: queries.findByPassportDateShop,
    findByNameDateShop: queries.findByNameDateShop,
    findByNameDate: queries.findByNameDate,
    findFuzzyByReceiptPrefix: queries.findFuzzyByReceiptPrefix,
    _fetchFullById: queries._fetchFullById,
    listManualBillLockedIds: queries.listManualBillLockedIds, // A1:锁定行保护(bill_match 重跑不重置)
    deleteLedgerRow: writes.deleteLedgerRow,
    deleteMany: writes.deleteMany,
    settleGroupAtomic: writes.settleGroupAtomic, // L180:删旧+写新同一事务(结算原子化)
    _listUnmatched: queries._listUnmatched,
    _listAll: queries._listAll,
    _listMatchCandidates: queries._listMatchCandidates,
    _listConsistencyCandidates: queries._listConsistencyCandidates,
    _iterateMergeCandidates: queries._iterateMergeCandidates,
    listBillReviewConflicts: queries.listBillReviewConflicts,
    countBillReviewConflicts: queries.countBillReviewConflicts,
    listForModeFolderRefresh: queries.listForModeFolderRefresh,
    listLedger: queries.listLedger,
    countLedger: queries.countLedger,
    groupByAgent: queries.groupByAgent,
    listByLedgerStatus: queries.listByLedgerStatus,
    countByLedgerStatus: queries.countByLedgerStatus,
    countByTourMatchStatus: queries.countByTourMatchStatus, // 0731:审核台页签的承接角标
    setLedgerStatus: writes.setLedgerStatus,
    publishToMonthly: writes.publishToMonthly,
    lockPosted: writes.lockPosted,
    updateDeparture: writes.updateDeparture,
    updateModeFolderBulk: writes.updateModeFolderBulk,
    resetBillMatchForIds: writes.resetBillMatchForIds,
    clearBillMatchLocksForIds: writes.clearBillMatchLocksForIds, // A1复核HIGH:桶级替换解除账单锁
    resetTourMatchForRematch: writes.resetTourMatchForRematch,
    applyDepartureRewrites: writes.applyDepartureRewrites,
    listDepartureSyncCandidates: queries.listDepartureSyncCandidates,
    _fields: FIELD_COLS,
    _camelByCol: CAMEL_BY_COL,
  };
}

module.exports = { createDailyReceiptRepository, FIELD_COLS, CAMEL_BY_COL };
