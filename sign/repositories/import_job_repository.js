'use strict';

function createImportJobRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO import_job (
      workspace_key, job_type, source_file, file_size, sha256, status,
      rows_total, rows_inserted, rows_skipped,
      started_at, finished_at, error_message, operator, details, bucket_folder
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE import_job
    SET status = ?, rows_total = ?, rows_inserted = ?, rows_skipped = ?,
        finished_at = ?, error_message = ?, details = ?
    WHERE id = ?
  `);
  const getStmt = db.prepare(`SELECT * FROM import_job WHERE id = ?`);
  const listStmt = db.prepare(`
    SELECT * FROM import_job
    WHERE workspace_key = ?
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `);
  const listByWorkspaceStmt = db.prepare(`
    SELECT * FROM import_job
    WHERE workspace_key = ?
      AND (? IS NULL OR job_type = ?)
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `);
  const markBucketReplacedStmt = db.prepare(`
    UPDATE import_job
    SET status = 'replaced',
        finished_at = COALESCE(finished_at, ?),
        error_message = NULL
    WHERE workspace_key = ?
      AND job_type = 'store_bill'
      AND bucket_folder = ?
      AND status != 'replaced'
  `);
  // SMG总账替换语义:整类型标 replaced(行已被 deleteByJobType 清掉,job 留审计不留活跃态)
  const markJobTypeReplacedStmt = db.prepare(`
    UPDATE import_job
    SET status = 'replaced',
        finished_at = COALESCE(finished_at, ?),
        error_message = NULL
    WHERE workspace_key = ?
      AND job_type = ?
      AND status != 'replaced'
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceKey: row.workspace_key,
      jobType: row.job_type,
      sourceFile: row.source_file,
      fileSize: row.file_size,
      sha256: row.sha256,
      status: row.status,
      rowsTotal: row.rows_total,
      rowsInserted: row.rows_inserted,
      rowsSkipped: row.rows_skipped,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorMessage: row.error_message,
      operator: row.operator,
      details: row.details ? safeJson(row.details) : null,
      bucketFolder: row.bucket_folder || null,
    };
  }

  return {
    create({ workspaceKey, jobType, sourceFile, fileSize, sha256, operator, startedAt, bucketFolder = null }) {
      const info = insertStmt.run(
        workspaceKey,
        jobType,
        sourceFile,
        fileSize || null,
        sha256 || null,
        'running',
        0,
        0,
        0,
        startedAt,
        null,
        null,
        operator || null,
        null,
        bucketFolder || null
      );
      return Number(info.lastInsertRowid);
    },
    finalize({ id, status, rowsTotal, rowsInserted, rowsSkipped, finishedAt, errorMessage = null, details = null }) {
      updateStmt.run(
        status,
        rowsTotal || 0,
        rowsInserted || 0,
        rowsSkipped || 0,
        finishedAt,
        errorMessage,
        details == null ? null : JSON.stringify(details),
        id
      );
      return this.findById(id);
    },
    findById(id) {
      return mapRow(getStmt.get(id));
    },
    list({ workspaceKey, limit = 50, offset = 0 }) {
      return listStmt.all(workspaceKey, limit, offset).map(mapRow);
    },
    listByWorkspace({ workspaceKey, jobType = null, limit = 500, offset = 0 }) {
      return listByWorkspaceStmt.all(
        workspaceKey,
        jobType,
        jobType,
        Number(limit),
        Number(offset)
      ).map(mapRow);
    },
    markBucketReplaced({ workspaceKey, bucketFolder, finishedAt = new Date().toISOString() }) {
      return markBucketReplacedStmt.run(finishedAt, workspaceKey, bucketFolder).changes;
    },
    markJobTypeReplaced({ workspaceKey, jobType, finishedAt = new Date().toISOString() }) {
      return markJobTypeReplacedStmt.run(finishedAt, workspaceKey, jobType).changes;
    },
  };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = {
  createImportJobRepository,
};
