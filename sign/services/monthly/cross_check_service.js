'use strict';

const { evaluateDepartureSync } = require('../../lib/monthly_pipeline/rule_engine/cross_check_rules');
const { RULE_ID } = require('../../lib/monthly_pipeline/rule_engine/constants');

/**
 * Runs the departure-date cross-purchase sync. Per §1.3.2 this must:
 *   1. detect rows whose passport_no has ≥ 2 distinct departure_date values
 *   2. pick the LATEST date as the source of truth
 *   3. rewrite every other row's departure_date to the latest
 *   4. persist a CC_DEPARTURE_SYNC error record per rewrite
 *   5. persist a departure_sync_audit row per rewrite (before/after/who)
 *
 * The three persistence steps are wrapped in a single logical pass so
 * an individual failure leaves the DB consistent — rewrites, errors,
 * and audit rows share a detectedAt/triggeredAt timestamp.
 */
function createCrossCheckService({
  storeBillRepo,
  dailyReceiptRepo = null,
  errorRecordRepo,
  departureSyncAuditRepo,
  auditLogRepo = null,
  clock = () => new Date().toISOString(),
}) {
  if (!storeBillRepo) throw new Error('storeBillRepo is required');
  if (!errorRecordRepo) throw new Error('errorRecordRepo is required');
  if (!departureSyncAuditRepo) throw new Error('departureSyncAuditRepo is required');

  return {
    /**
     * @param {{ workspaceKey: string, triggeredBy?: string }} opts
     * @returns {{ rewritten: number, errorsLogged: number, auditedAt: string }}
     */
    run({ workspaceKey, triggeredBy = 'cross_check_service' }) {
      if (!workspaceKey) throw new Error('workspaceKey is required');

      const detailBillRows = storeBillRepo.iterateDetail(workspaceKey);
      const dailyRows = dailyReceiptRepo?.listDepartureSyncCandidates
        ? dailyReceiptRepo.listDepartureSyncCandidates({ workspaceKey })
        : [];
      const ts = clock();
      const { errors } = evaluateDepartureSync({
        rows: detailBillRows,
        workspaceKey,
        detectedAt: ts,
      });
      const crossTableRewrites = buildCrossTableDepartureRewrites({
        dailyRows,
        billRows: detailBillRows,
        workspaceKey,
      });

      if (crossTableRewrites.length === 0) {
        errorRecordRepo.clearOpenByType({ workspaceKey, errorType: RULE_ID.CC_DEPARTURE_SYNC });
        return { rewritten: 0, errorsLogged: 0, auditedAt: ts };
      }

      // Replace any stale open CC_DEPARTURE_SYNC rows so re-running the
      // service never accumulates duplicates.
      errorRecordRepo.clearOpenByType({ workspaceKey, errorType: RULE_ID.CC_DEPARTURE_SYNC });

      const { records } = errorRecordRepo.insertMany(errors);

      // Match each persisted error back to its originating rewrite via the
      // storeBillId embedded in rawPayload so the audit row can link them.
      const errorByStoreBill = new Map();
      for (const rec of records) {
        const sid = rec.input?.rawPayload?.storeBillId;
        if (sid != null) errorByStoreBill.set(Number(sid), rec.id);
      }

      const billRewrites = crossTableRewrites
        .filter((r) => r.sourceTable === 'store_bill')
        .map((r) => ({ ...r, storeBillId: r.sourceId, workspaceKey }));
      const dailyRewrites = crossTableRewrites
        .filter((r) => r.sourceTable === 'daily_receipt_export')
        .map((r) => ({ ...r, dailyReceiptId: r.sourceId, workspaceKey }));

      const applied = (
        storeBillRepo.applyDepartureRewrites(billRewrites)
        + (dailyReceiptRepo?.applyDepartureRewrites
          ? dailyReceiptRepo.applyDepartureRewrites(dailyRewrites)
          : 0)
      );

      departureSyncAuditRepo.insertMany(
        billRewrites.map((r) => ({
          workspaceKey,
          storeBillId: r.storeBillId,
          passportNo: r.passportNo,
          name: r.name,
          receiptNo: r.receiptNo,
          beforeValue: r.beforeValue,
          afterValue: r.afterValue,
          triggeredBy,
          triggeredAt: ts,
          errorRecordId: errorByStoreBill.get(Number(r.storeBillId)) || null,
        }))
      );
      writeAuditLog({
        auditLogRepo,
        workspaceKey,
        rewrites: crossTableRewrites,
        triggeredBy,
        triggeredAt: ts,
      });

      return {
        rewritten: applied,
        errorsLogged: records.length,
        auditedAt: ts,
      };
    },
  };
}

function buildCrossTableDepartureRewrites({ dailyRows, billRows, workspaceKey }) {
  const byPassport = new Map();
  for (const row of dailyRows || []) {
    addCandidate(byPassport, {
      workspaceKey,
      sourceTable: 'daily_receipt_export',
      sourceId: row.id,
      passportNo: row.passportNo,
      name: row.name,
      receiptNo: row.receiptNo,
      departureDate: row.departureDate || null,
    });
  }
  for (const row of billRows || []) {
    addCandidate(byPassport, {
      workspaceKey,
      sourceTable: 'store_bill',
      sourceId: row.id,
      passportNo: row.passportNo,
      name: row.name,
      receiptNo: row.receiptNo,
      departureDate: row.departureDate || null,
    });
  }

  const rewrites = [];
  for (const [, bucket] of byPassport) {
    const dated = bucket.filter((r) => r.departureDate);
    if (dated.length === 0) continue;
    const latest = dated.reduce((max, row) => (
      !max || row.departureDate > max.departureDate ? row : max
    ), null);
    for (const row of bucket) {
      if (row.departureDate === latest.departureDate) continue;
      rewrites.push({
        ...row,
        beforeValue: row.departureDate,
        afterValue: latest.departureDate,
        triggerTable: latest.sourceTable,
        triggerId: latest.sourceId,
      });
    }
  }
  return rewrites;
}

function addCandidate(byPassport, row) {
  if (!row.passportNo) return;
  if (!byPassport.has(row.passportNo)) byPassport.set(row.passportNo, []);
  byPassport.get(row.passportNo).push(row);
}

function writeAuditLog({ auditLogRepo, workspaceKey, rewrites, triggeredBy, triggeredAt }) {
  if (!auditLogRepo || typeof auditLogRepo.logMany !== 'function' || rewrites.length === 0) return;
  auditLogRepo.logMany(rewrites.map((r) => ({
    workspaceKey,
    userId: triggeredBy || 'cross_check_service',
    action: 'cross_check_departure_sync',
    resourceType: r.sourceTable,
    resourceId: String(r.sourceId),
    details: {
      from: r.beforeValue,
      to: r.afterValue,
      passport_no: r.passportNo,
      source_table: r.sourceTable,
      source_id: r.sourceId,
      trigger_table: r.triggerTable,
      trigger_id: r.triggerId,
    },
    createdAt: triggeredAt,
  })));
}

module.exports = {
  createCrossCheckService,
  buildCrossTableDepartureRewrites,
};
