'use strict';

/**
 * 组合模式 key —— 团号匹配阶段决定台账行"模式"(= 操作员分桶的单位)的兜底口径。
 *
 * 背景:1 月团号表带精确模式(如「乐天SG-本司」),tour_match 直接用 gc.mode。
 * 2/3 月起团号表无模式,gc.mode 为空,此前退化成收票裸模式「SG」——而「SG」横跨
 * 乐天首尔/乐天釜山/爱宝客,操作员无法唯一归桶。
 *
 * 解决:团号表无模式时,用收票自带的 店铺·分店·返点模式 组合当模式 key
 * (如「乐天·乐天釜山·SG」「爱宝客·爱宝客·PKG」),组合天然唯一,操作员在
 * 「模式分桶」里把每个组合选进对应桶。系统不自动归桶(组合不在 7 枚举内 →
 * classifyModeFolder 返回 null → 待归类,等操作员映射)。
 *
 * @param {{shop?:string|null, branch?:string|null, modeRaw?:string|null}} row
 * @returns {string} 组合 key;全空时返回 ''
 */
function compositeModeKey({ shop, branch, modeRaw } = {}) {
  const parts = [shop, branch, modeRaw]
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean);
  return parts.length ? parts.join('·') : '';
}

module.exports = { compositeModeKey };
