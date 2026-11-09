'use strict';

// 票号结构锚点自检(2026-07-20 识别错误矩阵 P1/P2)。
// 数据依据:25751 张已审小票 Final 全量统计(tmp/errcase_mine_remote.js):
//   SHINSEGAE  16 位,形态 2-6-3-5,第 3-8 位=购买日期 YYMMDD(成立率 95.2%)
//   HYUNDAI    16 位占 99.4%,同 2-6-3-5,嵌入日期成立率 99.2%
//   LOTTE      14 位(字母占位)占 98.8%,第 1 位=9 占 99.9%,第 7-8 位=购买年份后两位 99.4%
//   济州乐天    71.9% 票号带字母 G(形态 90G───-──-──────,G 恒在第 3 位);
//              G→6 误读产出的 "906…" 恰好是合法 14 位形态,常规锚点全过 →
//              用 "906 开头"特征抓(首尔真 906 开头仅 0.25%)。
// 高频病例形态(auto vs final 实录):截断只抄末段(0017)、抄底部支付授权号
// (4200 开头 28 位)、抄柜台/日期行、嵌入日期段 8↔6(280712↔260712)、首位 5/8/3↔9。
//
// 原则:锚点只标红不改值不清值——错绿比空红危险,真旧格式票由人工放行。
// 值为空/编造形态(isJunkNumericValue)不在这里管(sanitizeReceiptJunk 已清空+标红)。

const { isJunkNumericValue } = require('./field_normalizer');

const ANCHOR_REASONS = Object.freeze({
  SHAPE: 'qwen_receipt_no_shape_suspect', // 位数/开头与该店固定形态不符
  DATE: 'qwen_receipt_no_date_anchor_suspect', // 嵌入日期段与购买日期对不上
});

// store(canonical) → 锚点规格。长度按字母数字混合计(济州乐天 G 占一位)。
// embedYmd: [起,止) 段应等于购买日期 YYMMDD;embedYy: 段应等于购买年份后两位。
// 新罗系(2026-07-20 二批,90%冲刺):13 位 2-3-3-4-1,第 3-4 位=年份后两位,
// 前缀新罗 01/03 两支(各占约半)、爱宝客 21——成立率见本批挖矿 errfix_mine2。
const RECEIPT_NO_ANCHOR_SPECS = Object.freeze({
  SHINSEGAE: Object.freeze({ fixedLen: 16, embedYmd: [2, 8], first2: Object.freeze(['05']) }),
  HYUNDAI: Object.freeze({ fixedLen: 16, embedYmd: [2, 8], first2: Object.freeze(['01']) }),
  LOTTE: Object.freeze({ fixedLen: 14, embedYy: [6, 8], firstChar: '9', jejuG6: true }),
  'THE SHILLA': Object.freeze({ fixedLen: 13, embedYy: [2, 4], first2: Object.freeze(['01', '03']) }),
  'SHILLA IPARK': Object.freeze({ fixedLen: 13, embedYy: [2, 4], first2: Object.freeze(['21']) }),
});

const alnum = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');

function parseIsoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  return m ? { yyyy: m[1], mm: m[2], dd: m[3] } : null;
}

// → { reasons: string[], suspect: boolean }
// reasons 为待并入 reviewReasons 的锚点异常码(去重后);无规格店/空值/编造值恒空。
function checkReceiptNoAnchors({ storeFamily, receiptNo, purchaseDate } = {}) {
  const spec = RECEIPT_NO_ANCHOR_SPECS[String(storeFamily || '').trim().toUpperCase()];
  const no = alnum(receiptNo);
  const reasons = new Set();
  if (!spec || !no || isJunkNumericValue(receiptNo)) {
    return { reasons: [], suspect: false };
  }
  if (no.length !== spec.fixedLen) {
    reasons.add(ANCHOR_REASONS.SHAPE);
  } else {
    // 长度对了才看首位/前缀(长度不对时位置无意义,一码足够引导人工)
    if (spec.firstChar && no[0] !== spec.firstChar) reasons.add(ANCHOR_REASONS.SHAPE);
    // 店段前缀(重放病例 hyErr_014:04-260604… 结构全对但首段 04≠01,唯前缀能抓):
    // 现代恒 01(99.8%)、新世界恒 05(len16 主体)、新罗 01/03、爱宝客 21
    if (spec.first2 && !spec.first2.includes(no.slice(0, 2))) reasons.add(ANCHOR_REASONS.SHAPE);
    // 济州 G→6 误读:906 开头的纯数字 14 位几乎必是 90G 看错(首尔真 906 仅 0.25%)
    if (spec.jejuG6 && no.startsWith('906') && !/[A-Z]/.test(no)) reasons.add(ANCHOR_REASONS.SHAPE);
    const pd = parseIsoDate(purchaseDate);
    if (pd) {
      if (spec.embedYmd) {
        const want = pd.yyyy.slice(2) + pd.mm + pd.dd;
        if (no.slice(spec.embedYmd[0], spec.embedYmd[1]) !== want) reasons.add(ANCHOR_REASONS.DATE);
      }
      if (spec.embedYy && no.slice(spec.embedYy[0], spec.embedYy[1]) !== pd.yyyy.slice(2)) {
        reasons.add(ANCHOR_REASONS.DATE);
      }
    }
  }
  return { reasons: [...reasons], suspect: reasons.size > 0 };
}

// 二遍重读采纳决策(P2,纯函数供单测):
//   两遍一致 → 不换值(锚点旗留给人工;两遍同错不能自证清白)
//   二遍值过全部锚点且与一遍不同 → 采纳二遍(放大重读更可信,但仍标 fixed 旗转人工确认)
//   二遍也不过锚点/为空 → 保一遍值
function decideReceiptNoRepair({ storeFamily, firstPass, secondPass, purchaseDate } = {}) {
  const second = String(secondPass == null ? '' : secondPass).trim();
  if (!second || isJunkNumericValue(second)) return { adopt: false };
  if (alnum(firstPass) === alnum(second)) return { adopt: false, agreed: true };
  const { suspect } = checkReceiptNoAnchors({ storeFamily, receiptNo: second, purchaseDate });
  if (suspect) return { adopt: false };
  return { adopt: true, value: second };
}

const isAnchorReason = (r) => r === ANCHOR_REASONS.SHAPE || r === ANCHOR_REASONS.DATE;

module.exports = {
  ANCHOR_REASONS, RECEIPT_NO_ANCHOR_SPECS,
  checkReceiptNoAnchors, decideReceiptNoRepair, isAnchorReason,
};
