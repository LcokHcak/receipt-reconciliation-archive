'use strict';

/**
 * spotcheck_d3_xlsx_perf — D3 useStyles:true 大数据集性能验证
 *
 * 生成 50000 行混合型数据(KRW / USD / 整数 / 文本),
 * 调用 writeRowsStreaming,测量:
 *   - 总耗时 (ms)
 *   - RSS 内存增量 (MB)
 *   - 输出文件大小 (MB)
 *
 * 阈值: duration ≤ 30000 ms, rss delta ≤ 200 MB
 * 退出码: 全 PASS → 0, 任一 FAIL → 1
 */

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { writeRowsStreaming } = require('../services/monthly/monthly_export/writers');
const { DATA_COLUMNS }       = require('../services/monthly/monthly_export/builders');

const ROWS = 50000;
const SHOPS   = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗', '신세계'];
const BRANDS  = ['Chanel', 'LV', 'Gucci', 'Hermès', 'Dior'];
const MODES   = ['T1', 'T2', 'GROUP', 'VIP', 'FIT'];

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return Math.abs(s) / 0xffffffff;
  };
}

function pick(arr, r) { return arr[Math.floor(r() * arr.length)]; }
function krw(r)  { return Math.round(120000 + r() * 8880000); }      // 120K – 9M  (압 KRW numFmt)
function usd(r)  { return Math.round((50 + r() * 8950) * 100) / 100; } // 50.00 – 9000.00
function pct(r)  { return Math.round(r() * 2000) / 10000; }           // 0 – 0.2 (presses 0.00% fmt)
function qty(r)  { return Math.floor(r() * 5) + 1; }                  // 1-5

function makeRows(n) {
  const r = seededRand(12345);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const gKrw = krw(r);
    const nKrw = Math.round(gKrw * (1 - r() * 0.3));
    const gUsd = usd(r);
    const nUsd = Math.round(gUsd * (1 - r() * 0.3) * 100) / 100;
    const dc   = pct(r);
    rows.push({
      stmt_date:             `2026-05-${String(Math.floor(r() * 23) + 1).padStart(2, '0')}`,
      statement_date:        `2026-05-${String(Math.floor(r() * 23) + 1).padStart(2, '0')}`,
      payment_mode:          pick(MODES, r),
      mode_raw:              pick(MODES, r),
      shop:                  pick(SHOPS, r),
      branch:                pick(SHOPS, r),
      upstream:              null,
      entry_company:         null,
      tour_guide:            `GUIDE-${String(Math.floor(r() * 200) + 1).padStart(4, '0')}`,
      agent:                 null,
      original_date:         null,
      purchase_date:         `2026-05-${String(Math.floor(r() * 23) + 1).padStart(2, '0')}`,
      tour_no:               `T${String(Math.floor(r() * 9000) + 1000).padStart(5, '0')}`,
      name:                  `CUSTOMER ${i + 1}`,
      passport_no:           `EG${String(Math.floor(r() * 9000000) + 1000000)}`,
      departure_date:        `2026-05-${String(Math.floor(r() * 10) + 20).padStart(2, '0')}`,
      receipt_no:            `R${String(i + 1).padStart(7, '0')}`,
      original_receipt_no:   null,
      category:              pick(['화장품', '의류', '식품', '전자제품'], r),
      brand:                 pick(BRANDS, r),
      sku:                   `SKU-${String(Math.floor(r() * 99000) + 1000)}`,
      product_name:          `Product ${i + 1}`,
      ref_no:                null,
      qty:                   qty(r),
      gross_usd:             gUsd,
      gross_krw:             gKrw,
      net_usd:               nUsd,
      net_krw:               nKrw,
      dc_usd:                Math.round((gUsd - nUsd) * 100) / 100,
      dc_krw:                gKrw - nKrw,
      discount_rate:         dc,
      voucher_amount:        r() > 0.8 ? krw(r) : null,
      voucher_deduction:     r() > 0.8 ? krw(r) : null,
      customer_points:       Math.round(nKrw * (0.03 + r() * 0.05)),
      customer_rebate_krw:   Math.round(nKrw * dc),
      customer_rebate_usd:   Math.round(nUsd * dc * 100) / 100,
      store_base_points:     Math.round((0.03 + r() * 0.05) * 10000) / 10000,
      store_base_rebate:     Math.round(nKrw * 0.04),
      store_extra_points:    Math.round(r() * 1000) / 10000,
      store_extra_amount:    r() > 0.5 ? Math.round(nKrw * r() * 0.01) : null,
      store_final_rebate:    Math.round(nKrw * (0.04 + r() * 0.02)),
      category_secondary:    null,
      remark:                null,
    });
  }
  return rows;
}

async function main() {
  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-perf-'));
  const filePath = path.join(dir, 'perf_50k.xlsx');

  try {
    console.log(`[D3 perf] generating ${ROWS} rows…`);
    const rows = makeRows(ROWS);

    const rssBefore = process.memoryUsage().rss;
    const t0        = process.hrtime.bigint();

    await writeRowsStreaming(filePath, 'export', DATA_COLUMNS, rows, {
      title: 'D3 Perf Test',
      workspaceKey: 'demo-2026-05',
      operator: 'spotcheck',
    });

    const t1       = process.hrtime.bigint();
    const rssAfter = process.memoryUsage().rss;

    const durationMs  = Number((t1 - t0) / 1_000_000n);
    const rssDeltaMb  = Math.round((rssAfter - rssBefore) / 1024 / 1024);
    const rssBefMb    = Math.round(rssBefore / 1024 / 1024);
    const rssAftMb    = Math.round(rssAfter  / 1024 / 1024);
    const fileSizeMb  = Math.round(fs.statSync(filePath).size / 1024 / 1024 * 100) / 100;

    const durationPass = durationMs <= 30000;
    const rssPass      = rssDeltaMb <= 200;

    console.log('');
    console.log(`[D3 perf] ${ROWS} rows`);
    console.log(`  duration         : ${durationMs} ms`);
    console.log(`  rss before       : ${rssBefMb} MB`);
    console.log(`  rss after        : ${rssAftMb} MB`);
    console.log(`  rss delta        : ${rssDeltaMb} MB`);
    console.log(`  output file size : ${fileSizeMb} MB`);
    console.log(`  threshold:`);
    console.log(`    duration ≤ 30000 ms     : ${durationPass ? 'PASS' : 'FAIL'}`);
    console.log(`    rss delta ≤ 200 MB      : ${rssPass      ? 'PASS' : 'FAIL'}`);

    const allPass = durationPass && rssPass;
    if (!allPass) {
      console.log('');
      if (!durationPass) {
        console.log('  [建议] duration 超限: 可改为仅对货币列逐 cell 设 cell.numFmt,');
        console.log('         而非全局开 useStyles:true —— 保留 useStyles:false,');
        console.log('         在 sheet.addRow().commit() 后立即对该行货币列');
        console.log('         调用 row.getCell(idx).numFmt = "#,##0" 写入格式。');
      }
      if (!rssPass) {
        console.log('  [建议] RSS 增量超限: ExcelJS WorkbookWriter 流式写入不应累积大量内存;');
        console.log('         检查是否有 rows 数组在 writeRowsStreaming 内部被整体持有。');
        console.log('         可改为逐行生成 + 逐行 stream,避免 50k 行同时在内存中。');
      }
    }

    process.exit(allPass ? 0 : 1);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* intentional */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
