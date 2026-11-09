'use strict';

const { clampInt } = require('./common');
const { createCounts } = require('./counts');
const { createDetailQueries } = require('./detail_queries');
const { createOperationSnapshots } = require('./operation_snapshots');
const { buildMetrics, buildFormulas } = require('./report_builder');

function createMonthlyReconciliationService({
  db,
  dailyReceiptRepo,
  storeBillRepo,
  billMatchLogRepo,
  pendingReviewRepo,
  monthlyDataRepo,
  stageJobRepo = null,
}) {
  if (!db) throw new Error('monthly_reconciliation_service: db required');

  const buildCounts = createCounts({
    dailyReceiptRepo,
    storeBillRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    monthlyDataRepo,
  });
  const { buildDetailSections } = createDetailQueries({ db });
  const buildOperationSnapshots = createOperationSnapshots(stageJobRepo);

  function build({ workspaceKey, detailLimit = 20 } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const generatedAt = new Date().toISOString();
    const safeLimit = clampInt(detailLimit, 1, 100, 20);
    const counts = buildCounts({ workspaceKey });

    return {
      workspaceKey,
      generatedAt,
      metrics: buildMetrics({ counts, generatedAt }),
      formulas: buildFormulas(counts),
      detailSections: buildDetailSections({ workspaceKey, limit: safeLimit }),
      operationSnapshots: buildOperationSnapshots({ workspaceKey }),
    };
  }

  return { build };
}

module.exports = { createMonthlyReconciliationService };
