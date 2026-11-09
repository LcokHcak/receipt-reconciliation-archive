const fs = require('node:fs');

function nowStamp() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return [
    d.getFullYear(),
    p(d.getMonth() + 1),
    p(d.getDate()),
    '_',
    p(d.getHours()),
    p(d.getMinutes()),
    p(d.getSeconds()),
  ].join('');
}

function formatBusinessDateStamp(date = new Date(), timeZone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}${partMap.month}${partMap.day}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileComponent(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F-\x9F]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function sanitizeAsciiFileComponent(value, fallback = '') {
  const normalizedFallback = sanitizeFileComponent(fallback);
  const sanitized = sanitizeFileComponent(value)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (sanitized) {
    return sanitized;
  }
  return normalizedFallback
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function chunkArray(items, chunkSize) {
  const normalizedSize = Math.max(1, Number.parseInt(String(chunkSize || 1), 10) || 1);
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const chunks = [];
  for (let index = 0; index < items.length; index += normalizedSize) {
    chunks.push(items.slice(index, index + normalizedSize));
  }
  return chunks;
}

// multipart 文件名:busboy 默认按 latin1 解码 originalname,中文/韩文名会变乱码
// (字节被逐个映射成 U+0000–U+00FF)。重新按 UTF-8 解释还原;已是合法 UTF-8(含 >0xFF
// 码点)说明上游已解码,直接保留,避免二次解码损坏。月度导入与 OCR 客户图片上传共用。
function decodeMultipartFilename(value) {
  const name = String(value || '');
  if (!name) return name;
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) > 0xff) return name;
  }
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}

module.exports = {
  chunkArray,
  decodeMultipartFilename,
  ensureDir,
  formatBusinessDateStamp,
  nowStamp,
  sanitizeAsciiFileComponent,
  sanitizeFileComponent,
};
