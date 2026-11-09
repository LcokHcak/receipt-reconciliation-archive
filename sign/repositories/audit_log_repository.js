'use strict';

/**
 * audit_log_repository — 审计日志持久化（Sprint 2 W4）。
 *
 * 记录关键操作：
 *   - 用户登录/登出
 *   - 数据导入（daily/bill/group_code）
 *   - 阶段执行（tour_match/bill_match/merge/second_pass）
 *   - pending_review 解决
 *   - 数据导出
 *   - 配置修改
 *
 * Schema:
 *   id INTEGER PRIMARY KEY
 *   workspace_key TEXT
 *   user_id TEXT (username or 'system')
 *   action TEXT (login, import_daily, run_tour_match, resolve_pending, export_monthly, etc.)
 *   resource_type TEXT (workspace, daily_receipt, store_bill, pending_review, stage_job, etc.)
 *   resource_id TEXT (可选，关联的资源 ID)
 *   details TEXT (JSON，操作详情)
 *   ip_address TEXT
 *   user_agent TEXT
 *   created_at TEXT (ISO 8601)
 *
 * 索引：
 *   - workspace_key + created_at (按工作区查询)
 *   - user_id + created_at (按用户查询)
 *   - action + created_at (按操作类型查询)
 */

function createAuditLogRepository({ db }) {
  if (!db) throw new Error('audit_log_repository: db required');

  // Per-instance counter: gives every log() call a unique seq so same-second
  // writes from different requests never collide on the UNIQUE constraint.
  let _seq = 0;

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      seq        INTEGER NOT NULL DEFAULT 0,
      workspace_key TEXT,
      user_id    TEXT NOT NULL,
      action     TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      details    TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_key, user_id, action, resource_id, created_at, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_time ON audit_log(workspace_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action_time ON audit_log(action, created_at DESC);
  `;

  db.exec(createTableSQL);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO audit_log (
      seq, workspace_key, user_id, action, resource_type, resource_id,
      details, ip_address, user_agent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function log({
    workspaceKey = null,
    userId,
    action,
    resourceType = null,
    resourceId = null,
    details = null,
    ipAddress = null,
    userAgent = null,
    createdAt = new Date().toISOString(),
  }) {
    if (!userId || !action) {
      throw new Error('audit_log: userId and action required');
    }
    const detailsJson = details ? JSON.stringify(details) : null;
    const info = insertStmt.run(
      ++_seq,
      workspaceKey,
      userId,
      action,
      resourceType,
      resourceId,
      detailsJson,
      ipAddress,
      userAgent,
      createdAt
    );
    return { id: info.lastInsertRowid, changes: info.changes };
  }

  function logMany(entries) {
    db.exec('BEGIN');
    try {
      for (const entry of entries) log(entry);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function list({
    workspaceKey = null,
    userId = null,
    action = null,
    resourceType = null,
    startDate = null,
    endDate = null,
    limit = 100,
    offset = 0,
  }) {
    const conditions = [];
    const params = [];

    if (workspaceKey) {
      conditions.push('workspace_key = ?');
      params.push(workspaceKey);
    }
    if (userId) {
      conditions.push('user_id = ?');
      params.push(userId);
    }
    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (resourceType) {
      conditions.push('resource_type = ?');
      params.push(resourceType);
    }
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT * FROM audit_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => ({
      id: r.id,
      workspaceKey: r.workspace_key,
      userId: r.user_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      details: r.details ? JSON.parse(r.details) : null,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    }));
  }

  function count({
    workspaceKey = null,
    userId = null,
    action = null,
    resourceType = null,
    startDate = null,
    endDate = null,
  }) {
    const conditions = [];
    const params = [];

    if (workspaceKey) {
      conditions.push('workspace_key = ?');
      params.push(workspaceKey);
    }
    if (userId) {
      conditions.push('user_id = ?');
      params.push(userId);
    }
    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (resourceType) {
      conditions.push('resource_type = ?');
      params.push(resourceType);
    }
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as total FROM audit_log ${where}`;
    const row = db.prepare(sql).get(...params);
    return row.total;
  }

  // ── E0c: distinct value queries for filter UI ──────────────────────────────
  function distinctUsers({ workspaceKey = null } = {}) {
    const sql = workspaceKey
      ? `SELECT DISTINCT user_id FROM audit_log WHERE workspace_key = ? AND user_id IS NOT NULL ORDER BY user_id ASC LIMIT 1000`
      : `SELECT DISTINCT user_id FROM audit_log WHERE user_id IS NOT NULL ORDER BY user_id ASC LIMIT 1000`;
    const rows = workspaceKey ? db.prepare(sql).all(workspaceKey) : db.prepare(sql).all();
    return rows.map((r) => r.user_id);
  }

  function distinctActions({ workspaceKey = null } = {}) {
    const sql = workspaceKey
      ? `SELECT DISTINCT action FROM audit_log WHERE workspace_key = ? AND action IS NOT NULL ORDER BY action ASC LIMIT 1000`
      : `SELECT DISTINCT action FROM audit_log WHERE action IS NOT NULL ORDER BY action ASC LIMIT 1000`;
    const rows = workspaceKey ? db.prepare(sql).all(workspaceKey) : db.prepare(sql).all();
    return rows.map((r) => r.action);
  }

  function distinctWorkspaces({ workspaceKey = null } = {}) {
    const sql = workspaceKey
      ? `SELECT DISTINCT workspace_key FROM audit_log WHERE workspace_key = ? AND workspace_key IS NOT NULL ORDER BY workspace_key ASC LIMIT 1000`
      : `SELECT DISTINCT workspace_key FROM audit_log WHERE workspace_key IS NOT NULL ORDER BY workspace_key ASC LIMIT 1000`;
    const rows = workspaceKey ? db.prepare(sql).all(workspaceKey) : db.prepare(sql).all();
    return rows.map((r) => r.workspace_key);
  }

  function distinctResourceTypes({ workspaceKey = null } = {}) {
    const sql = workspaceKey
      ? `SELECT DISTINCT resource_type FROM audit_log WHERE workspace_key = ? AND resource_type IS NOT NULL ORDER BY resource_type ASC LIMIT 1000`
      : `SELECT DISTINCT resource_type FROM audit_log WHERE resource_type IS NOT NULL ORDER BY resource_type ASC LIMIT 1000`;
    const rows = workspaceKey ? db.prepare(sql).all(workspaceKey) : db.prepare(sql).all();
    return rows.map((r) => r.resource_type);
  }

  return { log, logMany, list, count, distinctUsers, distinctActions, distinctWorkspaces, distinctResourceTypes };
}

module.exports = { createAuditLogRepository };
