'use strict';

const STAGE_LABELS = Object.freeze({
  import_store_bill: '导入店铺账单',
  received_receipt_export: '生成收票汇总',
  bill_match: '账单匹配',
  merge: '合并月度数据',
  second_pass: '二次扫漏',
  export: '导出交付包',
  tour_match: '团号匹配',
});

const STAGE_STATUS_LABELS = Object.freeze({
  running: '运行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
});

const LEDGER_STATUS_LABELS = Object.freeze({
  in_review: '待匹配',
  remedy: '待补救',
  ready_to_post: '待确认入月',
  posted: '已入月',
  locked: '已锁月',
});

const PENDING_REASON_LABELS = Object.freeze({
  field_conflict: '字段冲突',
  fuzzy_match: '疑似匹配',
  ambiguous_match: '多个候选',
  second_pass_candidate: '二次扫漏候选',
  tour_not_found: '团号未找到',
  agent_mismatch: '代理不一致',
  mode_unresolved: '模式无法归类',
});

function countMonthlyRows(list = [], isUnmatched) {
  if (!Array.isArray(list)) return 0;
  return list
    .filter((item) => Boolean(Number(item.unmatched)) === isUnmatched)
    .reduce((sum, item) => sum + Number(item.n || 0), 0);
}

function countStatus(counts, status) {
  return Number(counts.ledgerByStatus?.[status] || 0);
}

function toStatusMap(rows = [], keyName, valueName) {
  const out = {};
  for (const row of rows || []) {
    const key = row?.[keyName];
    if (!key) continue;
    out[key] = Number(row?.[valueName] || 0);
  }
  return out;
}

function buildSource(file, sheet, row) {
  return {
    file: file || '',
    sheet: sheet || '',
    row: row == null ? null : Number(row),
  };
}

function fmt(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function safeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

module.exports = {
  STAGE_LABELS,
  STAGE_STATUS_LABELS,
  LEDGER_STATUS_LABELS,
  PENDING_REASON_LABELS,
  countMonthlyRows,
  countStatus,
  toStatusMap,
  buildSource,
  fmt,
  safeJson,
  clampInt,
};
