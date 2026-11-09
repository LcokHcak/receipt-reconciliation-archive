'use strict';

const { normalizeString, normalizeDate } = require('../../../lib/monthly_pipeline/matching/field_diff');
const { RULE_VERSION } = require('../../../lib/monthly_pipeline/rule_version');

// 姓名键去**全部**空格(0727反馈#9 配套):任务侧姓名新标准是「姓␣名段合并」
// (PHAM THITHUYLINH),账单 Excel 侧常见全分写(PHAM THI THUY LINH)——
// 键若保留词间空格,P5/P6 会因纯排版差异漏配。field_diff.normalizeName 做冲突比对时
// 早就因同类病例(TEH SIEW CHYI vs TEH SIEWCHYI)去了全空格,索引键收口到同一口径。
// 只动姓名键;护照/票号/店等其它键维持 normalizeString 原样。
const normalizeNameKey = (v) => normalizeString(v).replace(/\s+/g, '');

function hasSharedCustomerSignal(probe, row) {
  const probePassport = normalizeString(probe.passportNo);
  const rowPassport = normalizeString(row.passportNo);
  if (probePassport && rowPassport && probePassport === rowPassport) return true;

  const probeName = normalizeNameKey(probe.name);
  const rowName = normalizeNameKey(row.name);
  return Boolean(probeName && rowName && probeName === rowName);
}

function createBuildIndex(dailyReceiptRepo) {
  // 风险 1 + 2 修复:
  //  风险 1 —— 候选池只看 ledger_status='posted',不看 tour_match_status。
  //    后果:posted 但未通过团号匹配的待补救行(agent_mismatch / tour_not_found 等)
  //    会进候选池,把一笔本应进交付或进未收的真账单 P1 命中吞掉 → 静默丢失。
  //    修复:候选行必须 posted 且 tour_match_status='matched'(isMatchableLedgerRow)。
  //  风险 2 —— 候选池是全工作区的,跨桶可见。
  //    后果:A 桶的账单可能命中 B 桶台账行,造成串桶误匹配。
  //    修复:按桶(folder)运行时只用本桶 mode_folder 的台账行建索引。
  function buildIndex(workspaceKey, { folder = null } = {}) {
    const rows = typeof dailyReceiptRepo._listMatchCandidates === 'function'
      ? dailyReceiptRepo._listMatchCandidates({ workspaceKey, folder })
      : (typeof dailyReceiptRepo._listAll === 'function'
        ? dailyReceiptRepo._listAll({ workspaceKey })
          .filter(isMatchableLedgerRow)
          .filter((r) => !folder || (r.modeFolder ?? r.mode_folder ?? null) === folder)
        : []);

    const byReceipt = new Map();
    const byReceiptDate = new Map();
    const byReceiptTour = new Map();
    const byPassportDateShop = new Map();
    const byNameDateShop = new Map();
    const byNameDate = new Map();
    const byReceiptPrefix = new Map();

    const pushTo = (m, k, v) => {
      if (!k) return;
      const arr = m.get(k);
      if (arr) arr.push(v); else m.set(k, [v]);
    };

    for (const r of rows) {
      const receipt = normalizeString(r.receiptNo);
      const pDate = normalizeDate(r.purchaseDate);
      const tour = normalizeString(r.tourNo);
      const passport = normalizeString(r.passportNo);
      const shop = normalizeString(r.shop);
      const name = normalizeNameKey(r.name);

      if (receipt) {
        pushTo(byReceipt, receipt, r);
        if (pDate) pushTo(byReceiptDate, `${receipt}|${pDate}`, r);
        if (tour) pushTo(byReceiptTour, `${receipt}|${tour}`, r);
        if (receipt.length >= 2) {
          const prefix = receipt.slice(0, Math.min(10, receipt.length - 1));
          if (prefix) pushTo(byReceiptPrefix, prefix, r);
        }
      }
      if (passport && pDate && shop) pushTo(byPassportDateShop, `${passport}|${pDate}|${shop}`, r);
      if (name && pDate && shop) pushTo(byNameDateShop, `${name}|${pDate}|${shop}`, r);
      if (name && pDate) pushTo(byNameDate, `${name}|${pDate}`, r);
    }

    const get = (m, k) => (k ? (m.get(k) || []) : []);

    return {
      _dailyCount: rows.length,
      findDailyByReceipt: (receiptNo) => get(byReceipt, normalizeString(receiptNo)),
      findDailyByReceiptDate: (receiptNo, purchaseDate) => {
        const r = normalizeString(receiptNo);
        const d = normalizeDate(purchaseDate);
        return r && d ? get(byReceiptDate, `${r}|${d}`) : [];
      },
      findDailyByReceiptTour: (receiptNo, tourNo) => {
        const r = normalizeString(receiptNo);
        const t = normalizeString(tourNo);
        return r && t ? get(byReceiptTour, `${r}|${t}`) : [];
      },
      findDailyByPassportDateShop: (passportNo, purchaseDate, shop) => {
        const p = normalizeString(passportNo);
        const d = normalizeDate(purchaseDate);
        const s = normalizeString(shop);
        return p && d && s ? get(byPassportDateShop, `${p}|${d}|${s}`) : [];
      },
      findDailyByNameDateShop: (name, purchaseDate, shop) => {
        const n = normalizeNameKey(name);
        const d = normalizeDate(purchaseDate);
        const s = normalizeString(shop);
        return n && d && s ? get(byNameDateShop, `${n}|${d}|${s}`) : [];
      },
      findDailyFuzzy: (probe) => {
        const r = normalizeString(probe.receiptNo);
        const d = normalizeDate(probe.purchaseDate);
        // P6 口径要求"小票号前缀 + 同购买日 + 同护照/姓名"。没有小票号信号时,
        // 不能退化成纯"姓名+日期"——同团多个同名客人会被错关联到不相关账单。
        if (!r || r.length < 2) return [];
        const prefix = r.slice(0, Math.min(10, r.length - 1));
        const hit = get(byReceiptPrefix, prefix);
        // A receipt prefix alone is too broad for stores that share a long
        // terminal/register prefix across many unrelated receipts. Keep it as
        // an OCR-tolerance signal only when the purchase date and a customer
        // identity signal also agree.
        const sameDateAndCustomer = d
          ? hit.filter((row) => normalizeDate(row.purchaseDate) === d && hasSharedCustomerSignal(probe, row))
          : [];
        if (sameDateAndCustomer.length > 0) return sameDateAndCustomer;
        const n = normalizeNameKey(probe.name);
        if (n && d) return get(byNameDate, `${n}|${d}`);
        return [];
      },
    };
  }
  return buildIndex;
}

function pickBillFields(bill) {
  return {
    id: bill.id,
    storeFamily: bill.storeFamily,
    receiptNo: bill.receiptNo,
    tourNo: bill.tourNo,
    name: bill.name,
    fullName: bill.fullName,
    passportNo: bill.passportNo,
    purchaseDate: bill.purchaseDate,
  };
}

function pickNormalized(bill) {
  return {
    receiptNo: normalizeString(bill.receiptNo),
    tourNo: normalizeString(bill.tourNo),
    passportNo: normalizeString(bill.passportNo),
    name: normalizeString(bill.name),
    purchaseDate: normalizeDate(bill.purchaseDate),
  };
}

function isPostedLedgerRow(row) {
  return row?.ledgerStatus === 'posted' || row?.ledger_status === 'posted';
}

// 可参与账单匹配的台账行:必须已入月(posted)且已通过团号匹配(matched)。
// 仅 posted 不够 —— 未通过团号匹配的行(待补救)不应进候选池(风险 1)。
function isMatchableLedgerRow(row) {
  if (!isPostedLedgerRow(row)) return false;
  const tourStatus = row?.tourMatchStatus ?? row?.tour_match_status ?? null;
  return tourStatus === 'matched';
}

function buildBillBadcase({ workspaceKey, bill, kind, stageJobId, startedAt, snapshot, dailyReceiptId = null }) {
  return {
    workspaceKey,
    stage: 'bill_match',
    kind,
    ruleVersion: RULE_VERSION,
    sourceTable: 'store_bill',
    sourceId: bill.id,
    dailyReceiptId,
    storeBillId: bill.id,
    receiptNo: bill.receiptNo || null,
    tourNo: bill.tourNo || null,
    passportNo: bill.passportNo || null,
    name: bill.name || bill.fullName || null,
    purchaseDate: bill.purchaseDate || null,
    snapshot,
    createdAt: startedAt,
    stageJobId,
  };
}

function createBillMatchTraceLog({
  stageLogService,
  workspaceKey,
  stageJobId,
  startedAt,
  billsScanned,
  dailyCount,
}) {
  if (!stageLogService || typeof stageLogService.createRunLog !== 'function') return null;
  const log = stageLogService.createRunLog({
    workspaceKey,
    stage: 'bill_match',
    stageJobId,
    startedAt,
  });
  log.writeLine('账单匹配核对日志');
  log.writeLine(`工作区：${workspaceKey}`);
  if (stageJobId != null) log.writeLine(`本次操作编号：${stageJobId}`);
  log.writeLine(`规则版本：${RULE_VERSION}`);
  log.writeLine(`开始时间：${startedAt}`);
  log.writeLine(`本次导入账单明细：${billsScanned} 条`);
  log.writeLine(`可参与匹配的台账记录：${dailyCount} 条`);
  log.writeLine('');
  log.writeLine('这个日志什么时候用：财务在月度工作台导入店铺账单后，点击【账单匹配】或【账单匹配并合并月度数据】时自动生成。');
  log.writeLine('怎么用来检查：逐条看“账单Excel字段”和“台账字段”的值是否一致；再看“数据去向”确认本条进入了正式月度数据、未收小票账单或人工确认表。');
  log.writeLine('匹配前提：只有已经通过审核并进入台账的记录会参与账单匹配；重拍、待补救、字段未确认的数据不会参与。');
  log.writeLine('');
  log.writeLine('匹配规则顺序：');
  for (const priority of [1, 2, 3, 4, 5, 6]) {
    log.writeLine(`- ${getPriorityRule(priority).title}`);
  }
  log.writeLine('冲突处理：台账字段为空时可以由账单补充；两边都有值但不同，会进入【人工确认表】，不会自动覆盖。');
  log.writeLine('');
  log.writeLine('逐条匹配过程');
  return log;
}

function writeBillMatchTrace(log, {
  bill,
  outcome,
  result,
  reason = '',
  candidates = [],
  conflicts = [],
  autoFilled = [],
}) {
  if (!log) return;
  const rule = getPriorityRule(outcome.priority);
  const selectedCandidate = candidates[0] || outcome.candidates?.[0] || null;
  log.writeLine('---');
  log.writeLine(`账单来源：${formatBillSource(bill)}`);
  log.writeLine('账单Excel主要字段：');
  for (const field of ['receiptNo', 'tourNo', 'name', 'passportNo', 'purchaseDate', 'departureDate', 'shop', 'branch']) {
    log.writeLine(`  - 【${fieldLabel(field)}】${formatValue(readBillField(bill, field))}`);
  }
  log.writeLine(`使用规则：${rule.title}`);
  writeComparisonLines(log, bill, selectedCandidate, rule.fields);
  log.writeLine(`处理结果：${resultLabel(result)}`);
  log.writeLine(`数据去向：本条进入【${destinationLabel(result)}】`);
  if (reason) log.writeLine(`说明：${toOperatorReason(reason, result, outcome)}`);
  if (candidates.length) {
    log.writeLine(`候选台账：${candidates.length} 条`);
    for (const c of candidates.slice(0, 10)) {
      log.writeLine(`  - ${formatDailyCandidate(c)}`);
    }
    if (candidates.length > 10) log.writeLine(`  - 还有 ${candidates.length - 10} 条候选未展开`);
  } else if (!selectedCandidate) {
    log.writeLine('候选台账：0 条');
  }
  if (conflicts.length) {
    log.writeLine('需要人工确认的冲突字段：');
    for (const conflict of conflicts) {
      log.writeLine(`  - 字段【${fieldLabel(conflict.field)}】不一致：账单Excel=${formatValue(conflict.billValue)}；台账=${formatValue(conflict.dailyValue)}`);
    }
  }
  if (autoFilled.length) {
    log.writeLine(`账单可自动补充到台账的字段：${autoFilled.map(fieldLabel).join('、')}`);
  }
}

const OPERATOR_FIELD_LABELS = Object.freeze({
  receiptNo: '小票号',
  originalReceiptNo: '原小票号',
  tourNo: '团号',
  purchaseDate: '购买日期',
  departureDate: '出境日期',
  passportNo: '护照号',
  name: '姓名',
  fullName: '姓名',
  shop: '免税店',
  storeFamily: '免税店',
  branch: '免税分店',
  storeBranch: '免税分店',
  modeNormalized: '返点模式',
});

const PRIORITY_RULES_FOR_LOG = Object.freeze({
  1: { title: 'P1 小票号一致', fields: ['receiptNo'] },
  2: { title: 'P2 小票号 + 购买日期一致', fields: ['receiptNo', 'purchaseDate'] },
  3: { title: 'P3 小票号 + 团号一致', fields: ['receiptNo', 'tourNo'] },
  4: { title: 'P4 护照号 + 购买日期 + 免税店一致', fields: ['passportNo', 'purchaseDate', 'shop'] },
  5: { title: 'P5 姓名 + 购买日期 + 免税店一致', fields: ['name', 'purchaseDate', 'shop'] },
  6: { title: 'P6 模糊候选，只进入人工确认', fields: ['receiptNo', 'name', 'purchaseDate', 'shop'] },
});

function getPriorityRule(priority) {
  if (!priority) {
    return { title: 'P1-P6 都没有命中', fields: ['receiptNo', 'purchaseDate', 'tourNo', 'passportNo', 'name', 'shop'] };
  }
  return PRIORITY_RULES_FOR_LOG[priority] || PRIORITY_RULES_FOR_LOG[6];
}

function fieldLabel(field) {
  return OPERATOR_FIELD_LABELS[field] || field;
}

function readBillField(bill, field) {
  if (field === 'shop') return bill?.storeFamily ?? bill?.shop;
  if (field === 'branch') return bill?.storeBranch ?? bill?.branch;
  if (field === 'name') return bill?.name ?? bill?.fullName;
  return bill?.[field];
}

function readDailyField(daily, field) {
  if (!daily) return '';
  return daily[field];
}

function formatValue(value) {
  if (value == null) return '空';
  const text = String(value).trim();
  return text ? text : '空';
}

function formatBillSource(bill) {
  const parts = [];
  if (bill.sourceSheet) parts.push(`工作表【${bill.sourceSheet}】`);
  if (bill.sourceRow) parts.push(`第 ${bill.sourceRow} 行`);
  if (!parts.length) parts.push(`账单记录 ${bill.id}`);
  return parts.join('，');
}

function writeComparisonLines(log, bill, daily, fields) {
  log.writeLine('字段比对：');
  if (!daily) {
    log.writeLine('  - 没有找到可比对的台账记录。');
    return;
  }
  for (const field of fields) {
    const billValue = readBillField(bill, field);
    const dailyValue = readDailyField(daily, field);
    log.writeLine(`  - 账单Excel字段【${fieldLabel(field)}】=${formatValue(billValue)}；台账字段【${fieldLabel(field)}】=${formatValue(dailyValue)}；结果：${compareLabel(field, billValue, dailyValue)}`);
  }
}

function compareLabel(field, billValue, dailyValue) {
  if (isEmptyForLog(billValue) && isEmptyForLog(dailyValue)) return '两边都为空';
  if (isEmptyForLog(billValue)) return '账单为空';
  if (isEmptyForLog(dailyValue)) return '台账为空';
  const a = field === 'purchaseDate' || field === 'departureDate'
    ? normalizeDate(billValue)
    : normalizeString(billValue);
  const b = field === 'purchaseDate' || field === 'departureDate'
    ? normalizeDate(dailyValue)
    : normalizeString(dailyValue);
  return a === b ? '一致' : '不一致';
}

function isEmptyForLog(value) {
  return value == null || String(value).trim() === '';
}

function resultLabel(result) {
  return {
    matched: '匹配成功',
    conflict: '字段冲突，需人工确认',
    pending_review: '候选不唯一或模糊，需人工确认',
    unmatched: '未找到台账对应记录',
  }[result] || '待人工确认';
}

function destinationLabel(result) {
  return {
    matched: '正式月度数据',
    conflict: '人工确认表',
    pending_review: '人工确认表',
    unmatched: '未收小票账单',
  }[result] || '人工确认表';
}

function formatDailyCandidate(row) {
  return [
    `台账记录 ${row.id}`,
    `小票号=${formatValue(row.receiptNo)}`,
    `团号=${formatValue(row.tourNo)}`,
    `姓名=${formatValue(row.name)}`,
    `护照号=${formatValue(row.passportNo)}`,
    `购买日期=${formatValue(row.purchaseDate)}`,
    `免税店=${formatValue(row.shop)}`,
  ].join('；');
}

function toOperatorReason(reason, result, outcome) {
  if (result === 'matched') return `${getPriorityRule(outcome.priority).title}，且没有需要人工处理的冲突。`;
  if (result === 'conflict') return `${getPriorityRule(outcome.priority).title}，但账单和台账有字段不一致，需要人工确认。`;
  if (result === 'pending_review') return `${getPriorityRule(outcome.priority).title}，系统只找到候选，不能自动决定。`;
  if (result === 'unmatched') return 'P1 到 P6 都没有找到可入月的台账记录，本条会进入未收小票账单。';
  return String(reason || '');
}

function buildBillMatchOperatorStats(stats) {
  const priorityBreakdown = {};
  for (const [priority, count] of Object.entries(stats.priorityBreakdown || {})) {
    priorityBreakdown[getPriorityRule(Number(priority)).title] = count;
  }
  return {
    账单扫描数: stats.billsScanned,
    匹配成功进入正式月度数据: stats.matched,
    未匹配进入未收小票账单: stats.unmatched,
    候选不唯一进入人工确认表: stats.ambiguous,
    模糊候选进入人工确认表: stats.fuzzy,
    字段冲突进入人工确认表: stats.conflicts,
    skipped_due_to_existing_open: stats.skipped_due_to_existing_open || 0,
    skipped_due_to_resolved_or_rejected: stats.skipped_due_to_resolved_or_rejected || 0,
    人工锁定字段跳过: {
      行数: stats.skipped_due_to_manual_lock?.rows_affected || 0,
      字段统计: stats.skipped_due_to_manual_lock?.fields || {},
    },
    newly_inserted: stats.newly_inserted || 0,
    匹配规则命中统计: priorityBreakdown,
    规则版本: stats.ruleVersion,
  };
}

module.exports = {
  createBuildIndex,
  pickBillFields,
  pickNormalized,
  isPostedLedgerRow,
  isMatchableLedgerRow,
  buildBillBadcase,
  createBillMatchTraceLog,
  writeBillMatchTrace,
  getPriorityRule,
  buildBillMatchOperatorStats,
};
