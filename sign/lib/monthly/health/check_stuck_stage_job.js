'use strict';

const ISSUE = {
  id: 'H3',
  severity: 'critical',
  name: '卡死阶段任务',
  suggestion: '确认后台任务状态，必要时重启服务或取消卡住的 stage_job',
};

function checkStuckStageJob({ db, workspaceKey, now = new Date() }) {
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(1) AS count
    FROM stage_job
    WHERE workspace_key = ?
      AND status = 'running'
      AND started_at < ?
  `).get(workspaceKey, cutoff);
  const samples = db.prepare(`
    SELECT id, stage, status, started_at, operator
    FROM stage_job
    WHERE workspace_key = ?
      AND status = 'running'
      AND started_at < ?
    ORDER BY started_at ASC
    LIMIT 5
  `).all(workspaceKey, cutoff);
  return {
    ...ISSUE,
    count: Number(row?.count || 0),
    samples,
  };
}

module.exports = { checkStuckStageJob };
