'use strict';

const ISSUE = {
  id: 'H2',
  severity: 'warning',
  name: 'monthly_data 缺失行',
  suggestion: '已跑 merge 后仍缺失时，重新运行 merge 或检查 bill_match_log',
};

function checkMissingInMonthly({ db, workspaceKey }) {
  const mergeSucceeded = db.prepare(`
    SELECT id
    FROM stage_job
    WHERE workspace_key = ?
      AND stage = 'merge'
      AND status = 'succeeded'
    LIMIT 1
  `).get(workspaceKey);
  if (!mergeSucceeded) {
    return {
      ...ISSUE,
      count: 0,
      skipped: true,
      reason: 'merge_never_run',
      samples: [],
    };
  }

  const row = db.prepare(`
    SELECT COUNT(1) AS count
    FROM daily_receipt_export dr
    LEFT JOIN monthly_data md
      ON md.workspace_key = dr.workspace_key
     AND md.daily_receipt_id = dr.id
    WHERE dr.workspace_key = ?
      AND dr.ledger_status = 'posted'
      AND md.id IS NULL
  `).get(workspaceKey);
  const samples = db.prepare(`
    SELECT dr.id, dr.receipt_no, dr.name, dr.purchase_date
    FROM daily_receipt_export dr
    LEFT JOIN monthly_data md
      ON md.workspace_key = dr.workspace_key
     AND md.daily_receipt_id = dr.id
    WHERE dr.workspace_key = ?
      AND dr.ledger_status = 'posted'
      AND md.id IS NULL
    ORDER BY dr.id
    LIMIT 5
  `).all(workspaceKey);
  return {
    ...ISSUE,
    count: Number(row?.count || 0),
    samples,
  };
}

module.exports = { checkMissingInMonthly };
