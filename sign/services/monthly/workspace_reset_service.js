'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseWorkspaceKey } = require('./workspace_service');

const WORKSPACE_TABLES = [
  'stage_job_retry',
  'stage_job',
  'import_job',
  'monthly_data',
  'bill_match_log',
  'pending_review',
  'match_badcase',
  'error_record',
  'departure_sync_audit',
  'daily_receipt_export',
  'received_receipt',
  'store_bill',
  'group_code',
  'missing_receipt',
  // 未收侧状态(P2 复核 HIGH#1,2026-07-16):重置不清 → 重导后 INSERT OR IGNORE 复用
  // 旧 first_seen,刚对账出来的行立即假「超7天」;resolution 同病(指向已删行的处理记录)。
  'unreceived_state',
  'unreceived_resolution',
];

function createMonthlyWorkspaceResetService({
  db,
  workspaceRepo,
  exportRoot = '',
  createBackup = null,
  backupOptions = {},
} = {}) {
  if (!db || !workspaceRepo) {
    throw new Error('workspace_reset_service: db and workspaceRepo required');
  }

  async function clearWorkspace({
    workspaceKey,
    confirmWorkspaceKey,
    operator = null,
    backup = true,
    allowDemoOnly = false,
  } = {}) {
    const normalized = normalizeWorkspaceKey(workspaceKey);
    const confirmation = normalizeWorkspaceKey(confirmWorkspaceKey);
    if (confirmation !== normalized) {
      const error = new Error(`confirmWorkspaceKey must equal ${normalized}`);
      error.statusCode = 400;
      throw error;
    }
    if (allowDemoOnly && !parseWorkspaceKey(normalized).isDemo) {
      const error = new Error('seed_only_allowed_on_demo_workspaces');
      error.statusCode = 403;
      error.code = 'SEED_DEMO_ONLY';
      throw error;
    }

    const existing = workspaceRepo.findByKey(normalized);
    if (!existing) {
      const error = new Error(`workspace not found: ${normalized}`);
      error.statusCode = 404;
      throw error;
    }
    rejectIfRunning(normalized);

    let backupDir = null;
    if (backup && typeof createBackup === 'function') {
      const result = await createBackup(backupOptions);
      backupDir = result?.backupDir || null;
    }

    const deleted = {};
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of WORKSPACE_TABLES) {
        if (!tableExists(table)) continue;
        deleted[table] = db.prepare(`DELETE FROM ${table} WHERE workspace_key = ?`).run(normalized).changes;
      }
      db.prepare(`
        UPDATE monthly_workspace
        SET status = 'open',
            updated_at = ?,
            locked_at = NULL,
            locked_by = NULL,
            metadata = ?
        WHERE workspace_key = ?
      `).run(
        now,
        JSON.stringify({
          ...(existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
          resetBy: operator || null,
          resetAt: now,
          backupDir,
        }),
        normalized
      );
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }

    const exportDir = removeWorkspaceExportDir(normalized);
    return {
      workspace: workspaceRepo.findByKey(normalized),
      deleted,
      backupDir,
      exportDir,
    };
  }

  function rejectIfRunning(workspaceKey) {
    if (!tableExists('stage_job')) return;
    const running = db.prepare(`
      SELECT id, stage FROM stage_job
      WHERE workspace_key = ? AND status = 'running'
      ORDER BY id DESC
      LIMIT 1
    `).get(workspaceKey);
    if (!running) return;
    const error = new Error(`Cannot clear ${workspaceKey} while stage ${running.stage} is running`);
    error.statusCode = 409;
    error.code = 'STAGE_ALREADY_RUNNING';
    error.running = running;
    throw error;
  }

  function tableExists(table) {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
    ).get(table);
    return Boolean(row);
  }

  function removeWorkspaceExportDir(workspaceKey) {
    if (!exportRoot) return null;
    const root = path.resolve(exportRoot);
    const target = path.resolve(root, workspaceKey);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error('resolved export path escapes export root');
    }
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    return target;
  }

  return { clearWorkspace };
}

function normalizeWorkspaceKey(workspaceKey) {
  try {
    return parseWorkspaceKey(workspaceKey).key;
  } catch (cause) {
    const error = new Error(cause?.message || 'workspaceKey must match YYYY-MM or demo-YYYY-MM');
    error.statusCode = 400;
    throw error;
  }
}

module.exports = {
  WORKSPACE_TABLES,
  createMonthlyWorkspaceResetService,
  normalizeWorkspaceKey,
};
