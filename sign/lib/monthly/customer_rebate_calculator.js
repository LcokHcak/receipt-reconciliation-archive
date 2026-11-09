'use strict';

const Decimal = require('decimal.js');

/**
 * 按 5-21 方案 1.1 节公式计算客人点数和双币种返点金额。
 *
 * 客人点数         = 免税店点数 + 免税店追加 + 扣点(人工)
 * 客人返点金额KRW  = 纯卖出KRW × 客人点数
 * 客人返点金额USD  = 纯卖出USD × 客人点数
 *
 * 注意：
 *   - 不除 100，直接相乘
 *   - storeBasePoints 和 storeExtraPoints 同时为 null → 无 daily 行，不算公式
 *   - netKrw / netUsd 其中一项为 null → 对应币种返点为 null，另一项正常算
 */
function calcCustomerRebate({ storeBasePoints, storeExtraPoints, deductValue, netKrw, netUsd }) {
  if (storeBasePoints == null && storeExtraPoints == null) {
    return { customerPoints: null, customerRebateKrw: null, customerRebateUsd: null };
  }
  const base = storeBasePoints ?? 0;
  const rawPoints = new Decimal(base)
    .plus(storeExtraPoints ?? 0)
    .plus(deductValue ?? 0);
  // ③ 免税店基本点=0 → 免税店没给返点,扣点无从施加,客人点数归 0(乐天 基本点=0 行交付口径,
  //   实测 28315/28315=100%)。仅当 base=0 且结果为负时归零;base≠0 的负点数(大扣点)仍保留。
  const points = (Number(base) === 0 && rawPoints.lessThan(0)) ? new Decimal(0) : rawPoints;
  const krw = netKrw == null
    ? null
    : new Decimal(netKrw).mul(points).toDecimalPlaces(4).toNumber();
  const usd = netUsd == null
    ? null
    : new Decimal(netUsd).mul(points).toDecimalPlaces(4).toNumber();
  return {
    customerPoints: points.toDecimalPlaces(4).toNumber(),
    customerRebateKrw: krw,
    customerRebateUsd: usd,
  };
}

module.exports = { calcCustomerRebate };
