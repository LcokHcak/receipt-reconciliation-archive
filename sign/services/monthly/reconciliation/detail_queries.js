'use strict';

const {
  mapLedgerRow,
  mapStoreBillRow,
  mapMonthlyTraceRow,
  mapPendingRow,
  mapBillMatchRow,
} = require('./mappers');

function createDetailQueries({ db }) {
  function buildDetailSections({ workspaceKey, limit }) {
    return {
      postedLedger: {
        title: '已入月台账明细',
        rows: listLedgerRows({ workspaceKey, statuses: ['posted', 'locked'], limit }),
      },
      readyLedger: {
        title: '待确认入月台账明细',
        rows: listLedgerRows({ workspaceKey, statuses: ['ready_to_post'], limit }),
      },
      remedyLedger: {
        title: '待补救台账明细',
        rows: listLedgerRows({ workspaceKey, statuses: ['remedy'], limit }),
      },
      storeBills: {
        title: '店铺账单明细',
        rows: listStoreBillRows({ workspaceKey, limit }),
      },
      monthlyMatched: {
        title: '正式入月明细',
        rows: listMonthlyTraceRows({ workspaceKey, isUnmatched: false, limit }),
      },
      monthlyUnreceived: {
        title: '账单有但未收明细',
        rows: listMonthlyTraceRows({ workspaceKey, isUnmatched: true, limit }),
      },
      pendingReview: {
        title: '待人工确认明细',
        rows: listPendingRows({ workspaceKey, limit }),
      },
      billMatchLogs: {
        title: '账单匹配日志明细',
        rows: listBillMatchRows({ workspaceKey, limit }),
      },
    };
  }

  function listLedgerRows({ workspaceKey, statuses, limit }) {
    const placeholders = statuses.map(() => '?').join(', ');
    return db.prepare(`
      SELECT id, receipt_date, ledger_status, remedy_reason, agent, modified_by,
             purchase_date, tour_no, name, passport_no, receipt_no, shop,
             source_file, source_sheet, source_row, source_batch_id,
             source_task_id, row_hash, imported_at
      FROM daily_receipt_export
      WHERE workspace_key = ? AND ledger_status IN (${placeholders})
      ORDER BY receipt_date DESC, id DESC
      LIMIT ?
    `).all(workspaceKey, ...statuses, Number(limit)).map(mapLedgerRow);
  }

  function listStoreBillRows({ workspaceKey, limit }) {
    return db.prepare(`
      SELECT id, store_family, store_branch, mode, tour_no, purchase_date,
             name, full_name, passport_no, receipt_no, source_file,
             source_sheet, source_row, row_hash, imported_at
      FROM store_bill
      WHERE workspace_key = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(workspaceKey, Number(limit)).map(mapStoreBillRow);
  }

  function listMonthlyTraceRows({ workspaceKey, isUnmatched, limit }) {
    const flag = isUnmatched ? 1 : 0;
    return db.prepare(`
      SELECT md.id AS monthly_id, md.mode_folder, md.is_unmatched,
             md.daily_receipt_id, md.store_bill_id, md.receipt_no, md.name,
             md.passport_no, md.tour_no, md.purchase_date, md.shop,
             d.source_file AS daily_source_file,
             d.source_sheet AS daily_source_sheet,
             d.source_row AS daily_source_row,
             d.source_batch_id AS daily_source_batch_id,
             d.source_task_id AS daily_source_task_id,
             d.modified_by AS daily_modified_by,
             d.receipt_date AS daily_receipt_date,
             b.source_file AS bill_source_file,
             b.source_sheet AS bill_source_sheet,
             b.source_row AS bill_source_row,
             b.store_family AS bill_store_family,
             b.store_branch AS bill_store_branch,
             l.id AS match_log_id,
             l.match_priority,
             l.match_key,
             l.match_status,
             l.note AS match_note
      FROM monthly_data md
      LEFT JOIN daily_receipt_export d
        ON d.workspace_key = md.workspace_key AND d.id = md.daily_receipt_id
      LEFT JOIN store_bill b
        ON b.workspace_key = md.workspace_key AND b.id = md.store_bill_id
      LEFT JOIN bill_match_log l
        ON l.id = (
          SELECT l2.id
          FROM bill_match_log l2
          WHERE l2.workspace_key = md.workspace_key
            AND (
              (md.daily_receipt_id IS NOT NULL AND l2.daily_receipt_id = md.daily_receipt_id)
              OR (md.store_bill_id IS NOT NULL AND l2.store_bill_id = md.store_bill_id)
            )
          ORDER BY l2.id DESC
          LIMIT 1
        )
      WHERE md.workspace_key = ? AND md.is_unmatched = ?
      ORDER BY md.id DESC
      LIMIT ?
    `).all(workspaceKey, flag, Number(limit)).map(mapMonthlyTraceRow);
  }

  function listPendingRows({ workspaceKey, limit }) {
    return db.prepare(`
      SELECT p.id, p.source_table, p.source_id, p.reason_type, p.detail,
             p.status, p.created_at, p.resolved_at, p.resolved_by,
             d.receipt_no AS daily_receipt_no,
             d.name AS daily_name,
             d.passport_no AS daily_passport_no,
             d.source_file AS daily_source_file,
             d.source_sheet AS daily_source_sheet,
             d.source_row AS daily_source_row,
             b.receipt_no AS bill_receipt_no,
             b.name AS bill_name,
             b.passport_no AS bill_passport_no,
             b.source_file AS bill_source_file,
             b.source_sheet AS bill_source_sheet,
             b.source_row AS bill_source_row
      FROM pending_review p
      LEFT JOIN daily_receipt_export d
        ON p.source_table = 'daily_receipt_export'
       AND d.workspace_key = p.workspace_key
       AND d.id = p.source_id
      LEFT JOIN store_bill b
        ON p.source_table = 'store_bill'
       AND b.workspace_key = p.workspace_key
       AND b.id = p.source_id
      WHERE p.workspace_key = ? AND p.status = 'open'
      ORDER BY p.id DESC
      LIMIT ?
    `).all(workspaceKey, Number(limit)).map(mapPendingRow);
  }

  function listBillMatchRows({ workspaceKey, limit }) {
    return db.prepare(`
      SELECT l.id, l.daily_receipt_id, l.store_bill_id, l.match_priority,
             l.match_key, l.match_status, l.matched_at, l.note,
             d.receipt_no AS daily_receipt_no,
             d.name AS daily_name,
             d.passport_no AS daily_passport_no,
             d.source_file AS daily_source_file,
             d.source_sheet AS daily_source_sheet,
             d.source_row AS daily_source_row,
             b.receipt_no AS bill_receipt_no,
             b.name AS bill_name,
             b.passport_no AS bill_passport_no,
             b.source_file AS bill_source_file,
             b.source_sheet AS bill_source_sheet,
             b.source_row AS bill_source_row
      FROM bill_match_log l
      LEFT JOIN daily_receipt_export d
        ON d.workspace_key = l.workspace_key AND d.id = l.daily_receipt_id
      LEFT JOIN store_bill b
        ON b.workspace_key = l.workspace_key AND b.id = l.store_bill_id
      WHERE l.workspace_key = ?
      ORDER BY l.id DESC
      LIMIT ?
    `).all(workspaceKey, Number(limit)).map(mapBillMatchRow);
  }

  return {
    buildDetailSections,
    listLedgerRows,
    listStoreBillRows,
    listMonthlyTraceRows,
    listPendingRows,
    listBillMatchRows,
  };
}

module.exports = { createDetailQueries };
