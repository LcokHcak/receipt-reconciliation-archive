'use strict';

/**
 * 兜底整本载入体积闸(审计LOW 2026-07-28)。
 *
 * 病理:streamRows 捕获特定 exceljs workbook-reader 错误后 fallback 到
 * readRowsWithWorkbook(整本 readFile,实测内存放大 ~360×:8.8MB→3.15GB heap)。
 * 98MB SMG 总账走到该兜底 = pm2 单实例 OOM 全站宕,且此刻旧总账行已被替换语义清掉。
 * 修法:兜底前 assertWorkbookFallbackSafe 查文件大小,超阈值抛清晰 413 而非整本载入。
 *
 * 触发兜底依赖 exceljs 内部 bug 命中特定文件结构,无法用真实工作簿稳定复现,
 * 故测试分两层:① 闸函数本身三态直测;② 源码契约锁死「兜底分支先过闸」的接线。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertWorkbookFallbackSafe } = require('../lib/monthly_pipeline/xlsx_reader');

function makeTmpFile(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxguard-'));
  const file = path.join(dir, 'book.xlsx');
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
  return { dir, file };
}

test('体积闸:阈值内文件放行(不抛)', () => {
  const { dir, file } = makeTmpFile(1024);
  try {
    assert.doesNotThrow(() => assertWorkbookFallbackSafe(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('体积闸:超阈值抛 413 清晰错误(不进整本载入),带体积与另存为指引', () => {
  const { dir, file } = makeTmpFile(2 * 1024 * 1024);
  try {
    assert.throws(
      () => assertWorkbookFallbackSafe(file, { maxMb: 1 }),
      (err) => err.statusCode === 413
        && err.code === 'xlsx_fallback_too_large'
        && /2\.0MB/.test(err.message)
        && /上限 1MB/.test(err.message)
        && /另存为/.test(err.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('体积闸:stat 不到(路径错/被并发清理)不拦,让 readFile 报真实 IO 错', () => {
  assert.doesNotThrow(() => assertWorkbookFallbackSafe(path.join(os.tmpdir(), 'no-such-dir', 'ghost.xlsx')));
});

test('接线契约:streamRows 兜底分支在 readRowsWithWorkbook 前必过体积闸', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'monthly_pipeline', 'xlsx_reader.js'), 'utf8');
  assert.match(
    src,
    /assertWorkbookFallbackSafe\(filePath\);\s*\r?\n\s*return readRowsWithWorkbook\(/,
    '兜底整本载入前必须先过 assertWorkbookFallbackSafe(删掉这行 = 98MB 总账 OOM 全站宕回归)',
  );
});
