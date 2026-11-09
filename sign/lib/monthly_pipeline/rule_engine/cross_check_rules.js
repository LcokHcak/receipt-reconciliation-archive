'use strict';

const { RULE_ID } = require('./constants');

/**
 * Departure-date cross-purchase sync. Per §1.3.2:
 *   - Same customer (passport_no) bought multiple times → departure_date
 *     must be identical across all purchases
 *   - On conflict, sync EVERYONE to the latest departure_date
 *   - Must leave an audit trail (persisted separately by cross_check_service)
 *
 * This pure function returns:
 *   - errors: one CC_DEPARTURE_SYNC error per rewritten row
 *   - rewrites: explicit {storeBillId, passportNo, beforeValue, afterValue}
 *               so the service can actually update store_bill + audit
 */
function evaluateDepartureSync({ rows, workspaceKey, detectedAt }) {
  const byPassport = new Map();
  for (const row of rows) {
    if (!row.passportNo || !row.departureDate) continue;
    if (!byPassport.has(row.passportNo)) byPassport.set(row.passportNo, []);
    byPassport.get(row.passportNo).push(row);
  }

  const errors = [];
  const rewrites = [];
  for (const [passportNo, bucket] of byPassport) {
    const dates = new Set(bucket.map((r) => r.departureDate));
    if (dates.size < 2) continue;
    const latest = [...dates].sort().pop();
    for (const row of bucket) {
      if (row.departureDate === latest) continue;
      errors.push({
        workspaceKey,
        errorType: RULE_ID.CC_DEPARTURE_SYNC,
        severity: 'high',
        storeFamily: row.storeFamily,
        mode: row.modeNormalized,
        tourNo: row.tourNo,
        receiptNo: row.receiptNo,
        passportNo,
        name: row.name,
        expectedValue: latest,
        actualValue: row.departureDate,
        detectedAt,
        rawPayload: {
          storeBillId: row.id,
          beforeValue: row.departureDate,
          afterValue: latest,
          autoRewrite: true,
        },
      });
      rewrites.push({
        storeBillId: row.id,
        workspaceKey,
        passportNo,
        name: row.name,
        receiptNo: row.receiptNo,
        beforeValue: row.departureDate,
        afterValue: latest,
      });
    }
  }
  return { errors, rewrites };
}

/**
 * Detect bill rows where (receiptNo, passportNo, name) conflicts with
 * another bill row's metadata — i.e., the same 小票号 appears with two
 * different passports or names.
 */
function evaluateNamePassport({ rows, workspaceKey, detectedAt }) {
  const byReceipt = new Map();
  for (const row of rows) {
    if (!row.receiptNo) continue;
    if (!byReceipt.has(row.receiptNo)) byReceipt.set(row.receiptNo, []);
    byReceipt.get(row.receiptNo).push(row);
  }

  const errors = [];
  for (const [receiptNo, bucket] of byReceipt) {
    const passports = new Set(bucket.filter((r) => r.passportNo).map((r) => r.passportNo));
    const names = new Set(bucket.filter((r) => r.name).map((r) => r.name));
    if (passports.size > 1 || names.size > 1) {
      for (const row of bucket) {
        errors.push({
          workspaceKey,
          errorType: RULE_ID.CC_NAME_PASSPORT,
          severity: 'high',
          storeFamily: row.storeFamily,
          mode: row.modeNormalized,
          tourNo: row.tourNo,
          receiptNo,
          passportNo: row.passportNo,
          name: row.name,
          expectedValue: `unique per receipt`,
          actualValue: `passports=${[...passports].join(',')} names=${[...names].join(',')}`,
          detectedAt,
          rawPayload: { storeBillId: row.id },
        });
      }
    }
  }
  return errors;
}

module.exports = {
  evaluateDepartureSync,
  evaluateNamePassport,
};
