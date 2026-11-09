'use strict';

/**
 * 代理工作台 V2 — 读模型全量重建 + parity 报告(Task 5)。
 *
 * 用途:①上线时回填历史客户;②增量投影(钩子)出过错后的对账/自愈;③灰度前 dry-run 验证。
 *
 * 设计约束:
 *   - 流式遍历:逐 workspace → 逐客户读 customer.json,逐批次读 batch.json;
 *     JS 堆里只保留聚合计数,峰值内存不随客户总数线性增长(walkFiles 爆栈事故的教训)。
 *   - 影子库:重建先写到独立的 shadow sqlite 文件(同一份 DDL,由 agent_workspace_repository
 *     建表,零 SQL 副本);apply 时 ATTACH 到主库,在单事务里 DELETE+INSERT SELECT 原子切换。
 *     失败回滚,旧投影继续可用;重跑幂等(shadow 文件每次重建前删除重建)。
 *   - dry-run 不写主库:只读主库现有行数做 parity(表不存在→live=null,不建表)。
 *   - 聚合口径与实时链路共用同一份纯函数(buildCustomerAnchor / buildBatchOverlayEntries /
 *     deriveCustomerStatus),禁止在这里另写副本。
 */

const fs = require('node:fs');
const path = require('node:path');

const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');
const {
  buildCustomerAnchor,
  buildBatchOverlayEntries,
} = require('../lib/agent_workspace/customer_projection');
const { deriveCustomerStatus } = require('../lib/agent_workspace/status_policy');

const TABLE = 'agent_workspace_customer';

function listDirNames(root) {
  if (!root || !fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function tally(map, key, by = 1) {
  const k = String(key || '');
  map.set(k, (map.get(k) || 0) + by);
}

function mapToObject(map, { top = 0 } = {}) {
  let pairs = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (top > 0) pairs = pairs.slice(0, top);
  return Object.fromEntries(pairs);
}

function tableExists(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function createAgentWorkspaceRebuildService({
  db,
  libraryRoot,
  batchesRoot,
  timeZone = process.env.SIGN_BUSINESS_TZ || 'Asia/Seoul',
  logger = null,
} = {}) {
  if (!db) throw new Error('db is required');
  if (!libraryRoot) throw new Error('libraryRoot is required');
  if (!batchesRoot) throw new Error('batchesRoot is required');

  // ── Phase A:客户锚点(流式) ─────────────────────────────────────────────
  function projectAnchors(shadowRepo, report) {
    for (const workspaceKey of listDirNames(libraryRoot)) {
      for (const folderName of listDirNames(path.join(libraryRoot, workspaceKey))) {
        const jsonPath = path.join(libraryRoot, workspaceKey, folderName, 'customer.json');
        if (!fs.existsSync(jsonPath)) continue;
        report.fsCustomerFiles += 1;
        const customer = readJsonSafe(jsonPath);
        if (!customer) {
          tally(report.warnings, 'bad_customer_json');
          continue;
        }
        if (customer.deletedAt) {
          report.tombstones += 1;
          continue;
        }
        const anchor = buildCustomerAnchor({ customer, workspaceKey, timeZone });
        for (const w of anchor.warnings) tally(report.warnings, w);
        // 同 workspace 下两个文件夹指向同一 customerId(历史改名残留)→ 后读的覆盖,记警告
        if (shadowRepo.getCustomer(anchor.customerPk)) {
          tally(report.warnings, 'duplicate_customer_pk');
        }
        shadowRepo.upsertCustomerAnchor(anchor);
        tally(report.fsCustomersByMonth, anchor.calendarMonth || '(未知月)');
      }
    }
  }

  // ── Phase B:批次覆盖层(流式,mtime 升序 → 无活动批次锚点时最新批次胜出)──
  function projectOverlays(shadowRepo, report) {
    const batchIds = listDirNames(batchesRoot)
      .map((id) => {
        const file = path.join(batchesRoot, id, 'batch.json');
        try {
          return { id, file, mtimeMs: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const { id, file } of batchIds) {
      const batch = readJsonSafe(file);
      if (!batch) {
        tally(report.warnings, 'bad_batch_json');
        continue;
      }
      report.batchesScanned += 1;
      const { entries, skippedNoRef } = buildBatchOverlayEntries(batch);
      report.overlay.skippedNoRef += skippedNoRef;
      for (const entry of entries) {
        const status = deriveCustomerStatus({
          hasActiveBatch: true,
          overlay: entry.overlay,
          settlementStatus: entry.settlementStatus,
        });
        const result = shadowRepo.upsertReviewOverlay({
          customerPk: entry.customerPk,
          batchId: batch.id || id,
          groupKey: entry.groupKey,
          monthlyWorkspaceKey: null, // 禁止拿客户库 workspaceKey 冒充台账自然月工作簿
          storeKeys: entry.storeKeys,
          candidateModes: entry.overlay.candidateModes,
          confirmedModes: entry.overlay.confirmedModes,
          reviewStatus: status.reviewStatus,
          nextAction: status.nextAction,
          reasonCodes: status.reasonCodes,
          settlementStatus: entry.settlementStatus,
        });
        if (result.orphan) report.overlay.orphans += 1;
        else if (result.stale) report.overlay.stale += 1;
        else report.overlay.projected += 1;
      }
    }
  }

  // ── Phase C:重建结果分布(在 shadow 库上聚合)────────────────────────────
  function summarizeShadow(shadowDb, report) {
    const byMonth = shadowDb.prepare(
      `SELECT calendar_month AS m, COUNT(*) AS n FROM ${TABLE} GROUP BY calendar_month`
    ).all();
    for (const row of byMonth) report.rebuiltByMonth[row.m || '(未知月)'] = Number(row.n);

    const agents = shadowDb.prepare(
      `SELECT agent_name AS k, COUNT(*) AS n FROM ${TABLE} GROUP BY agent_key ORDER BY n DESC LIMIT 20`
    ).all();
    for (const row of agents) report.agentDistribution[row.k] = Number(row.n);

    const owners = shadowDb.prepare(
      `SELECT COALESCE(owner_username, '(无owner)') AS k, COUNT(*) AS n FROM ${TABLE} GROUP BY k ORDER BY n DESC LIMIT 20`
    ).all();
    for (const row of owners) report.ownerDistribution[row.k] = Number(row.n);

    const statuses = shadowDb.prepare(
      `SELECT review_status AS k, COUNT(*) AS n FROM ${TABLE} GROUP BY review_status`
    ).all();
    for (const row of statuses) report.statusDistribution[row.k] = Number(row.n);

    report.rebuiltTotal = Number(
      shadowDb.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n
    );
  }

  // ── Phase D:parity(重建结果 vs 主库现有投影)───────────────────────────
  function computeParity(report) {
    if (!tableExists(db, TABLE)) {
      report.parity.liveTableMissing = true;
      return;
    }
    const liveByMonth = new Map(
      db.prepare(`SELECT calendar_month AS m, COUNT(*) AS n FROM ${TABLE} GROUP BY calendar_month`)
        .all()
        .map((r) => [r.m || '(未知月)', Number(r.n)])
    );
    report.parity.liveTotal = [...liveByMonth.values()].reduce((a, b) => a + b, 0);
    const months = new Set([...Object.keys(report.rebuiltByMonth), ...liveByMonth.keys()]);
    for (const month of months) {
      const rebuilt = report.rebuiltByMonth[month] || 0;
      const live = liveByMonth.get(month) || 0;
      if (rebuilt !== live) {
        report.parity.mismatches.push({ month, rebuilt, live, delta: rebuilt - live });
      }
    }
  }

  // ── Phase E:原子切换(仅 apply)────────────────────────────────────────
  function swapIntoMain(shadowDbPath, report) {
    // 主库先确保表存在(fresh 库也能切换)
    createAgentWorkspaceRepository({ db });
    db.prepare('ATTACH DATABASE ? AS rebuild_shadow').run(shadowDbPath);
    try {
      // 列清单必须一致才允许切换(防止两边代码版本不同的静默错位)
      const mainCols = db.prepare(`PRAGMA main.table_info(${TABLE})`).all().map((r) => r.name);
      const shadowCols = db.prepare(`PRAGMA rebuild_shadow.table_info(${TABLE})`).all().map((r) => r.name);
      if (JSON.stringify(mainCols) !== JSON.stringify(shadowCols)) {
        throw new Error(`schema mismatch: main[${mainCols.join(',')}] != shadow[${shadowCols.join(',')}]`);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`DELETE FROM main.${TABLE}`);
        db.exec(`INSERT INTO main.${TABLE} SELECT * FROM rebuild_shadow.${TABLE}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      report.applied = true;
      report.appliedRows = Number(db.prepare(`SELECT COUNT(*) AS n FROM main.${TABLE}`).get().n);
    } finally {
      db.exec('DETACH DATABASE rebuild_shadow');
    }
  }

  /**
   * @param {object} options
   * @param {boolean} options.apply false=dry-run(不写主库,只出报告+parity)
   * @param {string} options.shadowDbPath 影子库文件路径(重建前删除重建,结束后删除)
   */
  function rebuild({ apply = false, shadowDbPath } = {}) {
    if (!shadowDbPath) throw new Error('shadowDbPath is required');
    const startedAt = Date.now();
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      fsCustomerFiles: 0,
      tombstones: 0,
      batchesScanned: 0,
      rebuiltTotal: 0,
      fsCustomersByMonth: new Map(),
      rebuiltByMonth: {},
      agentDistribution: {},
      ownerDistribution: {},
      statusDistribution: {},
      overlay: { projected: 0, orphans: 0, stale: 0, skippedNoRef: 0 },
      warnings: new Map(),
      parity: { liveTableMissing: false, liveTotal: 0, mismatches: [] },
      applied: false,
      appliedRows: 0,
      elapsedMs: 0,
    };

    // 影子库:每次全新重建(中断重跑幂等);任何阶段失败都在 finally 里清理影子文件
    const removeShadowFiles = () => {
      fs.rmSync(shadowDbPath, { force: true });
      fs.rmSync(`${shadowDbPath}-wal`, { force: true });
      fs.rmSync(`${shadowDbPath}-shm`, { force: true });
    };
    removeShadowFiles();
    const { DatabaseSync } = require('node:sqlite');
    const shadowDb = new DatabaseSync(shadowDbPath);
    try {
      shadowDb.exec('PRAGMA busy_timeout = 5000'); // 与主库连接策略一致(workbench_sqlite_repository)
      try {
        const shadowRepo = createAgentWorkspaceRepository({ db: shadowDb });
        projectAnchors(shadowRepo, report);
        projectOverlays(shadowRepo, report);
        summarizeShadow(shadowDb, report);
      } finally {
        shadowDb.close();
      }
      computeParity(report);
      if (apply) {
        swapIntoMain(shadowDbPath, report);
      }
    } finally {
      removeShadowFiles();
    }

    report.fsCustomersByMonth = mapToObject(report.fsCustomersByMonth);
    report.warnings = mapToObject(report.warnings);
    report.elapsedMs = Date.now() - startedAt;
    logger?.info?.('agent_workspace_rebuild_done', {
      mode: report.mode,
      rebuiltTotal: report.rebuiltTotal,
      applied: report.applied,
      mismatches: report.parity.mismatches.length,
      elapsedMs: report.elapsedMs,
    });
    return report;
  }

  return { rebuild };
}

module.exports = { createAgentWorkspaceRebuildService };
