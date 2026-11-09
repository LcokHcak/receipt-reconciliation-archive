'use strict';

function iterateMatchedRowsFor(db, workspaceKey, folder) {
  return {
    rows: iterateRows(db, `
      ${monthlyTraceSelect()}
      WHERE md.workspace_key = ? AND md.mode_folder = ? AND md.is_unmatched = 0
      ORDER BY md.id
    `, traceParams(workspaceKey, folder)),
    count: countMonthlyRows(db, workspaceKey, 'AND mode_folder = ? AND is_unmatched = 0', [folder]),
  };
}

function iterateUnmatchedRows(db, workspaceKey) {
  return {
    rows: iterateRows(db, `
      ${monthlyTraceSelect()}
      WHERE md.workspace_key = ? AND md.is_unmatched = 1
      ORDER BY md.mode_folder, md.id
    `, traceParams(workspaceKey)),
    count: countMonthlyRows(db, workspaceKey, 'AND is_unmatched = 1'),
  };
}

function iterateUnmatchedRowsFor(db, workspaceKey, folder) {
  return {
    rows: iterateRows(db, `
      ${monthlyTraceSelect()}
      WHERE md.workspace_key = ? AND md.mode_folder = ? AND md.is_unmatched = 1
      ORDER BY md.id
    `, traceParams(workspaceKey, folder)),
    count: countMonthlyRows(db, workspaceKey, 'AND mode_folder = ? AND is_unmatched = 1', [folder]),
  };
}

function streamMatchedRowsFor(db, workspaceKey, folder) {
  return Array.from(iterateMatchedRowsFor(db, workspaceKey, folder).rows);
}

function streamUnmatchedRows(db, workspaceKey) {
  return Array.from(iterateUnmatchedRows(db, workspaceKey).rows);
}

function streamUnmatchedRowsFor(db, workspaceKey, folder) {
  return Array.from(iterateUnmatchedRowsFor(db, workspaceKey, folder).rows);
}

function monthlyTraceSelect() {
  return `
    WITH latest_daily_log AS (
      SELECT daily_receipt_id, MAX(id) AS id
      FROM bill_match_log
      WHERE workspace_key = ? AND daily_receipt_id IS NOT NULL
      GROUP BY daily_receipt_id
    ),
    latest_bill_log AS (
      SELECT store_bill_id, MAX(id) AS id
      FROM bill_match_log
      WHERE workspace_key = ? AND store_bill_id IS NOT NULL
      GROUP BY store_bill_id
    )
    SELECT md.*,
           md.id AS trace_monthly_data_id,
           md.daily_receipt_id AS trace_daily_receipt_id,
           md.store_bill_id AS trace_store_bill_id,
           d.source_file AS trace_daily_source_file,
           d.source_sheet AS trace_daily_source_sheet,
           d.source_row AS trace_daily_source_row,
           b.source_file AS trace_bill_source_file,
           b.source_sheet AS trace_bill_source_sheet,
           b.source_row AS trace_bill_source_row,
           l.id AS trace_match_log_id,
           l.match_key AS trace_match_key
    FROM monthly_data md
    LEFT JOIN daily_receipt_export d
      ON d.workspace_key = md.workspace_key AND d.id = md.daily_receipt_id
    LEFT JOIN store_bill b
      ON b.workspace_key = md.workspace_key AND b.id = md.store_bill_id
    LEFT JOIN latest_daily_log ld
      ON ld.daily_receipt_id = md.daily_receipt_id
    LEFT JOIN latest_bill_log lb
      ON lb.store_bill_id = md.store_bill_id
    LEFT JOIN bill_match_log l
      ON l.id = CASE
        WHEN ld.id IS NULL THEN lb.id
        WHEN lb.id IS NULL THEN ld.id
        WHEN ld.id >= lb.id THEN ld.id
        ELSE lb.id
      END
  `;
}

function traceParams(workspaceKey, ...tail) {
  return [workspaceKey, workspaceKey, workspaceKey, ...tail];
}

function countMonthlyRows(db, workspaceKey, extraWhere, extraParams = []) {
  const row = db.prepare(`
    SELECT COUNT(1) AS n
    FROM monthly_data
    WHERE workspace_key = ?
    ${extraWhere || ''}
  `).get(workspaceKey, ...extraParams);
  return Number(row?.n || 0);
}

function iterateRows(db, sql, params) {
  const stmt = db.prepare(sql);
  if (typeof stmt.iterate !== 'function') {
    return stmt.all(...params);
  }
  return {
    [Symbol.iterator]() {
      return stmt.iterate(...params);
    },
  };
}

module.exports = {
  iterateMatchedRowsFor,
  iterateUnmatchedRows,
  iterateUnmatchedRowsFor,
  streamMatchedRowsFor,
  streamUnmatchedRows,
  streamUnmatchedRowsFor,
};
