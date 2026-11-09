'use strict';

const ISSUE = {
  id: 'H4',
  severity: 'info',
  name: '长期未处理补救项',
  suggestion: '进入待补救队列处理长期 open 的记录',
};

function checkStalePendingReview({ db, workspaceKey, now = new Date() }) {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(1) AS count
    FROM pending_review
    WHERE workspace_key = ?
      AND status = 'open'
      AND created_at < ?
  `).get(workspaceKey, cutoff);
  const samples = db.prepare(`
    SELECT id, source_table, source_id, reason_type, created_at
    FROM pending_review
    WHERE workspace_key = ?
      AND status = 'open'
      AND created_at < ?
    ORDER BY created_at ASC
    LIMIT 5
  `).all(workspaceKey, cutoff);
  return {
    ...ISSUE,
    count: Number(row?.count || 0),
    samples,
  };
}

module.exports = { checkStalePendingReview };
