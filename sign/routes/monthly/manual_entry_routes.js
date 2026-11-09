'use strict';

/**
 * manual_entry_routes — 手动无图录入 (Sprint E E0a; F2 硬化)
 *
 * POST /api/monthly/workspaces/:workspaceKey/manual-entries
 *
 * 鉴权: intake (admin / reviewer)
 *
 * F2: 端点始终注册;当 manualEntryService 未注入时返回 503
 * 而非让路由消失(避免客户端拿到 404 误以为不支持手动录入)。
 */

const { workspaceKeyFromReq, sendRouteError, serviceUnavailable } = require('./route_utils');

function registerManualEntryRoutes({ app, guards, deps }) {
  const { intake } = guards;

  app.post('/api/monthly/workspaces/:workspaceKey/manual-entries', ...intake, (req, res) => {
    const { manualEntryService } = deps;
    if (!manualEntryService) {
      return serviceUnavailable(res, 'manual_entry_service');
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const body = req.body || {};
      const result = manualEntryService.createEntry({
        workspaceKey,
        mode: body.mode,
        customerNo: body.customerNo,
        customerName: body.customerName,
        passportNo: body.passportNo || null,
        purchaseDate: body.purchaseDate,
        grossKrw: body.grossKrw,
        deductKrw: body.deductKrw ?? 0,
        exchangeRate: body.exchangeRate,
        remark: body.remark || null,
        operator: req.user?.username || 'system',
      });
      // A3(2026-07-16 同步一致性审计):手工补录插台账此前不标脏 → 新行不进派生/月度。
      // 从 tour_match 起重算(失败不拦录入,ensureFresh 兜底)。
      try { deps.derivationRecomputeService?.markDirty(workspaceKey, 'tour_match'); } catch { /* noop */ }
      return res.status(201).json(result);
    } catch (error) {
      if (error?.code === 'validation_failed') {
        return res.status(400).json({
          error: error.message,
          code: error.code,
          errors: error.errors || [],
        });
      }
      if (error?.code === 'exchange_rate_missing') {
        return res.status(422).json({ error: error.message, code: error.code });
      }
      if (error?.code === 'target_row_hash_collision') {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      return sendRouteError(res, error, 'manual entry failed');
    }
  });
}

module.exports = { registerManualEntryRoutes };
