'use strict';

/**
 * 代理工作台 V2 — 客户级投影契约(纯函数层)。
 *
 * 真相源分工(架构文档 §6):
 *   - 客户身份/代理/owner/收票时间/原图数 ← customer.json(锚点,本文件 buildCustomerAnchor)
 *   - 审核/团号/模式/结算 ← batch.json(覆盖层,本文件 buildReviewOverlay)
 * 铁律:task 上的空代理名绝不覆盖客户锚点;自然月只从 createdAt(业务时区)推导,
 * 禁止解析 workspaceKey;customerId 不全局唯一,主键必须 workspaceKey+customerId。
 *
 * 票级两步流修订(2026-07-12 用户拍板,替代组级 tourConfirm 口径):
 *   - tour_pending 判据 = 组内存在"未表态小票"(tourStance 空且非豁免);
 *   - 候选模式 = 未表态小票的 modeRawPre;确认模式 = tourStance='matched' 票的
 *     modeManualPick||modeRawPre——两者必须分开,候选绝不能当已确认展示。
 * ⚠️ 豁免/锁定判定与前端 frontend/src/lib/reviewDisplay.js 的
 * isTourExemptTask/isTaskStanceLocked 逐字同口径(百货 canonical *_DEPT/原始文字、
 * 机场"无");改一边必须改另一边(副本口径漂移三犯的教训)。
 *
 * 本层不读文件、不访问 DB、不隐式取当前时间。
 */

const { ROOT_SOURCE_GROUP_KEY } = require('../source_group_utils');
const { isNoTourTask } = require('../no_tour');

const UNLABELED_AGENT_KEY = '__unlabeled__';
const UNLABELED_AGENT_NAME = '未标代理';

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// V1 只做字符级规范化:NFKC(全半角统一)+ 去首尾空格;key 再小写。
// 不做语义合并("永乐"≠"永乐旅行")。
function normalizeAgentName(raw) {
  const normalized = clean(raw).normalize('NFKC').trim();
  if (!normalized) {
    return { agentKey: UNLABELED_AGENT_KEY, agentName: UNLABELED_AGENT_NAME, unlabeled: true };
  }
  return { agentKey: normalized.toLowerCase(), agentName: normalized, unlabeled: false };
}

// 业务时区下的自然月(YYYY-MM)。无效输入返回 ''。
function calendarMonthOf(isoString, timeZone = 'Asia/Seoul') {
  const t = Date.parse(String(isoString || ''));
  if (!Number.isFinite(t)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(t));
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  return year && month ? `${year}-${month}` : '';
}

function customerPkOf(workspaceKey, customerId) {
  return `${clean(workspaceKey)}::${clean(customerId)}`;
}

// createdAt 缺失时的降级:customerId 形如 CLyyyymmdd-xxx → 取 yyyy-mm,并记 warning。
function monthFromCustomerId(customerId) {
  const m = clean(customerId).match(/^CL(\d{4})(\d{2})\d{2}/);
  return m ? `${m[1]}-${m[2]}` : '';
}

function buildCustomerAnchor({ customer = {}, workspaceKey = '', timeZone = 'Asia/Seoul' } = {}) {
  const warnings = [];
  const customerId = clean(customer.customerId || customer.id);
  const createdAt = clean(customer.createdAt);

  let calendarMonth = '';
  let monthSource = '';
  if (createdAt) {
    calendarMonth = calendarMonthOf(createdAt, timeZone);
    monthSource = calendarMonth ? 'createdAt' : '';
  }
  if (!calendarMonth) {
    const fallback = monthFromCustomerId(customerId);
    if (fallback) {
      calendarMonth = fallback;
      monthSource = 'customerId';
    }
    warnings.push('created_at_missing');
  }
  if (!calendarMonth) warnings.push('calendar_month_unresolved');
  // 主键用 '::' 拼接;分量含 '::' 会造成键歧义(系统生成的 ws/CLid 不会出现,出现即数据异常)
  if (clean(workspaceKey).includes('::') || customerId.includes('::')) {
    warnings.push('pk_separator_collision');
  }

  const agent = normalizeAgentName(customer.agentName);
  const images = Array.isArray(customer.images) ? customer.images : [];
  const abnormalImageCount = images.filter((img) => (
    img && (img.preprocessWarning || String(img.preprocessMessage || '').startsWith('split_failed_keep_original'))
  )).length;

  return {
    customerPk: customerPkOf(workspaceKey, customerId),
    calendarMonth,
    monthSource,
    warnings,
    workspaceKey: clean(workspaceKey),
    customerId,
    ownerUserId: customer.ownerUserId ?? null,
    ownerUsername: clean(customer.ownerUsername) || null,
    agentKey: agent.agentKey,
    agentName: agent.agentName,
    agentUnlabeled: agent.unlabeled,
    customerName: clean(customer.displayName) || clean(customer.folderNameFinal) || clean(customer.folderNameInitial) || '',
    // 活动批次关联(customer.review 指向):批次覆盖层用它做守卫——旧批次不许覆盖新批次的行。
    activeBatchId: clean(customer.review && customer.review.lastBatchId),
    activeGroupKey: clean(customer.review && customer.review.lastSourceGroupId),
    receivedAt: createdAt,
    originalImageCount: images.length,
    abnormalImageCount,
  };
}

// ── 票级判定(与前端 reviewDisplay 同口径的服务端孪生)─────────────────────
function normalizeDocTypeLocal(task = {}) {
  const raw = clean(task.docTypeFinal || task.docTypeAuto || task.docType).toLowerCase();
  if (raw === 'passport' || raw.includes('护照')) return 'passport';
  if (raw === 'receipt' || raw.includes('小票') || raw.includes('收据')) return 'receipt';
  return 'other';
}

function isOriginalLikeTask(task = {}) {
  const role = clean(task.autoSplitRole).toLowerCase();
  const message = clean(task.preprocessMessage).toLowerCase();
  return role === 'original' || message.includes('keep_original') || message.includes('no_split_detected');
}

function isTourExemptTask(task = {}) {
  if (normalizeDocTypeLocal(task) !== 'receipt') return true;
  // 无团号判定单源 lib/no_tour:字面量「无」或表态none+空值(存量行)同判豁免
  if (isNoTourTask(task)) return true;
  const store = String(task.receiptStoreFinal || task.receiptStoreAuto || '');
  return /_DEPT$/i.test(store) || /百货|백화점/.test(store);
}

function isTaskStanceLocked(task = {}) {
  if (normalizeDocTypeLocal(task) !== 'receipt') return false;
  if (isTourExemptTask(task)) return false;
  return !clean(task.tourStance);
}

function isTaskReviewDone(task = {}) {
  const pr = clean(task.processResult);
  const rs = clean(task.reviewStatus);
  return Boolean(task.reviewed)
    || pr === 'approved'
    || pr.includes('通过')
    || pr.includes('拒绝')
    || rs.includes('拒绝');
}

// 审核覆盖层:从批次任务聚合客户级计数与模式(候选/确认分开)。
function buildReviewOverlay({ tasks = [], settlementStatus = '' } = {}) {
  const candidateModes = new Set();
  const confirmedModes = new Set();
  let recognizingCount = 0;
  let rephotoCount = 0;
  let stanceLockedCount = 0;
  let pendingReviewCount = 0;
  let receiptCount = 0;
  let nonExemptReceiptCount = 0;

  for (const task of tasks) {
    if (!task || isOriginalLikeTask(task)) continue;
    const docType = normalizeDocTypeLocal(task);
    if (docType === 'receipt') {
      receiptCount += 1;
      if (!isTourExemptTask(task)) nonExemptReceiptCount += 1;
    }
    if (task.machineState && task.machineState !== 'completed') recognizingCount += 1;
    if (task.rephotoRequested) rephotoCount += 1;
    if (isTaskStanceLocked(task)) {
      stanceLockedCount += 1;
      const mode = clean(task.modeRawPre);
      if (mode) candidateModes.add(mode);
    }
    if (docType === 'receipt' && clean(task.tourStance) === 'matched') {
      const mode = clean(task.modeManualPick) || clean(task.modeRawPre);
      if (mode) confirmedModes.add(mode);
    }
    if (!task.rephotoRequested && !isTaskReviewDone(task)) pendingReviewCount += 1;
  }

  return {
    hasTasks: tasks.length > 0,
    recognizingCount,
    rephotoCount,
    stanceLockedCount,
    pendingReviewCount,
    receiptCount,
    nonExemptReceiptCount,
    candidateModes: [...candidateModes],
    confirmedModes: [...confirmedModes],
    settlementStatus: clean(settlementStatus),
  };
}

// 任务 → 客户引用(sourceOriginalPath 前两段 = workspaceKey/customerId;与前端同口径)。
function parseTaskCustomerRef(task = {}) {
  const parts = clean(task.sourceOriginalPath).replace(/\\/g, '/').split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { workspaceKey: parts[0], customerId: parts[1] };
}

// 整批 → 客户级覆盖层条目。批次实时同步(sync service)与历史重建(rebuild service)
// 共用这一份聚合,禁止各写各的副本(字段清洗三犯教训)。
// 返回 {entries, skippedNoRef}:entries 按客户去重;组键取客户首个任务的 sourceGroupKey。
function buildBatchOverlayEntries(batch = {}) {
  const byCustomer = new Map();
  let skippedNoRef = 0;
  for (const task of batch.tasks || []) {
    const ref = parseTaskCustomerRef(task);
    if (!ref) {
      skippedNoRef += 1;
      continue;
    }
    const pk = customerPkOf(ref.workspaceKey, ref.customerId);
    if (!byCustomer.has(pk)) {
      byCustomer.set(pk, {
        customerPk: pk,
        ref,
        tasks: [],
        groupKey: clean(task.sourceGroupKey) || ROOT_SOURCE_GROUP_KEY,
      });
    }
    byCustomer.get(pk).tasks.push(task);
  }
  const groupByKey = new Map((batch.sourceGroups || []).map((g) => [clean(g && g.key), g]));
  const entries = [];
  for (const entry of byCustomer.values()) {
    const sourceGroup = groupByKey.get(entry.groupKey) || null;
    const settlementStatus = clean(sourceGroup && sourceGroup.settlementStatus);
    const storeKeys = [...new Set(entry.tasks
      .filter((t) => normalizeDocTypeLocal(t) === 'receipt')
      .map((t) => clean(t.receiptStoreFinal || t.receiptStoreAuto))
      .filter(Boolean))];
    entries.push({
      customerPk: entry.customerPk,
      workspaceKey: entry.ref.workspaceKey,
      customerId: entry.ref.customerId,
      groupKey: entry.groupKey,
      storeKeys,
      settlementStatus,
      tasks: entry.tasks, // 该客户在批次里的任务子集(reconciler 组上下文用,免二次扫描)
      overlay: buildReviewOverlay({ tasks: entry.tasks, settlementStatus }),
    });
  }
  return { entries, skippedNoRef };
}

module.exports = {
  parseTaskCustomerRef,
  buildBatchOverlayEntries,
  UNLABELED_AGENT_KEY,
  UNLABELED_AGENT_NAME,
  normalizeAgentName,
  calendarMonthOf,
  customerPkOf,
  buildCustomerAnchor,
  buildReviewOverlay,
  isTourExemptTask,
  isTaskStanceLocked,
};
