'use strict';

const { countStatus } = require('./common');

function buildMetrics({ counts, generatedAt }) {
  return [
    metric({
      id: 'postedLedger',
      label: '已入月台账',
      value: countStatus(counts, 'posted') + countStatus(counts, 'locked'),
      sourceTable: '收票台账',
      rule: '台账状态为“已入月”或“已锁月”的凭证数量。',
      detailSectionId: 'postedLedger',
      generatedAt,
    }),
    metric({
      id: 'readyLedger',
      label: '待确认入月',
      value: countStatus(counts, 'ready_to_post'),
      sourceTable: '收票台账',
      rule: '字段审核和团号检查已通过，但还没有点击“确认入月”的凭证。',
      detailSectionId: 'readyLedger',
      generatedAt,
    }),
    metric({
      id: 'remedyLedger',
      label: '待补救',
      value: countStatus(counts, 'remedy'),
      sourceTable: '收票台账',
      rule: '团号、模式或日期仍需要人工补救的凭证。',
      detailSectionId: 'remedyLedger',
      generatedAt,
    }),
    metric({
      id: 'storeBills',
      label: '店铺账单明细',
      value: counts.storeBills,
      sourceTable: '店铺账单明细',
      rule: '导入的店铺账单 store_bill 明细行数量。',
      detailSectionId: 'storeBills',
      generatedAt,
    }),
    metric({
      id: 'matchedMonthly',
      label: '正式入月',
      value: counts.matchedMonthly,
      sourceTable: '月度数据',
      rule: '账单匹配成功后写入 monthly_data，且不是“账单有但未收”的记录。',
      detailSectionId: 'monthlyMatched',
      generatedAt,
    }),
    metric({
      id: 'unreceivedMonthly',
      label: '账单有但未收',
      value: counts.unreceivedMonthly,
      sourceTable: '月度数据',
      rule: '店铺账单存在，但本月收票台账没有匹配到对应小票的记录。',
      detailSectionId: 'monthlyUnreceived',
      generatedAt,
    }),
    metric({
      id: 'pendingReview',
      label: '待人工确认',
      value: counts.pendingOpen,
      sourceTable: '人工确认队列',
      rule: '系统无法自动决定，需要财务或审核员人工选择处理方式的记录。',
      detailSectionId: 'pendingReview',
      generatedAt,
    }),
  ];
}

function buildFormulas(counts) {
  const postedLedger = countStatus(counts, 'posted') + countStatus(counts, 'locked');
  const readyLedger = countStatus(counts, 'ready_to_post');
  const remedyLedger = countStatus(counts, 'remedy');
  const inReviewLedger = countStatus(counts, 'in_review');
  const knownLedger = postedLedger + readyLedger + remedyLedger + inReviewLedger;
  const ledgerOther = counts.dailyReceipts - knownLedger;
  const billRemainder = counts.storeBills - counts.matchedMonthly - counts.unreceivedMonthly;
  const monthlyRemainder = counts.monthlyData - counts.matchedMonthly - counts.unreceivedMonthly;

  return [
    formula({
      id: 'ledgerClosure',
      label: '收票台账闭环',
      expression: '收票台账 = 已入月 + 待确认入月 + 待补救 + 审核中 + 其他状态',
      left: { label: '收票台账', value: counts.dailyReceipts },
      parts: [
        { id: 'postedLedger', label: '已入月/已锁月', value: postedLedger },
        { id: 'readyLedger', label: '待确认入月', value: readyLedger },
        { id: 'remedyLedger', label: '待补救', value: remedyLedger },
        { id: 'inReviewLedger', label: '审核中/待匹配', value: inReviewLedger },
        { id: 'otherLedger', label: '其他状态', value: ledgerOther },
      ],
    }),
    formula({
      id: 'billClosure',
      label: '店铺账单闭环',
      expression: '店铺账单明细 = 正式入月 + 账单有但未收 + 未进入月度差异',
      left: { label: '店铺账单明细', value: counts.storeBills },
      parts: [
        { id: 'matchedMonthly', label: '正式入月', value: counts.matchedMonthly },
        { id: 'unreceivedMonthly', label: '账单有但未收', value: counts.unreceivedMonthly },
        { id: 'billRemainder', label: '未进入月度差异', value: billRemainder },
      ],
      note: billRemainder === 0
        ? '账单已全部被月度数据解释。'
        : '差异常见原因：待人工确认、非明细表行、规则跳过或匹配后尚未重新合并。',
    }),
    formula({
      id: 'monthlyDataClosure',
      label: '月度数据闭环',
      expression: '月度数据 = 正式入月 + 账单有但未收 + 其他月度数据',
      left: { label: '月度数据', value: counts.monthlyData },
      parts: [
        { id: 'matchedMonthly', label: '正式入月', value: counts.matchedMonthly },
        { id: 'unreceivedMonthly', label: '账单有但未收', value: counts.unreceivedMonthly },
        { id: 'monthlyRemainder', label: '其他月度数据', value: monthlyRemainder },
      ],
    }),
  ];
}

function formula({ id, label, expression, left, parts, note = '' }) {
  const rightTotal = parts.reduce((sum, part) => sum + Number(part.value || 0), 0);
  return {
    id,
    label,
    expression,
    left,
    parts,
    rightTotal,
    difference: Number(left.value || 0) - rightTotal,
    balanced: Number(left.value || 0) === rightTotal,
    note,
  };
}

function metric({ id, label, value, sourceTable, rule, detailSectionId, generatedAt }) {
  return {
    id,
    label,
    value: Number(value || 0),
    detailSectionId,
    calculation: {
      sourceTable,
      rule,
      calculatedAt: generatedAt,
    },
  };
}

module.exports = { buildMetrics, buildFormulas };
