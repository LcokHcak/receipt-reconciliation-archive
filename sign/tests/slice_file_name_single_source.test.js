'use strict';

/**
 * 切片文件名判据:两种,分开命名,单一真相源。
 *
 * 0731 收敛前的状态:一个概念散在四处,其中**两处同名不同义** ——
 *   delivery_render.SPLIT_FILE_RE      只看后缀
 *   review_doc_regions.SPLIT_FILE_RE   要求 ^NN- 前缀
 * 拿真数据跑,230 个文件名里 **7 个两者结论相反**(全是切片任务的 sourceImagePath,
 * 批次内名带 task_NNNN__ 前缀)。今天各自用在对的字段上,所以还不是活 bug,
 * 但 import 错一个不会有任何报错 —— 这类"静默走岔"正是本仓库反复吃亏的地方。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isSliceFileName, librarySliceBase, SLICE_SUFFIX_RE, LIBRARY_SLICE_RE } =
  require('../lib/slice_file_name');

// 两种真实命名(拿本地真数据核过形态)
const LIB = '02-mix1-two-receipts-tight_receipt_1.jpg';        // 客户库
const BATCH = 'task_0004__02-mix1-two-receipts-tight_receipt_1.jpg'; // 批次内
const ORIGINAL = '01-mix1-two-receipts-tight_original.jpg';

test('⭐两种命名都要认得出"这是切片"——批次内名带 task_NNNN__ 前缀', () => {
  assert.equal(isSliceFileName(LIB), true);
  assert.equal(isSliceFileName(BATCH), true, '锚开头就会漏掉批次内名 —— 生产上误拦过 29%');
  assert.equal(isSliceFileName(ORIGINAL), false);
  assert.equal(isSliceFileName('source\task_0004__x_receipt_1.jpg'), true, '反斜杠路径也要认');
  assert.equal(isSliceFileName(''), false);
});

test('⭐"反解原图 base"只对客户库名成立,批次内名返回空是设计不是缺陷', () => {
  assert.equal(librarySliceBase(LIB), 'mix1-two-receipts-tight');
  assert.equal(librarySliceBase(BATCH), '',
    '批次内名没带可反解的结构 —— 这正是两条判据必须分开命名的原因');
  assert.equal(librarySliceBase(ORIGINAL), '');
});

test('四种切片角色都要认(只认 receipt 是本仓库反复犯过的错)', () => {
  for (const role of ['receipt', 'passport', 'region', 'other']) {
    assert.equal(isSliceFileName(`01-a_${role}_1.jpg`), true, role);
    assert.equal(librarySliceBase(`01-a_${role}_2.png`), 'a', role);
  }
});

test('⭐四个消费方都从 lib/slice_file_name 取,不许再各写一份', () => {
  const strip = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const f of ['lib/delivery_render.js', 'lib/review_doc_regions.js', 'lib/task_original_image.js']) {
    const src = strip(f);
    assert.match(src, /require\('\.\/slice_file_name'\)/, `${f} 要从单一真相源取`);
    assert.ok(!/receipt\|passport\|region\|other/.test(src),
      `${f} 里还自己写着一份切片正则 —— 四份必漂,这次就是这么漂的`);
  }
});

test('导出的两个正则确实不同(它们不是一回事,别被同名骗了)', () => {
  assert.notEqual(String(SLICE_SUFFIX_RE), String(LIBRARY_SLICE_RE));
  assert.equal(SLICE_SUFFIX_RE.test(BATCH), true);
  assert.equal(LIBRARY_SLICE_RE.test(BATCH), false);
});
