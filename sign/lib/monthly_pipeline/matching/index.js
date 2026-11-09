'use strict';

/**
 * matching/index — orchestrates the 6-level priority match from the
 * 小票规则 spec. Callers pass a single store_bill row plus a
 * candidate-index helper (to keep the engine pluggable / testable).
 *
 * Priorities (doc §3.3):
 *   P1  receiptNo
 *   P2  receiptNo + purchaseDate
 *   P3  receiptNo + tourNo
 *   P4  passportNo + purchaseDate + shop
 *   P5  name + purchaseDate + shop
 *   P6  fuzzy  (manual review only)
 */

const { diffDailyVsBill, normalizeString, normalizeDate, isEmptyValue } = require('./field_diff');

const PRIORITIES = Object.freeze([1, 2, 3, 4, 5, 6]);

const KEY_BUILDERS = {
  // Returns the match key string for a priority, or null if not applicable
  1: (r) => isEmptyValue(r.receiptNo) ? null : `receipt_no=${normalizeString(r.receiptNo)}`,
  2: (r) => (isEmptyValue(r.receiptNo) || isEmptyValue(r.purchaseDate))
    ? null
    : `receipt_no=${normalizeString(r.receiptNo)}|purchase_date=${normalizeDate(r.purchaseDate)}`,
  3: (r) => (isEmptyValue(r.receiptNo) || isEmptyValue(r.tourNo))
    ? null
    : `receipt_no=${normalizeString(r.receiptNo)}|tour_no=${normalizeString(r.tourNo)}`,
  4: (r) => (isEmptyValue(r.passportNo) || isEmptyValue(r.purchaseDate) || isEmptyValue(r.shop))
    ? null
    : `passport=${normalizeString(r.passportNo)}|purchase_date=${normalizeDate(r.purchaseDate)}|shop=${normalizeString(r.shop)}`,
  5: (r) => (isEmptyValue(r.name) || isEmptyValue(r.purchaseDate) || isEmptyValue(r.shop))
    ? null
    : `name=${normalizeString(r.name)}|purchase_date=${normalizeDate(r.purchaseDate)}|shop=${normalizeString(r.shop)}`,
  6: () => null, // fuzzy — handled separately
};

// Normalizes bill naming to the daily schema so one key builder works
function billAsDaily(bill) {
  return {
    receiptNo: bill.receiptNo,
    purchaseDate: bill.purchaseDate,
    tourNo: bill.tourNo,
    passportNo: bill.passportNo,
    name: bill.name || bill.fullName,
    shop: bill.storeFamily || bill.shop,
    branch: bill.storeBranch || bill.branch,
    departureDate: bill.departureDate,
    modeNormalized: bill.modeNormalized,
    originalReceiptNo: bill.originalReceiptNo,
  };
}

/**
 * @param {object} bill — one store_bill row
 * @param {{
 *   findDailyByReceipt:   (receiptNo) => object[],
 *   findDailyByReceiptDate: (receiptNo, purchaseDate) => object[],
 *   findDailyByReceiptTour: (receiptNo, tourNo) => object[],
 *   findDailyByPassportDateShop: (passport, purchaseDate, shop) => object[],
 *   findDailyByNameDateShop: (name, purchaseDate, shop) => object[],
 *   findDailyFuzzy?: (bill) => object[],
 * }} index
 * @returns {{
 *   priority: number|null,
 *   status: 'matched' | 'ambiguous' | 'fuzzy' | 'unmatched',
 *   candidates: object[],
 *   matchKey: string|null,
 * }}
 */
function matchBillAgainstDaily(bill, index) {
  const probe = billAsDaily(bill);
  for (const prio of [1, 2, 3, 4, 5]) {
    const key = KEY_BUILDERS[prio](probe);
    if (!key) continue;
    const hits = runLevel(prio, probe, index) || [];
    if (hits.length === 1) {
      return { priority: prio, status: 'matched', candidates: hits, matchKey: key };
    }
    if (hits.length > 1) {
      if (canCollapseProductRows(probe, hits, prio)) {
        return { priority: prio, status: 'matched', candidates: [hits[0]], matchKey: key };
      }
      return { priority: prio, status: 'ambiguous', candidates: hits, matchKey: key };
    }
    // 0 hits → fall through to next priority
  }
  const fuzzy = index.findDailyFuzzy ? (index.findDailyFuzzy(probe) || []) : [];
  if (fuzzy.length > 0) {
    return { priority: 6, status: 'fuzzy', candidates: fuzzy, matchKey: 'fuzzy' };
  }
  return { priority: null, status: 'unmatched', candidates: [], matchKey: null };
}

function canCollapseProductRows(probe, hits, prio) {
  if (![1, 2, 3, 4, 5].includes(prio)) return false;
  if (!Array.isArray(hits) || hits.length < 2) return false;

  const identityFields = ['receiptNo', 'purchaseDate', 'tourNo', 'passportNo', 'name', 'shop'];
  const representative = hits[0] || {};
  for (const field of identityFields) {
    const expected = normalizeIdentityValue(field, representative[field]);
    for (const hit of hits.slice(1)) {
      const value = normalizeIdentityValue(field, hit?.[field]);
      if (expected && value && expected !== value) return false;
    }
    const billValue = normalizeIdentityValue(field, probe[field]);
    if (expected && billValue && expected !== billValue) return false;
  }
  return true;
}

function normalizeIdentityValue(field, value) {
  return field === 'purchaseDate' ? normalizeDate(value) : normalizeString(value);
}

function runLevel(prio, probe, index) {
  switch (prio) {
    case 1: return index.findDailyByReceipt(probe.receiptNo);
    case 2: return index.findDailyByReceiptDate(probe.receiptNo, probe.purchaseDate);
    case 3: return index.findDailyByReceiptTour(probe.receiptNo, probe.tourNo);
    case 4: return index.findDailyByPassportDateShop(probe.passportNo, probe.purchaseDate, probe.shop);
    case 5: return index.findDailyByNameDateShop(probe.name, probe.purchaseDate, probe.shop);
    default: return [];
  }
}

module.exports = {
  PRIORITIES,
  KEY_BUILDERS,
  matchBillAgainstDaily,
  billAsDaily,
  diffDailyVsBill,
  canCollapseProductRows,
};
