'use strict';

/**
 * 台账导出 SELECT 的每一列,必须真的存在于 daily_receipt_export 的建表语句里。
 *
 * 由来(2026-08-01):「收票日期」列的兜底写的是 `row.created_at`,而这张表**根本没有
 * created_at 这一列**,查询里也没查它。于是客户编号不是标准 CLyyyymmdd-NNN 的行
 * (导入的历史行、改过 ID 的行)这一列恒为空 —— 用户截图 image37 的「有表头没数据」。
 * 这个错活了很久,因为:
 *   - 读的是 JS 对象属性,取不到就是 undefined,不报错;
 *   - 测试夹具是手写的**部分**表结构,和真表各drift各的(本仓库上一次同类事故:
 *     夹具把列名写成 customer_rebate_krw,和代码里的同名笔误互相印证,导出崩溃没被测出)。
 *
 * 所以这道闸对着**迁移文件里的真建表语句**校验,不对着夹具 —— 夹具本身就是会漂的那一方。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function canonicalColumns(table) {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'storage', 'migrations', '0001_init_monthly.sql'), 'utf8',
  );
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
  const body = (re.exec(sql) || [])[1];
  assert.ok(body, `迁移文件里找不到 ${table} 的建表语句`);
  return new Set(
    body.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(l))
      .map((l) => (/^["`]?([a-z_][a-z0-9_]*)["`]?\s/i.exec(l) || [])[1])
      .filter(Boolean),
  );
}

test('⭐资料库模式导出 SELECT 的列都真实存在(别再对着不存在的列写兜底)', () => {
  const cols = canonicalColumns('daily_receipt_export');
  // 自检:解析器本身得管用,不然这条测试会"永远通过"
  assert.ok(cols.has('receipt_no') && cols.has('imported_at') && cols.size > 20,
    `建表语句解析失败,解析到 ${cols.size} 列`);
  assert.ok(!cols.has('created_at'),
    'daily_receipt_export 没有 created_at —— 这正是那处坏兜底赖以存在的错觉');

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'monthly', 'library_mode_export_service.js'), 'utf8',
  );
  const block = /const SELECT_KEYS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(block, '没定位到 SELECT_KEYS');
  // 显式列(字符串字面量);COLUMNS 展开的那部分由下面一条单独校验
  const explicit = [...block[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
  assert.ok(explicit.length >= 3, `SELECT_KEYS 里没解析到显式列名:${block[1]}`);
  for (const key of explicit) {
    assert.ok(cols.has(key), `SELECT_KEYS 里的 '${key}' 在 daily_receipt_export 建表语句里不存在`);
  }

  // COLUMNS 里的真列(排掉出口计算列 VIRTUAL_KEYS)也必须存在
  const colBlock = /const COLUMNS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
  const virtualBlock = /const VIRTUAL_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(colBlock && virtualBlock, '没定位到 COLUMNS / VIRTUAL_KEYS');
  const virtual = new Set([...virtualBlock[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]));
  const displayed = [...colBlock[1].matchAll(/,\s*'([a-z_][a-z0-9_]*)'\]/g)].map((m) => m[1]);
  assert.ok(displayed.length >= 10, `COLUMNS 解析异常,只拿到 ${displayed.length} 列`);
  for (const key of displayed) {
    if (virtual.has(key)) continue;
    assert.ok(cols.has(key), `COLUMNS 里的真列 '${key}' 在建表语句里不存在`);
  }
});

test('⭐收票日期兜底读的字段必须是真列(它读 JS 属性,读错了不会报错、只会整列空白)', () => {
  const cols = canonicalColumns('daily_receipt_export');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'workbench_receipt_export.js'), 'utf8',
  );
  const fn = /function resolveCollectedDateFromLedgerRow[\s\S]*?\n}/.exec(src);
  assert.ok(fn, '没定位到 resolveCollectedDateFromLedgerRow');
  // 先剥注释再扫:注释里解释"以前误读了哪个字段"是有价值的,不该被当成还在读它。
  // (这条闸自己第一次跑就踩了:它把说明性注释里的 row.customer_id 当成了实际读取。)
  const body = fn[0].replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // 函数体里出现的 row.<xxx> 蛇形字段(驼峰别名是兼容内存对象用的,不算库列)
  const read = [...body.matchAll(/row\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)/g)].map((m) => m[1]);
  assert.ok(read.length >= 2, `没解析到读取的库列:${fn[0]}`);
  for (const key of read) {
    // trace_ 前缀是月度交付 JOIN 出来的别名列,不在本表
    if (key.startsWith('trace_')) continue;
    assert.ok(cols.has(key),
      `收票日期兜底读了 row.${key},但 daily_receipt_export 没有这一列 —— 这一列会恒为空`);
  }
});
