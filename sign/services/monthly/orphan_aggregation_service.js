'use strict';

/**
 * orphan_aggregation_service — 孤立账单 + 孤立行聚合 (Sprint E E0b)
 *
 * 孤立账单: store_bill 中没有任何 matched bill_match_log 记录的行
 * 孤立行  : daily_receipt_export 中 bill_match_status='unmatched' 的行
 *
 * 对每条孤立项提供最多 3 个模糊匹配候选（score >= 0.3）：
 *   amount 0.4 + date 0.25 + mode 0.2 + passportNo 0.1 + name 0.05
 */

// ── 评分权重 ────────────────────────────────────────────────────────────────
const W_AMOUNT   = 0.40;
const W_DATE     = 0.25;
const W_MODE     = 0.20;
const W_PASSPORT = 0.10;
const W_NAME     = 0.05;
const THRESHOLD  = 0.30;
const MAX_CANDS  = 3;
const PRE_FILTER_CAP = 200;   // 超过此数量时裁剪候选池到 50
const PRE_FILTER_TRIM = 50;

// ── 评分函数 ─────────────────────────────────────────────────────────────────

function scoreAmount(a, b) {
  if (a == null || b == null) return 0;
  const lo = Math.min(Math.abs(a), Math.abs(b));
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (hi === 0) return 1;
  const ratio = lo / hi;
  return ratio >= 0.9 ? 1 : ratio >= 0.7 ? 0.5 : 0;
}

function scoreDate(a, b) {
  if (!a || !b) return 0;
  const da = new Date(a).getTime();
  const db_ = new Date(b).getTime();
  if (isNaN(da) || isNaN(db_)) return 0;
  const diffDays = Math.abs(da - db_) / 86_400_000;
  return diffDays === 0 ? 1 : diffDays <= 3 ? 0.5 : diffDays <= 7 ? 0.2 : 0;
}

function scoreMode(a, b) {
  if (!a || !b) return 0;
  return String(a).trim() === String(b).trim() ? 1 : 0;
}

function scorePassport(a, b) {
  if (!a || !b) return 0;
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase() ? 1 : 0;
}

function scoreName(a, b) {
  if (!a || !b) return 0;
  const la = String(a).trim().toUpperCase();
  const lb = String(b).trim().toUpperCase();
  if (la === lb) return 1;
  if (la.includes(lb) || lb.includes(la)) return 0.5;
  return 0;
}

function computeScore(bill, row) {
  return (
    W_AMOUNT   * scoreAmount(bill.netKrw, row.netKrw)
    + W_DATE     * scoreDate(bill.purchaseDate, row.purchaseDate)
    + W_MODE     * scoreMode(bill.modeNormalized || bill.mode, row.modeNormalized || row.modeRaw)
    + W_PASSPORT * scorePassport(bill.passportNo, row.passportNo)
    + W_NAME     * scoreName(bill.name, row.name)
  );
}

// ── 日期过滤 helper ───────────────────────────────────────────────────────────
function passesDateFilter(dateStr, from, to) {
  if (!from && !to) return true;
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

function passesSearch(text, search) {
  if (!search) return true;
  const q = String(search).trim().toLowerCase();
  if (!q) return true;
  return String(text || '').toLowerCase().includes(q);
}

// ── 服务工厂 ─────────────────────────────────────────────────────────────────

function createOrphanAggregationService({ db }) {
  if (!db) throw new Error('orphan_aggregation_service: db is required');

  // ── SQL helpers ─────────────────────────────────────────────────────────
  const orphanBillsStmt = db.prepare(`
    SELECT sb.*
    FROM store_bill sb
    WHERE sb.workspace_key = ?
      AND EXISTS (
        SELECT 1 FROM bill_match_log bml
        WHERE bml.workspace_key = sb.workspace_key
          AND bml.store_bill_id = sb.id
          AND bml.match_status = 'unmatched'
      )
    ORDER BY sb.purchase_date DESC, sb.id DESC
    LIMIT ? OFFSET ?
  `);
  const orphanRowsStmt = db.prepare(`
    SELECT *
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND bill_match_status = 'unmatched'
    ORDER BY purchase_date DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  // 候选 daily 行（按 netKrw 范围粗过滤）
  const candidateRowsStmt = db.prepare(`
    SELECT id, purchase_date, mode_raw, mode_normalized, name, passport_no,
           net_krw, net_usd, gross_krw
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND bill_match_status = 'unmatched'
      AND (? IS NULL OR (net_krw BETWEEN ? AND ?))
    LIMIT ?
  `);

  // 候选 store_bill 行（按 netKrw 范围粗过滤）
  const candidateBillsStmt = db.prepare(`
    SELECT id, purchase_date, mode, mode_normalized, name, passport_no,
           net_krw, net_usd, gross_krw
    FROM store_bill
    WHERE workspace_key = ?
      AND EXISTS (
        SELECT 1 FROM bill_match_log bml
        WHERE bml.workspace_key = store_bill.workspace_key
          AND bml.store_bill_id = store_bill.id
          AND bml.match_status = 'unmatched'
      )
      AND (? IS NULL OR (net_krw BETWEEN ? AND ?))
    LIMIT ?
  `);

  // ── 候选匹配逻辑 ──────────────────────────────────────────────────────────
  function findBillCandidates(workspaceKey, row) {
    const krw = row.netKrw ?? row.net_krw;
    const lo = krw != null ? krw * 0.5 : null;
    const hi = krw != null ? krw * 2.0 : null;
    const bills = candidateBillsStmt.all(
      workspaceKey,
      lo != null ? 1 : null,
      lo, hi,
      PRE_FILTER_CAP
    );
    let pool = bills.length >= PRE_FILTER_CAP ? bills.slice(0, PRE_FILTER_TRIM) : bills;
    return pool
      .map((b) => ({
        id: b.id,
        score: computeScore(
          { netKrw: b.net_krw, purchaseDate: b.purchase_date, modeNormalized: b.mode_normalized, mode: b.mode, passportNo: b.passport_no, name: b.name },
          { netKrw: row.net_krw ?? row.netKrw, purchaseDate: row.purchase_date ?? row.purchaseDate, modeNormalized: row.mode_normalized ?? row.modeNormalized, modeRaw: row.mode_raw ?? row.modeRaw, passportNo: row.passport_no ?? row.passportNo, name: row.name }
        ),
      }))
      .filter((c) => c.score >= THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDS);
  }

  function findRowCandidates(workspaceKey, bill) {
    const krw = bill.netKrw ?? bill.net_krw;
    const lo = krw != null ? krw * 0.5 : null;
    const hi = krw != null ? krw * 2.0 : null;
    const rows = candidateRowsStmt.all(
      workspaceKey,
      lo != null ? 1 : null,
      lo, hi,
      PRE_FILTER_CAP
    );
    let pool = rows.length >= PRE_FILTER_CAP ? rows.slice(0, PRE_FILTER_TRIM) : rows;
    return pool
      .map((r) => ({
        id: r.id,
        score: computeScore(
          { netKrw: bill.net_krw ?? bill.netKrw, purchaseDate: bill.purchase_date ?? bill.purchaseDate, modeNormalized: bill.mode_normalized ?? bill.modeNormalized, mode: bill.mode, passportNo: bill.passport_no ?? bill.passportNo, name: bill.name },
          { netKrw: r.net_krw, purchaseDate: r.purchase_date, modeNormalized: r.mode_normalized, modeRaw: r.mode_raw, passportNo: r.passport_no, name: r.name }
        ),
      }))
      .filter((c) => c.score >= THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDS);
  }

  // ── 公开 API ──────────────────────────────────────────────────────────────

  function listOrphanBills({ workspaceKey, mode = null, dateFrom = null, dateTo = null, search = null, limit = 50, offset = 0 }) {
    const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
    const off = Math.max(0, Number(offset) || 0);
    let rows = orphanBillsStmt.all(workspaceKey, 2000, 0);  // fetch larger pool for filtering
    // Apply in-memory filters (mode, date, search)
    rows = rows.filter((r) => {
      if (mode && (r.mode_normalized || r.mode) !== mode) return false;
      if (!passesDateFilter(r.purchase_date, dateFrom, dateTo)) return false;
      if (!passesSearch(`${r.name || ''} ${r.passport_no || ''} ${r.receipt_no || ''}`, search)) return false;
      return true;
    });
    const filteredTotal = rows.length;
    const page = rows.slice(off, off + lim);
    const items = page.map((bill) => ({
      id: bill.id,
      workspaceKey: bill.workspace_key,
      storeFamily: bill.store_family,
      storeBranch: bill.store_branch,
      mode: bill.mode,
      modeNormalized: bill.mode_normalized,
      name: bill.name,
      passportNo: bill.passport_no,
      purchaseDate: bill.purchase_date,
      receiptNo: bill.receipt_no,
      netKrw: bill.net_krw,
      netUsd: bill.net_usd,
      grossKrw: bill.gross_krw,
      candidates: findRowCandidates(workspaceKey, bill),
    }));
    return { items, total: filteredTotal, limit: lim, offset: off };
  }

  function listDailyWithoutBill({ workspaceKey, mode = null, dateFrom = null, dateTo = null, search = null, limit = 50, offset = 0 }) {
    const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
    const off = Math.max(0, Number(offset) || 0);
    let rows = orphanRowsStmt.all(workspaceKey, 2000, 0);  // fetch larger pool for filtering
    // Apply in-memory filters
    rows = rows.filter((r) => {
      if (mode && (r.mode_normalized || r.mode_raw) !== mode) return false;
      if (!passesDateFilter(r.purchase_date, dateFrom, dateTo)) return false;
      if (!passesSearch(`${r.name || ''} ${r.passport_no || ''} ${r.receipt_no || ''}`, search)) return false;
      return true;
    });
    const filteredTotal = rows.length;
    const page = rows.slice(off, off + lim);
    const items = page.map((row) => ({
      id: row.id,
      workspaceKey: row.workspace_key,
      modeRaw: row.mode_raw,
      modeNormalized: row.mode_normalized,
      name: row.name,
      passportNo: row.passport_no,
      purchaseDate: row.purchase_date,
      receiptNo: row.receipt_no,
      netKrw: row.net_krw,
      netUsd: row.net_usd,
      grossKrw: row.gross_krw,
      billMatchStatus: row.bill_match_status,
      candidates: findBillCandidates(workspaceKey, row),
    }));
    return { items, total: filteredTotal, limit: lim, offset: off };
  }

  function listOrphanRows({ limit = 50, offset = 0 } = {}) {
    const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
    const off = Math.max(0, Number(offset) || 0);
    return {
      items: [],
      total: 0,
      limit: lim,
      offset: off,
      deprecated: true,
      replacement: 'bill_match_daily_without_bill',
    };
  }

  return { listOrphanBills, listOrphanRows, listDailyWithoutBill };
}

module.exports = { createOrphanAggregationService };
