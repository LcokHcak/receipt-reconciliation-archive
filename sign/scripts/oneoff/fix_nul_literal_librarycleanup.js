'use strict';
// 一次性修复:LibraryCleanupView.vue 里键分隔符写成了**字面 NUL 字节**(应为 \u0000 转义)。
// 运行时行为逐字节等价('\u0000' 转义求值后就是 NUL),但字面字节让 vue-eslint-parser
// 直接解析失败(unexpected-null-character),整文件 lint 失明;部分编辑器/差异工具也会误判二进制。
const fs = require('node:fs');
const p = require('node:path').join(__dirname, '..', '..', 'frontend', 'src', 'views', 'LibraryCleanupView.vue');
const buf = fs.readFileSync(p);
const nulCount = [...buf].filter((b) => b === 0).length;
if (!nulCount) { console.log('no literal NUL — nothing to do'); process.exit(0); }
const escape = Buffer.from('\\u0000', 'utf8'); // 反斜杠 + u0000 六字符文本
const parts = [];
let start = 0;
for (let i = 0; i < buf.length; i += 1) {
  if (buf[i] === 0) { parts.push(buf.slice(start, i), escape); start = i + 1; }
}
parts.push(buf.slice(start));
fs.writeFileSync(p, Buffer.concat(parts));
console.log(`replaced ${nulCount} literal NUL byte(s) with \\u0000 escape text`);
