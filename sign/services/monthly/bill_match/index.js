'use strict';

const {
  KEY_BUILDERS,
  billAsDaily,
  canCollapseProductRows,
} = require('../../../lib/monthly_pipeline/matching');
const { diffDailyVsBill } = require('../../../lib/monthly_pipeline/matching/field_diff');
const { detectLedgerConsistency } = require('../ledger_consistency');
const { planMerge } = require('../../../lib/monthly_pipeline/matching/conflict_policy');
const { RULE_VERSION } = require('../../../lib/monthly_pipeline/rule_version');
const { tracker: progressTracker } = require('../../../lib/stage_progress_tracker');
const { logger: structuredLogger } = require('../../../lib/request_logger');
const { runSqliteTransaction } = require('../../../lib/storage/sqlite_transaction');
const { fingerprintFromPayload } = require('../../../lib/monthly/conflict_fingerprint');
const priority1ReceiptNo = require('./priority_1_receipt_no');
const priority2ReceiptDate = require('./priority_2_receipt_date');
const priority3ReceiptTour = require('./priority_3_receipt_tour');
const priority4PassportDateShop = require('./priority_4_passport_date_shop');
const priority5NameDateShop = require('./priority_5_name_date_shop');
const priority6Fuzzy = require('./priority_6_fuzzy');
const {
  createBuildIndex,
  pickBillFields,
  pickNormalized,
  buildBillBadcase,
  createBillMatchTraceLog,
  writeBillMatchTrace,
  buildBillMatchOperatorStats,
} = require('./common');

const PRIORITY_RUNNERS = Object.freeze({
  1: priority1ReceiptNo,
  2: priority2ReceiptDate,
  3: priority3ReceiptTour,
  4: priority4PassportDateShop,
  5: priority5NameDateShop,
  6: priority6Fuzzy,
});

function conflictFieldNames(conflicts) {
  return Array.from(new Set(
    (Array.isArray(conflicts) ? conflicts : [])
      .map((conflict) => conflict?.field)
      .filter(Boolean)
  )).sort();
}

function matchBillAgainstDaily(bill, index) {
  const probe = billAsDaily(bill);
  for (const prio of [1, 2, 3, 4, 5]) {
    const key = KEY_BUILDERS[prio](probe);
    if (!key) continue;
    const hits = PRIORITY_RUNNERS[prio].run({ index, probe }).matched || [];
    if (hits.length === 1) {
      return { priority: prio, status: 'matched', candidates: hits, matchKey: key };
    }
    if (hits.length > 1) {
      if (canCollapseProductRows(probe, hits, prio)) {
        return { priority: prio, status: 'matched', candidates: [hits[0]], matchKey: key };
      }
      return { priority: prio, status: 'ambiguous', candidates: hits, matchKey: key };
    }
  }
  const fuzzy = PRIORITY_RUNNERS[6].run({ index, probe }).matched || [];
  if (fuzzy.length > 0) {
    return { priority: 6, status: 'fuzzy', candidates: fuzzy, matchKey: 'fuzzy' };
  }
  return { priority: null, status: 'unmatched', candidates: [], matchKey: null };
}

function createBillMatchService({
  db = null,
  storeBillRepo,
  dailyReceiptRepo,
  billMatchLogRepo,
  pendingReviewRepo,
  matchBadcaseRepo = null,
}) {
  if (!storeBillRepo || !dailyReceiptRepo || !billMatchLogRepo || !pendingReviewRepo) {
    throw new Error('bill_match_service: missing repos');
  }

  const buildIndex = createBuildIndex(dailyReceiptRepo);

  async function run({
    workspaceKey,
    billFilter = null,
    folder = null,
    stageJobId = null,
    stageLogService = null,
  }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const startedAt = new Date().toISOString();
    // 阶段计时(定位大月份慢在哪;放进 stats.timingsMs,不影响逻辑)
    const timingsMs = {};
    let _t = Date.now();
    const mark = (k) => { timingsMs[k] = (timingsMs[k] || 0) + (Date.now() - _t); _t = Date.now(); };
    // 风险 2:按桶运行时只用本桶台账行建索引,避免串桶误匹配。
    const index = buildIndex(workspaceKey, { folder });
    mark('buildIndex');

    const bills = (typeof storeBillRepo.iterateMatchCandidates === 'function'
      ? storeBillRepo.iterateMatchCandidates(workspaceKey)
      : storeBillRepo.iterateDetail(workspaceKey))
      .filter((b) => b.isDetailSheet)
      // G11c (#33): 退税/退货账单不参与 receipt_no 匹配 — 否则会错关联到原售单
      // NULL = 兼容历史导入 (旧数据没识别字段) 默认当 sale
      .filter((b) => !b.transactionType || b.transactionType === 'sale');
    const filtered = billFilter ? bills.filter(billFilter) : bills;
    // 通知进度追踪器总量；每处理 200 条更新一次（避免 SSE 太密）
    progressTracker.update({ workspaceKey, stage: 'bill_match', current: 0, total: filtered.length });
    const PROGRESS_TICK = 200;
    let processed = 0;
    const logs = [];
    const pendings = [];
    const badcases = [];
    const stats = {
      billsScanned: filtered.length,
      matched: 0,
      ambiguous: 0,
      fuzzy: 0,
      unmatched: 0,
      conflicts: 0,
      skipped_due_to_existing_open: 0,
      skipped_due_to_resolved_or_rejected: 0,
      skipped_due_to_manual_lock: { rows_affected: 0, fields: {} },
      newly_inserted: 0,
      priorityBreakdown: {},
      ruleVersion: RULE_VERSION,
    };
    const clearedCurrent = clearCurrentMatchOutputs();
    stats.cleared_current_logs = clearedCurrent.deletedLogs;
    stats.cleared_current_badcases = clearedCurrent.deletedBadcases;
    stats.reset_current_daily_rows = clearedCurrent.resetDaily;
    // A1(2026-07-16 同步一致性审计):人工 resolve 锁下的行受保护——不重置/日志不删/账单不重匹配
    const protectedBillIds = clearedCurrent.protectedBillIds || new Set();
    stats.protected_manual_matches = { dailyRows: clearedCurrent.protectedDailyCount || 0, bills: protectedBillIds.size };
    mark('clearCurrent');
    // 标记-清扫(孤儿自愈):记录本轮遇到的全部冲突指纹,跑完后把范围内账单上
    // 「没再遇到的」open 待审作废 —— 否则数据修复后冲突消失,旧 open 行永远挂着,
    // 表现为首页/交付说有阻塞、账单核对各 tab 却是 0。
    const encounteredFingerprints = new Set();
    const traceLog = createBillMatchTraceLog({
      stageLogService,
      workspaceKey,
      stageJobId,
      startedAt,
      billsScanned: filtered.length,
      dailyCount: index._dailyCount,
    });

    // Collect updateBillMatch calls; flush in one transaction after the loop
    const statusUpdates = [];
    function clearCurrentMatchOutputs() {
      const storeBillIds = Array.from(new Set(
        filtered.map((bill) => Number(bill.id)).filter(Number.isFinite)
      ));
      if (!storeBillIds.length) return { deletedLogs: 0, deletedBadcases: 0, resetDaily: 0 };
      const execute = () => {
        const dailyIds = typeof billMatchLogRepo.listDailyIdsByStoreBillIds === 'function'
          ? billMatchLogRepo.listDailyIdsByStoreBillIds({ workspaceKey, storeBillIds })
          : [];
        // A1(2026-07-16 同步一致性审计):人工 resolve 把 billMatchStatus 锁在 matched 的行,
        // 此前被这里的裸 reset 打回 unmatched + matched 日志被删 + 指纹压制(resolved)不再立项
        // = **人工匹配结论静默丢失、月度行丢失**。保护三件套:
        //   ①锁定行不重置 ②它们的 matched 日志保留(merge 靠日志建月度行) ③对应账单本轮不重匹配。
        const lockedDailyIds = new Set(
          typeof dailyReceiptRepo.listManualBillLockedIds === 'function'
            ? dailyReceiptRepo.listManualBillLockedIds({ workspaceKey, ids: dailyIds })
            : [],
        );
        const resetIds = dailyIds.filter((id) => !lockedDailyIds.has(Number(id)));
        const protectedBills = new Set(
          lockedDailyIds.size && typeof billMatchLogRepo.listStoreBillIdsByDailyIds === 'function'
            ? billMatchLogRepo.listStoreBillIdsByDailyIds({ workspaceKey, dailyIds: [...lockedDailyIds] })
            : [],
        );
        const clearBillIds = storeBillIds.filter((id) => !protectedBills.has(Number(id)));
        const resetDaily = typeof dailyReceiptRepo.resetBillMatchForIds === 'function'
          ? dailyReceiptRepo.resetBillMatchForIds({ workspaceKey, ids: resetIds })
          : 0;
        const deletedLogs = typeof billMatchLogRepo.deleteByStoreBillIds === 'function'
          ? billMatchLogRepo.deleteByStoreBillIds({ workspaceKey, storeBillIds: clearBillIds })
          : 0;
        const deletedBadcases = typeof matchBadcaseRepo?.deleteByStoreBillIds === 'function'
          ? matchBadcaseRepo.deleteByStoreBillIds({ workspaceKey, storeBillIds: clearBillIds })
          : 0;
        return { deletedLogs, deletedBadcases, resetDaily, protectedBillIds: protectedBills, protectedDailyCount: lockedDailyIds.size };
      };
      return db
        ? runSqliteTransaction(db, execute, { savepointName: 'bill_match_clear_current', preferSavepoint: true })
        : execute();
    }

    function queuePending(payload) {
      const conflictFingerprint = fingerprintFromPayload(payload);
      encounteredFingerprints.add(conflictFingerprint);
      const existing = pendingReviewRepo.findByFingerprint
        ? pendingReviewRepo.findByFingerprint({
          workspaceKey,
          fingerprint: conflictFingerprint,
          statuses: ['open', 'resolved', 'approved', 'rejected'],
        })
        : null;
      // superseded_by_rerun 是重跑时的机械作废,不是人工处理结论 —— 不参与去重,
      // 同一冲突若再次出现要重新立 open 行;人工 resolved/rejected 仍去重(不再骚扰)。
      if (existing && existing.resolution !== 'superseded_by_rerun') {
        if (existing.status === 'open') stats.skipped_due_to_existing_open += 1;
        else stats.skipped_due_to_resolved_or_rejected += 1;
        return { inserted: false, existingStatus: existing.status };
      }
      pendings.push({ ...payload, conflictFingerprint });
      stats.newly_inserted += 1;
      return { inserted: true, existingStatus: null };
    }

    // 大数据量(乐天 10万+行)内存防护:不再把全部 logs/pendings/badcases/statusUpdates
    // 攒到循环结束一次性写(会 OOM),而是每 FLUSH_EVERY 行就落库一次并清空数组,峰值内存封顶。
    const FLUSH_EVERY = 5000;
    function flushBatch() {
      if (!logs.length && !pendings.length && !badcases.length && !statusUpdates.length) return;
      const doFlush = () => {
        if (statusUpdates.length && typeof dailyReceiptRepo._applyBillMatchBatch === 'function') {
          recordManualLockRows(stats, dailyReceiptRepo._applyBillMatchBatch(statusUpdates));
        } else {
          for (const u of statusUpdates) recordManualLockResult(stats, dailyReceiptRepo.updateBillMatch(u));
        }
        if (logs.length) billMatchLogRepo.insertMany(logs);
        if (pendings.length) pendingReviewRepo.insertMany(pendings);
        if (matchBadcaseRepo && badcases.length) {
          try {
            matchBadcaseRepo.insertMany(badcases);
          } catch (error) {
            stats.badcaseWriteError = String(error?.message || error);
            // 静默失败审计 2026-07-12:异常件写库失败原先只进没人读的 stats 字段——复核队列悄悄少件(钱相关)
            structuredLogger.error('badcase_insert_failed', { source: 'bill_match', count: badcases.length, error: stats.badcaseWriteError });
          }
        }
      };
      if (db) runSqliteTransaction(db, doFlush, { savepointName: 'bill_match_writes', preferSavepoint: true });
      else doFlush();
      logs.length = 0; pendings.length = 0; badcases.length = 0; statusUpdates.length = 0;
    }

    function flushProgress() {
      processed += 1;
      if (processed % PROGRESS_TICK === 0) {
        progressTracker.update({ workspaceKey, stage: 'bill_match', current: processed, total: filtered.length });
      }
      if (processed % FLUSH_EVERY === 0) flushBatch();
    }

    for (const bill of filtered) {
      // A1:受保护账单(人工锁定 matched)本轮不重匹配——它的结论就是终局,防重复日志/翻案
      if (protectedBillIds.has(Number(bill.id))) {
        processed += 1;
        continue;
      }
      try {
      const outcome = matchBillAgainstDaily(bill, index);
      const basePayload = {
        workspaceKey,
        storeBillId: bill.id,
        matchPriority: outcome.priority || 0,
        matchKey: outcome.matchKey,
        matchedAt: startedAt,
      };

      if (outcome.status === 'unmatched') {
        stats.unmatched += 1;
        logs.push({ ...basePayload, matchStatus: 'unmatched', dailyReceiptId: null });
        badcases.push(buildBillBadcase({
          workspaceKey, bill, kind: 'unmatched', stageJobId, startedAt,
          snapshot: {
            input: pickBillFields(bill),
            normalized: pickNormalized(bill),
            decision: 'unmatched',
            reason: '所有 6 级匹配都没命中候选',
          },
        }));
        writeBillMatchTrace(traceLog, {
          bill,
          outcome,
          result: 'unmatched',
          reason: 'P1-P6 都未命中；账单有但台账没有对应记录，会进入未收清单。',
        });
        continue;
      }

      if (outcome.status === 'ambiguous') {
        stats.ambiguous += 1;
        logs.push({
          ...basePayload,
          matchStatus: 'pending_review',
          dailyReceiptId: outcome.candidates[0]?.id || null,
          note: `ambiguous: ${outcome.candidates.length} hits at P${outcome.priority}`,
        });
        queuePending({
          workspaceKey,
          sourceTable: 'store_bill',
          sourceId: bill.id,
          reasonType: 'ambiguous_match',
          detail: {
            priority: outcome.priority,
            matchKey: outcome.matchKey,
            candidateIds: outcome.candidates.map((c) => c.id),
            // 可回溯字段:运营在账单核对页要能看出是哪个客户哪张票
            receiptNo: bill.receiptNo || null,
            name: bill.name || null,
            passportNo: bill.passportNo || null,
            purchaseDate: bill.purchaseDate || null,
          },
          status: 'open',
          createdAt: startedAt,
        });
        badcases.push(buildBillBadcase({
          workspaceKey, bill, kind: 'ambiguous_match', stageJobId, startedAt,
          snapshot: {
            input: pickBillFields(bill),
            decision: 'ambiguous',
            priority: outcome.priority,
            matchKey: outcome.matchKey,
            candidates: outcome.candidates.slice(0, 5).map((c) => ({
              id: c.id, receiptNo: c.receiptNo, tourNo: c.tourNo,
              name: c.name, purchaseDate: c.purchaseDate,
            })),
            reason: `P${outcome.priority} 命中 ${outcome.candidates.length} 条 daily`,
          },
        }));
        writeBillMatchTrace(traceLog, {
          bill,
          outcome,
          result: 'pending_review',
          reason: `同一优先级命中 ${outcome.candidates.length} 条台账，需人工确认。`,
          candidates: outcome.candidates,
        });
        continue;
      }

      if (outcome.status === 'fuzzy') {
        stats.fuzzy += 1;
        logs.push({
          ...basePayload,
          matchStatus: 'pending_review',
          dailyReceiptId: outcome.candidates[0]?.id || null,
          note: `fuzzy: ${outcome.candidates.length} candidates`,
        });
        queuePending({
          workspaceKey,
          sourceTable: 'store_bill',
          sourceId: bill.id,
          reasonType: 'fuzzy_match',
          detail: {
            priority: 6,
            candidateIds: outcome.candidates.map((c) => c.id).slice(0, 10),
            // 可回溯字段:运营在账单核对页要能看出是哪个客户哪张票
            receiptNo: bill.receiptNo || null,
            name: bill.name || null,
            passportNo: bill.passportNo || null,
            purchaseDate: bill.purchaseDate || null,
          },
          status: 'open',
          createdAt: startedAt,
        });
        badcases.push(buildBillBadcase({
          workspaceKey, bill, kind: 'fuzzy_match', stageJobId, startedAt,
          snapshot: {
            input: pickBillFields(bill),
            decision: 'fuzzy',
            candidates: outcome.candidates.slice(0, 5).map((c) => ({
              id: c.id, receiptNo: c.receiptNo, tourNo: c.tourNo,
              name: c.name, purchaseDate: c.purchaseDate,
            })),
            reason: 'P6 模糊匹配，置信度低',
          },
        }));
        writeBillMatchTrace(traceLog, {
          bill,
          outcome,
          result: 'pending_review',
          reason: 'P6 模糊匹配只给候选，不自动入月。',
          candidates: outcome.candidates,
        });
        continue;
      }

      // matched exactly one candidate — check for field conflicts
      const hit = outcome.candidates[0];
      const conflicts = diffDailyVsBill(hit, bill);
      const plan = planMerge(hit, bill, conflicts);
      stats.priorityBreakdown[outcome.priority] = (stats.priorityBreakdown[outcome.priority] || 0) + 1;

      if (plan.pendingConflicts.length === 0) {
        stats.matched += 1;
        logs.push({
          ...basePayload,
          matchStatus: 'matched',
          dailyReceiptId: hit.id,
          conflictFields: plan.autoOverwriteFields.length
            ? { autoFilled: plan.autoOverwriteFields } : null,
        });
        statusUpdates.push({
          id: hit.id, workspaceKey,
          billMatchStatus: 'matched',
          billMatchPriority: outcome.priority,
          conflictFields: null,
        });
        writeBillMatchTrace(traceLog, {
          bill,
          outcome,
          result: 'matched',
          dailyReceiptId: hit.id,
          reason: `P${outcome.priority} 唯一命中，且没有阻断冲突。`,
          candidates: outcome.candidates,
          autoFilled: plan.autoOverwriteFields,
        });
      } else {
        stats.conflicts += 1;
        logs.push({
          ...basePayload,
          matchStatus: 'conflict',
          dailyReceiptId: hit.id,
          conflictFields: plan.pendingConflicts,
        });
        const queued = queuePending({
          workspaceKey,
          sourceTable: 'store_bill',
          sourceId: bill.id,
          reasonType: 'field_conflict',
          detail: {
            priority: outcome.priority,
            matchKey: outcome.matchKey,
            dailyReceiptId: hit.id,
            conflicts: plan.pendingConflicts,
            autoFillable: plan.autoOverwriteFields,
            // 可回溯字段:运营在账单核对页要能看出是哪个客户哪张票
            receiptNo: bill.receiptNo || null,
            name: bill.name || null,
            passportNo: bill.passportNo || null,
            purchaseDate: bill.purchaseDate || null,
          },
          status: 'open',
          createdAt: startedAt,
        });
        if (queued.inserted || queued.existingStatus === 'open') {
          statusUpdates.push({
            id: hit.id, workspaceKey,
            billMatchStatus: 'pending_review',
            billMatchPriority: outcome.priority,
            conflictFields: conflictFieldNames(plan.pendingConflicts),
          });
        }
        badcases.push(buildBillBadcase({
          workspaceKey, bill, kind: 'field_conflict', stageJobId, startedAt,
          dailyReceiptId: hit.id,
          snapshot: {
            input: pickBillFields(bill),
            matchedDaily: { id: hit.id, receiptNo: hit.receiptNo, tourNo: hit.tourNo },
            decision: 'conflict',
            priority: outcome.priority,
            conflicts: plan.pendingConflicts,
            reason: `匹配上 daily ${hit.id}，但 ${plan.pendingConflicts.length} 个字段冲突`,
          },
        }));
      }

      if (plan.pendingConflicts.length > 0) {
        writeBillMatchTrace(traceLog, {
          bill,
          outcome,
          result: 'conflict',
          dailyReceiptId: hit.id,
          reason: `P${outcome.priority} 命中台账，但字段存在冲突，进入人工确认。`,
          candidates: outcome.candidates,
          conflicts: plan.pendingConflicts,
          autoFilled: plan.autoOverwriteFields,
        });
      }

      } finally {
        flushProgress();
      }
      // 大月份责让:每 500 行让出一次事件循环,避免 node:sqlite 同步长循环把整个服务卡死。
      // 实测(tmp/blocking_test):5000 行间隔时事件循环可响应度 0%(服务无响应),
      // 降到 500 行可提到 ~88%。匹配是纯内存计算,yield 几乎无开销;落库仍按 FLUSH_EVERY 分批,二者解耦。
      if (processed % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    mark('matchLoop');
    // 最终推一次
    progressTracker.update({ workspaceKey, stage: 'bill_match', current: processed, total: filtered.length });

    // 落库剩余的最后一批
    flushBatch();
    mark('finalFlush');

    // 清扫孤儿待审:范围内账单上 open 的待审若本轮没再遇到同指纹冲突 → 作废。
    // 仍存在的冲突指纹在 encounteredFingerprints 里,保持原 open 行不动。
    stats.superseded_pending_reviews = typeof pendingReviewRepo.closeStaleByStoreBillIds === 'function'
      ? pendingReviewRepo.closeStaleByStoreBillIds({
        workspaceKey,
        storeBillIds: filtered.map((bill) => Number(bill.id)).filter(Number.isFinite),
        keepFingerprints: encounteredFingerprints,
        operator: 'bill_match_rerun',
      })
      : 0;
    mark('closeStale');

    // 错表 B 类:台账跨小票一致性(同护照多名 / 同名多护照)→ 写进同一个 conflict_fields,
    // 自动出现在「账单核对」字段冲突列表,审核员原地看+改。幂等(只重写自己的 consistency 标记)。
    const consistency = detectLedgerConsistency({ dailyReceiptRepo, db }).run({ workspaceKey });
    stats.ledgerNameConflicts = consistency.nameConflictRows;
    stats.ledgerPassportConflicts = consistency.passportConflictRows;
    mark('consistency');
    stats.timingsMs = timingsMs;

    const finishedAt = new Date().toISOString();
    const logMeta = traceLog
      ? traceLog.finish({ finishedAt, result: buildBillMatchOperatorStats(stats) })
      : null;

    return {
      workspaceKey,
      startedAt,
      finishedAt,
      ...stats,
      ...(logMeta ? { logFile: logMeta.logFile } : {}),
    };
  }

  return { run, buildIndex };
}

function recordManualLockRows(stats, result) {
  const rows = Array.isArray(result?.skippedDueToManualLockRows)
    ? result.skippedDueToManualLockRows
    : [];
  for (const row of rows) recordManualLockFields(stats, row.fields || []);
}

function recordManualLockResult(stats, result) {
  const fields = Array.isArray(result?.skippedDueToManualLock)
    ? result.skippedDueToManualLock
    : [];
  recordManualLockFields(stats, fields);
}

function recordManualLockFields(stats, fields) {
  if (!fields.length) return;
  stats.skipped_due_to_manual_lock.rows_affected += 1;
  for (const field of fields) {
    stats.skipped_due_to_manual_lock.fields[field] =
      (stats.skipped_due_to_manual_lock.fields[field] || 0) + 1;
  }
}

module.exports = { createBillMatchService };
