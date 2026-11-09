'use strict';

/**
 * 源码里不许出现**字面**控制字节(NUL 等),要写就写转义(2026-08-01)。
 *
 * 为什么值得一道闸:这已经是第三次了。
 *   - LibraryCleanupView 修过一次(见 fbc36e0);
 *   - lib/agentWorkspaceLinks.js 头部专门立了规矩:「必须保持 ASCII 转义写法(\x00 这种
 *     四字符序列),不许出现字面控制字节 —— 否则 git 把整个文件当二进制,后续改动
 *     在 diff/PR 里完全不可审计」;
 *   - repositories/daily_receipt/writes.js 仍然漏着一个(2026-08-01 才发现)。
 *
 * 实测后果(不是理论风险):
 *   - ripgrep/grep 只回一句 "Binary file matches",搜不到行号 —— 本次排查真被它绊过一次;
 *   - `git diff --stat` 把它渲染成"整文件重写"(821 insertions/821 deletions),
 *     而字节级对比证明只差 1 处。要审的人根本看不出改了什么。
 *
 * 运行时行为与转义写法完全一样('\u0000'.charCodeAt(0) === 0),所以这条闸零代价。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 只扫我们自己写的源码;产物/依赖/存储/二进制资源不在射程
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'coverage',
  'passport_review_workbench', 'xhs-cards', 'tmp',
  // vendor:第三方原样 vendoring 的代码/文档(PaddleOCR-v2.9.1 的 FAQ.md 里有 0x08),
  // 不是我们写的、也不该被我们改 —— 改了下次同步就冲突。它们不影响我们自己的代码搜索。
  'vendor',
]);
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.vue', '.json', '.md', '.css', '.html', '.sql']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.eslintrc.js') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// 允许的控制字节:\t(9) \n(10) \r(13)。其余 0x00-0x1F 一律算字面控制字节。
//
// 2026-08-01 补 U+FEFF(EF BB BF):它不是 0x00-0x1F,所以这道闸原来一个都没抓到,
// 实测漏了 13 处 —— 4 处在导出服务里给 `导出说明.txt` 加 BOM(eslint no-irregular-whitespace
// 报的 error 就是它们)、4 个文件连开头都带 BOM(含入口 workbench_server.js)、
// 3 处在测试断言里、1 处在 BadcaseView 的 CSV 导出。
// 加 BOM 这件事本身是对的(不加 Excel/记事本开中文就乱码),错在写成**看不见的字符**:
// 源码里 `\uFEFF${notes}` 和 `${notes}` 长得一模一样,审代码的人分不出来。
// 改成 '\uFEFF' 转义,运行时同一个字节,眼睛能看见。
function findControlBytes(buf) {
  const hits = [];
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf[i];
    if (c === 0xEF && buf[i + 1] === 0xBB && buf[i + 2] === 0xBF) {
      hits.push({ offset: i, byte: c, bom: true });
      i += 2;
      continue;
    }
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32) hits.push({ offset: i, byte: c });
  }
  return hits;
}

test('⭐源码里不许出现字面控制字节(NUL 等)——要写就写转义', () => {
  const files = walk(ROOT);
  assert.ok(files.length > 500, `扫描范围异常(只找到 ${files.length} 个文件),闸本身可能失灵`);

  const offenders = [];
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const hits = findControlBytes(buf);
    if (!hits.length) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const first = hits[0];
    const line = buf.slice(0, first.offset).toString('utf8').split('\n').length;
    offenders.push(`${rel}:${line} 有 ${hits.length} 个字面控制字节(首个 0x${first.byte.toString(16).padStart(2, '0')})`);
  }

  assert.deepEqual(offenders, [],
    `这些文件里嵌了字面控制字节,改成转义写法(如 '\\u0000'):\n  ${offenders.join('\n  ')}`);
});

test('自检:闸本身能抓到(往缓冲里塞一个 NUL 必须被认出来)', () => {
  assert.equal(findControlBytes(Buffer.from('abc')).length, 0);
  assert.equal(findControlBytes(Buffer.from('a\tb\r\nc')).length, 0, '制表/换行是正常的');
  assert.equal(findControlBytes(Buffer.from([97, 0, 98])).length, 1, 'NUL 要抓到');
  assert.equal(findControlBytes(Buffer.from([97, 7, 98])).length, 1, '响铃这类也算');
  // U+FEFF:补这条之前,下面两行全是 0 —— 13 处真实漏网就是这么来的
  assert.equal(findControlBytes(Buffer.from('a\uFEFFb', 'utf8')).length, 1, '句中 BOM 要抓到');
  assert.equal(findControlBytes(Buffer.from('\uFEFFabc', 'utf8')).length, 1, '文件开头 BOM 也算');
  assert.equal(findControlBytes(Buffer.from('a\\uFEFFb', 'utf8')).length, 0,
    '转义写法(反斜杠+uFEFF)是我们要的写法,不许误伤');
  // 中文本身有大量 0xEF 开头的三字节序列(如「说」EF? 不是),这里挑一个真含 0xEF 的:
  // U+FB00-U+FFFF 段落里 '\uFEFF' 之外的字符不能被当成 BOM
  assert.equal(findControlBytes(Buffer.from('！', 'utf8')).length, 0,
    '全角叹号是 EF BC 81,不是 BOM,不许误报');
});
