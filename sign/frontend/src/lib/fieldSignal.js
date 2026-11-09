// 审核台字段三色信号灯 —— 加快人工审核浏览。
// 金标实测:绿=快速通道(~98-99.5% 对),不是自动通过保证;护照号加合理性闸后假绿 6.6%→0.5%。
//
// 信号:
//   red(必改)   = 缺失 或 格式/校验错(沿用 FieldEditor.fieldErrors)
//   yellow(瞄一眼)= 过格式但机器标了该字段疑点,或字段级合理性可疑(护照号非标准/外国、日期年份可疑)
//   green(可跳过) = 过校验 + 无机器疑点 + 过合理性闸
//
// ⚠️ 纯颜色不可靠(色盲),UI 必须同时给图标/文字。

// 中国护照标准式(1-2 字母 + 6-8 数字,无 CHN 国家码混入)。
// 注意:外国护照(如阿根廷 AAJ554634 = 3 字母)会判 false → 黄(让操作员瞄一眼确认是外籍),不是红。
// CHN 混入(CHNEH69 这种 OCR 把国家码读进号里)也判 false → 黄 → 操作员修。
export function isStandardCnPassport(value) {
  const s = String(value || '').toUpperCase().replace(/\s+/g, '');
  if (!s || s.includes('CHN')) return false;
  return /^[A-Z]{1,2}\d{6,8}$/.test(s);
}

function yearOf(value) {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(String(value || '').trim());
  return m ? Number(m[1]) : null;
}

// 日期年份是否可疑(偏离批次/当前收集年)。expectedYear 传不进来就用当前年。
function isDateYearSuspicious(value, expectedYear) {
  const y = yearOf(value);
  if (y == null) return false; // 非 ISO 由 red 兜
  const base = Number(expectedYear) || new Date().getFullYear();
  // 收集期通常是当年;跨年初采购给 1 年缓冲。偏离 → 可疑。
  return y < base - 1 || y > base;
}

/**
 * @param {string} fieldKey  draft 的字段键(如 passportNoFinal)
 * @param {string} value     当前值
 * @param {{ hasFormatError?:boolean, isMachineFlagged?:boolean, expectedYear?:number }} opts
 * @returns {'red'|'yellow'|'green'}
 */
export function fieldSignal(fieldKey, value, opts = {}) {
  const v = String(value || '').trim();
  // 选填字段(百货身份两件套):空=合法留空,绿灯放行;填了值则照常走格式/合理性检查。
  if (!v) return opts.isOptional ? 'green' : 'red';
  if (opts.hasFormatError) return 'red';
  if (opts.isMachineFlagged) return 'yellow';

  if (fieldKey === 'passportNoFinal' && !isStandardCnPassport(v)) return 'yellow';
  if ((fieldKey === 'purchaseDateFinal' || fieldKey === 'departureDateFinal')
    && isDateYearSuspicious(v, opts.expectedYear)) return 'yellow';

  return 'green';
}

export const SIGNAL_META = {
  red: { icon: '✗', label: '必改', cls: 'sig-red' },
  yellow: { icon: '!', label: '核对', cls: 'sig-yellow' },
  green: { icon: '✓', label: '通过', cls: 'sig-green' },
};
