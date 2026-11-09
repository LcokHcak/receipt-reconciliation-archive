'use strict';

/**
 * pending_review_resolution_service — closes the loop for every
 * pending_review row raised in stages 1.5/2/3.
 *
 * Dispatches by reason_type to the correct write-back:
 *   - field_conflict        → applies operator's per-field overrides
 *                             (use_daily / use_bill / custom) onto daily
 *                             + flips bill_match_status to 'matched'
 *                             + ensures bill_match_log has a matched row
 *   - ambiguous_match       → operator picked chosenDailyId; writes a
 *                             matched bill_match_log row + flips daily
 *   - fuzzy_match           → same shape as ambiguous_match when accepted
 *   - second_pass_candidate → accepted bill promotes daily to matched;
 *                             optionally backfills receipt_no from bill
 *   - agent_mismatch        → records agentOverride on daily + re-runs
 *                             tour-match-like classification (single row)
 *   - mode_unresolved       → sets modeFolder + tourMatchStatus='matched'
 *
 * After each resolution we either DELETE the old monthly_data row for the
 * affected daily and INSERT a fresh one (precise single-row re-merge) or
 * for the tour_match classes, just upsert the monthly_data row.
 *
 * Caller provides `resolvedBy` + `status` ('resolved' | 'rejected').
 * Rejected resolutions only flip pending_review.status, nothing else.
 */

const crypto = require('node:crypto');

const FIELD_COLS_CAMEL = [
  'stmtDate', 'statementDate', 'paymentMode',
  'modeRaw', 'modeNormalized',
  'shop', 'branch', 'upstream', 'entryCompany',
  'tourGuide', 'agent',
  'originalDate', 'purchaseDate', 'tourNo',
  'name', 'passportNo', 'departureDate',
  'receiptNo', 'originalReceiptNo',
  'category', 'brand', 'sku', 'productName',
  'refNo', 'qty',
  'grossUsd', 'grossKrw', 'netUsd', 'netKrw',
  'dcUsd', 'dcKrw', 'discountRate',
  'voucherAmount', 'voucherDeduction',
  'customerPoints', 'customerRebate',
  'storeBasePoints', 'storeBaseRebate',
  'storeExtraPoints', 'storeExtraAmount', 'storeFinalRebate',
  'categorySecondary', 'remark',
];

const BILL_CAMEL_BY_DAILY_CAMEL = Object.freeze({
  receiptNo: 'receiptNo',
  originalReceiptNo: 'originalReceiptNo',
  tourNo: 'tourNo',
  purchaseDate: 'purchaseDate',
  departureDate: 'departureDate',
  passportNo: 'passportNo',
  name: 'name',
  shop: 'storeFamily',
  branch: 'storeBranch',
  modeNormalized: 'modeNormalized',
});

function createPendingReviewResolutionService({
  dailyReceiptRepo,
  storeBillRepo,
  billMatchLogRepo,
  pendingReviewRepo,
  monthlyDataRepo,
}) {
  if (!dailyReceiptRepo || !storeBillRepo || !billMatchLogRepo
      || !pendingReviewRepo || !monthlyDataRepo) {
    throw new Error('pending_review_resolution_service: missing repos');
  }

  /**
   * Apply an operator's decision to a pending_review row.
   *
   * @param {{
   *   id: number,
   *   workspaceKey: string,
   *   status: 'resolved' | 'rejected',
   *   resolution?: string,
   *   resolvedBy?: string,
   *   decision?: ResolveDecision,
   * }} args
   * @returns {{ ok: boolean, applied: string[], warnings: string[] }}
   */
  async function resolve(args) {
    const { id, workspaceKey } = args;
    const status = args.status || 'resolved';
    if (!id || !workspaceKey) throw new Error('id and workspaceKey required');

    const existing = pendingReviewRepo.ensureFingerprint
      ? pendingReviewRepo.ensureFingerprint({ id, workspaceKey })
      : pendingReviewRepo.findById({ id, workspaceKey });
    if (!existing) {
      return { ok: false, applied: [], warnings: ['pending_review_not_found'] };
    }
    if (existing.status !== 'open') {
      return { ok: false, applied: [], warnings: [`already_${existing.status}`] };
    }

    const applied = [];
    const warnings = [];
    const nowIso = new Date().toISOString();

    if (status === 'rejected') {
      pendingReviewRepo.resolve({
        id, workspaceKey, status: 'rejected',
        resolution: args.resolution || 'rejected_by_operator',
        resolvedBy: args.resolvedBy || null, resolvedAt: nowIso,
      });
      applied.push('rejected');
      return { ok: true, applied, warnings };
    }

    const decision = args.decision || {};
    const reason = existing.reasonType;
    const detail = existing.detail || {};

    try {
      switch (reason) {
        case 'field_conflict':
          handleFieldConflict({
            workspaceKey, existing, detail, decision, nowIso,
            applied, warnings, resolvedBy: args.resolvedBy,
          });
          break;

        case 'ambiguous_match':
        case 'fuzzy_match':
          handleAmbiguousOrFuzzy({
            workspaceKey, existing, detail, decision, nowIso,
            applied, warnings, resolvedBy: args.resolvedBy,
          });
          break;

        case 'second_pass_candidate':
          handleSecondPassCandidate({
            workspaceKey, existing, detail, decision, nowIso,
            applied, warnings, resolvedBy: args.resolvedBy,
          });
          break;

        case 'agent_mismatch':
          handleAgentMismatch({
            workspaceKey, existing, detail, decision, nowIso,
            applied, warnings, resolvedBy: args.resolvedBy,
          });
          break;

        case 'mode_unresolved':
          handleModeUnresolved({
            workspaceKey, existing, detail, decision, nowIso,
            applied, warnings, resolvedBy: args.resolvedBy,
          });
          break;

        default:
          warnings.push(`unsupported_reason_type:${reason}`);
      }
    } catch (error) {
      warnings.push(`dispatch_error:${error?.message || 'unknown'}`);
      // 处理动作抛错时不能把待审项标记为 resolved。否则会"幽灵成功":记录从
      // 待审列表消失,但 daily_receipt 实际没匹配,下次 merge 出错。保持 open
      // 让操作员重试或排查。
      return { ok: false, applied, warnings };
    }

    // 审计H3(2026-07-16):handler 以 `warnings.push(...); return;` 早退(缺ID/找不到daily/bill、
    // chosen不在候选、无modeFolder等)**不会**触发上面的 catch(那只接 throw)。此前控制流无条件
    // 落到 resolve(status:'resolved') → "幽灵成功":item 从待审队列消失但实际没写回,且指纹去重
    // 不再重立 open → 账单/小票被永久压制、月度漏票且无痕。与 catch 分支同口径:有 warning=没真正
    // 完成,保持 open 让操作员重试/排查,绝不标 resolved。(warnings 两类来源:①handler 早退
    // 均配 early-return;②rebuildMonthlyDataFor 未重建(复核HIGH-3)——两类都=没完整落地,同口径拦。)
    if (warnings.length > 0) {
      return { ok: false, applied, warnings, resolved: false };
    }

    pendingReviewRepo.resolve({
      id, workspaceKey, status: 'resolved',
      resolution: args.resolution || applied.join(',') || 'applied',
      resolvedBy: args.resolvedBy || null, resolvedAt: nowIso,
    });
    applied.push('resolved');

    return { ok: true, applied, warnings, resolved: true };
  }

  // ───────────────────── handlers ─────────────────────

  function handleFieldConflict({
    workspaceKey, existing, detail, decision, nowIso,
    applied, warnings, resolvedBy,
  }) {
    const dailyId = detail.dailyReceiptId;
    const billId = existing.sourceTable === 'store_bill' ? existing.sourceId : null;
    if (!dailyId || !billId) {
      warnings.push('field_conflict_missing_ids');
      return;
    }
    const daily = dailyReceiptRepo._fetchFullById({ workspaceKey, id: dailyId });
    if (!daily) { warnings.push('daily_not_found'); return; }
    const bill = findStoreBillById({ workspaceKey, billId, receiptNo: daily.receiptNo });
    if (!bill) { warnings.push('bill_not_found'); return; }

    const overrides = decision.fieldOverrides || {};
    const updates = {};
    const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts : [];
    for (const c of conflicts) {
      const choice = overrides[c.field];
      if (!choice) continue;
      if (choice === 'use_daily') continue; // daily already has the value
      if (choice === 'use_bill') {
        const billCamel = BILL_CAMEL_BY_DAILY_CAMEL[c.field] || c.field;
        updates[c.field] = bill[billCamel];
      } else if (choice && typeof choice === 'object' && 'custom' in choice) {
        updates[c.field] = choice.custom;
      }
    }
    // auto-fillable fields (daily empty + bill non-empty) are safe to write
    const autoFillable = Array.isArray(detail.autoFillable) ? detail.autoFillable : [];
    for (const c of autoFillable) {
      if (updates[c.field] != null) continue;
      const billCamel = BILL_CAMEL_BY_DAILY_CAMEL[c.field] || c.field;
      updates[c.field] = bill[billCamel];
    }

    updates.billMatchStatus = 'matched';
    if (existing.sourceId && detail.priority) {
      updates.billMatchPriority = Number(detail.priority);
    }
    const changed = dailyReceiptRepo.applyFieldUpdates({
      id: dailyId, workspaceKey, updates, manualLock: true,
      historySource: 'pending_resolution',
      actor: resolvedBy || null,
      conflictId: existing.id,
    });
    applied.push(`daily_updated:${changeCount(changed)}`);

    billMatchLogRepo.insertMany([{
      workspaceKey,
      dailyReceiptId: dailyId,
      storeBillId: bill.id,
      matchPriority: Number(detail.priority || 0),
      matchKey: detail.matchKey || null,
      matchStatus: 'matched',
      conflictFields: conflicts,
      matchedAt: nowIso,
      confirmedBy: resolvedBy || null,
      confirmedAt: nowIso,
      note: 'resolved_from_field_conflict',
    }]);
    applied.push('bill_match_log_matched');

    applied.push(rebuildMonthlyDataFor({ workspaceKey, dailyId, billId: bill.id, nowIso, warnings }));
  }

  function handleAmbiguousOrFuzzy({
    workspaceKey, existing, detail, decision, nowIso,
    applied, warnings, resolvedBy,
  }) {
    const chosenDailyId = Number(decision.chosenDailyId);
    if (!chosenDailyId) { warnings.push('no_chosen_daily_id'); return; }
    const candidateIds = Array.isArray(detail.candidateIds) ? detail.candidateIds.map(Number) : [];
    if (candidateIds.length && !candidateIds.includes(chosenDailyId)) {
      warnings.push('chosen_id_not_in_candidates');
      return;
    }
    const billId = existing.sourceTable === 'store_bill' ? existing.sourceId : null;
    if (!billId) { warnings.push('no_bill_id'); return; }

    const updates = {
      billMatchStatus: 'matched',
      billMatchPriority: Number(detail.priority || 6),
    };
    const changed = dailyReceiptRepo.applyFieldUpdates({
      id: chosenDailyId, workspaceKey, updates, manualLock: true,
      historySource: 'pending_resolution',
      actor: resolvedBy || null,
      conflictId: existing.id,
    });
    applied.push(`daily_flipped_matched:${changeCount(changed)}`);

    billMatchLogRepo.insertMany([{
      workspaceKey,
      dailyReceiptId: chosenDailyId,
      storeBillId: billId,
      matchPriority: Number(detail.priority || 6),
      matchKey: detail.matchKey || null,
      matchStatus: 'matched',
      conflictFields: null,
      matchedAt: nowIso,
      confirmedBy: resolvedBy || null,
      confirmedAt: nowIso,
      note: existing.reasonType === 'fuzzy_match'
        ? 'resolved_from_fuzzy_match'
        : 'resolved_from_ambiguous_match',
    }]);
    applied.push('bill_match_log_matched');

    applied.push(rebuildMonthlyDataFor({ workspaceKey, dailyId: chosenDailyId, billId, nowIso, warnings }));
  }

  function handleSecondPassCandidate({
    workspaceKey, existing, detail, decision, nowIso,
    applied, warnings, resolvedBy,
  }) {
    const dailyId = existing.sourceId;
    const chosenBillId = Number(
      decision.chosenBillId
      || (Array.isArray(detail.candidates) && detail.candidates[0]?.billId)
    );
    if (!dailyId || !chosenBillId) {
      warnings.push('second_pass_missing_ids');
      return;
    }
    const bills = storeBillRepo.findByPassport({
      workspaceKey,
      passportNo: detail.dailyPassport || '',
    });
    const bill = bills.find((b) => b.id === chosenBillId) || null;
    if (!bill) { warnings.push('bill_not_found'); return; }

    const updates = {
      billMatchStatus: 'matched',
      billMatchPriority: 6,
    };
    if (decision.adoptBillReceiptNo && bill.receiptNo) {
      updates.receiptNo = bill.receiptNo;
    }
    const changed = dailyReceiptRepo.applyFieldUpdates({
      id: dailyId, workspaceKey, updates, manualLock: true,
      historySource: 'pending_resolution',
      actor: resolvedBy || null,
      conflictId: existing.id,
    });
    applied.push(`daily_flipped_matched:${changeCount(changed)}`);

    billMatchLogRepo.insertMany([{
      workspaceKey,
      dailyReceiptId: dailyId,
      storeBillId: chosenBillId,
      matchPriority: 6,
      matchKey: 'second_pass',
      matchStatus: 'matched',
      conflictFields: null,
      matchedAt: nowIso,
      confirmedBy: resolvedBy || null,
      confirmedAt: nowIso,
      note: 'resolved_from_second_pass',
    }]);
    applied.push('bill_match_log_matched');

    applied.push(rebuildMonthlyDataFor({ workspaceKey, dailyId, billId: chosenBillId, nowIso, warnings }));
  }

  function handleAgentMismatch({
    workspaceKey, existing, detail, decision, nowIso,
    applied, warnings, resolvedBy,
  }) {
    const dailyId = existing.sourceId;
    if (!dailyId) { warnings.push('no_daily_id'); return; }

    const agentChoice = decision.agentChoice || 'use_expected';
    const updates = { tourMatchStatus: 'matched' };
    if (agentChoice === 'use_expected') {
      updates.agent = detail.expected;
    } else if (agentChoice === 'use_actual') {
      // keep as-is; only flip tourMatchStatus
    } else if (agentChoice === 'custom' && decision.agentValue) {
      updates.agent = String(decision.agentValue);
    }
    const changed = dailyReceiptRepo.applyFieldUpdates({
      id: dailyId, workspaceKey, updates, manualLock: true,
      historySource: 'pending_resolution',
      actor: resolvedBy || null,
      conflictId: existing.id,
    });
    applied.push(`daily_agent_updated:${changeCount(changed)}`);

    applied.push(rebuildMonthlyDataFor({ workspaceKey, dailyId, billId: null, nowIso, warnings }));
  }

  function handleModeUnresolved({
    workspaceKey, existing, decision, nowIso,
    applied, warnings, resolvedBy,
  }) {
    const dailyId = existing.sourceId;
    if (!dailyId) { warnings.push('no_daily_id'); return; }
    const modeFolder = decision.modeFolder;
    if (!modeFolder) { warnings.push('no_mode_folder'); return; }

    const updates = {
      modeFolder,
      tourMatchStatus: 'matched',
    };
    const changed = dailyReceiptRepo.applyFieldUpdates({
      id: dailyId, workspaceKey, updates, manualLock: true,
      historySource: 'pending_resolution',
      actor: resolvedBy || null,
      conflictId: existing.id,
    });
    applied.push(`daily_mode_folder_updated:${changeCount(changed)}`);

    applied.push(rebuildMonthlyDataFor({ workspaceKey, dailyId, billId: null, nowIso, warnings }));
  }

  // ───────────────────── monthly_data re-merge (single row) ─────────────────────

  // 返回状态串(供 applied 记录),不再「删行后静默返回成功」:
  //   'monthly_data_rewritten'                 重建成功
  //   'monthly_data_not_rebuilt:daily_missing' 台账行查不到
  //   'monthly_data_not_rebuilt:no_folder'     台账行未归类,无法落桶(留待操作员)
  // 复核HIGH-3(2026-07-16):两处收口——①先检查后删除:此前先 delete 再发现重建不了直接 return,
  // monthly_data 旧行已删没补=永久消失;现在只有确定能重建才删。②"重建不了且**确有旧行会丢**"
  // 必须进 warnings(不是 applied)——否则 resolve() 照样标 resolved,正是 H3 要堵的"幽灵成功"旁路;
  // 进 warnings=item 保持 open,操作员补好 modeFolder 后重试(daily 更新幂等;bill_match_log 可能
  // 多一条 matched 流水,可接受——比丢月度行好)。⭐口径收窄:没落桶的行本来就没有月度行(merge 落桶
  // 后才建),没东西可丢 → 照旧放行 resolved(B4 重放保护测试锁的正是这个常态)。
  function rebuildMonthlyDataFor({ workspaceKey, dailyId, billId, nowIso, warnings = null }) {
    const daily = dailyReceiptRepo._fetchFullById({ workspaceKey, id: dailyId });
    if (!daily) {
      warnings?.push('monthly_data_not_rebuilt:daily_missing');
      return 'monthly_data_not_rebuilt:daily_missing';
    }
    if (!daily.modeFolder) {
      const hadOldRow = monthlyDataRepo.findByDaily({ workspaceKey, dailyReceiptId: dailyId });
      if (hadOldRow) {
        warnings?.push('monthly_data_not_rebuilt:no_folder'); // 有旧行且重建不了=会丢,拦下保 open
        return 'monthly_data_not_rebuilt:no_folder';
      }
      return 'monthly_data_not_rebuilt:no_folder_no_prior'; // 无旧行=无损,照旧 resolved
    }
    monthlyDataRepo.deleteByDaily({ workspaceKey, dailyReceiptId: dailyId });

    const effectiveBillId = billId != null ? Number(billId) : resolveBillIdFromLogs(workspaceKey, dailyId);
    const isUnmatched = effectiveBillId == null;
    const payload = {
      workspaceKey,
      modeFolder: daily.modeFolder,
      isUnmatched,
      dailyReceiptId: dailyId,
      storeBillId: effectiveBillId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    for (const k of FIELD_COLS_CAMEL) payload[k] = daily[k];
    payload.rowHash = hashRow(payload);
    monthlyDataRepo.insertMany([payload]);
    return 'monthly_data_rewritten';
  }

  function resolveBillIdFromLogs(workspaceKey, dailyId) {
    const logs = billMatchLogRepo.findByDaily({ workspaceKey, dailyReceiptId: dailyId });
    const matched = logs.find((l) => l.matchStatus === 'matched' && l.storeBillId);
    return matched ? matched.storeBillId : null;
  }

  function findStoreBillById({ workspaceKey, billId, receiptNo }) {
    if (typeof storeBillRepo.iterateDetail === 'function') {
      const row = storeBillRepo.iterateDetail(workspaceKey)
        .find((b) => b.id === Number(billId));
      if (row) return row;
    }
    const bills = storeBillRepo.findByReceipt({ workspaceKey, receiptNo });
    return bills.find((b) => b.id === Number(billId)) || bills[0] || null;
  }

  return { resolve };
}

// A2(2026-07-16 同步一致性审计):与 merge_streaming_service.hashRow **逐键一致**(此前多混
// updatedAt→同一行两路径不同 hash)。单行重建仍是简化行(无账单回填/返点),resolve 路由已标脏
// merge,ensureFresh 全量重建会用完整口径覆盖;hash 对齐保证覆盖时按同键替换不残留双行。
function hashRow(p) {
  const src = JSON.stringify({
    ws: p.workspaceKey, folder: p.modeFolder, daily: p.dailyReceiptId, bill: p.storeBillId,
    r: p.receiptNo, n: p.name, pa: p.passportNo, d: p.purchaseDate,
  });
  return crypto.createHash('sha1').update(src).digest('hex');
}

function changeCount(result) {
  return typeof result === 'number' ? result : Number(result?.changes || 0);
}

module.exports = { createPendingReviewResolutionService };
