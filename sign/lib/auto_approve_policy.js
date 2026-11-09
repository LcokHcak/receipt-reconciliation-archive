'use strict';

/**
 * 自动终审策略(B1) — 纯函数,可审计,默认极保守。
 *
 * 红线:不让错误信息自动通过。放行 = 多个相互独立的硬约束「同时」成立;
 * 任一闸不过即不放行(留待人工终审),并在 blockedBy 里逐条记原因。
 *
 * 决策点在「审核侧终审」(workbench.sqlite / source_image)。此处全量
 * tour_match(团号+代理+日期窗)尚未运行——它在终审通过、桥接进月度
 * (daily_receipt_export, source_type='workbench')之后才跑。因此「团号读对」
 * 在通过前可用的独立证据是:团号 ∈ 本批团号表(membership,查 batch_group_code)。
 * 完整 tour_match 仍在通过后作为第二重兜底网(见 scripts/diagnostics 回放与告警)。
 *
 * 本模块「只判断」,不读库、不写库、不查团号表。跨库的团号表 membership 由调用方
 * 查好后通过 signals.groupCodeInTable 传入——保持纯函数可单测、可回放、可审计。
 */

const { getTaskRequiredFieldChecks } = require('./workbench_task_flow');
const { DOC_TYPES } = require('./package_constants');

const POLICY_VERSION = 'auto-policy@v1';

// 机器的「硬」复核信号:无文档 / OCR 失败一类——这类必须拦。
// 而 field_*_invalid(护照名/号/小票号等字段级)不在此列:本策略对小票字段
// 自身做强校验(invalidFields),且护照字段 reason 对小票无关,故不作通用拦截。
const HARD_REVIEW_REASONS = Object.freeze([
  'qwen_no_document',
  'qwen_error',
  'ocr_error',
  'no_document',
]);

const DEFAULT_OPTIONS = Object.freeze({
  // 分类置信阈值:显著高于现有「自动确认分类」用的 0.75,只放最稳的。
  minDocTypeConfidence: 0.92,
  // 第一档只放小票;护照另开一档(走 MRZ 校验,默认不在白名单内)。
  allowedDocTypes: Object.freeze([DOC_TYPES.RECEIPT]),
  // 小票必须团号 ∈ 团号表(「团号读对」独立证据)。
  requireGroupCodeMembership: true,
  // 小票必须小票号 ∈ 免税店账单(「小票号读对」独立证据;读错的号对不上账单)。
  // 这是唯一能独立验小票号的信号,缺它则审核时点 ~5% 小票号假阳性无法消除。
  requireBillMembership: true,
  // 仅这些「硬」机器复核原因才一票否决(见上)。
  hardReviewReasons: HARD_REVIEW_REASONS,
});

const BLOCK_CODES = Object.freeze({
  MACHINE_NOT_COMPLETED: 'machine_not_completed',
  DOC_TYPE_NOT_ALLOWED: 'doc_type_not_allowed',
  LOW_CONFIDENCE: 'low_confidence',
  MACHINE_HARD_FLAG: 'machine_hard_flag',
  REPHOTO_REQUESTED: 'rephoto_requested',
  CLASSIFY_NOT_CONFIRMED: 'classification_not_confirmed',
  MISSING_FIELDS: 'missing_fields',
  INVALID_FIELDS: 'invalid_fields',
  GROUP_CODE_NOT_IN_TABLE: 'group_code_not_in_table',
  RECEIPT_NOT_IN_BILL: 'receipt_not_in_bill',
});

function normText(value) {
  return String(value == null ? '' : value).trim();
}

function toReasonList(value) {
  if (Array.isArray(value)) {
    return value.map(normText).filter(Boolean);
  }
  return normText(value)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 评估一张审核任务能否自动终审通过。
 *
 * @param {object} task   workbench source_image 的 task 视图(camelCase 字段)。
 * @param {object} signals 调用方查好的跨库/外部信号:
 *   - groupCodeInTable {boolean}  该小票团号是否在本批团号表里(membership)。
 * @param {object} options 阈值与白名单(默认 DEFAULT_OPTIONS,可覆盖)。
 * @returns {{approve:boolean, reasons:string[], blockedBy:string[], evidence:object, policyVersion:string}}
 */
function evaluateAutoApprove(task = {}, signals = {}, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const allowedDocTypes = Array.isArray(opts.allowedDocTypes)
    ? opts.allowedDocTypes
    : DEFAULT_OPTIONS.allowedDocTypes;
  const hardReviewReasons = Array.isArray(opts.hardReviewReasons)
    ? opts.hardReviewReasons
    : DEFAULT_OPTIONS.hardReviewReasons;

  const summary = getTaskRequiredFieldChecks(task);
  const docType = summary.docTypeFinal;
  const confidence = Number(task.docTypeConfidence || 0);
  const machineState = normText(task.machineState);
  const reviewReasons = toReasonList(task.reviewReasons);

  const blockedBy = [];
  const reasons = [];

  // 1) OCR 必须正常跑完(非 error/processing/queued)。
  if (machineState !== 'completed') {
    blockedBy.push(BLOCK_CODES.MACHINE_NOT_COMPLETED);
  } else {
    reasons.push('machine_completed');
  }

  // 2) 只放白名单文档类型(第一档=小票;other/护照不在内)。
  if (!allowedDocTypes.includes(docType)) {
    blockedBy.push(BLOCK_CODES.DOC_TYPE_NOT_ALLOWED);
  } else {
    reasons.push(`doc_type_allowed:${docType}`);
  }

  // 3) 分类置信门(高阈值)。
  if (!(confidence >= Number(opts.minDocTypeConfidence))) {
    blockedBy.push(BLOCK_CODES.LOW_CONFIDENCE);
  } else {
    reasons.push(`confidence>=${opts.minDocTypeConfidence}`);
  }

  // 4) 仅机器「硬」复核信号(无文档/OCR 失败)才拦。字段级 reason(尤其护照名/号)
  //    对小票无关,且小票字段由本策略自身强校验覆盖,不在此拦截。
  const hitHardReasons = reviewReasons.filter((r) => hardReviewReasons.includes(r));
  if (hitHardReasons.length > 0) {
    blockedBy.push(BLOCK_CODES.MACHINE_HARD_FLAG);
  } else {
    reasons.push('no_hard_machine_flag');
  }

  // 5) 已被要求重拍的不自动。
  if (task.rephotoRequested === true) {
    blockedBy.push(BLOCK_CODES.REPHOTO_REQUESTED);
  }

  // 6) 分类必须已确认(自动确认或人工确认)。
  if (!summary.classificationConfirmed) {
    blockedBy.push(BLOCK_CODES.CLASSIFY_NOT_CONFIRMED);
  } else {
    reasons.push('classification_confirmed');
  }

  // 7) 字段必须齐全。
  if (summary.missingFields.length > 0) {
    blockedBy.push(BLOCK_CODES.MISSING_FIELDS);
  } else {
    reasons.push('no_missing_fields');
  }

  // 8) 字段必须全部通过强校验(店∈白名单 + 店专属长度 + 日期严格+购买≤离境)。
  //    invalidFields 由 getTaskRequiredFieldChecks/validateFieldValue 产出。
  if (summary.invalidFields.length > 0) {
    blockedBy.push(BLOCK_CODES.INVALID_FIELDS);
  } else {
    reasons.push('all_fields_valid');
  }

  // 9) 小票:团号必须 ∈ 团号表(「团号读对」独立证据)。
  if (opts.requireGroupCodeMembership && docType === DOC_TYPES.RECEIPT) {
    if (signals.groupCodeInTable === true) {
      reasons.push('group_code_in_table');
    } else {
      blockedBy.push(BLOCK_CODES.GROUP_CODE_NOT_IN_TABLE);
    }
  }

  // 10) 小票:小票号必须 ∈ 免税店账单(唯一能独立验小票号的闸;读错的号对不上账单)。
  if (opts.requireBillMembership && docType === DOC_TYPES.RECEIPT) {
    if (signals.receiptInBill === true) {
      reasons.push('receipt_in_bill');
    } else {
      blockedBy.push(BLOCK_CODES.RECEIPT_NOT_IN_BILL);
    }
  }

  return {
    approve: blockedBy.length === 0,
    reasons,
    blockedBy,
    policyVersion: POLICY_VERSION,
    evidence: {
      docType,
      confidence,
      machineState,
      classificationConfirmed: summary.classificationConfirmed,
      missingFields: summary.missingFields.map((f) => f.label),
      invalidFields: summary.invalidFields.map((f) => `${f.label}（${f.issue}）`),
      groupCodeInTable: signals.groupCodeInTable === true,
      receiptInBill: signals.receiptInBill === true,
      hardReviewReasons: hitHardReasons,
    },
  };
}

module.exports = {
  BLOCK_CODES,
  DEFAULT_OPTIONS,
  POLICY_VERSION,
  evaluateAutoApprove,
};
