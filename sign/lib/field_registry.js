'use strict';

/**
 * field_registry — 任务级字段注册表(配置台 P0/T1,2026-07-14)。
 *
 * 定位:字段知识的**单一声明处**,三类消费方:
 *   1. 字段契约守卫测试(tests/task_field_contract.test.js)——原 FIELD_CONTRACT 搬家至此,
 *      守卫逻辑不变:persisted=normalizeTask 必须保留;clearOnSwitch=改类型必须清场。
 *   2. 配置台词汇表(P1 起):导出/审核勾选只能引用这里注册过的字段——
 *      "新增字段(手填)"只许选已注册字段;真正的新字段必须先来这里登记再走
 *      适配器/白名单/清场同步(漏哪处哪处红)。
 *   3. 冲突检查(P1):导出勾的字段查 source,判"该模式下有没有来源"。
 *
 * 字段属性:
 *   key          任务对象字段名(*_Final/*_Auto 之外的活字段也在)
 *   label        审核台中文名(与 reviewFieldConfig 文案对齐)
 *   source       'manual'=审核员填/点 | 'ocr'=识别产出 | 'derived'=系统算出(预匹配等)
 *   exportable   可被导出配置勾选(台账/交付列的候选词汇)
 *   docTypes     适用文档类型(dept=百货票,存储上仍是 receipt+百货店家)
 *   contract     字段契约(null=不参与守卫;有值=persisted/clearOnSwitch/sentinel 守卫三件套)
 *
 * ⚠️ 注册表是"描述",normalizeTask 白名单仍是执行真相——契约测试负责两边对齐。
 */

const FIELD_REGISTRY = Object.freeze([
  // ── 核心可编辑字段(审核台面板;P0 只登记,P3 面板才从注册表派生)──
  { key: 'extractedNameFinal', label: '英文名', source: 'manual', exportable: true, docTypes: ['passport', 'dept'], contract: null },
  { key: 'passportNoFinal', label: '护照号', source: 'manual', exportable: true, docTypes: ['passport', 'dept'], contract: null },
  { key: 'receiptStoreFinal', label: '免税店/店家', source: 'manual', exportable: true, docTypes: ['receipt', 'dept'], contract: null },
  { key: 'receiptNoFinal', label: '小票号/交易编号', source: 'manual', exportable: true, docTypes: ['receipt', 'dept'], contract: null },
  { key: 'groupNoFinal', label: '团号', source: 'manual', exportable: true, docTypes: ['receipt'], contract: null },
  { key: 'purchaseDateFinal', label: '购买日期', source: 'manual', exportable: true, docTypes: ['receipt', 'dept'], contract: null },
  { key: 'departureDateFinal', label: '出境日期', source: 'manual', exportable: true, docTypes: ['receipt'], contract: null },

  // ── 字段契约家族(原 tests/task_field_contract.test.js FIELD_CONTRACT 原样搬家)──
  // 批次无主事故家族(owner 三件套在批次级,任务级对应客户代理名)
  { key: 'customerAgentName', label: '客户代理', source: 'derived', exportable: true, docTypes: ['passport', 'receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: '哨兵代理' } },
  // 票级两步流家族(登机牌事故:改类型必须清)
  { key: 'tourStance', label: '本票表态', source: 'manual', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: 'none' } },
  { key: 'tourStancedAt', label: '表态时间', source: 'derived', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '2026-07-13T00:00:00.000Z' } },
  { key: 'tourStancedBy', label: '表态人', source: 'derived', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: 'op1' } },
  // 组级确认站盖章=SLIM免审凭据之一(isSlimLaneTask 与 tourStance 等价),改类型必须一并清
  // (2026-07-14 审计#8:漏清→批量确认过的票改类型往返仍带旧盖章,可绕两步流免审放行)
  { key: 'tourConfirmedAt', label: '组确认盖章', source: 'derived', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '2026-07-10T00:00:00.000Z' } },
  { key: 'sActivityFlag', label: 'S活动标记', source: 'manual', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: true, clearedValue: false } },
  { key: 'modeManualPick', label: '人选渠道模式', source: 'manual', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '乐天SG-本司' } },
  { key: 'modeManualPickTour', label: '人选团号', source: 'manual', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '26140098' } },
  // 重拍原因分键(0727反馈#10):blurry/missing/other,与 rephotoRequested 同生共死——
  // 标记时落,取消/通过/改类型时清(改类型清 rephotoRequested,原因必须跟着走)
  { key: 'rephotoReason', label: '重拍原因', source: 'manual', exportable: false, docTypes: ['passport', 'receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: 'blurry' } },
  // 预匹配活字段
  { key: 'modeRawPre', label: '渠道模式(预匹配)', source: 'derived', exportable: true, docTypes: ['receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: '乐天SG-本司' } },
  { key: 'groupNoMatchStatus', label: '团号匹配状态', source: 'derived', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: 'matched' } },
  { key: 'modeStoreMismatch', label: '撞店提示', source: 'derived', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: 'A / B' } },
  { key: 'groupNoSuggestion', label: '团号近似建议', source: 'derived', exportable: false, docTypes: ['receipt'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: '26141846' } },
  // 导出格式还原
  { key: 'receiptNoRawAuto', label: '票号识别原串', source: 'ocr', exportable: true, docTypes: ['receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '9584-0025' } },
  // 百货真字段(P2 家族:改类型清场防串)
  { key: 'receiptAmountFinal', label: '金额(总金额)', source: 'manual', exportable: true, docTypes: ['dept'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '2910000' } },
  { key: 'branchFinal', label: '门店(票面4位编号)', source: 'manual', exportable: true, docTypes: ['dept'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '0394' } },
  { key: 'brandFinal', label: '品牌', source: 'manual', exportable: true, docTypes: ['dept'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '루이비통' } },
  { key: 'upstreamFinal', label: '上家', source: 'manual', exportable: true, docTypes: ['dept'],
    contract: { persisted: true, clearOnSwitch: true, sentinel: '东方' } },

  // ── 预处理产物家族(2026-07-16 同步一致性审计B1:曾漏白名单,重存即抹→投影计数漂移)──
  // autoSplitRole/preprocessMessage:投影 isOriginalLikeTask 判"原图不计数"+前端"原图/切图"命名;
  // preprocessWarning:预处理警示展示;classificationSource:识别来源统计(qwen/paddle)。
  // 改类型不清(是图片属性不是业务字段)。
  { key: 'autoSplitRole', label: '切图角色', source: 'derived', exportable: false, docTypes: ['passport', 'receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: 'original' } },
  { key: 'preprocessMessage', label: '预处理消息', source: 'derived', exportable: false, docTypes: ['passport', 'receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: 'no_split_detected' } },
  { key: 'preprocessWarning', label: '预处理警示', source: 'derived', exportable: false, docTypes: ['passport', 'receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: true } }, // 布尔(与写方 task_factory 一致)
  { key: 'classificationSource', label: '识别来源', source: 'derived', exportable: false, docTypes: ['passport', 'receipt', 'dept'],
    contract: { persisted: true, clearOnSwitch: false, sentinel: 'qwen' } },
]);

function fieldByKey(key) {
  return FIELD_REGISTRY.find((field) => field.key === key) || null;
}

function exportableFields() {
  return FIELD_REGISTRY.filter((field) => field.exportable);
}

// 契约守卫消费方用:恢复原 FIELD_CONTRACT 形状(key + persisted/clearOnSwitch/sentinel…)
function contractEntries() {
  return FIELD_REGISTRY
    .filter((field) => field.contract)
    .map((field) => ({ key: field.key, ...field.contract }));
}

module.exports = { FIELD_REGISTRY, fieldByKey, exportableFields, contractEntries };
