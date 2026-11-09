'use strict';

/**
 * mode_store — 团号表「模式名 → 店家」+ 按票店消歧选行(2026-07-07,唯一真相源)。
 *
 * 背景(70299 病例):同一个团在新世界、现代各有消费,团号表里同团号两行两个模式
 * (新世界SG-振华 不用记 / 现代-JEOCU)。匹配必须用**小票自己的店家**在候选行里选,
 * 否则新世界小票命中现代模式=错桶,且两行记账语义可能相反(不用记 vs 要记)。
 *
 * 前缀规律用 2026-07 真实团号表(2.6 万行、21 种模式)实测 100% 可判:
 *   乐天* / 济州乐天* / 乐天釜山*  → LOTTE
 *   新罗* / 济州新罗*             → THE SHILLA
 *   爱宝客*                       → SHILLA IPARK
 *   新世界*                       → SHINSEGAE
 *   现代*                         → HYUNDAI
 * 认不出 → ''(不参与消歧,行为保守回退)。百货模式(P4 落地后为"乐天百货"等常量)
 * 借用 field_rules 撞名防线口径先行支持。
 */

const { STORE_FAMILIES } = require('./field_rules');

// 注意顺序:百货标记词优先(撞名防线同款,「乐天百货」不能被 /^乐天/ 咬进免税店);
// 济州/釜山是前缀修饰,归并到主店。
function storeFamilyOfMode(mode) {
  const s = String(mode || '').trim();
  if (!s) return '';
  if (/百货|백화점/.test(s)) {
    if (/乐天|樂天|롯데/.test(s)) return STORE_FAMILIES.LOTTE_DEPT;
    if (/新世界|신세계/.test(s)) return STORE_FAMILIES.SHINSEGAE_DEPT;
    if (/现代|現代|현대/.test(s)) return STORE_FAMILIES.HYUNDAI_DEPT;
    return '';
  }
  if (/^(济州|濟州)?新罗/.test(s) || /^(济州|濟州)?新羅/.test(s)) return STORE_FAMILIES.THE_SHILLA;
  if (/^爱宝客|^愛寶客/.test(s)) return STORE_FAMILIES.SHILLA_IPARK;
  if (/^(济州|濟州)?乐天/.test(s) || /^(济州|濟州)?樂天/.test(s)) return STORE_FAMILIES.LOTTE;
  if (/^新世界/.test(s)) return STORE_FAMILIES.SHINSEGAE;
  if (/^现代|^現代/.test(s)) return STORE_FAMILIES.HYUNDAI;
  return '';
}

/**
 * 按小票店家在团号候选行里消歧。
 *
 * @param {Array<{mode?: string}>} rows      团号命中的候选行(可能多店多模式)
 * @param {string} ticketStoreFamily         小票店家(canonical,如 'SHINSEGAE';空=不消歧)
 * @returns {{ rows: Array, storeMismatch: boolean, candidates: Array }}
 *   - rows: 消歧后的候选(店匹配行;无法消歧时原样返回,交给下游歧义闸)
 *   - storeMismatch: true = 候选行**全部可判店且没有一行**属于本票店 → 不猜,转人工
 *   - candidates: storeMismatch 时的原候选(供提示"表内模式属哪些店")
 *
 * 保守边界:
 *   - **单行命中不消歧**(历史上"票店≠模式店"的单行匹配是被接受的既有行为,如票在A店、
 *     渠道记账在B店模式;贸然翻案会把大量历史匹配打进待补救)。消歧只解决"多行选错行"。
 *   - 票店未知、候选里存在"认不出店"的模式 → 一律不宣告 mismatch,
 *     原样交给现有歧义闸(宁可多一次人工,不做半吊子推断)。
 */
function filterRowsByStore(rows, ticketStoreFamily) {
  const list = Array.isArray(rows) ? rows : [];
  const fam = String(ticketStoreFamily || '').trim().toUpperCase();
  if (!fam || list.length <= 1) return { rows: list, storeMismatch: false, candidates: [] };

  const classified = list.map((row) => storeFamilyOfMode(row && row.mode));
  if (classified.every((c) => !c)) return { rows: list, storeMismatch: false, candidates: [] };

  const matched = list.filter((_, i) => classified[i] === fam);
  if (matched.length > 0) return { rows: matched, storeMismatch: false, candidates: [] };

  // 没有一行属于本票店:只有当"每一行都能判店"时才敢下 mismatch 结论
  if (classified.every((c) => Boolean(c))) {
    return { rows: [], storeMismatch: true, candidates: list };
  }
  return { rows: list, storeMismatch: false, candidates: [] };
}

module.exports = { storeFamilyOfMode, filterRowsByStore };
