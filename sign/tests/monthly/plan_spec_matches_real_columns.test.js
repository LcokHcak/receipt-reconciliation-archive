'use strict';

/**
 * 「查看规则」里的列清单必须等于**真表头**(2026-08-01)。
 *
 * 病灶:lib/builtin_export_plan_specs 是给操作员看的"这个计划会导出什么"说明,
 * 而真正决定表长什么样的是 services/monthly/library_mode_export_service 的 COLUMNS。
 * 两份**并列手工维护** —— 说明那行是手抄的。
 *
 * 后果不是理论:0801 当天核对时发现它已经漂出三处 ——
 *   漏了第 2 列「收票日期」(0724 拍板新增的)、没提汇总页、没说百货页会换叫法。
 * 操作员点开「查看规则」照着核对交付表,核不上,只能猜哪个是对的。
 * 而这份说明恰恰是他**唯一**能看到规则的地方(内置计划在配置台是只读的,
 * 规则冻结在代码常量里)。
 *
 * 这条闸把"说明"钉死在"真表头"上:列数、每一列的名字、顺序,一处不同就红。
 * 与今天立的其它几张对拍闸同一个思路 —— **同一个事实只许有一个来源**,
 * 靠人记着同步两份,迟早漂(这已经是第 N 次了)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const { BUILTIN_PLAN_SPECS } = require('../../lib/builtin_export_plan_specs');

// COLUMNS 是模块私有常量,从源码里取出来(它就是**真表头**的定义处)
function realColumns() {
  const src = fs.readFileSync(
    path.join(ROOT, 'services', 'monthly', 'library_mode_export_service.js'), 'utf8',
  );
  const start = src.indexOf('const COLUMNS = Object.freeze([');
  assert.ok(start > 0, '找不到 COLUMNS —— 取段方式失效了');
  const end = src.indexOf('\n]);', start);
  assert.ok(end > start, 'COLUMNS 括号没找到结尾');
  const block = src.slice(start, end);
  // 每项形如 ['购买日期', 'purchase_date'](注释行不要)
  return [...block.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map((m) => m[1]);
}

// 说明里那句 files 形如 "列(共 17,顺序即表内顺序):A/B/C…"
function specColumns() {
  const files = BUILTIN_PLAN_SPECS.library_excel.rules[0].files;
  const m = String(files).match(/列\(共\s*(\d+)[^)]*\):(.+)$/);
  assert.ok(m, `说明里的列清单格式变了,解析不出来:${files}`);
  return {
    declared: Number(m[1]),
    names: m[2].split('/').map((s) => s.trim()).filter(Boolean),
  };
}

test('⭐「查看规则」里的列清单 = 真表头(逐列逐序)', () => {
  const real = realColumns();
  const spec = specColumns();
  assert.ok(real.length > 5, `真表头只解析出 ${real.length} 列,取段跑偏了`);
  assert.deepEqual(spec.names, real,
    '说明里的列与真表头对不上。操作员点「查看规则」照着核对交付表就会核不上,'
    + `而这是他唯一能看到规则的地方。\n  说明:${JSON.stringify(spec.names)}\n  真表:${JSON.stringify(real)}`);
});

test('⭐说明里写的列数也要对(数字和清单是两处,都会漂)', () => {
  const real = realColumns();
  const spec = specColumns();
  assert.equal(spec.declared, real.length,
    `说明写「共 ${spec.declared} 列」,真表头是 ${real.length} 列`);
});

test('⭐0724 拍板加的「收票日期」必须在两边都在(它就是漂掉的那一列)', () => {
  const real = realColumns();
  const spec = specColumns();
  assert.ok(real.includes('收票日期'), '真表头里要有收票日期(0724 拍板新增)');
  assert.ok(spec.names.includes('收票日期'),
    '说明里漏了收票日期 —— 0801 核对时它就是漏掉的那一列');
  // 顺序也钉一下:它排在购买日期后面,不是随便加在末尾
  assert.equal(real[1], '收票日期', '收票日期应是第 2 列');
});

test('⭐百货页换叫法这件事,说明里必须提(它会让同一张表两种表头)', () => {
  const note = String(BUILTIN_PLAN_SPECS.library_excel.rules[0].note);
  assert.match(note, /交易编号/, '百货页的表头覆盖要在说明里提到');
  assert.match(note, /交易金额/, '同上');
  // 而且覆盖表本身要真的存在(说明提了、代码没做,就是另一个方向的假话)
  const src = fs.readFileSync(
    path.join(ROOT, 'services', 'monthly', 'library_mode_export_service.js'), 'utf8',
  );
  assert.match(src, /DEPT_HEADER_OVERRIDES/,
    '说明里承诺了百货换叫法,代码里就必须真有这张覆盖表');
});

test('自检:两边的解析都真的取到了东西(否则上面全是空跑)', () => {
  const real = realColumns();
  const spec = specColumns();
  assert.ok(real.includes('购买日期') && real.includes('团号'),
    `真表头解析结果可疑:${JSON.stringify(real)}`);
  assert.ok(spec.names.length === real.length && spec.names.length > 5,
    `说明解析结果可疑:${JSON.stringify(spec.names)}`);
});
