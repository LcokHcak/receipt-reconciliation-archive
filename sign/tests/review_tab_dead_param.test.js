'use strict';

// 诚实性契约:审核页 /review/:batchId 自 2026-07-14 起是单队列视图,
// query 参数 tab(image/field)与 my_todo_service 的 route 字段(TODO_STAGE_ROUTE)
// 已于 2026-07-20 整链删除(2026-07-19 全链路审计实锤全仓零消费)。
// 此测试扫运行时源码,拦下常见字面量复发形态:重新消费 route.query.tab
// (含可选链/解构)、重新往深链塞 tab、或复活 TODO_STAGE_ROUTE。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 运行时代码 + 探针脚本;不含 tests(本文件自身携带这些字面量)
const SCAN_DIRS = ['frontend/src', 'frontend/e2e', 'services', 'scripts', 'lib'];
const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.vue']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const BANNED = [
  { name: '消费 query.tab(含可选链)', re: /\bquery\??\.tab\b/ },
  { name: "消费 query['tab']", re: /query\[\s*['"]tab['"]\s*\]/ },
  { name: '从 query 解构 tab', re: /\{[^}]*\btab\b[^}]*\}\s*=[^;\n]*\.query\b/ },
  { name: '深链造 tab 参数(query 对象)', re: /query\s*:\s*\{[^}]*\btab\s*:/ },
  { name: '深链造 tab 参数(URL 字符串)', re: /\?tab=/ },
  { name: '复活 TODO_STAGE_ROUTE', re: /TODO_STAGE_ROUTE/ },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walk(path.join(dir, entry.name));
      }
    } else if (SCAN_EXTS.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

test('全仓 route.query.tab 零消费/零生产:tab 与 route 死参数不得复发', () => {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const { name, re } of BANNED) {
        const match = re.exec(src);
        if (match) {
          const line = src.slice(0, match.index).split('\n').length;
          violations.push(`${path.relative(root, file)}:${line} → ${name}`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `审核页单队列,tab/route 死参数链已删,以下位置复发:\n${violations.join('\n')}`,
  );
});
