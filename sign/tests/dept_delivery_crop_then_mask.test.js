'use strict';

/**
 * 乐天百货交付:既要打码、又要按框裁的那张图,必须**先裁后打码**。
 *
 * 0731 实锤的静默重复报账:写盘那段原来是两个**并列的 if**,而打码那段
 * `if (res.masked) { continue; }` —— 于是同时带 maskBbox 和 cropRect 的 entry
 * 永远走不到裁剪。一张照片上两张票、审核员各画一个框,两条 entry 带同一个
 * maskBbox、各带不同 cropRect,结果**写出两份一模一样的打码整图**,
 * 只是文件名是两个不同的交易编号 —— 上家看到同一张照片报了两笔账。
 * 而且 imageBlocked 一条不记,导出说明里一个字没有,全静默。
 *
 * 顺序按 0730 拍板:先按框裁、再打码,顺序不能反。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { remapBboxIntoCrop } = require('../lib/delivery_render');

// ── 几何:护照框重映射 ──────────────────────────────────────────────
test('⭐重映射:护照落在票框里 → 换算成裁片自己的 0~1 坐标', () => {
  // 裁片占原图右半;护照在右半的左上角
  const rect = { x1: 0.5, y1: 0.0, x2: 1.0, y2: 1.0 };
  const out = remapBboxIntoCrop([0.5, 0.0, 0.75, 0.5], rect);
  assert.ok(out, '应该有交集');
  assert.deepEqual(out.map((v) => Number(v.toFixed(3))), [0, 0, 0.5, 0.5],
    '原图右半的左上角 1/4,在裁片里就是左上角 1/4');
});

test('⭐护照不在这张票的框里 → 返回 null(别硬涂)', () => {
  // 两张票各一个框,护照只压着左边那张
  const rightReceipt = { x1: 0.55, y1: 0, x2: 1, y2: 1 };
  assert.equal(remapBboxIntoCrop([0.05, 0.1, 0.4, 0.6], rightReceipt), null,
    '护照在左半,右边这张票的裁片里没有护照,不该返回框');
});

test('部分重叠 → 只涂落进来的那部分', () => {
  const rect = { x1: 0.4, y1: 0, x2: 1, y2: 1 };
  const out = remapBboxIntoCrop([0.2, 0.2, 0.7, 0.6], rect);
  assert.ok(out);
  assert.equal(Number(out[0].toFixed(3)), 0, '越界的左边被裁到 0');
  assert.equal(Number(out[2].toFixed(3)), 0.5, '(0.7-0.4)/0.6 = 0.5');
});

test('擦边/退化 → null,不产生没意义的遮罩', () => {
  const rect = { x1: 0.5, y1: 0, x2: 1, y2: 1 };
  assert.equal(remapBboxIntoCrop([0.0, 0.0, 0.502, 1], rect), null, '只擦进来 0.4%');
  assert.equal(remapBboxIntoCrop([0.6, 0.6, 0.6, 0.9], rect), null, '零宽');
  assert.equal(remapBboxIntoCrop(null, rect), null);
  assert.equal(remapBboxIntoCrop([0.6, 0.1, 0.9, 0.5], { x1: 0.5, y1: 0, x2: 0.5, y2: 1 }), null,
    '零宽裁框');
  assert.equal(remapBboxIntoCrop([0.6, 0.1, NaN, 0.5], rect), null, 'NaN 不能混进坐标');
});

// ── 接线:写盘那段必须先裁后打码,不能再并列 ────────────────────────
test('⭐写盘顺序:同时有框和护照时,裁剪必须在打码**之前**执行', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'lotte_dept_delivery_export_service.js'), 'utf8',
  );
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // 必须存在"两者都有"的合并分支
  assert.match(bare, /if \(entry\.cropRect && entry\.maskBbox\)/,
    '缺少「既要裁又要打码」的合并分支 —— 并列 if 会让打码 continue 掉裁剪');

  const merged = (bare.match(/if \(entry\.cropRect && entry\.maskBbox\)\s*\{([\s\S]*?)\n        \}/) || [])[1] || '';
  assert.ok(merged, '没定位到合并分支的函数体');
  const cropAt = merged.indexOf('renderCroppedDelivery');
  const maskAt = merged.indexOf('maskPassportRegion');
  assert.ok(cropAt > -1 && maskAt > -1, '合并分支里裁剪和打码都要有');
  assert.ok(cropAt < maskAt,
    '0730 拍板:先按框裁、再打码,顺序不能反 —— 现在打码排在裁剪前面');
  assert.match(merged, /remapBboxIntoCrop/,
    '裁完必须把护照框换算进裁片坐标系,否则会涂错地方');

  // 合并分支里裁失败不许回退整图
  assert.match(merged, /imageBlocked\.push/, '裁失败要进 imageBlocked,不能静默');
  assert.ok(!/copyFile/.test(merged), '合并分支里不许出现原样复制整图的回退');
});

test('国籍要从原图读,不是从裁片读(裁片可能把 MRZ 切掉一半)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'lotte_dept_delivery_export_service.js'), 'utf8',
  );
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const merged = (bare.match(/if \(entry\.cropRect && entry\.maskBbox\)\s*\{([\s\S]*?)\n        \}/) || [])[1] || '';
  assert.match(merged, /readPassportNationality\(entry\.sourcePath, \{ bbox: entry\.maskBbox \}\)/,
    '国籍探针要喂原图 + 原图坐标的护照框');
  assert.match(merged, /sourcePath: tmpPath/, '打码要作用在裁片上');
});
