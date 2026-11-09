const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDir } = require('../lib/workbench_utils');

function createWorkbenchSqliteRepository({ dbPath }) {
  if (!dbPath) {
    throw new Error('dbPath is required');
  }

  ensureDir(path.dirname(dbPath));

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS batch (
      batch_id TEXT PRIMARY KEY,
      batch_name TEXT NOT NULL,
      scenario TEXT,
      created_at TEXT,
      updated_at TEXT,
      machine_state TEXT,
      status TEXT,
      source_group_count INTEGER DEFAULT 0,
      task_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS traveler_group (
      group_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      folder_key TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      folder_path TEXT,
      status TEXT,
      task_count INTEGER DEFAULT 0,
      source_image_count INTEGER DEFAULT 0,
      receipt_count INTEGER DEFAULT 0,
      passport_count INTEGER DEFAULT 0,
      attachment_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_traveler_group_batch_id
      ON traveler_group (batch_id, folder_key);

    CREATE TABLE IF NOT EXISTS source_image (
      source_image_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      legacy_task_id TEXT,
      file_name TEXT,
      file_path TEXT,
      original_path TEXT,
      raw_json_path TEXT,
      machine_state TEXT,
      doc_type TEXT,
      process_result TEXT,
      review_status TEXT,
      source_type TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_source_image_batch_group
      ON source_image (batch_id, group_id);

    CREATE INDEX IF NOT EXISTS idx_source_image_legacy_task
      ON source_image (legacy_task_id);

    CREATE TABLE IF NOT EXISTS passport_record (
      passport_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      source_image_id TEXT,
      legacy_task_id TEXT,
      english_name TEXT,
      passport_no TEXT,
      departure_date TEXT,
      tour_no TEXT,
      status TEXT,
      raw_payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_passport_record_group
      ON passport_record (batch_id, group_id);

    -- 代理视图 B 页在途判定(P3,2026-07-17):按归一护照号反查"图收了还在审"的批次/组。
    -- 表达式形与查询 WHERE lower(trim(passport_no)) IN (…) 精确匹配,普通列索引用不上。
    CREATE INDEX IF NOT EXISTS idx_passport_record_no_norm
      ON passport_record (lower(trim(passport_no)));

    CREATE TABLE IF NOT EXISTS receipt_record (
      receipt_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      source_image_id TEXT,
      legacy_task_id TEXT,
      purchase_date TEXT,
      statement_date TEXT,
      payment_mode TEXT,
      rebate_mode TEXT,
      duty_free_shop TEXT,
      duty_free_branch TEXT,
      upstream_name TEXT,
      receipt_no TEXT,
      original_receipt_no TEXT,
      category TEXT,
      brand TEXT,
      is_manual_added INTEGER DEFAULT 0,
      status TEXT,
      raw_payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_receipt_record_group
      ON receipt_record (batch_id, group_id);

    CREATE INDEX IF NOT EXISTS idx_receipt_record_source_image
      ON receipt_record (source_image_id);

    -- 代理视图 B 页在途判定(P3,2026-07-17):按归一票号反查在途小票(表达式形,同上)
    CREATE INDEX IF NOT EXISTS idx_receipt_record_no_norm
      ON receipt_record (lower(trim(receipt_no)));

    CREATE TABLE IF NOT EXISTS attachment_file (
      attachment_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      file_name TEXT,
      file_path TEXT,
      file_kind TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attachment_file_group
      ON attachment_file (batch_id, group_id);
  `);

  const replaceBatchStmt = db.prepare(`
    INSERT INTO batch (
      batch_id, batch_name, scenario, created_at, updated_at, machine_state, status, source_group_count, task_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id) DO UPDATE SET
      batch_name = excluded.batch_name,
      scenario = excluded.scenario,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      machine_state = excluded.machine_state,
      status = excluded.status,
      source_group_count = excluded.source_group_count,
      task_count = excluded.task_count
  `);

  const insertTravelerGroupStmt = db.prepare(`
    INSERT INTO traveler_group (
      group_id, batch_id, folder_key, folder_name, folder_path, status, task_count,
      source_image_count, receipt_count, passport_count, attachment_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSourceImageStmt = db.prepare(`
    INSERT INTO source_image (
      source_image_id, batch_id, group_id, legacy_task_id, file_name, file_path, original_path,
      raw_json_path, machine_state, doc_type, process_result, review_status, source_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPassportStmt = db.prepare(`
    INSERT INTO passport_record (
      passport_id, batch_id, group_id, source_image_id, legacy_task_id, english_name,
      passport_no, departure_date, tour_no, status, raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertReceiptStmt = db.prepare(`
    INSERT INTO receipt_record (
      receipt_id, batch_id, group_id, source_image_id, legacy_task_id, purchase_date, statement_date,
      payment_mode, rebate_mode, duty_free_shop, duty_free_branch, upstream_name,
      receipt_no, original_receipt_no, category, brand, is_manual_added, status, raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAttachmentStmt = db.prepare(`
    INSERT INTO attachment_file (
      attachment_id, batch_id, group_id, file_name, file_path, file_kind
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const deleteTravelerGroupsByBatchStmt = db.prepare(`DELETE FROM traveler_group WHERE batch_id = ?`);
  const deleteSourceImagesByBatchStmt = db.prepare(`DELETE FROM source_image WHERE batch_id = ?`);
  const deletePassportsByBatchStmt = db.prepare(`DELETE FROM passport_record WHERE batch_id = ?`);
  const deleteReceiptsByBatchStmt = db.prepare(`DELETE FROM receipt_record WHERE batch_id = ?`);
  const deleteAttachmentsByBatchStmt = db.prepare(`DELETE FROM attachment_file WHERE batch_id = ?`);
  const deleteBatchStmt = db.prepare(`DELETE FROM batch WHERE batch_id = ?`);

  const countBatchesStmt = db.prepare(`SELECT COUNT(1) AS count FROM batch`);
  const countGroupsStmt = db.prepare(`SELECT COUNT(1) AS count FROM traveler_group`);
  const countReceiptsStmt = db.prepare(`SELECT COUNT(1) AS count FROM receipt_record`);
  const countPassportsStmt = db.prepare(`SELECT COUNT(1) AS count FROM passport_record`);

  function clearBatchChildren(batchId) {
    deleteTravelerGroupsByBatchStmt.run(batchId);
    deleteSourceImagesByBatchStmt.run(batchId);
    deletePassportsByBatchStmt.run(batchId);
    deleteReceiptsByBatchStmt.run(batchId);
    deleteAttachmentsByBatchStmt.run(batchId);
  }

  function replaceBatchProjection(projection) {
    if (!projection?.batch?.batch_id) {
      throw new Error('Invalid batch projection');
    }

    db.exec('BEGIN');
    try {
      replaceBatchStmt.run(
        projection.batch.batch_id,
        projection.batch.batch_name,
        projection.batch.scenario,
        projection.batch.created_at,
        projection.batch.updated_at,
        projection.batch.machine_state,
        projection.batch.status,
        projection.batch.source_group_count,
        projection.batch.task_count
      );

      clearBatchChildren(projection.batch.batch_id);

      for (const group of projection.travelerGroups || []) {
        insertTravelerGroupStmt.run(
          group.group_id,
          group.batch_id,
          group.folder_key,
          group.folder_name,
          group.folder_path,
          group.status,
          group.task_count,
          group.source_image_count,
          group.receipt_count,
          group.passport_count,
          group.attachment_count
        );
      }

      for (const sourceImage of projection.sourceImages || []) {
        insertSourceImageStmt.run(
          sourceImage.source_image_id,
          sourceImage.batch_id,
          sourceImage.group_id,
          sourceImage.legacy_task_id,
          sourceImage.file_name,
          sourceImage.file_path,
          sourceImage.original_path,
          sourceImage.raw_json_path,
          sourceImage.machine_state,
          sourceImage.doc_type,
          sourceImage.process_result,
          sourceImage.review_status,
          sourceImage.source_type
        );
      }

      for (const passport of projection.passportRecords || []) {
        insertPassportStmt.run(
          passport.passport_id,
          passport.batch_id,
          passport.group_id,
          passport.source_image_id,
          passport.legacy_task_id,
          passport.english_name,
          passport.passport_no,
          passport.departure_date,
          passport.tour_no,
          passport.status,
          passport.raw_payload_json
        );
      }

      for (const receipt of projection.receiptRecords || []) {
        insertReceiptStmt.run(
          receipt.receipt_id,
          receipt.batch_id,
          receipt.group_id,
          receipt.source_image_id,
          receipt.legacy_task_id,
          receipt.purchase_date,
          receipt.statement_date,
          receipt.payment_mode,
          receipt.rebate_mode,
          receipt.duty_free_shop,
          receipt.duty_free_branch,
          receipt.upstream_name,
          receipt.receipt_no,
          receipt.original_receipt_no,
          receipt.category,
          receipt.brand,
          receipt.is_manual_added,
          receipt.status,
          receipt.raw_payload_json
        );
      }

      for (const attachment of projection.attachmentFiles || []) {
        insertAttachmentStmt.run(
          attachment.attachment_id,
          attachment.batch_id,
          attachment.group_id,
          attachment.file_name,
          attachment.file_path,
          attachment.file_kind
        );
      }

      db.exec('COMMIT');
      return projection;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function deleteBatch(batchId) {
    db.exec('BEGIN');
    try {
      clearBatchChildren(batchId);
      deleteBatchStmt.run(batchId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getCounts() {
    return {
      batchCount: countBatchesStmt.get().count,
      travelerGroupCount: countGroupsStmt.get().count,
      receiptRecordCount: countReceiptsStmt.get().count,
      passportRecordCount: countPassportsStmt.get().count,
    };
  }

  function getForeignKeysEnabled() {
    return Boolean(db.prepare('PRAGMA foreign_keys').get().foreign_keys);
  }

  function close() {
    db.close();
  }

  return {
    close,
    // 代理工作台V2:读模型仓库复用同一 DatabaseSync 句柄(同文件双连接在 WAL 下也可,
    // 但同句柄免锁竞争;agent_workspace_repository 经此注入,不自开连接)。
    db,
    dbPath,
    deleteBatch,
    getForeignKeysEnabled,
    getCounts,
    replaceBatchProjection,
  };
}

module.exports = {
  createWorkbenchSqliteRepository,
};
