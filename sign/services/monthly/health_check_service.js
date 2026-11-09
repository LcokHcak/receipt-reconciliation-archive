'use strict';

const { runHealthCheck } = require('../../lib/monthly/health');

function createMonthlyHealthCheckService({ db, workspaceService } = {}) {
  if (!db || !workspaceService) {
    throw new Error('monthly_health_check_service: db and workspaceService required');
  }

  function checkWorkspace({ workspaceKey } = {}) {
    const workspace = workspaceService.getOrThrow(workspaceKey);
    return runHealthCheck({
      workspaceKey: workspace.workspaceKey,
      db,
      isTestMode: workspaceService.isTestWorkspace(workspace.workspaceKey),
    });
  }

  function checkWorkspaceCsv({ workspaceKey } = {}) {
    const report = checkWorkspace({ workspaceKey });
    return toCsv(report);
  }

  return {
    checkWorkspace,
    checkWorkspaceCsv,
  };
}

function toCsv(report) {
  const header = [
    'workspaceKey',
    'checkedAt',
    'id',
    'severity',
    'name',
    'count',
    'skipped',
    'reason',
    'suggestion',
    'samples',
  ];
  const rows = report.issues.map((issue) => [
    report.workspaceKey,
    report.checkedAt,
    issue.id,
    issue.skipped ? '' : issue.severity,
    issue.name,
    issue.count,
    issue.skipped ? 'true' : 'false',
    issue.reason || '',
    issue.suggestion || '',
    JSON.stringify(issue.samples || []),
  ]);
  return [
    header.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ].join('\n');
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

module.exports = {
  createMonthlyHealthCheckService,
  toCsv,
};
