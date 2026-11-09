'use strict';

const { runSqliteTransaction } = require('../../lib/storage/sqlite_transaction');
const { computeDailyRowHash } = require('../../lib/monthly/daily_row_hash');
// L496:与桥接 dailyRowHashOf 同源的数字投影(剥杠),用于跨月迁移时对齐去重哈希口径(非副本)。
const { normalizeReceiptNoDigits } = require('../../lib/workbench_field_normalizer');
const { recordFieldHistory } = require('../../lib/monthly/field_history');
const {
  filterStageUpdates,
  getLockedFields,
  serializeLockedFields,
} = require('../../lib/monthly/manual_lock');
const {
  ALLOWED_FIELD_UPDATES,
  CAMEL_BY_COL,
  FIELD_COLS,
  NUMERIC_COLS,
  addOwnerScopeCondition,
  normalizeFieldValue,
} = require('./common');

// L518:结算去重业务键(与 insertRowsCore/service SETTLE_BUSINESS_KEY_FIELDS 同口径)——背书
// carry-forward 判断「确认行是否锁了业务键」用它(锁了业务键的确认行不 carry,与 #33 一致)。
const SETTLE_BUSINESS_KEY_FIELDS = new Set(['receipt_no', 'shop', 'purchase_date']);

const NON_MANUAL_LOCK_COLUMNS = new Set(['modified_by', 'posted_at', 'posted_by']);

// 换团号表后"重新匹配未命中行":把这些待补救状态打回 pending 让 tour_match 用新表重跑。
// matched(含人工补救锁定的)不动;date_missing 缺购买日期、重跑也救不了 → 不重置,留人工。
const REMATCH_RESET_STATUSES = Object.freeze([
  'tour_not_found', 'tour_ambiguous', 'tour_store_mismatch', 'date_out_of_window', 'agent_mismatch', 'mode_unresolved',
]);

function buildInsertValues(row) {
  return [
    row.workspaceKey,
    row.sourceCustomerId || null,
    ...FIELD_COLS.map((col) => {
      const value = row[CAMEL_BY_COL[col]];
      if (value == null || value === '') return null;
      if (NUMERIC_COLS.has(col)) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
      return value;
    }),
    row.billMatchStatus || 'unmatched',
    row.billMatchPriority == null ? null : Number(row.billMatchPriority),
    row.modeFolder || null,
    row.tourMatchStatus || 'pending',
    row.sourceFile || null,
    row.sourceSheet || null,
    row.sourceRow == null ? null : Number(row.sourceRow),
    row.rawPayload ? JSON.stringify(row.rawPayload) : null,
    row.rowHash,
    row.importedAt,
    row.importJobId || null,
    row.receiptDate || (row.importedAt ? String(row.importedAt).slice(0, 10) : null),
    row.agentId == null ? null : Number(row.agentId),
    row.agentCode || null,
    row.sourceType || 'imported',
    row.sourceBatchId || null,
    row.sourceTaskId || null,
    row.modifiedBy || null,
    row.ledgerStatus || 'posted',
    row.remedyReason || null,
    row.postedAt || row.importedAt || null,
    row.postedBy || null,
    // 复核HIGH-1(2026-07-16):此前 insert 列清单缺下面 4 列(迁移后加的),重结算失败回滚
    // (restoreOldRows:_fetchFullById→insertMany 往返)会静默丢手动锁/渠道确认戳/冲突标记。
    // 其它插入路径从不带这些字段 → 恒 null,与 schema 默认一致,零行为变化。
    row.conflictFields == null ? null : JSON.stringify(row.conflictFields),
    row.manualLockedFields ?? null,
    row.modeConfirmedAt || null,
    row.modeConfirmedBy || null,
  ];
}

function createDailyReceiptWrites({ db, fieldHistoryRepo = null }) {
  const insertCols = [
    'workspace_key', 'source_customer_id', ...FIELD_COLS,
    'bill_match_status', 'bill_match_priority', 'mode_folder',
    'tour_match_status', 'source_file', 'source_sheet', 'source_row',
    'raw_payload', 'row_hash', 'imported_at', 'import_job_id',
    'receipt_date', 'agent_id', 'agent_code',
    'source_type', 'source_batch_id', 'source_task_id', 'modified_by',
    'ledger_status', 'remedy_reason', 'posted_at', 'posted_by',
    // 复核HIGH-1:补齐迁移列(顺序与 buildInsertValues 尾部一一对应)
    'conflict_fields', 'manual_locked_fields', 'mode_confirmed_at', 'mode_confirmed_by',
  ];
  const placeholders = insertCols.map(() => '?').join(', ');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO daily_receipt_export (${insertCols.join(', ')})
    VALUES (${placeholders})
  `);
  const receiptBusinessExistsStmt = db.prepare(`
    SELECT id
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND COALESCE(receipt_no, '') = ?
      AND COALESCE(shop, '') = ?
      AND COALESCE(purchase_date, '') = ?
    LIMIT 1
  `);
  const deleteByIdStmt = db.prepare(`
    DELETE FROM daily_receipt_export
    WHERE workspace_key = ? AND id = ?
  `);
  // 删台账时一并清掉这条派生出来的下游数据,避免「删了台账,阻塞项/待补救/月度行还挂着」的孤儿。
  const selectReceiptNoStmt = db.prepare(
    'SELECT receipt_no FROM daily_receipt_export WHERE workspace_key = ? AND id = ?',
  );
  const cascadeStmts = {
    pendingReview: db.prepare(
      "DELETE FROM pending_review WHERE workspace_key = ? AND source_table = 'daily_receipt_export' AND source_id = ?",
    ),
    matchBadcase: db.prepare('DELETE FROM match_badcase WHERE workspace_key = ? AND daily_receipt_id = ?'),
    monthlyData: db.prepare('DELETE FROM monthly_data WHERE workspace_key = ? AND daily_receipt_id = ?'),
    billMatchLog: db.prepare('DELETE FROM bill_match_log WHERE workspace_key = ? AND daily_receipt_id = ?'),
    // L610-④:error_record 已有行级 source_id(=daily_receipt_export.id),删台账行时按行精确清它
    // 自己的 open TM error(消孤儿:同票号多行时删 A 留 B,A 的 error 也能清掉,不再被 receipt_no 撞 B
    // 而留孤儿)。legacy(source_id 为 null,本列上线前的旧 error)仍走下面 receipt_no 兜底路径。
    errorRecordTmBySourceId: db.prepare(
      "DELETE FROM error_record WHERE workspace_key = ? AND source_table = 'daily_receipt_export' AND source_id = ? AND status = 'open' AND error_type LIKE 'TM%'",
    ),
    // 兜底扫尾:当该 receipt_no 的**最后一行**台账被删(remaining.c===0),其名下所有 TM error 都成
    // 孤儿(含 legacy source_id 为 null 的旧 error、及按行漏网的),整票号清干净。remaining.c===0 保证
    // 无存活兄弟行,删全部安全不误伤;仅团号匹配类(TM_*)。同票多行未删尽时靠上面按 source_id 逐行清。
    countDailyByReceipt: db.prepare(
      "SELECT COUNT(*) AS c FROM daily_receipt_export WHERE workspace_key = ? AND receipt_no = ?",
    ),
    errorRecordTm: db.prepare(
      "DELETE FROM error_record WHERE workspace_key = ? AND receipt_no = ? AND error_type LIKE 'TM%'",
    ),
    // B3(2026-07-16 同步一致性审计):field_conflict 类待审挂在 store_bill 名下,台账 id 藏在
    // detail.dailyReceiptId——上面按 source_id 的级联清不到它;行删了它残留 open,resolve 时
    // daily_not_found 保持 open(幽灵成功防线的新口径)= **永久卡住的死待审**。这里按 json_extract
    // 关闭(closeFieldConflictByDailyReceiptId 同款谓词),留 resolution 备注可追溯,不物理删。
    pendingReviewStoreBillSide: db.prepare(`
      UPDATE pending_review
      SET status = 'resolved', resolution = 'daily_row_deleted', resolved_by = 'cascade', resolved_at = ?
      WHERE workspace_key = ? AND source_table = 'store_bill' AND status = 'open'
        AND reason_type = 'field_conflict'
        AND json_extract(detail, '$.dailyReceiptId') = ?
    `),
  };
  // 删 ids 对应的台账行 + 级联清下游。单事务,返回删掉的台账行数。
  function deleteRowsWithCascade(workspaceKey, ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
    if (!list.length) return 0;
    return runSqliteTransaction(db, () => {
      let deleted = 0;
      for (const id of list) {
        const before = selectReceiptNoStmt.get(workspaceKey, id);
        const receiptNo = before ? before.receipt_no : null;
        const changes = deleteByIdStmt.run(workspaceKey, id).changes;
        if (!changes) continue;
        deleted += changes;
        cascadeStmts.pendingReview.run(workspaceKey, id);
        cascadeStmts.pendingReviewStoreBillSide.run(new Date().toISOString(), workspaceKey, id); // B3
        cascadeStmts.matchBadcase.run(workspaceKey, id);
        cascadeStmts.monthlyData.run(workspaceKey, id);
        cascadeStmts.billMatchLog.run(workspaceKey, id);
        // L610-④:按行(source_id)精确清被删行自己的 open TM error——同票号多行时删 A 留 B,
        // A 的 error 也清得掉(不再被 countDailyByReceipt 撞 B 而留孤儿虚计)。
        cascadeStmts.errorRecordTmBySourceId.run(workspaceKey, id);
        if (receiptNo) {
          const remaining = cascadeStmts.countDailyByReceipt.get(workspaceKey, receiptNo);
          if (!remaining || Number(remaining.c) === 0) {
            cascadeStmts.errorRecordTm.run(workspaceKey, receiptNo); // 最后一行删尽 → 扫尾清整票号残留(含 legacy)
          }
        }
      }
      return deleted;
    }, { savepointName: 'daily_receipt_delete_cascade', preferSavepoint: true });
  }
  const lockPostedStmt = db.prepare(`
    UPDATE daily_receipt_export
    SET ledger_status = 'locked', modified_by = ?
    WHERE workspace_key = ? AND ledger_status = 'posted'
  `);
  const updateDepartureStmt = db.prepare(`
    UPDATE daily_receipt_export
    SET departure_date = ?
    WHERE id = ? AND workspace_key = ?
  `);
  const fetchUpdateRowStmt = db.prepare(`
    SELECT *
    FROM daily_receipt_export
    WHERE id = ? AND workspace_key = ?
  `);
  const fetchMigrationRowStmt = db.prepare(`
    SELECT id, workspace_key, receipt_no, shop, purchase_date, row_hash, manual_locked_fields
    FROM daily_receipt_export
    WHERE workspace_key = ? AND id = ?
  `);
  const findByRowHashStmt = db.prepare(`
    SELECT id
    FROM daily_receipt_export
    WHERE workspace_key = ? AND row_hash = ?
    LIMIT 1
  `);
  // L518:结算删旧行前,取「已确认模式(mode_confirmed_at 非空)」行的背书+业务键,供 carry-forward。
  const fetchConfirmCarryStmt = db.prepare(`
    SELECT receipt_no, shop, purchase_date, mode_confirmed_at, mode_confirmed_by, manual_locked_fields
    FROM daily_receipt_export
    WHERE workspace_key = ? AND id = ? AND mode_confirmed_at IS NOT NULL
  `);
  const migrateRowStmt = db.prepare(`
    UPDATE daily_receipt_export
    SET workspace_key = ?,
        purchase_date = ?,
        row_hash = ?,
        tour_match_status = 'pending',
        bill_match_status = 'unmatched',
        bill_match_priority = NULL,
        conflict_fields = NULL,
        ledger_status = 'posted',
        remedy_reason = NULL,
        mode_confirmed_at = NULL,
        mode_confirmed_by = NULL,
        manual_locked_fields = ?,
        modified_by = ?
    WHERE workspace_key = ? AND id = ?
  `);
  const updateModeFolderStmt = db.prepare(`
    UPDATE daily_receipt_export
    SET mode_folder = ?
    WHERE workspace_key = ? AND id = ?
  `);
  // 清单 #5: 重刷 folder 时一并修正 tour_match_status
  // (skipped_mode_not_required ↔ matched),否则用户把模式选进桶后状态仍是
  // skipped,会被 #2/#4 的 matched 过滤挡在桶外。
  const updateModeFolderWithStatusStmt = db.prepare(`
    UPDATE daily_receipt_export
    SET mode_folder = ?, tour_match_status = ?
    WHERE workspace_key = ? AND id = ?
  `);
  const resetBillMatchStmt = db.prepare(`
    UPDATE daily_receipt_export
    SET bill_match_status = 'unmatched',
        bill_match_priority = NULL,
        conflict_fields = NULL
    WHERE workspace_key = ? AND id = ?
  `);
  // 流式确认:把某批某客户组里"审核员点确认时可定稿渠道模式"的小票标为人工已确认。
  // F1b(2026-07-20):原 WHERE 只认 'matched',漏掉两类命中票——审核台点「确认」永久无效、
  // 组卡 needs_confirm(deriveSettlementStatus 要求非remedy行全有 mode_confirmed_at 才 settled):
  //   ① skipped_mode_not_required:命中团号但该模式"不按小票记"(渠道模式有、桶待映射),
  //      设计注释明说"审核员确认渠道模式后由 mapping/补救落桶"——盖戳=审核员认可渠道模式,
  //      落桶另由账单管理映射独立进行,与确认解耦;
  //   ② 无团号票(tourStance='none'/字面量'无' → tour_no 落库 NULL):tourMatch 把它钉在 pending
  //      不动点(isEmptyValue(NULL) 分支显式写回 pending),永久卡死无出路 → 确认必须能盖它。
  // remedy 类状态(tour_not_found/date_out_of_window 等)不在此列:走补救台,且 deriveSettlementStatus
  // 先判 needs_remedy 拦在前面。待匹配中间态(pending 但 tour_no 非空)也不盖——等增量匹配跑完再确认。
  const confirmModesByGroupStmt = db.prepare(`
    UPDATE daily_receipt_export
    SET mode_confirmed_at = ?, mode_confirmed_by = ?
    WHERE workspace_key = ? AND source_batch_id = ? AND source_customer_id = ?
      AND mode_confirmed_at IS NULL
      AND (
        tour_match_status IN ('matched', 'skipped_mode_not_required')
        OR (tour_match_status = 'pending' AND tour_no IS NULL)
      )
  `);

  function runDynamicUpdate({
    id,
    workspaceKey,
    plannedUpdates,
    manualLock = false,
    historySource = null,
    actor = null,
    conflictId = null,
  }) {
    return runSqliteTransaction(db, () => {
      const current = fetchUpdateRowStmt.get(Number(id), workspaceKey);
      if (!current) return { changes: 0, written: {}, skippedDueToManualLock: [] };
      const { allowed, skipped } = manualLock
        ? { allowed: plannedUpdates, skipped: [] }
        : filterStageUpdates(current, plannedUpdates);
      const sets = [];
      const vals = [];
      const historyChanges = {};
      for (const [col, value] of Object.entries(allowed)) {
        const normalized = normalizeFieldValue(col, value);
        sets.push(`${col} = ?`);
        vals.push(normalized);
        historyChanges[col] = { before: current[col], after: normalized };
      }
      if (manualLock) {
        const locks = getLockedFields(current);
        for (const col of Object.keys(plannedUpdates)) {
          if (!NON_MANUAL_LOCK_COLUMNS.has(col)) locks.add(col);
        }
        sets.push('manual_locked_fields = ?');
        vals.push(serializeLockedFields(locks));
      }
      if (sets.length === 0) {
        return { changes: 0, written: {}, skippedDueToManualLock: skipped };
      }
      const sql = `UPDATE daily_receipt_export SET ${sets.join(', ')} WHERE id = ? AND workspace_key = ?`;
      vals.push(Number(id), workspaceKey);
      const changes = db.prepare(sql).run(...vals).changes;
      if (changes > 0) {
        recordFieldHistory(fieldHistoryRepo, {
          workspaceKey,
          dailyRowId: Number(id),
          changes: historyChanges,
          changeSource: historySource || (manualLock ? 'manual_edit' : 'ocr'),
          actor: actor || current.modified_by || 'system',
          conflictId,
        });
      }
      return { changes, written: allowed, skippedDueToManualLock: skipped };
    }, { savepointName: 'daily_receipt_field_update', preferSavepoint: true });
  }

  function buildInsertHistoryChanges(row) {
    const changes = {};
    for (const col of FIELD_COLS) {
      const value = row[CAMEL_BY_COL[col]];
      if (value !== undefined && value !== null && value !== '') {
        changes[col] = { before: null, after: NUMERIC_COLS.has(col) ? Number(value) : value };
      }
    }
    changes.source_type = { before: null, after: row.sourceType || 'imported' };
    changes.ledger_status = {
      before: null,
      after: row.ledgerStatus || 'posted',
    };
    return changes;
  }

  // 无事务的纯插入循环(供 insertMany 和结算复合 op settleGroupAtomic 复用):调用方负责开事务。
  // 抽出原因:insertMany 原用裸 db.exec('BEGIN'),嵌不进外层事务;L180 结算要「删旧+写新」同一
  // 事务(崩溃/跨月多桶都原子),必须能在一个 runSqliteTransaction 里连着删和插,故剥出无事务核心。
  function insertRowsCore(rows) {
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const businessKey = {
        workspaceKey: String(row.workspaceKey || '').trim(),
        receiptNo: String(row.receiptNo || '').trim(),
        shop: String(row.shop || '').trim(),
        purchaseDate: String(row.purchaseDate || '').trim(),
      };
      const shouldDedupeWorkbenchReceipt = String(row.sourceType || '').trim() === 'workbench';
      if (
        shouldDedupeWorkbenchReceipt
        && businessKey.workspaceKey
        && businessKey.receiptNo
        && businessKey.shop
        && businessKey.purchaseDate
      ) {
        const existing = receiptBusinessExistsStmt.get(
          businessKey.workspaceKey,
          businessKey.receiptNo,
          businessKey.shop,
          businessKey.purchaseDate
        );
        if (existing) {
          skipped += 1;
          continue;
        }
      }
      const result = insertStmt.run(...buildInsertValues(row));
      if (result.changes > 0) {
        inserted += 1;
        if (String(row.sourceType || '').trim() === 'manual') {
          recordFieldHistory(fieldHistoryRepo, {
            workspaceKey: row.workspaceKey,
            dailyRowId: Number(result.lastInsertRowid),
            changes: buildInsertHistoryChanges(row),
            changeSource: 'manual_no_image',
            actor: row.modifiedBy || 'system',
          });
        }
      } else {
        skipped += 1;
      }
    }
    return { inserted, skipped };
  }

  return {
    // 确认某客户组已命中小票的渠道模式(人工背书);返回本次新确认的行数。
    confirmModesByGroup({ workspaceKey, sourceBatchId, sourceCustomerId, operator = null, at = null }) {
      const ts = at || new Date().toISOString();
      return confirmModesByGroupStmt.run(
        ts,
        operator || null,
        String(workspaceKey || ''),
        String(sourceBatchId || ''),
        String(sourceCustomerId || ''),
      ).changes;
    },
    insertMany(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, skipped: 0 };
      // 事务机制从裸 db.exec('BEGIN') 改为 runSqliteTransaction:独立调用=BEGIN/COMMIT/ROLLBACK
      // (行为逐字节不变);若被外层事务包着(db.isTransaction)=自动降级 SAVEPOINT 可嵌套——
      // L180 结算复合 op settleGroupAtomic 靠这个把删旧+写新放进同一事务。
      return runSqliteTransaction(db, () => insertRowsCore(rows), { savepointName: 'daily_receipt_insert_many' });
    },
    // L180:结算「删旧未匹配行 + 写新台账行」原子化——删和插放进同一个 runSqliteTransaction,
    // 进程崩溃/某工作区抛错都整体回滚(旧行不丢、新行不半写),无需内存快照+补插回滚。
    // deletes: [{workspaceKey, ids}](删旧行,可跨多个旧月工作区);
    // insertBuckets: [{workspaceKey, rows}](写新行,可落多个新月工作区——改了购买日期时删/插工作区不同)。
    // 删在插之前:去重(insertRowsCore 按业务键预查)看到的是删后状态,与旧「先删后插」语义一致。
    settleGroupAtomic({ deletes = [], insertBuckets = [] } = {}) {
      return runSqliteTransaction(db, () => {
        // L518:删旧之前快照「已确认模式」行的背书,按业务键 carry-forward 到重插后业务键不变的同一行——
        // 保住审核员模式背书,不因重结算(补图/重识别)静默翻回 needs_confirm。业务键变了(票号/店/日期
        // 改了)的行不命中→背书自然丢弃走重确认(与 migrateRow 换月清背书同原则)。删除 filter 完全不动
        // (裸保护旧行会双计);背书是随「同一票」carry,不是保护旧行。锁了业务键的确认行不 carry(与 #33 一致)。
        const carryBusinessKey = (ws, receiptNo, shop, purchaseDate) => [
          String(ws || '').trim(), String(receiptNo || '').trim(),
          String(shop || '').trim(), String(purchaseDate || '').trim(),
        ].join('\u0000');
        const confirmCarry = new Map();
        for (const d of (Array.isArray(deletes) ? deletes : [])) {
          if (!d || !Array.isArray(d.ids)) continue;
          for (const id of d.ids) {
            const snap = fetchConfirmCarryStmt.get(d.workspaceKey, Number(id));
            if (!snap) continue;
            const locks = getLockedFields({ manual_locked_fields: snap.manual_locked_fields });
            // 锁了业务键(购买日期/票号/店)的确认行不 carry:业务键被手改,背书归属有歧义,宁可重确认。
            if ([...locks].some((f) => SETTLE_BUSINESS_KEY_FIELDS.has(f))) continue;
            confirmCarry.set(
              carryBusinessKey(d.workspaceKey, snap.receipt_no, snap.shop, snap.purchase_date),
              { at: snap.mode_confirmed_at, by: snap.mode_confirmed_by }
            );
          }
        }

        let removed = 0;
        for (const d of (Array.isArray(deletes) ? deletes : [])) {
          if (d && Array.isArray(d.ids) && d.ids.length) {
            removed += deleteRowsWithCascade(d.workspaceKey, d.ids);
          }
        }
        let inserted = 0;
        let skipped = 0;
        for (const b of (Array.isArray(insertBuckets) ? insertBuckets : [])) {
          if (b && Array.isArray(b.rows) && b.rows.length) {
            // L518:插入前把命中快照的背书注入行(buildInsertValues 落 mode_confirmed_at/by 列);
            // 已带背书的行不覆盖(幂等)。业务键不变才命中→carry;变了则不命中→翻 needs_confirm。
            if (confirmCarry.size) {
              for (const row of b.rows) {
                if (row.modeConfirmedAt) continue;
                const carried = confirmCarry.get(
                  carryBusinessKey(row.workspaceKey, row.receiptNo, row.shop, row.purchaseDate)
                );
                if (carried) {
                  row.modeConfirmedAt = carried.at;
                  row.modeConfirmedBy = carried.by;
                }
              }
            }
            const r = insertRowsCore(b.rows);
            inserted += r.inserted;
            skipped += r.skipped;
          }
        }
        return { removed, inserted, skipped };
      }, { savepointName: 'settle_group_atomic' });
    },

    updateTourMatch({ id, workspaceKey, modeFolder, modeRaw, modeNormalized, tourMatchStatus }) {
      const plannedUpdates = {
        mode_folder: modeFolder || null,
        tour_match_status: tourMatchStatus || 'matched',
      };
      if (modeRaw) plannedUpdates.mode_raw = modeRaw;
      if (modeNormalized) plannedUpdates.mode_normalized = modeNormalized;
      return runDynamicUpdate({ id, workspaceKey, plannedUpdates, manualLock: false });
    },

    // 只改 conflict_fields(不动 bill_match_status)。供台账一致性检查(错表B类)用。
    setConflictFields({ id, workspaceKey, conflictFields }) {
      return runDynamicUpdate({
        id,
        workspaceKey,
        plannedUpdates: { conflict_fields: conflictFields },
        manualLock: false,
      });
    },

    updateBillMatch(update) {
      const {
        id,
        workspaceKey,
        billMatchStatus,
        billMatchPriority,
        conflictFields,
      } = update;
      const plannedUpdates = {
        bill_match_status: billMatchStatus,
        bill_match_priority: billMatchPriority == null ? null : Number(billMatchPriority),
      };
      if (Object.prototype.hasOwnProperty.call(update || {}, 'conflictFields')) {
        plannedUpdates.conflict_fields = conflictFields;
      }
      return runDynamicUpdate({
        id,
        workspaceKey,
        plannedUpdates,
        manualLock: false,
      });
    },

    applyFieldUpdates({
      id,
      workspaceKey,
      updates,
      manualLock = false,
      historySource = null,
      actor = null,
      conflictId = null,
    }) {
      if (!updates || typeof updates !== 'object') {
        return { changes: 0, written: {}, skippedDueToManualLock: [] };
      }
      const plannedUpdates = {};
      for (const [camel, value] of Object.entries(updates)) {
        const col = ALLOWED_FIELD_UPDATES.get(camel);
        if (!col) continue;
        plannedUpdates[col] = value;
      }
      if (Object.keys(plannedUpdates).length === 0) {
        return { changes: 0, written: {}, skippedDueToManualLock: [] };
      }
      return runDynamicUpdate({
        id,
        workspaceKey,
        plannedUpdates,
        manualLock,
        historySource,
        actor,
        conflictId,
      });
    },

    migrateRow({ sourceWorkspaceKey, targetWorkspaceKey, dailyReceiptId, newPurchaseDate, modifiedBy = null }) {
      return runSqliteTransaction(db, () => {
        const current = fetchMigrationRowStmt.get(sourceWorkspaceKey, Number(dailyReceiptId));
        if (!current) {
          const error = new Error('daily row not found');
          error.status = 404;
          error.statusCode = 404;
          error.code = 'daily_not_found';
          throw error;
        }
        // L496:目标月 row_hash 必须与桥接 dailyRowHashOf 同口径,否则 DEPT/兜底(digits 投影)行
        // 跨月迁移后:①碰撞检测(findByRowHashStmt)口径不一致→漏检,与桥接同票在目标月落两行双计;
        // ②本行落库 row_hash 与桥接约定不符→后续桥接 INSERT OR IGNORE(UNIQUE ws,row_hash)也不撞→
        // 再产重复行。桥接的投影(raw|digits)由运行期、非落库的标记决定,迁移只有落库列拿不到 task;
        // 但源月已存的 row_hash 唯一编码了该行投影——从「存储 hash 匹配 hash(raw) 还是 hash(digits)」
        // 反推出投影,再对目标月施同一投影。只 import 桥接同一个 normalizeReceiptNoDigits +
        // computeDailyRowHash(单一真相源,非复刻模式解析,不违字段清洗副本铁律)。
        const digitsReceiptNo = normalizeReceiptNoDigits(current.receipt_no);
        let projectedReceiptNo = current.receipt_no; // 默认 raw(已知模式行 letters14/dashed19/digits*)
        if (digitsReceiptNo && digitsReceiptNo !== current.receipt_no && current.row_hash) {
          // 用源月 workspaceKey + 源月 purchase_date 复现存储时的 hash(必须用旧值,不是 newPurchaseDate)
          const hashRaw = computeDailyRowHash({
            workspaceKey: sourceWorkspaceKey, receiptNo: current.receipt_no,
            purchaseDate: current.purchase_date, shop: current.shop,
          });
          if (current.row_hash !== hashRaw) {
            const hashDigits = computeDailyRowHash({
              workspaceKey: sourceWorkspaceKey, receiptNo: digitsReceiptNo,
              purchaseDate: current.purchase_date, shop: current.shop,
            });
            // 存储 hash 命中 digits 口径 → 该行原走数字投影(DEPT/兜底);都不命中则保守用 raw(安全降级)
            if (current.row_hash === hashDigits) projectedReceiptNo = digitsReceiptNo;
          }
        }
        const newRowHash = computeDailyRowHash({
          workspaceKey: targetWorkspaceKey,
          receiptNo: projectedReceiptNo,
          purchaseDate: newPurchaseDate,
          shop: current.shop,
        });
        const existing = findByRowHashStmt.get(targetWorkspaceKey, newRowHash);
        if (existing && Number(existing.id) !== Number(dailyReceiptId)) {
          const error = new Error(`target workspace ${targetWorkspaceKey} already has this receipt`);
          error.status = 409;
          error.statusCode = 409;
          error.code = 'target_row_hash_collision';
          error.existingDailyId = Number(existing.id);
          throw error;
        }
        const locks = getLockedFields(current);
        locks.add('purchase_date');
        // 跨月迁移=换月重判(审计 HIGH line534 + MEDIUM line486):migrateRowStmt 已把
        // tour/bill_match_status 硬重置为 pending/unmatched、清掉 mode_confirmed_* 让新月重新
        // 匹配/背书。但若这两个「阶段状态」还锁在 manual_locked_fields 里,重匹配的
        // filterStageUpdates 会跳过它们 → 永久卡 pending/unmatched(人工背书补救行迁移后两月都
        // 漏这张票,affaae1 只标脏没摘锁,对它无效)。迁移时一并摘掉这两个阶段状态锁;人工对
        // 字段「值」的订正锁(票号/姓名/护照/上家/购买日期等)照常保留,数据订正跨月仍有效。
        locks.delete('tour_match_status');
        locks.delete('bill_match_status');
        const manualLockedFields = serializeLockedFields(locks);
        const changes = migrateRowStmt.run(
          targetWorkspaceKey,
          newPurchaseDate,
          newRowHash,
          manualLockedFields,
          modifiedBy || null,
          sourceWorkspaceKey,
          Number(dailyReceiptId)
        ).changes;
        if (changes > 0) {
          recordFieldHistory(fieldHistoryRepo, {
            workspaceKey: targetWorkspaceKey,
            dailyRowId: Number(dailyReceiptId),
            changes: {
              workspace_key: { before: sourceWorkspaceKey, after: targetWorkspaceKey },
              purchase_date: { before: current.purchase_date, after: newPurchaseDate },
            },
            changeSource: 'bridge_migration',
            actor: modifiedBy || 'system',
          });
        }
        return { changes, rowHash: newRowHash };
      }, { savepointName: 'daily_receipt_migrate_row', preferSavepoint: true });
    },

    _applyBillMatchBatch(updates) {
      if (!Array.isArray(updates) || updates.length === 0) {
        return { changes: 0, skippedDueToManualLockRows: [] };
      }
      return runSqliteTransaction(db, () => {
        let changes = 0;
        const skippedDueToManualLockRows = [];
        for (const update of updates) {
          const plannedUpdates = {
            bill_match_status: update.billMatchStatus,
            bill_match_priority: update.billMatchPriority == null ? null : Number(update.billMatchPriority),
          };
          if (Object.prototype.hasOwnProperty.call(update, 'conflictFields')) {
            plannedUpdates.conflict_fields = update.conflictFields;
          }
          const result = runDynamicUpdate({
            id: update.id,
            workspaceKey: update.workspaceKey,
            plannedUpdates,
            manualLock: false,
          });
          changes += result.changes;
          if (result.skippedDueToManualLock.length) {
            skippedDueToManualLockRows.push({
              id: update.id,
              fields: result.skippedDueToManualLock,
            });
          }
        }
        return { changes, skippedDueToManualLockRows };
      }, { savepointName: 'daily_receipt_bill_match_batch' });
    },

    deleteLedgerRow({ workspaceKey, id }) {
      return deleteRowsWithCascade(workspaceKey, [id]);
    },

    deleteMany({ workspaceKey, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) return 0;
      return deleteRowsWithCascade(workspaceKey, ids);
    },

    setLedgerStatus({ id, workspaceKey, ledgerStatus, remedyReason = null, modifiedBy = null }) {
      const sql = `UPDATE daily_receipt_export
                   SET ledger_status = ?, remedy_reason = ?, modified_by = ?
                   WHERE id = ? AND workspace_key = ?`;
      return db.prepare(sql).run(
        ledgerStatus,
        remedyReason || null,
        modifiedBy || null,
        Number(id),
        workspaceKey,
      ).changes;
    },

    publishToMonthly({ workspaceKey, ids = null, postedBy, ownerUserId = null, ownerUsername = null }) {
      const now = new Date().toISOString();
      let sql;
      let params;
      const ownerConds = [];
      const ownerParams = [];
      addOwnerScopeCondition(ownerConds, ownerParams, { ownerUserId, ownerUsername });
      const ownerWhere = ownerConds.length ? ` AND ${ownerConds.join(' AND ')}` : '';
      if (ids && ids.length) {
        // 分块 IN(...):ids 可达数万,一次性拼占位符会触发 SQLite "too many SQL variables"。
        const CHUNK = 500;
        let changed = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => '?').join(',');
          sql = `UPDATE daily_receipt_export
                 SET ledger_status = 'posted', posted_at = ?, posted_by = ?
                 WHERE workspace_key = ? AND ledger_status = 'ready_to_post'
                   AND id IN (${placeholders})${ownerWhere}`;
          params = [now, postedBy || null, workspaceKey, ...chunk.map(Number), ...ownerParams];
          changed += db.prepare(sql).run(...params).changes;
        }
        return changed;
      }
      sql = `UPDATE daily_receipt_export
             SET ledger_status = 'posted', posted_at = ?, posted_by = ?
             WHERE workspace_key = ? AND ledger_status = 'ready_to_post'${ownerWhere}`;
      params = [now, postedBy || null, workspaceKey, ...ownerParams];
      return db.prepare(sql).run(...params).changes;
    },

    lockPosted({ workspaceKey, lockedBy = null }) {
      return lockPostedStmt.run(lockedBy || null, workspaceKey).changes;
    },

    updateDeparture({ id, workspaceKey, departureDate }) {
      return updateDepartureStmt.run(
        departureDate || null,
        Number(id),
        workspaceKey
      ).changes;
    },

    updateModeFolderBulk({ workspaceKey, updates }) {
      if (!Array.isArray(updates) || updates.length === 0) return 0;
      return runSqliteTransaction(db, () => {
        let changed = 0;
        for (const update of updates) {
          // 若指定了 tourMatchStatus,同时改 folder + 状态(#5 promote/demote);
          // 否则保持旧行为只改 folder。
          if (update.tourMatchStatus) {
            changed += updateModeFolderWithStatusStmt.run(
              update.modeFolder || null,
              update.tourMatchStatus,
              workspaceKey,
              Number(update.id)
            ).changes;
          } else {
            changed += updateModeFolderStmt.run(
              update.modeFolder || null,
              workspaceKey,
              Number(update.id)
            ).changes;
          }
        }
        return changed;
      }, { savepointName: 'daily_receipt_mode_folder_refresh', preferSavepoint: true });
    },
    resetBillMatchForIds({ workspaceKey, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) return 0;
      let changed = 0;
      for (const id of ids) {
        changed += resetBillMatchStmt.run(workspaceKey, Number(id)).changes;
      }
      return changed;
    },

    // A1复核HIGH(2026-07-16):桶级替换=整桶账单作废重来,人工锁定 bill_match 的行其"结论依据"
    // (旧账单)已删——必须**解除账单三列的锁**再重置,否则:锁着不重置=僵尸锁(新账单永远匹不上且
    // 无任何信号),锁着又重置=A1修复前的绕锁老病。只摘 bill 三列锁,tour/字段等其它人工锁原样保留。
    clearBillMatchLocksForIds({ workspaceKey, ids }) {
      const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
      if (!list.length) return 0;
      const fetchStmt = db.prepare('SELECT manual_locked_fields FROM daily_receipt_export WHERE workspace_key = ? AND id = ?');
      const updateStmt = db.prepare('UPDATE daily_receipt_export SET manual_locked_fields = ? WHERE workspace_key = ? AND id = ?');
      let changed = 0;
      for (const id of list) {
        const row = fetchStmt.get(workspaceKey, id);
        if (!row) continue;
        const locks = getLockedFields(row);
        const before = locks.size;
        locks.delete('bill_match_status');
        locks.delete('bill_match_priority');
        locks.delete('conflict_fields');
        if (locks.size === before) continue;
        changed += updateStmt.run(serializeLockedFields(locks), workspaceKey, id).changes;
      }
      return changed;
    },

    // 换团号表 / 用当前表重新匹配:把"本批次"的待补救行打回 pending,交给 tour_match 重跑。
    // 严格限定 source_batch_id,只动 REMATCH_RESET_STATUSES;matched / 别批次 / 缺日期不碰。
    resetTourMatchForRematch({ workspaceKey, batchId, statuses = REMATCH_RESET_STATUSES }) {
      if (!workspaceKey || !batchId) return 0;
      const list = (Array.isArray(statuses) && statuses.length ? statuses : REMATCH_RESET_STATUSES)
        .map((s) => String(s)).filter(Boolean);
      if (!list.length) return 0;
      const placeholders = list.map(() => '?').join(', ');
      const sql = `UPDATE daily_receipt_export
                   SET tour_match_status = 'pending'
                   WHERE workspace_key = ? AND source_batch_id = ?
                     AND tour_match_status IN (${placeholders})`;
      return db.prepare(sql).run(workspaceKey, batchId, ...list).changes;
    },

    applyDepartureRewrites(rewrites) {
      if (!Array.isArray(rewrites) || rewrites.length === 0) return 0;
      let applied = 0;
      db.exec('BEGIN');
      try {
        for (const r of rewrites) {
          applied += updateDepartureStmt.run(
            r.afterValue || null,
            Number(r.dailyReceiptId),
            r.workspaceKey
          ).changes;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return applied;
    },
  };
}

module.exports = { createDailyReceiptWrites };
