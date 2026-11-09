'use strict';

const FAMILY_RULES = [
  { family: '乐天', pattern: /乐天|롯데|LOTTE/i, receiptLen: 14, tourLen: 8 },
  { family: '新罗', pattern: /新罗|SHILLA|신라/i, receiptLen: 13, tourLen: 5 },
  { family: '爱宝客', pattern: /爱宝客|HDC|신라아이파크|IPARK/i, receiptLen: 13, tourLen: 5 },
];

const BRANCH_RULES = [
  { branch: '乐天明洞', pattern: /明洞|明동/i },
  { branch: '乐天蚕室', pattern: /蚕室|잠실/i },
  { branch: '乐天釜山', pattern: /釜山|부산/i },
  { branch: '新罗济州', pattern: /济州|제주/i },
  { branch: '新罗首尔', pattern: /首尔|서울/i },
  { branch: '爱宝客', pattern: /爱宝客|HDC|IPARK/i },
];

function detectFamily({ fileName = '', sheetName = '', hints = [] } = {}) {
  const haystack = [fileName, sheetName, ...hints].join(' ');
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(haystack)) {
      return { family: rule.family, receiptLen: rule.receiptLen, tourLen: rule.tourLen };
    }
  }
  return { family: null, receiptLen: null, tourLen: null };
}

function detectBranch({ fileName = '', sheetName = '', row = {} } = {}) {
  const haystack = [fileName, sheetName, row.branch, row.shop, row.免税分店, row.免税店].join(' ');
  for (const rule of BRANCH_RULES) {
    if (rule.pattern.test(haystack)) return rule.branch;
  }
  return null;
}

/**
 * 是否属于"明细类" sheet（Q4 决议：只有明细类参与规则校验）。
 */
function isDetailSheet(sheetName) {
  return /明细|卖出明细|^Sheet1$/i.test(String(sheetName || ''));
}

module.exports = {
  detectFamily,
  detectBranch,
  isDetailSheet,
};
