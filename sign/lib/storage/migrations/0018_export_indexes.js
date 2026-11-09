'use strict';

module.exports = function migrate0018(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bill_match_log_export_daily
      ON bill_match_log (workspace_key, daily_receipt_id, id);
    CREATE INDEX IF NOT EXISTS idx_bill_match_log_export_bill
      ON bill_match_log (workspace_key, store_bill_id, id);
    CREATE INDEX IF NOT EXISTS idx_monthly_data_export_folder
      ON monthly_data (workspace_key, mode_folder, is_unmatched, id);
    CREATE INDEX IF NOT EXISTS idx_monthly_data_export_unmatched
      ON monthly_data (workspace_key, is_unmatched, mode_folder, id);
    CREATE INDEX IF NOT EXISTS idx_pending_review_export_open
      ON pending_review (workspace_key, status, id);
  `);
};
