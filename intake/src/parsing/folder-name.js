'use strict';

// 解析客户文件夹名（真值集），形如 "BAI FANGRUIYAN EM93" / "CHEN YANGNI 3678"。
// 末尾 token 为护照前缀/尾号（字母+数字 或 纯数字），其余为姓名。
// 返回新对象，不修改入参（不可变）。

const PASSPORT_TOKEN_RE = /^[A-Z]{1,2}\d{2,}$/;
const DIGITS_TOKEN_RE = /^\d{3,}$/;

function parseCustomerFolderName(folderName) {
  const raw = String(folderName || '').trim();
  const tokens = raw.split(/\s+/).filter(Boolean);

  if (tokens.length < 2) {
    return { raw, name: raw, passportToken: '', valid: false };
  }

  const last = tokens[tokens.length - 1].toUpperCase();
  const isPassportToken = PASSPORT_TOKEN_RE.test(last) || DIGITS_TOKEN_RE.test(last);

  if (!isPassportToken) {
    return { raw, name: raw, passportToken: '', valid: false };
  }

  return {
    raw,
    name: tokens.slice(0, -1).join(' '),
    passportToken: last,
    valid: true,
  };
}

module.exports = { parseCustomerFolderName };
