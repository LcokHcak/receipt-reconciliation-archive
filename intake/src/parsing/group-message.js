'use strict';

// 解析员工下发的团号消息（群聊场景的「金矿」，可正则）。
// 例： "乐天B团号 26144790~6/12 EN7296496 SUN XIAO"
//      "乐天B团团号 26143139~6/5\nER8529180 JI XUAN\nEL2276892 SUN LULU"
//      "2563"（裸数字，需结合上下文，单独标记）
// 全部返回新对象，不修改入参。

// 中国护照号：1~2 位字母 + 7~8 位数字
const PASSPORT_RE = /[A-Z]{1,2}\d{7,8}/g;
// 团号(6~8 位数字) ~ 有效期(M/D)
const GROUP_VALID_RE = /(\d{6,8})\s*[~～]\s*(\d{1,2}\/\d{1,2})/g;
// 模式关键词（团种）
const MODE_TOKENS = ['SG', 'PKG', 'H团', 'V团', 'B团', 'R团', 'S团', '机场', '百货'];

function detectModes(text) {
  const found = [];
  // S-H-PKG / SG H PKG 这类组合：先抓字母型
  const letterModes = text.toUpperCase().match(/\b(SG|PKG|H|V|B|R|S)\b/g) || [];
  for (const m of letterModes) {
    if (!found.includes(m)) found.push(m);
  }
  for (const token of MODE_TOKENS) {
    if (text.includes(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

function parseGroupNos(text) {
  const result = [];
  for (const match of text.matchAll(GROUP_VALID_RE)) {
    result.push({ groupNo: match[1], validUntil: match[2] });
  }
  return result;
}

function cleanName(value) {
  return String(value || '').replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 按行解析：行内取护照号，其后到下一个护照号(或行尾)之间的字母作姓名。
// 避免跨行把下一行护照的字母误吃进姓名。
function parsePassports(text) {
  const result = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const matches = [...line.matchAll(PASSPORT_RE)];
    for (let i = 0; i < matches.length; i++) {
      const passportNo = matches[i][0];
      if (seen.has(passportNo)) continue;
      seen.add(passportNo);
      const start = matches[i].index + passportNo.length;
      const end = i + 1 < matches.length ? matches[i + 1].index : line.length;
      result.push({ passportNo, name: cleanName(line.slice(start, end)) });
    }
  }
  return result;
}

function parseGroupMessage(text) {
  const raw = String(text || '');
  const trimmed = raw.trim();

  const isBareNumber = /^\d{3,6}$/.test(trimmed);
  if (isBareNumber) {
    return {
      raw,
      isBareNumber: true,
      bareNumber: trimmed,
      modes: [],
      groupNos: [],
      passports: [],
    };
  }

  return {
    raw,
    isBareNumber: false,
    bareNumber: '',
    modes: detectModes(raw),
    groupNos: parseGroupNos(raw),
    passports: parsePassports(raw),
  };
}

module.exports = { parseGroupMessage };
