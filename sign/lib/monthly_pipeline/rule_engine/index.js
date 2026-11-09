'use strict';

const { evaluateBillRows } = require('./bill_rules');
const {
  evaluateDateWindow,
  evaluateReceiptLength,
  evaluateTourLength,
} = require('./group_code_rules');
const { evaluateDepartureSync, evaluateNamePassport } = require('./cross_check_rules');
const { RULE_ID } = require('./constants');

/**
 * Run all Sprint-1 rules for a workspace and return the collected error
 * records + departure-sync rewrites. Caller persists them.
 *
 * @param {{
 *   workspaceKey: string,
 *   detailBillRows: Array,
 *   groupCodeByTour?: Map<string, {applyDate: string|null, endDate: string|null}>,
 *   detectedAt?: string,
 * }} ctx
 * @returns {{ errors: Array, rewrites: Array, summary: Record<string, number> }}
 */
function runRules({
  workspaceKey,
  detailBillRows = [],
  groupCodeByTour = new Map(),
  detectedAt,
}) {
  const ts = detectedAt || new Date().toISOString();

  const billErrors = evaluateBillRows({
    rows: detailBillRows,
    workspaceKey,
    detectedAt: ts,
  });
  const dateWindowErrors = evaluateDateWindow({
    billRows: detailBillRows,
    groupCodeByTour,
    workspaceKey,
    detectedAt: ts,
  });
  const receiptLenErrors = evaluateReceiptLength({
    billRows: detailBillRows,
    workspaceKey,
    detectedAt: ts,
  });
  const tourLenErrors = evaluateTourLength({
    billRows: detailBillRows,
    workspaceKey,
    detectedAt: ts,
  });
  const { errors: departureErrors, rewrites } = evaluateDepartureSync({
    rows: detailBillRows,
    workspaceKey,
    detectedAt: ts,
  });
  const namePassportErrors = evaluateNamePassport({
    rows: detailBillRows,
    workspaceKey,
    detectedAt: ts,
  });

  const errors = [
    ...billErrors,
    ...dateWindowErrors,
    ...receiptLenErrors,
    ...tourLenErrors,
    ...departureErrors,
    ...namePassportErrors,
  ];

  const summary = {};
  for (const err of errors) {
    summary[err.errorType] = (summary[err.errorType] || 0) + 1;
  }

  return { errors, rewrites, summary };
}

module.exports = {
  runRules,
  RULE_ID,
};
