'use strict';

const { workspaceKeyFromReq, sendRouteError } = require('./route_utils');

function registerConfigRoutes({ app, guards, deps }) {
  const { read, finalReview } = guards;
  const { modeConfigService, derivationRecomputeService } = deps;
  if (!modeConfigService) return;

  // 扣点变 → 只影响 merge 返点计算;模式映射变 → 影响归桶/tour 起,从 tour 重跑。
  const markDirty = (workspaceKey, stage) => {
    try { derivationRecomputeService?.markDirty(workspaceKey, stage); } catch { /* 标记失败不阻断配置保存 */ }
  };

  app.get('/api/monthly/workspaces/:workspaceKey/deduct-config', ...read, (req, res) => {
    try {
      res.json(toDeductResponse(modeConfigService.getDeductConfig(workspaceKeyFromReq(req))));
    } catch (error) {
      sendRouteError(res, error, 'get deduct config failed', 400);
    }
  });

  app.put('/api/monthly/workspaces/:workspaceKey/deduct-config', ...finalReview, (req, res) => {
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const result = modeConfigService.updateDeductConfig({
        workspaceKey,
        rows: req.body?.rows,
        confirm: Boolean(req.body?.confirm),
        operator: req.user?.username || null,
      });
      markDirty(workspaceKey, 'merge');
      res.json(toDeductResponse(result));
    } catch (error) {
      sendConfigError(res, error, 'update deduct config failed');
    }
  });

  app.post('/api/monthly/workspaces/:workspaceKey/deduct-config/copy-from-previous', ...finalReview, (req, res) => {
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const result = modeConfigService.copyDeductFromPrevious({
        workspaceKey,
        operator: req.user?.username || null,
      });
      markDirty(workspaceKey, 'merge');
      res.json(toDeductResponse(result, { copied: result.copied || 0 }));
    } catch (error) {
      sendConfigError(res, error, 'copy deduct config failed');
    }
  });

  app.get('/api/monthly/workspaces/:workspaceKey/mode-mapping', ...read, (req, res) => {
    try {
      res.json(toMappingResponse(modeConfigService.getModeMapping(workspaceKeyFromReq(req))));
    } catch (error) {
      sendRouteError(res, error, 'get mode mapping failed', 400);
    }
  });

  app.put('/api/monthly/workspaces/:workspaceKey/mode-mapping', ...finalReview, (req, res) => {
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const result = modeConfigService.updateModeMapping({
        workspaceKey,
        mappings: req.body?.mappings,
        confirm: Boolean(req.body?.confirm),
        operator: req.user?.username || null,
      });
      markDirty(workspaceKey, 'tour_match');
      res.json(toMappingResponse(result));
    } catch (error) {
      sendConfigError(res, error, 'update mode mapping failed');
    }
  });

  app.post('/api/monthly/workspaces/:workspaceKey/mode-mapping/copy-from-previous', ...finalReview, (req, res) => {
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const result = modeConfigService.copyModeMappingFromPrevious({
        workspaceKey,
        operator: req.user?.username || null,
      });
      markDirty(workspaceKey, 'tour_match');
      res.json(toMappingResponse(result, { copied: result.copied || 0 }));
    } catch (error) {
      sendConfigError(res, error, 'copy mode mapping failed');
    }
  });
}

function toDeductResponse(result, extra = {}) {
  return {
    workspaceKey: result.workspaceKey,
    isTestMode: result.isTestMode,
    confirmed_at: result.confirmedAt || null,
    rows: result.rows.map((row) => ({
      mode_folder: row.modeFolder,
      deduct_value: row.deductValue == null ? null : row.deductValue,
      updated_at: row.updatedAt || null,
      updated_by: row.updatedBy || null,
    })),
    ...extra,
  };
}

function toMappingResponse(result, extra = {}) {
  return {
    workspaceKey: result.workspaceKey,
    isTestMode: result.isTestMode,
    confirmed_at: result.confirmedAt || null,
    items: result.items.map((row) => ({
      mode_raw: row.modeRaw,
      mode_folder: row.modeFolder || null,
      created_by: row.createdBy || null,
      updated_at: row.updatedAt || null,
    })),
    unmapped: result.unmapped || [],
    dailyRowsRefreshed: result.dailyRowsRefreshed || 0,
    dailyRowsRefreshStats: result.dailyRowsRefreshStats || undefined,
    ...extra,
  };
}

function sendConfigError(res, error, fallbackMessage) {
  if (error?.code === 'MODE_CONFIG_INVALID') {
    return res.status(400).json({
      error: error.message || fallbackMessage,
      code: 'mode_config_invalid',
      reason: error.reason || null,
      details: error.details || {},
    });
  }
  return sendRouteError(res, error, fallbackMessage, 400);
}

module.exports = { registerConfigRoutes };
