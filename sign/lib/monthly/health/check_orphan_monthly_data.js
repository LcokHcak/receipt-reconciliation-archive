'use strict';

const ISSUE = {
  id: 'H1',
  severity: 'warning',
  name: 'monthly_data 孤立行',
  suggestion: '运行重 merge 或手动删除孤立行',
};

function checkOrphanMonthlyData({ db, workspaceKey }) {
  const row = db.prepare(`
    SELECT COUNT(1) AS count
    FROM monthly_data md
    LEFT JOIN daily_receipt_export dr
      ON dr.workspace_key = md.workspace_key
     AND dr.id = md.daily_receipt_id
    WHERE md.workspace_key = ?
      AND md.daily_receipt_id IS NOT NULL
      AND dr.id IS NULL
  `).get(workspaceKey);
  const samples = db.prepare(`
    SELECT md.id, md.daily_receipt_id, md.receipt_no, md.name
    FROM monthly_data md
    LEFT JOIN daily_receipt_export dr
      ON dr.workspace_key = md.workspace_key
     AND dr.id = md.daily_receipt_id
    WHERE md.workspace_key = ?
      AND md.daily_receipt_id IS NOT NULL
      AND dr.id IS NULL
    ORDER BY md.id
    LIMIT 5
  `).all(workspaceKey);
  return {
    ...ISSUE,
    count: Number(row?.count || 0),
    samples,
  };
}

module.exports = { checkOrphanMonthlyData };
