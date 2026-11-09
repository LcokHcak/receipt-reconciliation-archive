'use strict';

/**
 * @typedef {{
 *   workspaceKey: string,
 *   year: number,
 *   month: number,
 *   status: 'open' | 'locked' | 'archived',
 *   createdAt: string,
 *   updatedAt: string,
 *   lockedAt?: string | null,
 *   lockedBy?: string | null,
 *   metadata?: unknown,
 * }} MonthlyWorkspaceRecord
 */

function createMonthlyWorkspaceRepository({ db }) {
  if (!db) throw new Error('db is required');

  const upsertStmt = db.prepare(`
    INSERT INTO monthly_workspace (
      workspace_key, year, month, status, created_at, updated_at, locked_at, locked_by, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_key) DO UPDATE SET
      year = excluded.year,
      month = excluded.month,
      status = excluded.status,
      updated_at = excluded.updated_at,
      locked_at = excluded.locked_at,
      locked_by = excluded.locked_by,
      metadata = excluded.metadata
  `);
  const getStmt = db.prepare(`SELECT * FROM monthly_workspace WHERE workspace_key = ?`);
  const listStmt = db.prepare(`SELECT * FROM monthly_workspace ORDER BY workspace_key DESC`);
  const listProductionStmt = db.prepare(`
    SELECT * FROM monthly_workspace
    WHERE workspace_key NOT LIKE 'demo-%'
    ORDER BY workspace_key DESC
  `);
  const listTestStmt = db.prepare(`
    SELECT * FROM monthly_workspace
    WHERE workspace_key LIKE 'demo-%'
    ORDER BY workspace_key DESC
  `);
  const updateStatusStmt = db.prepare(`
    UPDATE monthly_workspace
    SET status = ?, updated_at = ?, locked_at = ?, locked_by = ?
    WHERE workspace_key = ?
  `);
  const updateDeductConfirmedStmt = db.prepare(`
    UPDATE monthly_workspace
    SET deduct_config_confirmed_at = ?, updated_at = ?
    WHERE workspace_key = ?
  `);
  const updateModeMappingConfirmedStmt = db.prepare(`
    UPDATE monthly_workspace
    SET mode_mapping_confirmed_at = ?, updated_at = ?
    WHERE workspace_key = ?
  `);
  const setDirtyFromStmt = db.prepare(`
    UPDATE monthly_workspace
    SET derivation_dirty_from = ?, updated_at = ?
    WHERE workspace_key = ?
  `);
  const getDirtyFromStmt = db.prepare(`
    SELECT derivation_dirty_from AS dirtyFrom FROM monthly_workspace WHERE workspace_key = ?
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      workspaceKey: row.workspace_key,
      year: row.year,
      month: row.month,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lockedAt: row.locked_at || null,
      lockedBy: row.locked_by || null,
      deductConfigConfirmedAt: row.deduct_config_confirmed_at || null,
      modeMappingConfirmedAt: row.mode_mapping_confirmed_at || null,
      derivationDirtyFrom: row.derivation_dirty_from || null,
      metadata: row.metadata ? safeJson(row.metadata) : null,
    };
  }

  return {
    upsert({ workspaceKey, year, month, status, createdAt, updatedAt, lockedAt = null, lockedBy = null, metadata = null }) {
      upsertStmt.run(
        workspaceKey,
        year,
        month,
        status,
        createdAt,
        updatedAt,
        lockedAt,
        lockedBy,
        metadata == null ? null : JSON.stringify(metadata)
      );
      return this.findByKey(workspaceKey);
    },
    findByKey(workspaceKey) {
      return mapRow(getStmt.get(workspaceKey));
    },
    list() {
      return listStmt.all().map(mapRow);
    },
    listProduction() {
      return listProductionStmt.all().map(mapRow);
    },
    listTest() {
      return listTestStmt.all().map(mapRow);
    },
    updateStatus({ workspaceKey, status, updatedAt, lockedAt = null, lockedBy = null }) {
      updateStatusStmt.run(status, updatedAt, lockedAt, lockedBy, workspaceKey);
      return this.findByKey(workspaceKey);
    },
    updateDeductConfigConfirmedAt({ workspaceKey, confirmedAt, updatedAt }) {
      updateDeductConfirmedStmt.run(confirmedAt || null, updatedAt, workspaceKey);
      return this.findByKey(workspaceKey);
    },
    updateModeMappingConfirmedAt({ workspaceKey, confirmedAt, updatedAt }) {
      updateModeMappingConfirmedStmt.run(confirmedAt || null, updatedAt, workspaceKey);
      return this.findByKey(workspaceKey);
    },
    // 派生脏标记(原始列存取;状态机逻辑在 derivation_state_service)
    getDerivationDirtyFrom(workspaceKey) {
      return getDirtyFromStmt.get(workspaceKey)?.dirtyFrom || null;
    },
    setDerivationDirtyFrom({ workspaceKey, dirtyFrom }) {
      setDirtyFromStmt.run(dirtyFrom || null, new Date().toISOString(), workspaceKey);
      return dirtyFrom || null;
    },
  };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = {
  createMonthlyWorkspaceRepository,
};
