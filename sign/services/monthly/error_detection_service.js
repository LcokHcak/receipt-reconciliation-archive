'use strict';

const { runRules, RULE_ID } = require('../../lib/monthly_pipeline/rule_engine');

/**
 * Runs the non-sync Sprint-1 rules (bill-level + group-code cross ref +
 * receipt/tour length + receipt→passport/name conflicts) and persists
 * the findings. Departure-date auto-sync lives in cross_check_service
 * because it has side effects on store_bill + its own audit trail.
 */
function createErrorDetectionService({
  storeBillRepo,
  errorRecordRepo,
  groupCodeRepo = null,
  crossCheckService = null,
}) {
  if (!storeBillRepo || !errorRecordRepo) {
    throw new Error('storeBillRepo and errorRecordRepo required');
  }

  const MANAGED_RULES = [
    RULE_ID.GC_DATE_WINDOW,
    RULE_ID.GC_RECEIPT_LEN,
    RULE_ID.GC_TOUR_LEN,
    RULE_ID.BILL_MODE_ENUM,
    RULE_ID.BILL_SHOP_ENUM,
    RULE_ID.CC_NAME_PASSPORT,
  ];

  function buildGroupCodeIndex(workspaceKey) {
    if (!groupCodeRepo) return new Map();
    const list = groupCodeRepo.list
      ? groupCodeRepo.list({ workspaceKey, limit: 100000, offset: 0 })
      : [];
    const byTour = new Map();
    for (const row of list) {
      if (!row.tourNo) continue;
      const current = byTour.get(row.tourNo);
      if (!current || compareImportedAt(row, current) > 0) {
        byTour.set(row.tourNo, {
          applyDate: row.applyDate || null,
          endDate: row.endDate || null,
          importedAt: row.importedAt || null,
          id: row.id || 0,
        });
      }
    }
    return byTour;
  }

  return {
    /**
     * Run the detection rules (no departure auto-rewrite). Returns the
     * summary plus, optionally, the departure-sync outcome when the
     * caller wants a one-shot "do everything" path.
     *
     * @param {{ workspaceKey: string, withDepartureSync?: boolean, triggeredBy?: string }} opts
     */
    runCrossCheck({ workspaceKey, withDepartureSync = false, triggeredBy = 'error_detection_service' }) {
      const detailBillRows = storeBillRepo.iterateDetail(workspaceKey);
      const groupCodeByTour = buildGroupCodeIndex(workspaceKey);
      const detectedAt = new Date().toISOString();

      const { errors } = runRules({
        workspaceKey,
        detailBillRows,
        groupCodeByTour,
        detectedAt,
      });

      // Drop everything except CC_DEPARTURE_SYNC (that one is owned by
      // cross_check_service). Refresh all managed rule buckets so we
      // never stack duplicates across re-runs.
      const managedErrors = errors.filter(
        (e) => e.errorType !== RULE_ID.CC_DEPARTURE_SYNC
      );

      for (const ruleType of MANAGED_RULES) {
        errorRecordRepo.clearOpenByType({ workspaceKey, errorType: ruleType });
      }

      errorRecordRepo.insertMany(managedErrors);

      let departure = null;
      if (withDepartureSync) {
        if (!crossCheckService) {
          throw new Error('crossCheckService is required when withDepartureSync=true');
        }
        departure = crossCheckService.run({ workspaceKey, triggeredBy });
      }

      const summary = {};
      for (const err of managedErrors) {
        summary[err.errorType] = (summary[err.errorType] || 0) + 1;
      }
      if (departure) {
        summary[RULE_ID.CC_DEPARTURE_SYNC] = departure.errorsLogged;
      }

      return {
        summary,
        totalErrors: managedErrors.length + (departure ? departure.errorsLogged : 0),
        ranAt: detectedAt,
        departureSync: departure,
      };
    },
    list(opts) {
      return errorRecordRepo.list(opts);
    },
    countByType(workspaceKey) {
      return errorRecordRepo.countByType(workspaceKey);
    },
    resolve({ id, resolvedBy, note }) {
      errorRecordRepo.resolve({
        id,
        resolvedAt: new Date().toISOString(),
        resolvedBy,
        note,
      });
    },
  };
}

function compareImportedAt(a, b) {
  const at = String(a.importedAt || '');
  const bt = String(b.importedAt || '');
  if (at !== bt) return at > bt ? 1 : -1;
  return Number(a.id || 0) - Number(b.id || 0);
}

module.exports = {
  createErrorDetectionService,
};
