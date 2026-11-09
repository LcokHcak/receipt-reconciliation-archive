'use strict';

const { normalizeName, normalizeString } = require('../../lib/monthly_pipeline/matching/field_diff');
const { runSqliteTransaction } = require('../../lib/storage/sqlite_transaction');

/**
 * 台账跨小票一致性检查(错表 B 类):
 *   - 同一护照号 出现多个姓名(一护照几姓名)
 *   - 同一姓名   出现多个护照号(一姓名两护照)
 *
 * 结果直接写进 daily_receipt_export.conflict_fields(和账单字段冲突同一列),
 * 这样这些行**自动出现在「账单核对」字段冲突列表里**,审核员在原地就能看到并修正,
 * 不需要新页面/新按钮。标记带 kind:'consistency' 以便幂等重算时只清自己那部分。
 *
 * 每条冲突标记形状(复用 BillConflictRow 的 {field, dailyValue, billValue}):
 *   { field, dailyValue: 本行值, billValue: '同XX其他票: a / b', kind: 'consistency', variants: [...] }
 *
 * 只读 daily + 写 conflict_fields,不碰返点/匹配状态。
 */
function detectLedgerConsistency({ dailyReceiptRepo, db = null }) {
  if (!dailyReceiptRepo || (
    typeof dailyReceiptRepo._listConsistencyCandidates !== 'function'
    && typeof dailyReceiptRepo._listAll !== 'function'
  )) {
    return { ran: false, nameConflictRows: 0, passportConflictRows: 0 };
  }

  function run({ workspaceKey }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const rows = typeof dailyReceiptRepo._listConsistencyCandidates === 'function'
      ? dailyReceiptRepo._listConsistencyCandidates({ workspaceKey })
      : dailyReceiptRepo._listAll({ workspaceKey });

    // 护照 → 出现过的不同姓名(原值);姓名 → 不同护照
    const namesByPassport = new Map();
    const passportsByName = new Map();
    for (const r of rows) {
      const p = normalizeString(r.passportNo);
      const n = normalizeName(r.name);
      if (p && r.name) {
        if (!namesByPassport.has(p)) namesByPassport.set(p, new Map());
        namesByPassport.get(p).set(n, String(r.name).trim());
      }
      if (n && r.passportNo) {
        if (!passportsByName.has(n)) passportsByName.set(n, new Map());
        passportsByName.get(n).set(p, String(r.passportNo).trim());
      }
    }

    let nameConflictRows = 0;
    let passportConflictRows = 0;
    const updates = [];

    for (const r of rows) {
      const p = normalizeString(r.passportNo);
      const n = normalizeName(r.name);
      const markers = [];

      // 同护照多名 → 这行的"姓名"存疑
      const names = p ? namesByPassport.get(p) : null;
      if (names && names.size > 1) {
        const others = [...names.values()].filter((v) => normalizeName(v) !== n);
        markers.push({
          field: 'name',
          dailyValue: r.name ?? null,
          billValue: null, // 一致性冲突无"账单侧"单值 → 禁用"用账单值",审核员自定义修正
          kind: 'consistency',
          reason: 'ledger_name_conflict',
          note: `同护照(${r.passportNo})其他票的姓名: ${others.join(' / ')}`,
          variants: [...names.values()],
        });
        nameConflictRows += 1;
      }

      // 同名多护照 → 这行的"护照"存疑
      const passports = n ? passportsByName.get(n) : null;
      if (passports && passports.size > 1) {
        const others = [...passports.values()].filter((v) => normalizeString(v) !== p);
        markers.push({
          field: 'passportNo',
          dailyValue: r.passportNo ?? null,
          billValue: null,
          kind: 'consistency',
          reason: 'ledger_passport_conflict',
          note: `同姓名(${r.name})其他票的护照: ${others.join(' / ')}`,
          variants: [...passports.values()],
        });
        passportConflictRows += 1;
      }

      // 合并:保留该行已有的"账单字段冲突",只重写自己的 consistency 部分(幂等)。
      const existing = Array.isArray(r.conflictFields) ? r.conflictFields : [];
      const keptNonConsistency = existing.filter((c) => c && c.kind !== 'consistency');
      const next = [...keptNonConsistency, ...markers];

      const before = JSON.stringify(existing);
      const after = JSON.stringify(next);
      if (before !== after) {
        updates.push({ id: r.id, conflictFields: next.length ? next : null });
      }
    }

    // 大月份性能:把逐行 setConflictFields(各一次 fsync)合并进单事务一次提交。
    if (updates.length) {
      const apply = () => {
        for (const u of updates) {
          dailyReceiptRepo.setConflictFields({ id: u.id, workspaceKey, conflictFields: u.conflictFields });
        }
      };
      if (db) runSqliteTransaction(db, apply, { savepointName: 'ledger_consistency_writes', preferSavepoint: true });
      else apply();
    }

    return {
      ran: true,
      nameConflictRows,
      passportConflictRows,
      totalRows: rows.length,
      writtenRows: updates.length,
    };
  }

  return { run };
}

module.exports = { detectLedgerConsistency };
