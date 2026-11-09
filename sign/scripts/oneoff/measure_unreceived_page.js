'use strict';

/**
 * L103 诊断(只读,不改数据):实测未收对账 B 页每次 GET 都跑的两条重查询的耗时/行数,量化「卡」。
 *
 * B 页 buildView 每次 GET 都:①billUnreceivedStmt——store_bill 全表 GROUP BY(SMG 源、无覆盖索引→
 * temp b-tree);②ledgerSeenStmt——daily_receipt_export 全扫。node:sqlite 同步执行,查询期间全站
 * API 停摆。本脚本按工作区分别计时这两条(与 customer_reconciliation_service 逐字同 SQL),报告
 * 耗时/行数/估算响应体积,对照报告门槛(单条或合计 > ~1s / 未收行 JSON > ~5MB 才值得优化)。
 *
 * 用法(服务器上,只读):
 *   node scripts/oneoff/measure_unreceived_page.js
 *   SIGN_STORAGE_ROOT=/path/to/storage node scripts/oneoff/measure_unreceived_page.js
 */

const path = require('node:path');
const { performance } = require('node:perf_hooks');

// 逐字镜像 customer_reconciliation_service 的两条重查询(单源=SMG)。
const BILL_UNRECEIVED_SQL = `
  SELECT mode AS mode_raw, tour_no, purchase_date, name, full_name,
         passport_no, receipt_no, brand,
         store_family AS mode_folder, store_branch,
         MAX(statement_date) AS statement_date,
         SUM(COALESCE(net_usd, 0)) AS net_usd
  FROM store_bill
  WHERE workspace_key = ?
    AND (? IS NULL OR store_family = ?)
    AND receipt_no IS NOT NULL AND receipt_no != ''
    AND (transaction_type IS NULL OR transaction_type = 'sale')
    AND import_job_id IN (SELECT id FROM import_job WHERE workspace_key = ? AND job_type = 'smg_ledger')
  GROUP BY passport_no, name, receipt_no
  ORDER BY mode, passport_no, receipt_no
`;
const LEDGER_SEEN_SQL = `
  SELECT passport_no, name, receipt_no
  FROM daily_receipt_export
  WHERE workspace_key = ?
    AND receipt_no IS NOT NULL AND receipt_no != ''
`;

// 纯函数:给已打开的 db,测每工作区两条重查询的耗时/行数(可单测行数,耗时随机器)。
function measureUnreceived(db) {
  const workspaces = db
    .prepare("SELECT DISTINCT workspace_key AS ws FROM import_job WHERE job_type = 'smg_ledger'")
    .all()
    .map((r) => r.ws)
    .filter(Boolean);
  const bill = db.prepare(BILL_UNRECEIVED_SQL);
  const ledger = db.prepare(LEDGER_SEEN_SQL);

  const results = [];
  for (const ws of workspaces) {
    const t1 = performance.now();
    const billRowsArr = bill.all(ws, null, null, ws);
    const billMs = performance.now() - t1;
    const t2 = performance.now();
    const ledgerRows = ledger.all(ws).length;
    const ledgerMs = performance.now() - t2;
    // 未收行 JSON 体积粗估:每行约 200 字节(9 列 + 派生)。
    const approxBytes = billRowsArr.length * 200;
    results.push({
      ws,
      billMs: Math.round(billMs * 100) / 100,
      billRows: billRowsArr.length,
      ledgerMs: Math.round(ledgerMs * 100) / 100,
      ledgerRows,
      totalMs: Math.round((billMs + ledgerMs) * 100) / 100,
      approxUnreceivedBytes: approxBytes,
    });
  }
  return results;
}

function runCli() {
  const { DatabaseSync } = require('node:sqlite');
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
  const STORAGE = process.env.SIGN_STORAGE_ROOT || path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
  const dbPath = path.join(STORAGE, 'monthly.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = measureUnreceived(db);
    console.log(`\n[L103 未收页耗时实测] db=${dbPath}  (只读,未改动任何数据)\n`);
    console.log('工作区\tbill_ms\tbill行\tledger_ms\tledger行\t合计ms\t未收JSON估算');
    let worst = 0;
    for (const r of rows) {
      const mb = (r.approxUnreceivedBytes / 1024 / 1024).toFixed(2);
      const flag = r.totalMs > 1000 ? '  ⚠️>1s' : '';
      worst = Math.max(worst, r.totalMs);
      console.log(`${r.ws}\t${r.billMs}\t${r.billRows}\t${r.ledgerMs}\t${r.ledgerRows}\t${r.totalMs}\t~${mb}MB${flag}`);
    }
    console.log(`\n最慢工作区合计 ${worst} ms。门槛(报告):单次 > ~1000ms 或未收行 JSON > ~5MB 即值得优化。`);
    console.log('注:B 页每次 GET 还叠加 syncGroupTasks 逐组点查 + statusCount 三遍重算,实际比这两条更慢。\n');
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

if (require.main === module) runCli();

module.exports = { measureUnreceived };
