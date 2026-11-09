'use strict';

/**
 * conflict_policy — decides whether a daily_receipt row can be auto-
 * updated from a bill row, or whether the conflict needs human review.
 *
 * Doc §3.5 rule:
 *   daily empty → bill wins (auto-fill allowed)
 *   daily != bill (both non-empty) → pending_review; no auto-overwrite
 *
 * Returns a plan that the caller can apply:
 *   { autoOverwriteFields: [...], pendingConflicts: [...] }
 */

const { isEmptyValue, isPlaceholderName } = require('./field_diff');

// A daily value yields to the bill (auto-fill, no human review) when it is
// empty, or when it is a known name placeholder ("无护照") that carries no
// real identity — the bill name is authoritative in that case.
function dailyYieldsToBill(field, value) {
  if (isEmptyValue(value)) return true;
  if (field === 'name' && isPlaceholderName(value)) return true;
  return false;
}

function planMerge(daily, bill, conflicts) {
  const autoOverwriteFields = [];
  const pendingConflicts = [];
  for (const c of conflicts) {
    if (dailyYieldsToBill(c.field, daily?.[c.field])) {
      // daily empty or placeholder → safe to backfill from bill
      autoOverwriteFields.push(c);
    } else {
      pendingConflicts.push(c);
    }
  }
  return { autoOverwriteFields, pendingConflicts };
}

function anyBlockingConflict(plan) {
  return plan.pendingConflicts.length > 0;
}

module.exports = { planMerge, anyBlockingConflict };
