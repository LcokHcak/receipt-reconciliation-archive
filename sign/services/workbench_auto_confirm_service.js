'use strict';

/**
 * 审核台「尝试自动确认」服务(B1)— 组级,零假阳性边界。
 *
 * 单位是「源分组」(一本护照 + 其小票),因为终审审批本就是整组进行
 * (approveSourceGroupTasks 要求组内有且仅一本护照、字段校验过)。
 *
 * 一组自动确认 当且仅当:
 *  - 组内每张小票都过策略边界(强校验 + 置信≥0.92 + 团号∈团号表 + 小票号∈账单);
 *  - 本组护照号 == 账单权威护照号(账单地面真值反验护照号)。
 * 命中 → 复用 approveSourceGroup(同一条月度入账路径);否则跳过,记 blockedBy。
 *
 * 只读探针 + 复用既有审批,本服务不直接写库。
 */

const { evaluateAutoApprove } = require('../lib/auto_approve_policy');
const { normalizeDocType } = require('../lib/workbench_task_flow');
const { DOC_TYPES } = require('../lib/package_constants');

const AUTO_OPERATOR = 'auto-confirm@v1';

function pick(task, ...keys) {
  for (const k of keys) {
    const v = String(task?.[k] == null ? '' : task[k]).trim();
    if (v) return v;
  }
  return '';
}
function isReceipt(task) {
  return normalizeDocType(task?.docTypeFinal || task?.docType) === DOC_TYPES.RECEIPT;
}
function isPassport(task) {
  return normalizeDocType(task?.docTypeFinal || task?.docType) === DOC_TYPES.PASSPORT;
}
function shortId(task) {
  return String(task?.id || task?.legacyTaskId || '').split('::').pop() || '?';
}

function createWorkbenchAutoConfirmService({
  loadBatchGroups,
  approveGroup,
  probe,
  evaluatePolicy = evaluateAutoApprove,
  logger = console,
}) {
  if (typeof loadBatchGroups !== 'function') throw new Error('loadBatchGroups required');
  if (typeof approveGroup !== 'function') throw new Error('approveGroup required');
  if (!probe || typeof probe.billLookup !== 'function') throw new Error('probe required');

  /** 纯判断:一组能否自动确认。返回 {ok, blockedBy[], receipts, passportNo}。 */
  function evaluateGroup(group = {}) {
    const tasks = Array.isArray(group.tasks) ? group.tasks : [];
    const receipts = tasks.filter(isReceipt);
    const passports = tasks.filter(isPassport);
    const blockedBy = [];

    if (receipts.length === 0) return { ok: false, blockedBy: ['no_receipt'] };
    if (passports.length !== 1) return { ok: false, blockedBy: ['passport_count_not_1'] };

    const passport = passports[0];
    const ws = probe.monthOf(
      pick(receipts[0], 'purchaseDateFinal', 'purchaseDateAuto') || pick(passport, 'departureDateFinal', 'departureDateAuto')
    );
    const passportTour = pick(passport, 'tourNoFinal', 'tourNoAuto', 'tourNo');
    const passportDeparture = pick(passport, 'departureDateFinal', 'departureDateAuto', 'departureDate');

    const billPassports = new Set();
    for (const r of receipts) {
      // 小票任务补齐组级字段(团号/出境日期来自同组护照)
      const merged = {
        ...r,
        groupNoAuto: pick(r, 'groupNoAuto') || passportTour,
        departureDateAuto: pick(r, 'departureDateAuto') || passportDeparture,
      };
      const tourNo = pick(merged, 'groupNoFinal', 'groupNoAuto');
      const receiptNo = pick(merged, 'receiptNoFinal', 'receiptNoAuto');
      const bill = probe.billLookup(receiptNo, ws);
      const signals = {
        groupCodeInTable: probe.tourInTable(tourNo, ws),
        receiptInBill: Boolean(bill),
      };
      const res = evaluatePolicy(merged, signals);
      if (!res.approve) {
        for (const b of res.blockedBy) blockedBy.push(`${shortId(r)}:${b}`);
      }
      if (bill && bill.passportNo) billPassports.add(bill.passportNo.toUpperCase());
    }

    // 账单地面真值反验护照号(账单命中时账单带权威护照号)
    const groupPassportNo = pick(passport, 'passportNoFinal', 'passportNoAuto').toUpperCase();
    if (billPassports.size > 0 && groupPassportNo && !billPassports.has(groupPassportNo)) {
      blockedBy.push('passport_no_mismatch_bill');
    }

    return { ok: blockedBy.length === 0, blockedBy, passportNo: groupPassportNo };
  }

  async function autoConfirmBatch({ batchId, operator = null } = {}) {
    if (!batchId) {
      const e = new Error('batchId required');
      e.code = 'BATCH_ID_REQUIRED';
      throw e;
    }
    const groups = (await loadBatchGroups(batchId)) || [];
    const result = {
      batchId, scanned: 0, confirmed: 0, skipped: 0,
      confirmedGroups: [], skips: [],
    };

    for (const group of groups) {
      // 已审过的组不动
      const tasks = Array.isArray(group.tasks) ? group.tasks : [];
      const allReviewed = tasks.length > 0 && tasks.every((t) => t.reviewed === true);
      if (allReviewed) continue;

      result.scanned += 1;
      const decision = evaluateGroup(group);
      if (!decision.ok) {
        result.skipped += 1;
        result.skips.push({ groupKey: group.groupKey, blockedBy: decision.blockedBy });
        continue;
      }
      try {
        await approveGroup({ batchId, groupKey: group.groupKey, operator: operator || AUTO_OPERATOR });
        result.confirmed += 1;
        result.confirmedGroups.push(group.groupKey);
      } catch (err) {
        result.skipped += 1;
        result.skips.push({ groupKey: group.groupKey, blockedBy: [`approve_failed:${err.code || err.message}`] });
        logger.warn?.(`[auto-confirm] group ${group.groupKey} approve failed: ${err.message}`);
      }
    }
    return result;
  }

  return { autoConfirmBatch, evaluateGroup, AUTO_OPERATOR };
}

module.exports = { createWorkbenchAutoConfirmService, AUTO_OPERATOR };
