'use strict';

/**
 * monthly_data — merged view of daily_receipt_export + matched store_bill
 * rows, partitioned by mode_folder. Written by stage 2/3 after bill match
 * succeeds. Sprint 2 produces this; Sprint 3 exports it to xlsx.
 */

const { FIELD_COLS, CAMEL_BY_COL } = require('./daily_receipt_repository');

function createMonthlyDataRepository({ db }) {
  if (!db) throw new Error('db is required');

  let _imSeq = 0;

  const insertCols = [
    'workspace_key', 'mode_folder', 'is_unmatched',
    'daily_receipt_id', 'store_bill_id', 'is_brand_activity',
    ...FIELD_COLS,
    'customer_rebate_krw', 'customer_rebate_usd', 'merge_config_version',
    'row_hash', 'created_at', 'updated_at',
  ];
  const placeholders = insertCols.map(() => '?').join(', ');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO monthly_data (${insertCols.join(', ')})
    VALUES (${placeholders})
  `);

  const countStmt = db.prepare(
    `SELECT COUNT(1) AS n FROM monthly_data WHERE workspace_key = ?`
  );
  const countByModeStmt = db.prepare(`
    SELECT mode_folder AS folder, is_unmatched AS unmatched, COUNT(1) AS n
    FROM monthly_data
    WHERE workspace_key = ?
    GROUP BY mode_folder, is_unmatched
    ORDER BY mode_folder, is_unmatched
  `);
  const listByModeStmt = db.prepare(`
    SELECT * FROM monthly_data
    WHERE workspace_key = ? AND mode_folder = ?
    ORDER BY id
    LIMIT ? OFFSET ?
  `);
  const listFilteredStmt = db.prepare(`
    SELECT * FROM monthly_data
    WHERE workspace_key = ?
      AND (? IS NULL OR mode_folder = ?)
      AND (? IS NULL OR is_unmatched = ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const countFilteredStmt = db.prepare(`
    SELECT COUNT(1) AS n FROM monthly_data
    WHERE workspace_key = ?
      AND (? IS NULL OR mode_folder = ?)
      AND (? IS NULL OR is_unmatched = ?)
  `);
  // 各桶返点合计(2026-08-01)。WHERE 必须与 listFilteredStmt **逐字一致** ——
  // 交付核对页原来是把"当前已加载的那一页"累加当合计:前端固定 limit:500,
  // 后端 clampInt 又把 limit 硬顶在 500,而真实月份 monthly_data 是万行级。
  // 于是四个「返点合计」只反映前 500 行(可能只有真值的百分之几),
  // 紧挨着的「交付总行数」却用服务端全量 total —— 两个数字并排,人默认同一口径,
  // 按它跟上家对账会直接对错。
  // 放在这里而不是前端翻页累加:翻几十页只为求个和,既慢又会在中途失败时给出半截数。
  const sumRebateFilteredStmt = db.prepare(`
    SELECT mode_folder AS folder,
           COUNT(1) AS n,
           COALESCE(SUM(customer_rebate_krw), 0) AS rebateKrw
    FROM monthly_data
    WHERE workspace_key = ?
      AND (? IS NULL OR mode_folder = ?)
      AND (? IS NULL OR is_unmatched = ?)
    GROUP BY mode_folder
    ORDER BY mode_folder
  `);
  const deleteByWorkspaceStmt = db.prepare(
    `DELETE FROM monthly_data WHERE workspace_key = ?`
  );
  const deleteByDailyStmt = db.prepare(
    `DELETE FROM monthly_data WHERE workspace_key = ? AND daily_receipt_id = ?`
  );
  const findByDailyStmt = db.prepare(
    `SELECT * FROM monthly_data WHERE workspace_key = ? AND daily_receipt_id = ? LIMIT 1`
  );

  return {
    insertMany(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, skipped: 0 };
      let inserted = 0;
      let skipped = 0;
      // Use SAVEPOINT so insertMany is safe both standalone (autocommit) and
      // when called from within an outer BEGIN IMMEDIATE (merge_streaming_service).
      // SAVEPOINT + RELEASE  ≡ BEGIN + COMMIT   in autocommit mode.
      // SAVEPOINT + RELEASE inside an outer tx merges into that tx without committing.
      // SAVEPOINT + ROLLBACK TO + RELEASE undoes only this batch in both modes.
      const sp = `_im${++_imSeq}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        for (const r of rows) {
          const vals = [
            r.workspaceKey,
            r.modeFolder,
            r.isUnmatched ? 1 : 0,
            r.dailyReceiptId == null ? null : Number(r.dailyReceiptId),
            r.storeBillId == null ? null : Number(r.storeBillId),
            r.isBrandActivity ? 1 : 0,
            ...FIELD_COLS.map((col) => {
              const v = r[CAMEL_BY_COL[col]];
              if (v == null || v === '') return null;
              return v;
            }),
            r.customerRebateKrw == null ? null : Number(r.customerRebateKrw),
            r.customerRebateUsd == null ? null : Number(r.customerRebateUsd),
            r.mergeConfigVersion || null,
            r.rowHash,
            r.createdAt,
            r.updatedAt || r.createdAt,
          ];
          const result = insertStmt.run(...vals);
          if (result.changes > 0) inserted += 1; else skipped += 1;
        }
        db.exec(`RELEASE ${sp}`);
      } catch (error) {
        try { db.exec(`ROLLBACK TO ${sp}`); } catch { /* intentional */ }
        try { db.exec(`RELEASE ${sp}`); } catch { /* intentional */ }
        throw error;
      }
      return { inserted, skipped };
    },
    countByWorkspace(workspaceKey) {
      return Number(countStmt.get(workspaceKey)?.n || 0);
    },
    countByMode(workspaceKey) {
      return countByModeStmt.all(workspaceKey);
    },
    listByMode({ workspaceKey, modeFolder, limit = 100, offset = 0 }) {
      return listByModeStmt.all(workspaceKey, modeFolder, Number(limit), Number(offset));
    },
    listFiltered({ workspaceKey, modeFolder = null, isUnmatched = null, limit = 100, offset = 0 }) {
      const flag = isUnmatched == null ? null : (isUnmatched ? 1 : 0);
      return listFilteredStmt.all(
        workspaceKey,
        modeFolder, modeFolder,
        flag, flag,
        Number(limit), Number(offset)
      );
    },
    countFiltered({ workspaceKey, modeFolder = null, isUnmatched = null }) {
      const flag = isUnmatched == null ? null : (isUnmatched ? 1 : 0);
      return Number(countFilteredStmt.get(
        workspaceKey,
        modeFolder, modeFolder,
        flag, flag
      )?.n || 0);
    },
    /**
     * 各桶返点合计 + 行数,**全量**(不受分页 limit 影响),但跟随同一套筛选。
     * @returns {{buckets: Array<{folder: string, n: number, rebateKrw: number}>,
     *            totalRebateKrw: number, totalRows: number}}
     */
    sumRebateByMode({ workspaceKey, modeFolder = null, isUnmatched = null }) {
      const flag = isUnmatched == null ? null : (isUnmatched ? 1 : 0);
      const rows = sumRebateFilteredStmt.all(
        workspaceKey,
        modeFolder, modeFolder,
        flag, flag
      );
      const buckets = rows.map((r) => ({
        folder: r.folder || '未归类',
        n: Number(r.n || 0),
        rebateKrw: Number(r.rebateKrw || 0),
      }));
      return {
        buckets,
        totalRebateKrw: buckets.reduce((s, b) => s + b.rebateKrw, 0),
        totalRows: buckets.reduce((s, b) => s + b.n, 0),
      };
    },
    deleteByWorkspace(workspaceKey) {
      return deleteByWorkspaceStmt.run(workspaceKey).changes;
    },
    deleteByDaily({ workspaceKey, dailyReceiptId }) {
      return deleteByDailyStmt.run(workspaceKey, Number(dailyReceiptId)).changes;
    },
    findByDaily({ workspaceKey, dailyReceiptId }) {
      return findByDailyStmt.get(workspaceKey, Number(dailyReceiptId)) || null;
    },

    // 交付前核对: 人工修改 monthly_data 某一行的可改字段(白名单),并标记 updated_at。
    updateRow({ workspaceKey, id, updates }) {
      const EDITABLE = new Set([
        'name', 'full_name', 'passport_no', 'tour_no',
        'purchase_date', 'departure_date', 'receipt_no',
        'net_krw', 'net_usd', 'customer_points',
        'customer_rebate_krw', 'customer_rebate_usd',
      ]);
      const NUMERIC = new Set(['net_krw', 'net_usd', 'customer_points', 'customer_rebate_krw', 'customer_rebate_usd']);
      const sets = [];
      const vals = [];
      for (const [k, v] of Object.entries(updates || {})) {
        if (!EDITABLE.has(k)) continue;
        let val = v;
        if (NUMERIC.has(k)) { const n = Number(v); val = Number.isFinite(n) ? n : null; }
        else if (v === '' || v == null) val = null;
        sets.push(`${k} = ?`);
        vals.push(val);
      }
      if (sets.length === 0) return 0;
      sets.push('updated_at = ?');
      vals.push(new Date().toISOString());
      const stmt = db.prepare(
        `UPDATE monthly_data SET ${sets.join(', ')} WHERE workspace_key = ? AND id = ?`
      );
      return stmt.run(...vals, workspaceKey, Number(id)).changes;
    },
  };
}

module.exports = { createMonthlyDataRepository };
