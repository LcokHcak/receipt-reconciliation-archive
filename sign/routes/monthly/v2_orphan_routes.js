'use strict';

/**
 * v2_orphan_routes — 孤立账单 + 孤立行聚合 (Sprint E E0b; F2 硬化)
 *
 * GET /api/monthly/v2/:workspaceKey/orphans/bills
 * GET /api/monthly/v2/:workspaceKey/orphans/rows
 *
 * 只读端点，不触发 audit_middleware。
 * 鉴权: read (admin / reviewer / finance)
 *
 * F2: 端点始终注册;当 orphanAggregationService 未注入时返回 503
 * 而非让路由消失。
 */

const {
  workspaceKeyFromReq,
  clampInt,
  sendRouteError,
  serviceUnavailable,
} = require('./route_utils');

function registerV2OrphanRoutes({ app, guards, deps }) {
  const { read } = guards;

  app.get('/api/monthly/v2/:workspaceKey/orphans/bills', ...read, (req, res) => {
    const { orphanAggregationService } = deps;
    if (!orphanAggregationService) {
      return serviceUnavailable(res, 'orphan_aggregation_service');
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const result = orphanAggregationService.listOrphanBills({
        workspaceKey,
        mode:     req.query.mode     || null,
        dateFrom: req.query.dateFrom || null,
        dateTo:   req.query.dateTo   || null,
        search:   req.query.search   || null,
        limit:    clampInt(req.query.limit,  1, 200, 50),
        offset:   clampInt(req.query.offset, 0, 1_000_000, 0),
      });
      res.json(result);
    } catch (error) {
      sendRouteError(res, error, 'orphan bills query failed');
    }
  });

  app.get('/api/monthly/v2/:workspaceKey/orphans/rows', ...read, (req, res) => {
    const { orphanAggregationService } = deps;
    if (!orphanAggregationService) {
      return serviceUnavailable(res, 'orphan_aggregation_service');
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const result = orphanAggregationService.listOrphanRows({
        workspaceKey,
        mode:     req.query.mode     || null,
        dateFrom: req.query.dateFrom || null,
        dateTo:   req.query.dateTo   || null,
        search:   req.query.search   || null,
        limit:    clampInt(req.query.limit,  1, 200, 50),
        offset:   clampInt(req.query.offset, 0, 1_000_000, 0),
      });
      res.json(result);
    } catch (error) {
      sendRouteError(res, error, 'orphan rows query failed');
    }
  });
}

module.exports = { registerV2OrphanRoutes };
