'use strict';

const { ensureWorkspaceWritable, sendRouteError } = require('./route_utils');

/**
 * batch_operations_routes — 批量操作 API（Sprint 2 W4）。
 *
 * POST /api/monthly/workspaces/:workspaceKey/batch/resolve-pending
 *   批量解决 pending_review
 *   Body: { ids: string[], resolution: 'accept' | 'reject' | 'skip' }
 *
 * POST /api/monthly/workspaces/:workspaceKey/batch/delete-daily
 *   批量删除 daily_receipt_export
 *   Body: { ids: string[] }
 *
 * POST /api/monthly/workspaces/:workspaceKey/batch/delete-bill
 *   批量删除 store_bill
 *   Body: { ids: string[] }
 *
 * POST /api/monthly/workspaces/:workspaceKey/batch/update-daily
 *   批量更新 daily_receipt_export
 *   Body: { ids: string[], updates: { modeFolder?: string, ... } }
 *
 * POST /api/monthly/workspaces/:workspaceKey/batch/mark-badcase-handled
 *   批量标记 match_badcase 为已处理
 *   Body: { ids: string[] }
 *
 * 所有端点需要 admin 或 reviewer 角色。
 */

function createBatchOperationsRoutes({ batchOperationsService, workspaceService, auth }) {
  if (!batchOperationsService) {
    throw new Error('batch_operations_routes: batchOperationsService required');
  }

  const { authenticateToken, requireRole } = auth || {};
  const protect = authenticateToken ? [authenticateToken] : [];

  function roleGuard(roles) {
    if (requireRole) return requireRole(...roles);
    return (req, res, next) => {
      if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({ error: `Forbidden: requires one of [${roles.join(', ')}]` });
      }
      next();
    };
  }

  function register(app) {
    // 批量解决 pending_review
    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/resolve-pending',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids, resolution } = req.body;
        const operator = req.user?.username || 'system';

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }
        if (!['accept', 'reject', 'skip'].includes(resolution)) {
          return res.status(400).json({ error: 'resolution must be accept, reject, or skip' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchResolvePendingReview({
            workspaceKey,
            ids,
            resolution,
            operator,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] resolve-pending failed:', error);
          sendRouteError(res, error, 'Batch resolve failed');
        }
      }
    );

    // 批量删除 daily_receipt_export
    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/delete-daily',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchDeleteDailyReceipt({
            workspaceKey,
            ids,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] delete-daily failed:', error);
          sendRouteError(res, error, 'Batch delete failed');
        }
      }
    );

    // 批量删除 store_bill
    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/delete-bill',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchDeleteStoreBill({
            workspaceKey,
            ids,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] delete-bill failed:', error);
          sendRouteError(res, error, 'Batch delete failed');
        }
      }
    );

    // 批量更新 daily_receipt_export
    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/delete-group-codes',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchDeleteGroupCodes({
            workspaceKey,
            ids,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] delete-group-codes failed:', error);
          sendRouteError(res, error, 'Batch delete failed');
        }
      }
    );

    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/delete-received-receipts',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchDeleteReceivedReceipts({
            workspaceKey,
            ids,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] delete-received-receipts failed:', error);
          sendRouteError(res, error, 'Batch delete failed');
        }
      }
    );

    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/delete-missing',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchDeleteMissingReceipts({
            workspaceKey,
            ids,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] delete-missing failed:', error);
          sendRouteError(res, error, 'Batch delete failed');
        }
      }
    );

    // 鎵归噺鏇存柊 daily_receipt_export
    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/update-daily',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids, updates } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }
        if (!updates || typeof updates !== 'object') {
          return res.status(400).json({ error: 'updates object required' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchUpdateDailyReceipt({
            workspaceKey,
            ids,
            updates,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] update-daily failed:', error);
          sendRouteError(res, error, 'Batch update failed');
        }
      }
    );

    // 批量标记 match_badcase 为已处理
    app.post(
      '/api/monthly/workspaces/:workspaceKey/batch/mark-badcase-handled',
      ...protect,
      roleGuard(['admin']),
      async (req, res) => {
        const { workspaceKey } = req.params;
        const { ids } = req.body;
        const operator = req.user?.username || 'system';

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'ids array required' });
        }

        try {
          ensureWorkspaceWritable({ workspaceService, workspaceKey });
          const result = await batchOperationsService.batchMarkBadcaseHandled({
            workspaceKey,
            ids,
            operator,
          });
          res.json(result);
        } catch (error) {
          console.error('[batch_operations] mark-badcase-handled failed:', error);
          sendRouteError(res, error, 'Batch mark failed');
        }
      }
    );
  }

  return { register };
}

module.exports = { createBatchOperationsRoutes };
