'use strict';

/**
 * unreceived_resolution_repository (B3)
 *
 * 未收清单「已处理」状态持久化。未收项 = 账单有、台账无,逐张小票;
 * 操作员执行 link / 延期 / 作废后写一行,据此从未收清单中移除(刷新不复活)。
 *
 * item_key 必须与 customer_reconciliation_service.unreceivedItemKey 同口径
 * (normalize 护照|姓名|小票号),否则过滤对不上。
 */

const { runSqliteTransaction } = require('../lib/storage/sqlite_transaction');

// waive=「无需补」(代理视图 B 页,2026-07-17):与 link/delay/void 同表同键——
// 人工标记只有这一张表,不另建第二套。waive 行照常从催收清单(未收清单页/交付包/xlsx)
// 消失;B 页用 includeResolved 标记模式把它显示成灰色留痕行。
const ALLOWED_ACTIONS = new Set(['link', 'delay', 'void', 'waive']);

function createUnreceivedResolutionRepository({ db }) {
  if (!db) throw new Error('unreceived_resolution_repository: db required');

  const upsertStmt = db.prepare(`
    INSERT INTO unreceived_resolution (
      workspace_key, item_key, passport_no, name, receipt_no,
      action, linked_ref, reason, resolved_by, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_key, item_key) DO UPDATE SET
      action      = excluded.action,
      linked_ref  = excluded.linked_ref,
      reason      = excluded.reason,
      resolved_by = excluded.resolved_by,
      resolved_at = excluded.resolved_at,
      passport_no = excluded.passport_no,
      name        = excluded.name,
      receipt_no  = excluded.receipt_no
  `);

  const keysStmt = db.prepare(
    'SELECT item_key FROM unreceived_resolution WHERE workspace_key = ?'
  );

  const listStmt = db.prepare(`
    SELECT id, workspace_key AS workspaceKey, item_key AS itemKey,
           passport_no AS passportNo, name, receipt_no AS receiptNo,
           action, linked_ref AS linkedRef, reason,
           resolved_by AS resolvedBy, resolved_at AS resolvedAt
    FROM unreceived_resolution
    WHERE workspace_key = ?
    ORDER BY resolved_at DESC, id DESC
  `);

  const deleteStmt = db.prepare(
    'DELETE FROM unreceived_resolution WHERE workspace_key = ? AND item_key = ?'
  );

  /**
   * 批量标记未收项为已处理。
   * @param {{ workspaceKey: string, items: Array<{itemKey:string, passportNo?:string,
   *   name?:string, receiptNo?:string}>, action: string, linkedRef?: string|null,
   *   reason?: string|null, resolvedBy?: string|null }} args
   */
  function resolveMany({
    workspaceKey,
    items,
    action,
    linkedRef = null,
    reason = null,
    resolvedBy = null,
  }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    if (!ALLOWED_ACTIONS.has(action)) {
      const err = new Error(`unsupported_action:${action}`);
      err.code = 'unsupported_action';
      throw err;
    }
    if (!Array.isArray(items) || items.length === 0) {
      return { resolved: 0 };
    }
    const at = new Date().toISOString();
    let resolved = 0;
    runSqliteTransaction(
      db,
      () => {
        for (const it of items) {
          if (!it || !it.itemKey) continue;
          upsertStmt.run(
            workspaceKey,
            it.itemKey,
            it.passportNo ?? null,
            it.name ?? null,
            it.receiptNo ?? null,
            action,
            linkedRef,
            reason,
            resolvedBy,
            at
          );
          resolved += 1;
        }
      },
      { savepointName: 'unreceived_resolve', preferSavepoint: true }
    );
    return { resolved };
  }

  /** 已处理 item_key 集合,供 listUnreceived 过滤。 */
  function listKeys(workspaceKey) {
    const set = new Set();
    for (const r of keysStmt.all(workspaceKey)) set.add(r.item_key);
    return set;
  }

  function list(workspaceKey) {
    return listStmt.all(workspaceKey);
  }

  /** 撤销处理(误操作恢复),让该未收项重新出现在清单。 */
  function unresolve({ workspaceKey, itemKey }) {
    if (!workspaceKey || !itemKey) throw new Error('workspaceKey and itemKey required');
    deleteStmt.run(workspaceKey, itemKey);
  }

  return { resolveMany, listKeys, list, unresolve };
}

module.exports = { createUnreceivedResolutionRepository };
