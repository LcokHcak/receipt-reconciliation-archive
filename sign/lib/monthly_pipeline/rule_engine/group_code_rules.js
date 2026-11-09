'use strict';

const { RULE_ID, RECEIPT_LEN_BY_FAMILY, TOUR_LEN_BY_FAMILY } = require('./constants');
const { detectFamily } = require('../store_family_detector');

/**
 * Rules that tie store_bill rows to the 团号 (group_code) master table
 * and to store-family conventions (receipt-number length, tour-number length).
 *
 *   GC_DATE_WINDOW  — purchase_date must fall within [apply_date, end_date]
 *                     from the matching group_code row. Per Q5:
 *                       - apply_date NULL → skip the lower bound
 *                       - end_date   NULL → auto-pass (no error)
 *   GC_RECEIPT_LEN  — receipt_no length must match the store family.
 *                     All-alpha placeholders (e.g. ZZ...) are tolerated.
 *   GC_TOUR_LEN     — tour_no length must match the store family.
 *                     All-alpha placeholders are tolerated.
 *
 * Pure functions — return error records. Caller persists them.
 */

/**
 * @param {{
 *   billRows: Array,
 *   groupCodeByTour: Map<string, {applyDate: string|null, endDate: string|null}>,
 *   workspaceKey: string,
 *   detectedAt: string,
 * }} ctx
 */
function evaluateDateWindow({ billRows, groupCodeByTour, workspaceKey, detectedAt }) {
  const errors = [];
  if (!groupCodeByTour || groupCodeByTour.size === 0) return errors;

  for (const row of billRows) {
    if (!row.isDetailSheet) continue;
    if (!row.tourNo || !row.purchaseDate) continue;

    const tourNo = String(row.tourNo).trim();
    const gc = groupCodeByTour.get(tourNo);
    if (!gc) continue; // no matching group_code row; covered by other rules

    const applyDate = gc.applyDate || null;
    const endDate = gc.endDate || null;
    const purchase = row.purchaseDate;

    // End-date null → auto-pass (Q5 decision)
    if (!endDate && !applyDate) continue;

    const outOfLower = applyDate && purchase < applyDate;
    const outOfUpper = endDate && purchase > endDate;
    if (!outOfLower && !outOfUpper) continue;

    errors.push({
      workspaceKey,
      errorType: RULE_ID.GC_DATE_WINDOW,
      severity: 'high',
      storeFamily: row.storeFamily,
      mode: row.modeNormalized || row.mode,
      tourNo,
      receiptNo: row.receiptNo,
      passportNo: row.passportNo,
      name: row.name,
      expectedValue: `[${applyDate || '-∞'}, ${endDate || '+∞'}]`,
      actualValue: purchase,
      detectedAt,
      rawPayload: {
        storeBillId: row.id,
        applyDate,
        endDate,
      },
    });
  }
  return errors;
}

/**
 * Per-bill receipt-number length check, keyed on detected store family.
 *
 * @param {{ billRows: Array, workspaceKey: string, detectedAt: string }} ctx
 */
function evaluateReceiptLength({ billRows, workspaceKey, detectedAt }) {
  const errors = [];
  for (const row of billRows) {
    if (!row.isDetailSheet) continue;
    if (!row.receiptNo) continue;

    const family = resolveFamily(row);
    if (!family) continue;

    const expected = RECEIPT_LEN_BY_FAMILY[family];
    if (!expected) continue;

    const raw = String(row.receiptNo).trim();
    if (isAlphaPlaceholder(raw)) continue;
    if (raw.length === expected) continue;

    errors.push({
      workspaceKey,
      errorType: RULE_ID.GC_RECEIPT_LEN,
      severity: 'high',
      storeFamily: family,
      mode: row.modeNormalized || row.mode,
      tourNo: row.tourNo,
      receiptNo: raw,
      passportNo: row.passportNo,
      name: row.name,
      expectedValue: `len=${expected}`,
      actualValue: `len=${raw.length}`,
      detectedAt,
      rawPayload: { storeBillId: row.id },
    });
  }
  return errors;
}

/**
 * Per-bill tour-number length check, keyed on detected store family.
 * Mirrors evaluateReceiptLength.
 */
function evaluateTourLength({ billRows, workspaceKey, detectedAt }) {
  const errors = [];
  for (const row of billRows) {
    if (!row.isDetailSheet) continue;
    if (!row.tourNo) continue;

    const family = resolveFamily(row);
    if (!family) continue;

    const expected = TOUR_LEN_BY_FAMILY[family];
    if (!expected) continue;

    const raw = String(row.tourNo).trim();
    if (isAlphaPlaceholder(raw)) continue;
    if (raw.length === expected) continue;

    errors.push({
      workspaceKey,
      errorType: RULE_ID.GC_TOUR_LEN,
      severity: 'high',
      storeFamily: family,
      mode: row.modeNormalized || row.mode,
      tourNo: raw,
      receiptNo: row.receiptNo,
      passportNo: row.passportNo,
      name: row.name,
      expectedValue: `len=${expected}`,
      actualValue: `len=${raw.length}`,
      detectedAt,
      rawPayload: { storeBillId: row.id },
    });
  }
  return errors;
}

function resolveFamily(row) {
  if (row.storeFamily) return row.storeFamily;
  if (!row.sourceFile && !row.sourceSheet) return null;
  return detectFamily({ fileName: row.sourceFile, sheetName: row.sourceSheet }).family;
}

function isAlphaPlaceholder(value) {
  return /^[A-Za-z_]+$/.test(String(value));
}

module.exports = {
  evaluateDateWindow,
  evaluateReceiptLength,
  evaluateTourLength,
};
