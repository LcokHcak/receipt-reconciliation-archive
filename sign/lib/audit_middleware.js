'use strict';

/**
 * audit_middleware — Express 中间件，自动记录审计日志（Sprint 2 W4）。
 *
 * 拦截关键路由，提取操作信息并写入 audit_log：
 *   - POST /api/auth/login → action: 'login'
 *   - POST /api/auth/logout → action: 'logout'
 *   - POST /api/monthly/.../import/daily → action: 'import_daily'
 *   - POST /api/monthly/.../import/bill → action: 'import_bill'
 *   - POST /api/monthly/.../import/group-code → action: 'import_group_code'
 *   - POST /api/monthly/.../stages/tour-match → action: 'run_tour_match'
 *   - POST /api/monthly/.../stages/bill-match → action: 'run_bill_match'
 *   - POST /api/monthly/.../stages/merge → action: 'run_merge'
 *   - POST /api/monthly/.../stages/second-pass → action: 'run_second_pass'
 *   - POST /api/monthly/.../pending-review/:id/resolve → action: 'resolve_pending_review'
 *   - POST /api/monthly/.../export → action: 'export_monthly'
 *
 * 使用方式：
 *   app.use(createAuditMiddleware({ auditLogRepo }));
 *   // 在所有路由注册之后调用，确保能捕获响应
 */

function createAuditMiddleware({ auditLogRepo }) {
  if (!auditLogRepo) {
    throw new Error('audit_middleware: auditLogRepo required');
  }

  const actionMap = [
    { method: 'POST', pattern: /^\/api\/auth\/login$/, action: 'login', resourceType: 'auth' },
    { method: 'POST', pattern: /^\/api\/auth\/logout$/, action: 'logout', resourceType: 'auth' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/imports\/daily-receipt$/, action: 'import_daily', resourceType: 'daily_receipt' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/imports\/store-bill$/, action: 'import_bill', resourceType: 'store_bill' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/imports\/group-code$/, action: 'import_group_code', resourceType: 'group_code' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/imports\/received-receipt$/, action: 'import_received_receipt', resourceType: 'received_receipt' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/stages\/tour-match$/, action: 'run_tour_match', resourceType: 'stage_job' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/stages\/bill-match$/, action: 'run_bill_match', resourceType: 'stage_job' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/stages\/merge$/, action: 'run_merge', resourceType: 'stage_job' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/stages\/second-pass$/, action: 'run_second_pass', resourceType: 'stage_job' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/pending-reviews\/([^/]+)\/resolve$/, action: 'resolve_pending_review', resourceType: 'pending_review' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/exports\/monthly-data$/, action: 'export_monthly', resourceType: 'monthly_data' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/ledger\/publish$/, action: 'publish_ledger', resourceType: 'daily_receipt' },
    { method: 'PATCH', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/ledger\/([^/]+)\/fields$/, action: 'update_ledger_fields', resourceType: 'daily_receipt' },
    { method: 'DELETE', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/ledger\/([^/]+)$/, action: 'delete_ledger_row', resourceType: 'daily_receipt' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/lock$/, action: 'lock_workspace', resourceType: 'monthly_workspace' },
    // G8-fix(G3): admin-only unlock,补 audit
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/unlock$/, action: 'unlock_workspace', resourceType: 'monthly_workspace' },
    // D4a additions — previously uncovered routes
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/ledger\/([^/]+)\/status$/, action: 'update_ledger_status', resourceType: 'daily_receipt' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces$/, action: 'create_workspace', resourceType: 'monthly_workspace' },
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/clear$/, action: 'clear_workspace', resourceType: 'monthly_workspace' },
    { method: 'PUT', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/deduct-config$/, action: 'update_deduct_config', resourceType: 'monthly_workspace' },
    { method: 'PUT', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/mode-mapping$/, action: 'update_mode_mapping', resourceType: 'monthly_workspace' },
    // E0a: manual no-image entry
    { method: 'POST', pattern: /^\/api\/monthly\/workspaces\/([^/]+)\/manual-entries$/, action: 'create_manual_entry', resourceType: 'daily_receipt' },
    // 批次导出留痕(P1,2026-07-18):这些路由组1是 batchId 不是 workspaceKey,
    // 用 groups 显式指定落位(默认 {workspaceKey:1, resourceId:2} 保持既有条目行为)。
    // 今日导出计数/导出历史都从这里查(resource_type='batch', action in export_*)。
    // 台账侧订正(2026-07-21):admin 撤销已结算组台账,必须留审计(快照另存组 meta.ledgerCorrections)
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/source-groups\/([^/]+)\/ledger-correction$/, action: 'ledger_correction', resourceType: 'daily_receipt', groups: { workspaceKey: null, resourceId: 1 } },
    // 结算/确认渠道模式/组通过留痕(8模块审计 HIGH:全链路零 audit_log,无法回答"谁在何时把哪组结进台账")。
    // 组1=batchId 落 resourceId(照 ledger-correction/export_batch 先例);groupKey 在 details.path 里可溯。
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/source-groups\/([^/]+)\/settle$/, action: 'settle_group', resourceType: 'daily_receipt', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/source-groups\/([^/]+)\/confirm-modes$/, action: 'confirm_group_modes', resourceType: 'daily_receipt', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/source-groups\/([^/]+)\/approve$/, action: 'approve_group', resourceType: 'daily_receipt', groups: { workspaceKey: null, resourceId: 1 } },
    // 整批删除留痕(8模块审计 HIGH 姊妹条):删批次带走台账证据图,必须可回溯谁删的。
    { method: 'DELETE', pattern: /^\/api\/batches\/([^/]+)$/, action: 'delete_batch', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/export$/, action: 'export_batch', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/export-customer-data$/, action: 'export_delivery', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/export-hyundai-delivery$/, action: 'export_delivery', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/export-lotte-dept-delivery$/, action: 'export_delivery', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'POST', pattern: /^\/api\/batches\/([^/]+)\/export-mode-delivery$/, action: 'export_delivery', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    // 客户数据Excel下载留痕(审计MEDIUM):含全量姓名+护照号的 Excel,此前零审计——谁在何时导过查不到。
    // workspace/batch 在 query 不在 path,用 queryKeys 把范围记进 details.query。
    { method: 'GET', pattern: /^\/api\/monthly\/library-export\/download$/, action: 'export_library_excel', resourceType: 'library_excel', queryKeys: ['workspaceKey', 'batchId'] },
    // 删除动作留痕(审计MEDIUM):删票/删客户组/删客户/删图/整库删/库清理批量物理删——此前全部零审计,
    // 谁在何时删了什么无从追查(生产 force:true 恒物理删,连软删墓碑都没有)。批次侧组1=batchId 落 resourceId。
    { method: 'DELETE', pattern: /^\/api\/batches\/([^/]+)\/tasks\/([^/]+)$/, action: 'delete_task', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'DELETE', pattern: /^\/api\/batches\/([^/]+)\/source-groups\/([^/]+)\/customer$/, action: 'delete_customer_group', resourceType: 'batch', groups: { workspaceKey: null, resourceId: 1 } },
    { method: 'DELETE', pattern: /^\/api\/customer-library\/workspaces\/([^/]+)$/, action: 'delete_workspace_library', resourceType: 'customer_library' },
    { method: 'DELETE', pattern: /^\/api\/customer-library\/workspaces\/([^/]+)\/customers\/([^/]+)$/, action: 'delete_customer', resourceType: 'customer_library' },
    { method: 'DELETE', pattern: /^\/api\/customer-library\/workspaces\/([^/]+)\/customers\/([^/]+)\/images\/([^/]+)$/, action: 'delete_customer_image', resourceType: 'customer_library' },
    { method: 'POST', pattern: /^\/api\/customer-library\/cleanup\/delete$/, action: 'cleanup_orphans', resourceType: 'customer_library' },
  ];

  return (req, res, next) => {
    const originalSend = res.send;
    const originalJson = res.json;

    const match = actionMap.find((m) => m.method === req.method && m.pattern.test(req.path));
    if (!match) {
      return next();
    }

    const patternMatch = req.path.match(match.pattern);
    // 组号落位:默认 组1=workspaceKey/组2=resourceId(月度路由约定);
    // 批次路由组1是 batchId,由条目的 groups 显式改写落位。
    const groups = match.groups || { workspaceKey: 1, resourceId: 2 };
    const pickGroup = (index) => (index && patternMatch && patternMatch[index] ? patternMatch[index] : null);
    const workspaceKey = pickGroup(groups.workspaceKey);
    const resourceId = pickGroup(groups.resourceId);

    const ipAddress = req.ip || req.connection?.remoteAddress || null;
    const userAgent = req.get('user-agent') || null;
    let logged = false;

    // Intercept response to log only on success (2xx status)
    const logAudit = () => {
      if (logged) return;
      logged = true;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // 范围在 query 不在 path 的路由(如客户数据Excel下载):把指定 query 键记进 details.query,
        // 让审计能回答"导的是哪个工作区/批次的 PII"。
        const queryScope = {};
        if (Array.isArray(match.queryKeys)) {
          for (const k of match.queryKeys) {
            const v = req.query?.[k];
            if (v != null && String(v) !== '') queryScope[k] = String(v);
          }
        }
        try {
          auditLogRepo.log({
            workspaceKey: workspaceKey || queryScope.workspaceKey || null,
            // req.user 必须在响应时才读:鉴权是路由级中间件,本中间件全局挂载在
            // 路由之前,请求进入时 req.user 还没填——早读=所有条目记 anonymous
            // (2026-07-19 P1 真机验证实锤,月度路由既有同病一并治好)。
            userId: req.user?.username || 'anonymous',
            action: match.action,
            resourceType: match.resourceType,
            resourceId,
            details: {
              method: req.method,
              path: req.path,
              statusCode: res.statusCode,
              ...(Object.keys(queryScope).length ? { query: queryScope } : {}),
            },
            ipAddress,
            userAgent,
          });
        } catch (error) {
          // 审计日志失败不应阻断主流程
          console.error('[audit_middleware] Failed to log audit:', error);
        }
      }
    };

    res.send = function (body) {
      logAudit();
      return originalSend.call(this, body);
    };

    res.json = function (body) {
      logAudit();
      return originalJson.call(this, body);
    };

    // res.download/sendFile 走流式响应,不经过 send/json——挂 finish 事件兜底,
    // 否则 4 个交付包导出(zip 下载)永远不留审计(logAudit 幂等,双挂无重复)。
    res.on('finish', logAudit);
    // 客户端中途取消下载只触发 close 不触发 finish——导出动作已经发生,必须留痕
    // (2026-07-19 全链路审计;logAudit 幂等,三挂也只记一笔)。
    res.on('close', logAudit);

    next();
  };
}

module.exports = { createAuditMiddleware };
