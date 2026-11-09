'use strict';

/**
 * Workspace surface — open/list/lock/overview.
 *
 * Overview pulls counts from every repo that's wired; each block is
 * gated so a partial bootstrap (e.g. tests without Sprint 2 repos) still
 * produces a valid payload.
 */

const { workspaceKeyFromReq } = require('./route_utils');
const ENDPOINT_REMOVED_RESPONSE = Object.freeze({
  error: '端点已废弃，月度不再使用锁月/解锁流程',
  code: 'endpoint_removed',
});

function registerWorkspaceRoutes({ app, guards, deps }) {
  const { admin, read, intake, finalReview } = guards;
  const {
    workspaceService,
    workspaceResetService,
    monthlySeedService,
    monthlyHealthCheckService,
    groupCodeRepo, storeBillRepo, missingReceiptRepo, errorRecordRepo,
    receivedReceiptRepo, dailyReceiptRepo, billMatchLogRepo,
    pendingReviewRepo, monthlyDataRepo, stageJobRepo,
  } = deps;

  app.get('/api/monthly/workspaces', ...read, (req, res) => {
    const mode = String(req.query.mode || 'production').trim().toLowerCase();
    res.json({ workspaces: workspaceService.list({ mode }), mode });
  });

  app.post('/api/monthly/workspaces', ...intake, (req, res) => {
    try {
      const { workspaceKey } = req.body || {};
      const ws = workspaceService.open({ workspaceKey, operator: req.user?.username });
      res.json({ workspace: ws });
    } catch (error) {
      res.status(400).json({ error: error?.message || 'open failed' });
    }
  });

  app.post('/api/monthly/workspaces/:workspaceKey/lock', ...finalReview, (req, res) => {
    return res.status(410).json(ENDPOINT_REMOVED_RESPONSE);
  });

  app.post('/api/monthly/workspaces/:workspaceKey/unlock', ...admin, (req, res) => {
    return res.status(410).json(ENDPOINT_REMOVED_RESPONSE);
  });

  if (workspaceResetService) {
    app.post('/api/monthly/workspaces/:workspaceKey/clear', ...admin, async (req, res) => {
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        const result = await workspaceResetService.clearWorkspace({
          workspaceKey,
          confirmWorkspaceKey: req.body?.confirmWorkspaceKey,
          operator: req.user?.username || null,
        });
        res.json(result);
      } catch (error) {
        res.status(error?.statusCode || 500).json({
          error: error?.message || 'clear failed',
          code: error?.code || undefined,
          running: error?.running || undefined,
        });
      }
    });
  }

  if (monthlySeedService) {
    app.post('/api/monthly/workspaces/:workspaceKey/seed', ...admin, async (req, res) => {
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        const result = await monthlySeedService.seedWorkspace({
          workspaceKey,
          scenario: req.body?.scenario,
          reset: req.body?.reset !== false,
          count: req.body?.count,
          operator: req.user?.username || null,
        });
        res.json(result);
      } catch (error) {
        res.status(error?.statusCode || 500).json({
          error: error?.message || 'seed failed',
          code: error?.code || undefined,
        });
      }
    });
  }

  if (monthlyHealthCheckService) {
    app.post('/api/monthly/workspaces/:workspaceKey/health-check', ...read, (req, res) => {
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        res.json(monthlyHealthCheckService.checkWorkspace({ workspaceKey }));
      } catch (error) {
        res.status(error?.statusCode || 404).json({
          error: error?.message || 'health check failed',
          code: error?.code || undefined,
        });
      }
    });

    app.get('/api/monthly/workspaces/:workspaceKey/health-check.csv', ...read, (req, res) => {
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        const csv = monthlyHealthCheckService.checkWorkspaceCsv({ workspaceKey });
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader(
          'content-disposition',
          `attachment; filename="${workspaceKey}-health-check.csv"`
        );
        res.send(csv);
      } catch (error) {
        res.status(error?.statusCode || 404).json({
          error: error?.message || 'health check csv failed',
          code: error?.code || undefined,
        });
      }
    });
  }

  app.get('/api/monthly/workspaces/:workspaceKey/overview', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);

    // 月份还没创建(但 key 是合法的 YYYY-MM)是**正常空态**,不是错误。
    // 否则当月第一次进来(workspace 未 open)整页会报 404,连切月份都做不到。
    // 这里返回 exists:false + 空 counts,让前端渲染"本月待创建"引导卡 + 月份切换器。
    let parsed = null;
    try {
      parsed = workspaceService.parseKey(workspaceKey);
    } catch (parseError) {
      return res.status(400).json({ error: parseError?.message || 'invalid workspaceKey' });
    }
    const existingWorkspace = workspaceService.list({ mode: 'all' })
      .find((w) => String(w.workspaceKey) === parsed.key);
    if (!existingWorkspace) {
      return res.json({
        workspace: null,
        exists: false,
        isTestMode: parsed.isDemo,
        counts: {},
      });
    }

    try {
      const workspace = existingWorkspace;
      const isTestMode = workspaceService.isTestWorkspace(workspace.workspaceKey);
      const queryWorkspaceKey = workspace.workspaceKey;
      const counts = {
        groupCodes: groupCodeRepo.countByWorkspace(queryWorkspaceKey),
        storeBills: storeBillRepo.countByWorkspace(queryWorkspaceKey),
        storeBillsByFamily: storeBillRepo.countByFamily(queryWorkspaceKey),
        missingReceipts: missingReceiptRepo.countByWorkspace(queryWorkspaceKey),
        missingByStatus: missingReceiptRepo.countByStatus(queryWorkspaceKey),
        errorsByType: errorRecordRepo.countByType(queryWorkspaceKey),
      };
      if (receivedReceiptRepo) {
        counts.receivedReceipts = receivedReceiptRepo.countByWorkspace(queryWorkspaceKey);
      }
      if (dailyReceiptRepo) {
        counts.dailyReceipts = dailyReceiptRepo.countByWorkspace(queryWorkspaceKey);
        counts.dailyByMode = dailyReceiptRepo.countByMode(queryWorkspaceKey);
        counts.dailyByMatchStatus = dailyReceiptRepo.countByMatchStatus(queryWorkspaceKey);
        if (typeof dailyReceiptRepo.countByLedgerStatus === 'function') {
          counts.ledgerByStatus = dailyReceiptRepo.countByLedgerStatus({ workspaceKey: queryWorkspaceKey });
        }
      }
      if (billMatchLogRepo) {
        counts.billMatchLogs = billMatchLogRepo.countByWorkspace(queryWorkspaceKey);
        counts.billMatchByStatus = billMatchLogRepo.countByStatus(queryWorkspaceKey);
      }
      if (monthlyDataRepo) {
        counts.monthlyData = monthlyDataRepo.countByWorkspace(queryWorkspaceKey);
        counts.monthlyByMode = monthlyDataRepo.countByMode(queryWorkspaceKey);
      }
      if (pendingReviewRepo) {
        counts.pendingReviewOpen = pendingReviewRepo.countOpen(queryWorkspaceKey);
        counts.pendingByReason = pendingReviewRepo.countByReason(queryWorkspaceKey);
      }
      if (stageJobRepo) {
        counts.stageJobsRecent = stageJobRepo.listRecent({ workspaceKey: queryWorkspaceKey, limit: 20 });
        counts.stageJobsRunning = stageJobRepo.listRecent({
          workspaceKey: queryWorkspaceKey, status: 'running', limit: 10,
        });
      }
      res.json({ workspace, exists: true, counts, isTestMode });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'overview failed' });
    }
  });
}

module.exports = { registerWorkspaceRoutes };
