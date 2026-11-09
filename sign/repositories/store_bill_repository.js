'use strict';

const { runSqliteTransaction } = require('../lib/storage/sqlite_transaction');

function createStoreBillRepository({ db }) {
  if (!db) throw new Error('db is required');
  const MATCH_CANDIDATE_COLS = `
    id, workspace_key, store_family, store_branch, mode, mode_normalized,
    tour_no, purchase_date, original_date, departure_date,
    name, full_name, passport_no, receipt_no, original_receipt_no,
    brand, sku, ref_no, category, qty,
    gross_usd, gross_krw, net_usd, net_krw, points, rebate_amount,
    store_base_points, store_extra_points,
    source_file, source_sheet, source_row, is_detail_sheet,
    raw_payload, row_hash, imported_at, import_job_id, transaction_type
  `;

  // G11c (#33): transaction_type 新增列,NULL 兼容历史导入 = 'sale';
  // 0027: statement_date 出账日期(SMG总账未收对账),历史来源 NULL。
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO store_bill (
      workspace_key, store_family, store_branch, mode, mode_normalized,
      tour_no, purchase_date, original_date, departure_date,
      name, full_name, passport_no, receipt_no, original_receipt_no,
      brand, sku, ref_no, category, qty,
      gross_usd, gross_krw, net_usd, net_krw, points, rebate_amount,
      store_base_points, store_extra_points,
      source_file, source_sheet, source_row, is_detail_sheet,
      raw_payload, row_hash, imported_at, import_job_id,
      transaction_type, statement_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 店家账单读面统一只看明细行(is_detail_sheet=1):SMG总账行(is_detail_sheet=0)与店家账单
  // 共表隔离(import_service.js:120),这些"店家账单视图/计数/匹配/兜底"若不带该过滤,SMG导入后
  // 28万总账行会污染账单列表(首页全是总账)、工作区计数虚增、团号覆盖率失真、兜底捡到总账行
  // (审计 MEDIUM,2026-07-22)。SMG感知的替换/删除走 job_type 语句,不在此列。
  const countByWsStmt = db.prepare(`SELECT COUNT(1) AS count FROM store_bill WHERE workspace_key = ? AND is_detail_sheet = 1`);
  const deleteByIdStmt = db.prepare(`DELETE FROM store_bill WHERE workspace_key = ? AND id = ?`);
  const countByFamilyStmt = db.prepare(`
    SELECT store_family AS family, COUNT(1) AS count
    FROM store_bill
    WHERE workspace_key = ? AND is_detail_sheet = 1
    GROUP BY store_family
  `);
  const listStmt = db.prepare(`
    SELECT * FROM store_bill
    WHERE workspace_key = ? AND is_detail_sheet = 1
      AND (? IS NULL OR store_family = ?)
      AND (? IS NULL OR mode_normalized = ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  // ⭐与 listStmt **同一套 WHERE**(2026-08-01):账单页原来 rows 走 list(带 family/mode 筛),
  // total 却走 countByWorkspace(整个工作区)。筛成一家店时列表 30 行、页脚写"共 5000 条",
  // 分页还会给出一堆点进去是空的页码。两个数必须出自同一个条件,所以这条 SQL 与上面那条
  // 只差 SELECT 部分 —— 改 WHERE 时两条一起改。
  const countFilteredStmt = db.prepare(`
    SELECT COUNT(1) AS count FROM store_bill
    WHERE workspace_key = ? AND is_detail_sheet = 1
      AND (? IS NULL OR store_family = ?)
      AND (? IS NULL OR mode_normalized = ?)
  `);
  const findByReceiptStmt = db.prepare(`
    SELECT * FROM store_bill
    WHERE workspace_key = ? AND receipt_no = ? AND is_detail_sheet = 1
  `);
  const findByPassportStmt = db.prepare(`
    SELECT * FROM store_bill
    WHERE workspace_key = ? AND passport_no = ? AND is_detail_sheet = 1
    ORDER BY purchase_date ASC, id ASC
  `);
  const listDetailByWorkspaceStmt = db.prepare(`
    SELECT *
    FROM store_bill
    WHERE workspace_key = ? AND is_detail_sheet = 1
  `);
  const listDetailMatchCandidatesStmt = db.prepare(`
    SELECT ${MATCH_CANDIDATE_COLS}
    FROM store_bill
    WHERE workspace_key = ?
      AND is_detail_sheet = 1
      AND (transaction_type IS NULL OR transaction_type = 'sale')
    ORDER BY id
  `);
  const listDetailMergeCandidatesStmt = db.prepare(`
    SELECT ${MATCH_CANDIDATE_COLS}
    FROM store_bill
    WHERE workspace_key = ?
      AND is_detail_sheet = 1
    ORDER BY id
  `);
  const listIdsByImportBucketStmt = db.prepare(`
    SELECT sb.id
    FROM store_bill sb
    INNER JOIN import_job ij ON ij.id = sb.import_job_id
    WHERE sb.workspace_key = ?
      AND ij.workspace_key = ?
      AND ij.job_type = 'store_bill'
      AND ij.bucket_folder = ?
      AND ij.status != 'replaced'
  `);
  const updateDepartureStmt = db.prepare(`
    UPDATE store_bill
    SET departure_date = ?
    WHERE id = ? AND workspace_key = ?
  `);
  // SMG总账替换语义:按导入类型清本工作区旧行(滚动全量,上家会修订历史行)。
  // 走 import_job.job_type 关联,不误伤店家账单(job_type='store_bill')的行;
  // 0027 建了 idx_store_bill_import_job,28万行级删除不全表扫。
  const deleteByJobTypeStmt = db.prepare(`
    DELETE FROM store_bill
    WHERE workspace_key = ?
      AND import_job_id IN (
        SELECT id FROM import_job WHERE workspace_key = ? AND job_type = ?
      )
  `);
  // 旧版守卫用:某导入类型现存行的出账日期上限(替换前记旧版锚,替换后比对新版)
  const maxStatementDateByJobTypeStmt = db.prepare(`
    SELECT MAX(statement_date) AS max_stmt
    FROM store_bill
    WHERE workspace_key = ?
      AND statement_date IS NOT NULL
      AND import_job_id IN (
        SELECT id FROM import_job WHERE workspace_key = ? AND job_type = ?
      )
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceKey: row.workspace_key,
      storeFamily: row.store_family,
      storeBranch: row.store_branch,
      mode: row.mode,
      modeNormalized: row.mode_normalized,
      tourNo: row.tour_no,
      purchaseDate: row.purchase_date,
      originalDate: row.original_date,
      departureDate: row.departure_date,
      name: row.name,
      fullName: row.full_name,
      passportNo: row.passport_no,
      receiptNo: row.receipt_no,
      originalReceiptNo: row.original_receipt_no,
      brand: row.brand,
      sku: row.sku,
      refNo: row.ref_no,
      category: row.category,
      qty: row.qty,
      grossUsd: row.gross_usd,
      grossKrw: row.gross_krw,
      netUsd: row.net_usd,
      netKrw: row.net_krw,
      points: row.points,
      rebateAmount: row.rebate_amount,
      storeBasePoints: row.store_base_points,
      storeExtraPoints: row.store_extra_points,
      sourceFile: row.source_file,
      sourceSheet: row.source_sheet,
      sourceRow: row.source_row,
      isDetailSheet: Boolean(row.is_detail_sheet),
      rawPayload: parseRawPayload(row.raw_payload),
      rowHash: row.row_hash,
      importedAt: row.imported_at,
      importJobId: row.import_job_id,
      transactionType: row.transaction_type || null, // G11c (#33)
      statementDate: row.statement_date || null, // 0027 出账日期(SMG总账)
    };
  }

  return {
    insertMany(rows) {
      let inserted = 0;
      let skipped = 0;
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          const result = insertStmt.run(
            r.workspaceKey,
            r.storeFamily || null,
            r.storeBranch || null,
            r.mode || null,
            r.modeNormalized || null,
            r.tourNo || null,
            r.purchaseDate || null,
            r.originalDate || null,
            r.departureDate || null,
            r.name || null,
            r.fullName || null,
            r.passportNo || null,
            r.receiptNo || null,
            r.originalReceiptNo || null,
            r.brand || null,
            r.sku || null,
            r.refNo || null,
            r.category || null,
            r.qty == null ? null : Number(r.qty),
            numberOrNull(r.grossUsd),
            numberOrNull(r.grossKrw),
            numberOrNull(r.netUsd),
            numberOrNull(r.netKrw),
            numberOrNull(r.points),
            numberOrNull(r.rebateAmount),
            numberOrNull(r.storeBasePoints),
            numberOrNull(r.storeExtraPoints),
            r.sourceFile || null,
            r.sourceSheet || null,
            r.sourceRow == null ? null : Number(r.sourceRow),
            r.isDetailSheet ? 1 : 0,
            r.rawPayload ? JSON.stringify(r.rawPayload) : null,
            r.rowHash,
            r.importedAt,
            r.importJobId || null,
            r.transactionType || null, // G11c (#33)
            r.statementDate || null    // 0027 出账日期(SMG总账)
          );
          if (result.changes > 0) inserted += 1; else skipped += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { inserted, skipped };
    },
    countByWorkspace(workspaceKey) {
      return Number(countByWsStmt.get(workspaceKey)?.count || 0);
    },
    // G8-fix(C1+B4): 团号命中率统计 — 账单团号 × 团号表重叠
    // SQL 单次扫;同 workspace_key 两表。返:
    //   { billsTotal, billsDistinctTours, groupsDistinctTours, overlap, coverageRate }
    tourCoverageStats(workspaceKey) {
      const billsTotal = Number(countByWsStmt.get(workspaceKey)?.count || 0);
      const billsDistinctTours = Number(db.prepare(
        `SELECT COUNT(DISTINCT tour_no) AS n FROM store_bill
         WHERE workspace_key = ? AND is_detail_sheet = 1 AND tour_no IS NOT NULL AND tour_no != ''`
      ).get(workspaceKey)?.n || 0);
      const groupsDistinctTours = Number(db.prepare(
        `SELECT COUNT(DISTINCT tour_no) AS n FROM group_code
         WHERE workspace_key = ? AND tour_no IS NOT NULL AND tour_no != ''`
      ).get(workspaceKey)?.n || 0);
      const overlap = Number(db.prepare(
        `SELECT COUNT(DISTINCT sb.tour_no) AS n
         FROM store_bill sb
         INNER JOIN group_code gc
           ON gc.workspace_key = sb.workspace_key AND gc.tour_no = sb.tour_no
         WHERE sb.workspace_key = ?
           AND sb.is_detail_sheet = 1
           AND sb.tour_no IS NOT NULL AND sb.tour_no != ''`
      ).get(workspaceKey)?.n || 0);
      const coverageRate = billsDistinctTours > 0
        ? Math.round((overlap / billsDistinctTours) * 10000) / 100   // 0~100 两位小数
        : 0;
      return { billsTotal, billsDistinctTours, groupsDistinctTours, overlap, coverageRate };
    },
    // SMG总账替换语义用;返回删除行数
    deleteByJobType({ workspaceKey, jobType }) {
      if (!workspaceKey || !jobType) return 0;
      return deleteByJobTypeStmt.run(workspaceKey, workspaceKey, jobType).changes;
    },
    maxStatementDateByJobType({ workspaceKey, jobType }) {
      if (!workspaceKey || !jobType) return null;
      return maxStatementDateByJobTypeStmt.get(workspaceKey, workspaceKey, jobType)?.max_stmt || null;
    },
    deleteMany({ workspaceKey, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) return 0;
      return runSqliteTransaction(db, () => {
        let deleted = 0;
        for (const id of ids) {
          deleted += deleteByIdStmt.run(workspaceKey, Number(id)).changes;
        }
        return deleted;
      }, { savepointName: 'store_bill_delete_many', preferSavepoint: true });
    },
    countByFamily(workspaceKey) {
      return countByFamilyStmt.all(workspaceKey);
    },
    list({ workspaceKey, family = null, mode = null, limit = 50, offset = 0 }) {
      return listStmt.all(
        workspaceKey,
        family,
        family,
        mode,
        mode,
        limit,
        offset
      ).map(mapRow);
    },
    // 与 list 同条件的计数(分页页脚/页数用它,别再用 countByWorkspace)
    countFiltered({ workspaceKey, family = null, mode = null }) {
      return Number(countFilteredStmt.get(workspaceKey, family, family, mode, mode)?.count || 0);
    },
    findByReceipt({ workspaceKey, receiptNo }) {
      return findByReceiptStmt.all(workspaceKey, receiptNo).map(mapRow);
    },
    findByPassport({ workspaceKey, passportNo }) {
      return findByPassportStmt.all(workspaceKey, passportNo).map(mapRow);
    },
    iterateDetail(workspaceKey) {
      return listDetailByWorkspaceStmt.all(workspaceKey).map(mapRow);
    },
    iterateMatchCandidates(workspaceKey) {
      return listDetailMatchCandidatesStmt.all(workspaceKey).map(mapRow);
    },
    *iterateMergeCandidates(workspaceKey) {
      for (const row of listDetailMergeCandidatesStmt.iterate(workspaceKey)) {
        yield mapRow(row);
      }
    },
    // 轻量投影:只取归桶 + 计数需要的列(不含 raw_payload 等大字段),
    // 给桶汇总等大数据量场景用,避免 SELECT * 读 18 万行大对象。
    iterateDetailLight(workspaceKey) {
      return db.prepare(`
        SELECT id, mode, store_family, store_branch, source_file, source_sheet
        FROM store_bill WHERE workspace_key = ? AND is_detail_sheet = 1
      `).all(workspaceKey).map((r) => ({
        id: r.id, mode: r.mode, storeFamily: r.store_family,
        storeBranch: r.store_branch, sourceFile: r.source_file, sourceSheet: r.source_sheet,
      }));
    },
    listIdsByImportBucket({ workspaceKey, bucketFolder }) {
      return listIdsByImportBucketStmt
        .all(workspaceKey, workspaceKey, bucketFolder)
        .map((row) => Number(row.id));
    },
    updateDeparture({ id, workspaceKey, departureDate }) {
      const result = updateDepartureStmt.run(departureDate, Number(id), workspaceKey);
      return result.changes;
    },
    applyDepartureRewrites(rewrites) {
      if (!Array.isArray(rewrites) || rewrites.length === 0) return 0;
      let applied = 0;
      db.exec('BEGIN');
      try {
        for (const r of rewrites) {
          const result = updateDepartureStmt.run(
            r.afterValue,
            Number(r.storeBillId),
            r.workspaceKey
          );
          applied += result.changes;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return applied;
    },
  };
}

function numberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseRawPayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  createStoreBillRepository,
};
