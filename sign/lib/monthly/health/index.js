'use strict';

const { checkOrphanMonthlyData } = require('./check_orphan_monthly_data');
const { checkMissingInMonthly } = require('./check_missing_in_monthly');
const { checkStuckStageJob } = require('./check_stuck_stage_job');
const { checkStalePendingReview } = require('./check_stale_pending_review');
const { checkLockedMonthWrites } = require('./check_locked_month_writes');

const CHECKERS = [
  checkOrphanMonthlyData,
  checkMissingInMonthly,
  checkStuckStageJob,
  checkStalePendingReview,
  checkLockedMonthWrites,
];

function runHealthCheck({ workspaceKey, db, isTestMode = false, now = new Date() }) {
  if (!workspaceKey || !db) throw new Error('workspaceKey and db required');
  const checkedAt = now.toISOString();
  const issues = CHECKERS
    .map((checker) => checker({ db, workspaceKey, now }))
    .filter((issue) => issue.skipped || Number(issue.count || 0) > 0);
  return {
    ok: true,
    workspaceKey,
    isTestMode,
    checkedAt,
    issues,
    summary: summarize(issues),
  };
}

function summarize(issues) {
  const summary = { critical: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    if (issue.skipped || Number(issue.count || 0) <= 0) continue;
    if (Object.hasOwn(summary, issue.severity)) summary[issue.severity] += 1;
  }
  return summary;
}

module.exports = {
  runHealthCheck,
};
