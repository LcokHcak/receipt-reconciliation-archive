'use strict';

const { countMonthlyRows, toStatusMap } = require('./common');

function createCounts({
  dailyReceiptRepo,
  storeBillRepo,
  billMatchLogRepo,
  pendingReviewRepo,
  monthlyDataRepo,
}) {
  function buildCounts({ workspaceKey }) {
    const ledgerByStatusRows = dailyReceiptRepo?.countByLedgerStatus
      ? dailyReceiptRepo.countByLedgerStatus({ workspaceKey })
      : [];
    const ledgerByStatus = toStatusMap(ledgerByStatusRows, 'status', 'n');
    const monthlyByMode = monthlyDataRepo?.countByMode
      ? monthlyDataRepo.countByMode(workspaceKey)
      : [];

    const matchedMonthly = countMonthlyRows(monthlyByMode, false);
    const unreceivedMonthly = countMonthlyRows(monthlyByMode, true);
    const monthlyData = monthlyDataRepo?.countByWorkspace
      ? Number(monthlyDataRepo.countByWorkspace(workspaceKey) || 0)
      : 0;
    const dailyReceipts = dailyReceiptRepo?.countByWorkspace
      ? Number(dailyReceiptRepo.countByWorkspace(workspaceKey) || 0)
      : 0;
    const storeBills = storeBillRepo?.countByWorkspace
      ? Number(storeBillRepo.countByWorkspace(workspaceKey) || 0)
      : 0;

    return {
      dailyReceipts,
      storeBills,
      billMatchLogs: billMatchLogRepo?.countByWorkspace
        ? Number(billMatchLogRepo.countByWorkspace(workspaceKey) || 0)
        : 0,
      monthlyData,
      matchedMonthly,
      unreceivedMonthly,
      pendingOpen: pendingReviewRepo?.countOpen
        ? Number(pendingReviewRepo.countOpen(workspaceKey) || 0)
        : 0,
      ledgerByStatus,
      ledgerStatusRows: ledgerByStatusRows || [],
      monthlyByMode,
    };
  }

  return buildCounts;
}

module.exports = { createCounts };
