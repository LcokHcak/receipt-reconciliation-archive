'use strict';

// 2026-07-27 部署前审计 HIGH:客户数据 Excel 加「汇总」首页后单次内存翻倍
// (实测 3 万行 heap 377MB→730MB / RSS 549MB→1278MB)。不带范围 = 跨全部月份全表导出、
// listRows 无 LIMIT,能直接顶穿生产堆(3072MB;2c4g 配置仅 1536MB)。
// 这里锁两条防线:①下载端点必须带范围 ②并发闸默认降到 2。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'monthly', 'export_routes.js'), 'utf8');

test('library-export/download:不带 workspaceKey/batchId 直接 400,不放进全表导出', () => {
  assert.match(src, /code: 'scope_required'/);
  assert.match(src, /if \(!filter\.workspaceKey && !filter\.batchId\)/);
  // ⭐校验必须在占坑之前:放进 try 里提前 return 会和 finally 的 release 撞成双释放(信号量泄漏)
  const dl = src.slice(src.indexOf("library-export/download"), src.indexOf("library-export/download") + 1400);
  assert.ok(dl.indexOf('scope_required') < dl.indexOf('xlsxExportGate.acquire'),
    '范围校验要排在 acquire 之前,否则提前 return 会漏掉/重复 release');
});

test('xlsx 导出并发闸默认 2(4 并发月度导出约 2.9GB,会顶穿 3072MB 堆)', () => {
  const m = /maxConcurrent: Number\(process\.env\.XLSX_EXPORT_MAX_CONCURRENCY\) \|\| (\d+)/.exec(src);
  assert.ok(m, '找得到并发闸默认值');
  assert.ok(Number(m[1]) <= 2, `默认并发应 ≤2,当前 ${m[1]}`);
});
