'use strict';

/**
 * agent_workspace_routes — 代理工作台 API(V2 Task 8,前缀 /api/agent-workspace/v1)。
 *
 * 权限:读 = admin/finance/reviewer(reviewer 由 service 层强制收窄到自己 owner);
 *      完成任务 = admin/reviewer(finance 只读,路由层直接 403,service 层再兜一道)。
 * 维护端点(重建投影)不走 HTTP,只有 CLI(scripts/rebuild_agent_workspace_projection.js)。
 */

const { forwardAsync } = require('../services/handlers/workbench/handler_utils');
const {
  authenticateToken: createAuthenticateToken,
  requireRole: defaultRequireRole,
} = require('../lib/auth/jwt_middleware');

// 兼容两种 auth 形状(照 admin_routes 先例):
//   - 原始配置 {jwtSecret, userService}(workbench_server 的 buildAuthConfig 产物)
//   - 已构造的中间件对象 {authenticateToken(中间件实例), requireRole}
function resolveTokenMiddleware(auth = {}) {
  if (typeof auth.authenticateToken === 'function') {
    return auth.authenticateToken.length >= 3
      ? auth.authenticateToken
      : auth.authenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  if (auth.jwtSecret) {
    return createAuthenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  return null;
}

function createRouteProtector(auth) {
  if (!auth) return () => []; // SIGN_ENABLE_AUTH=false 的开发模式:与全站一致不设防
  const tokenMiddleware = resolveTokenMiddleware(auth);
  const roleGuard = auth.requireRole || defaultRequireRole;
  if (!tokenMiddleware) {
    // fail-closed:开了认证却装配不出中间件,宁可启动失败也不裸奔
    throw new Error('agent_workspace_routes: auth 已启用但无法构造鉴权中间件');
  }
  return (...roles) => [tokenMiddleware, roleGuard(...roles)];
}

function registerAgentWorkspaceRoutes({ app, auth = null, agentWorkspaceService, agentUnreceivedService = null }) {
  if (!agentWorkspaceService) throw new Error('agentWorkspaceService is required');
  const protect = createRouteProtector(auth);
  const read = protect('admin', 'finance', 'reviewer');
  const act = protect('admin', 'reviewer'); // finance 只读

  const base = '/api/agent-workspace/v1';

  app.get(`${base}/months`, ...read, forwardAsync(async (req, res) => {
    res.json({ ok: true, months: agentWorkspaceService.listMonths() });
  }));

  app.get(`${base}/summary`, ...read, forwardAsync(async (req, res) => {
    res.json({ ok: true, ...agentWorkspaceService.getSummary(req.user, req.query) });
  }));

  app.get(`${base}/agents`, ...read, forwardAsync(async (req, res) => {
    res.json({ ok: true, ...agentWorkspaceService.listAgents(req.user, req.query) });
  }));

  app.get(`${base}/customers`, ...read, forwardAsync(async (req, res) => {
    res.json({ ok: true, ...agentWorkspaceService.listCustomers(req.user, req.query) });
  }));

  app.get(`${base}/tasks`, ...read, forwardAsync(async (req, res) => {
    res.json({ ok: true, ...agentWorkspaceService.listTasks(req.user, req.query) });
  }));

  app.post(`${base}/tasks/:id/complete`, ...act, forwardAsync(async (req, res) => {
    const result = agentWorkspaceService.completeTask(req.user, req.params.id, {
      note: req.body?.note,
      expectedVersion: req.body?.expectedVersion,
    });
    res.json({ ok: true, ...result });
  }));

  // ── B 页:未收客户组(P2,2026-07-16)。全员可读(拍板⑦:未收数据按代理分,不属于操作员) ──
  if (agentUnreceivedService) {
    app.get(`${base}/unreceived/workspaces`, ...read, forwardAsync(async (req, res) => {
      res.json({ ok: true, workspaces: agentUnreceivedService.listWorkspaces() });
    }));

    app.get(`${base}/unreceived`, ...read, forwardAsync(async (req, res) => {
      const workspaceKey = String(req.query.workspaceKey || '').trim();
      if (!workspaceKey) return res.status(400).json({ ok: false, error: 'workspaceKey required' });
      res.json({
        ok: true,
        ...agentUnreceivedService.buildView({
          workspaceKey,
          search: String(req.query.search || '').slice(0, 60),
          agentKey: String(req.query.agentKey || '').trim(),
        }),
      });
    }));

    // 「无需补」豁免/恢复(P3):写 unreceived_resolution(action='waive'),reviewer 及以上可操作留痕
    app.post(`${base}/unreceived/waive`, ...act, forwardAsync(async (req, res) => {
      const workspaceKey = String(req.body?.workspaceKey || '').trim();
      if (!workspaceKey) return res.status(400).json({ ok: false, error: 'workspaceKey required' });
      const result = agentUnreceivedService.waiveItems({
        workspaceKey,
        items: Array.isArray(req.body?.items) ? req.body.items : [],
        note: String(req.body?.note || ''),
        by: req.user?.username || null,
      });
      res.json({ ok: true, ...result });
    }));

    app.post(`${base}/unreceived/unwaive`, ...act, forwardAsync(async (req, res) => {
      const workspaceKey = String(req.body?.workspaceKey || '').trim();
      if (!workspaceKey) return res.status(400).json({ ok: false, error: 'workspaceKey required' });
      const result = agentUnreceivedService.unwaiveItems({
        workspaceKey,
        itemKeys: Array.isArray(req.body?.itemKeys) ? req.body.itemKeys : [],
      });
      res.json({ ok: true, ...result });
    }));

    app.get(`${base}/unreceived/export`, ...read, forwardAsync(async (req, res) => {
      const workspaceKey = String(req.query.workspaceKey || '').trim();
      if (!workspaceKey) return res.status(400).json({ ok: false, error: 'workspaceKey required' });
      const { workbook } = agentUnreceivedService.buildWorkbook({ workspaceKey });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`未收清单_${workspaceKey}.xlsx`)}`,
      );
      await workbook.xlsx.write(res);
      res.end();
    }));
  }
}

module.exports = { registerAgentWorkspaceRoutes };
