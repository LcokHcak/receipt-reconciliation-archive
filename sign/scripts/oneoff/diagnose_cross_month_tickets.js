'use strict';

/**
 * L18 诊断(只读,不改任何数据):量化「跨月票」规模——SMG 总账里 purchase_date 早于本工作区账期月的行。
 *
 * 背景:SMG 总账全部归导入工作区(不按购买月拆),而台账按购买日落月。若某工作区(如 2026-07)的
 * 总账里有一张购买日在 6 月的票,它台账落在 2026-06,而 07 的未收清单只查 07 台账 → 永远判它未收
 * → 每周催一张已交的票,无收敛出口。本脚本数出这种「earlier(购买月<账期月)」的行/票号规模,
 * 供拍板「改不改、跨区查 vs 按购买月归属」。
 *
 * 用法(在服务器上,只读):
 *   node scripts/oneoff/diagnose_cross_month_tickets.js
 *   SIGN_STORAGE_ROOT=/path/to/storage node scripts/oneoff/diagnose_cross_month_tickets.js
 */

const path = require('node:path');

// 纯函数:给一个已打开的 monthly db,返回每工作区的跨月统计(可单测)。
function diagnoseCrossMonth(db) {
  const workspaces = db
    .prepare("SELECT DISTINCT workspace_key AS ws FROM import_job WHERE job_type = 'smg_ledger'")
    .all()
    .map((r) => r.ws)
    .filter(Boolean);

  // substr(purchase_date,1,7)='YYYY-MM',与工作区月做字典序比较(月份可比)。只算卖出、有票号的行,
  // 与 customer_reconciliation_service.billUnreceivedStmt 同口径(SMG 源、sale、receipt_no 非空)。
  const stmt = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN purchase_date IS NOT NULL AND substr(purchase_date,1,7) < ? THEN 1 ELSE 0 END) AS earlier,
      SUM(CASE WHEN purchase_date IS NOT NULL AND substr(purchase_date,1,7) > ? THEN 1 ELSE 0 END) AS later,
      COUNT(DISTINCT CASE WHEN purchase_date IS NOT NULL AND substr(purchase_date,1,7) < ? THEN receipt_no END) AS earlierReceipts
    FROM store_bill
    WHERE workspace_key = ?
      AND receipt_no IS NOT NULL AND receipt_no != ''
      AND (transaction_type IS NULL OR transaction_type = 'sale')
      AND import_job_id IN (SELECT id FROM import_job WHERE workspace_key = ? AND job_type = 'smg_ledger')
  `);

  const rows = [];
  for (const ws of workspaces) {
    const m = /(\d{4}-\d{2})/.exec(String(ws || ''));
    if (!m) {
      rows.push({ ws, month: null, total: null, earlier: null, later: null, earlierReceipts: null, note: '无法从 workspace_key 提取 YYYY-MM,跳过' });
      continue;
    }
    const month = m[1];
    const r = stmt.get(month, month, month, ws, ws) || {};
    rows.push({
      ws,
      month,
      total: Number(r.total || 0),
      earlier: Number(r.earlier || 0), // 购买月 < 账期月 = 永判未收风险
      later: Number(r.later || 0), // 购买月 > 账期月(次要)
      earlierReceipts: Number(r.earlierReceipts || 0), // 跨月(earlier)不同票号数
    });
  }
  return rows;
}

function summarize(rows) {
  const valid = rows.filter((r) => r.month);
  return {
    workspaces: valid.length,
    totalSmgRows: valid.reduce((n, r) => n + r.total, 0),
    totalEarlier: valid.reduce((n, r) => n + r.earlier, 0),
    totalEarlierReceipts: valid.reduce((n, r) => n + r.earlierReceipts, 0),
    totalLater: valid.reduce((n, r) => n + r.later, 0),
  };
}

function runCli() {
  const { DatabaseSync } = require('node:sqlite');
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
  const STORAGE = process.env.SIGN_STORAGE_ROOT || path.join(PROJECT_ROOT, 'passport_review_workbench', 'storage');
  const dbPath = path.join(STORAGE, 'monthly.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = diagnoseCrossMonth(db);
    const s = summarize(rows);
    console.log(`\n[L18 跨月票诊断] db=${dbPath}  (只读,未改动任何数据)\n`);
    console.log('工作区\t账期月\tSMG行\t跨月earlier\t跨月票号\t晚月later');
    for (const r of rows) {
      if (!r.month) { console.log(`${r.ws}\t${r.note}`); continue; }
      console.log(`${r.ws}\t${r.month}\t${r.total}\t${r.earlier}\t${r.earlierReceipts}\t${r.later}`);
    }
    console.log(`\n汇总:${s.workspaces} 个 SMG 工作区,共 ${s.totalSmgRows} 行;其中 earlier(购买月<账期月=永判未收风险)= ${s.totalEarlier} 行 / ${s.totalEarlierReceipts} 个不同票号;later= ${s.totalLater} 行。`);
    console.log('→ earlier 规模大 = L18 值得修(选跨区查台账 or SMG 按购买月归属);规模很小 = 可暂缓。\n');
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

if (require.main === module) runCli();

module.exports = { diagnoseCrossMonth, summarize };
