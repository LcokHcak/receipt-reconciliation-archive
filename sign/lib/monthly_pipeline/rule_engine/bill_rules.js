'use strict';

const { RULE_ID, STORE_FAMILIES } = require('./constants');

/**
 * Bill-level rules that can evaluate a single row without cross references.
 * Pure function — returns an array of error records (not yet persisted).
 *
 * Covers:
 *   BILL_MODE_ENUM — mode must normalize to one of the 7 standard codes
 *   BILL_SHOP_ENUM — store_family must be one of {乐天, 新罗, 爱宝客}
 *
 * Note: GC_TOUR_LEN and GC_RECEIPT_LEN live in group_code_rules.js — they
 * keep the "length-by-family" policy close to the family definition so the
 * rules list stays one-concept-per-file.
 *
 * @param {Array} rows  store_bill rows
 * @param {string} workspaceKey
 * @param {string} detectedAt ISO string
 */
function evaluateBillRows({ rows, workspaceKey, detectedAt }) {
  const errors = [];
  for (const row of rows) {
    if (!row.isDetailSheet) continue;

    if (row.modeNormalized === 'UNKNOWN' && row.mode) {
      errors.push({
        workspaceKey,
        errorType: RULE_ID.BILL_MODE_ENUM,
        severity: 'medium',
        storeFamily: row.storeFamily,
        mode: row.mode,
        tourNo: row.tourNo,
        receiptNo: row.receiptNo,
        passportNo: row.passportNo,
        name: row.name,
        expectedValue: 'PKG|SG|H|B|V|F|FIT',
        actualValue: row.mode,
        detectedAt,
        rawPayload: { storeBillId: row.id },
      });
    }

    if (row.storeFamily && !STORE_FAMILIES.includes(row.storeFamily)) {
      errors.push({
        workspaceKey,
        errorType: RULE_ID.BILL_SHOP_ENUM,
        severity: 'high',
        storeFamily: row.storeFamily,
        mode: row.modeNormalized || row.mode,
        tourNo: row.tourNo,
        receiptNo: row.receiptNo,
        passportNo: row.passportNo,
        name: row.name,
        expectedValue: STORE_FAMILIES.join('|'),
        actualValue: row.storeFamily,
        detectedAt,
        rawPayload: { storeBillId: row.id },
      });
    }
  }
  return errors;
}

module.exports = {
  evaluateBillRows,
};
