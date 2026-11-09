'use strict';

const ISSUE = {
  id: 'H5',
  severity: 'critical',
  name: '锁月后仍有写入',
  suggestion: '检查锁月后写入来源，必要时走解锁审批后重跑月度流程',
};

const TABLE_CHECKS = [
  { table: 'monthly_data', timeExpr: 'updated_at' },
  { table: 'daily_receipt_export', timeExpr: "MAX(COALESCE(imported_at, ''), COALESCE(posted_at, ''))" },
  { table: 'store_bill', timeExpr: 'imported_at' },
  { table: 'group_code', timeExpr: 'imported_at' },
  { table: 'received_receipt', timeExpr: 'imported_at' },
  { table: 'pending_review', timeExpr: 'created_at' },
  { table: 'match_badcase', timeExpr: 'created_at' },
];

function checkLockedMonthWrites({ db, workspaceKey }) {
  const workspace = db.prepare(`
    SELECT workspace_key, status, locked_at
    FROM monthly_workspace
    WHERE workspace_key = ?
  `).get(workspaceKey);
  if (!workspace || workspace.status !== 'locked' || !workspace.locked_at) {
    return {
      ...ISSUE,
      count: 0,
      skipped: true,
      reason: 'workspace_not_locked',
      samples: [],
    };
  }

  const samples = [];
  for (const check of TABLE_CHECKS) {
    const sample = countWritesAfterLock(db, {
      workspaceKey,
      lockedAt: workspace.locked_at,
      table: check.table,
      timeExpr: check.timeExpr,
    });
    if (sample.count > 0) samples.push(sample);
  }
  return {
    ...ISSUE,
    count: samples.length,
    samples: samples.slice(0, 5),
  };
}

function countWritesAfterLock(db, { workspaceKey, lockedAt, table, timeExpr }) {
  const row = db.prepare(`
    SELECT COUNT(1) AS count, MAX(${timeExpr}) AS latest_at
    FROM ${table}
    WHERE workspace_key = ?
      AND ${timeExpr} > ?
  `).get(workspaceKey, lockedAt);
  return {
    table,
    count: Number(row?.count || 0),
    latest_at: row?.latest_at || null,
  };
}

module.exports = { checkLockedMonthWrites };
