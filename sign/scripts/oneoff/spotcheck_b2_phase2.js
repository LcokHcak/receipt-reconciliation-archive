'use strict';

/**
 * B2 Phase 2 真实数据对账脚本
 * 5 行非规整 fixture，故意含 0.1+0.2 浮点陷阱，验证 Decimal.js 链路接通
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Decimal = require('decimal.js');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMergeStreamingService } = require('../services/monthly/merge_streaming_service');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');

const WS = 'spotcheck-2026-01';
const FOLDERS = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗V团'];

// 5 行 fixture：数值非规整，Row1 故意用 0.1+0.2 触发 float 陷阱
const FIXTURE_ROWS = [
  { id:1, folder:'乐天首尔',   sbp:0.1,    sep:0.2,    dv:-0.0053, nkrw:132847, nusd:98.50  },
  { id:2, folder:'乐天釜山',   sbp:0.0412, sep:0.0088, dv:0,       nkrw:87634,  nusd:64.20  },
  { id:3, folder:'爱宝客',     sbp:0.0333, sep:0.0001, dv:-0.0002, nkrw:215430, nusd:163.80 },
  { id:4, folder:'济州新罗V团', sbp:0.2300, sep:0,      dv:0.0100,  nkrw:9133138,nusd:6365   },
];

const UNMATCHED_BILL = {
  id:999, mode:'신라면세점', storeFamily:'新罗', storeBranch:'釜山',
  netKrw:450000, netUsd:330, points:0.24, rebateAmount:108000,
};

const DEDUCT_VALUES = {
  '乐天首尔':   -0.0053,
  '乐天釜山':   0,
  '爱宝客':     -0.0002,
  '济州新罗V团': 0.0100,
};

function makeService(monthlyDataRepo) {
  const dailyRows = FIXTURE_ROWS.map(r => ({
    id: r.id, workspaceKey: WS, modeFolder: r.folder, ledgerStatus: 'posted',
    storeBasePoints: r.sbp, storeExtraPoints: r.sep,
    netKrw: r.nkrw, netUsd: r.nusd,
    receiptNo: 'R' + String(r.id).padStart(3, '0'),
    name: 'USER' + r.id, passportNo: 'P' + r.id, purchaseDate: '2026-01-15',
  }));

  const matchedLogs = FIXTURE_ROWS.map(r => ({ dailyReceiptId: r.id, storeBillId: r.id + 100 }));
  const matchedBills = FIXTURE_ROWS.map(r => ({ id: r.id + 100, mode: null, storeFamily: null }));
  const unmatchedBillObj = {
    id: UNMATCHED_BILL.id, mode: UNMATCHED_BILL.mode,
    storeFamily: UNMATCHED_BILL.storeFamily, storeBranch: UNMATCHED_BILL.storeBranch,
    netKrw: UNMATCHED_BILL.netKrw, netUsd: UNMATCHED_BILL.netUsd,
    points: UNMATCHED_BILL.points, rebateAmount: UNMATCHED_BILL.rebateAmount,
  };

  return createMergeStreamingService({
    dailyReceiptRepo: {
      countByMode: () => FOLDERS.map(f => ({ folder: f, n: 1 })),
      listByMode: ({ modeFolder, limit, offset }) =>
        dailyRows.filter(r => r.modeFolder === modeFolder).slice(offset, offset + limit),
      _listAll: ({ workspaceKey }) => dailyRows.filter(r => r.workspaceKey === workspaceKey),
    },
    billMatchLogRepo: {
      list: ({ status, limit, offset }) =>
        (status === 'matched' ? matchedLogs : [{ storeBillId: UNMATCHED_BILL.id }])
          .slice(offset, offset + limit),
    },
    monthlyDataRepo,
    storeBillRepo: {
      iterateDetail: () => [...matchedBills, unmatchedBillObj],
    },
    modeDeductConfigRepo: {
      listByWorkspace: () => FOLDERS.map(f => ({ modeFolder: f, deductValue: DEDUCT_VALUES[f] })),
    },
    modeFolderMappingRepo: { listByWorkspace: () => [] },
    workspaceRepo: {
      findByKey: () => ({
        deductConfigConfirmedAt: '2026-05-22T10:30:00.000Z',
        modeMappingConfirmedAt:  '2026-05-22T10:31:15.000Z',
      }),
    },
  });
}

function expected(row) {
  const d = DEDUCT_VALUES[row.folder];
  const points = new Decimal(row.sbp).plus(row.sep).plus(d ?? 0);
  return {
    points: points.toDecimalPlaces(4).toNumber(),
    krw:    new Decimal(row.nkrw).mul(points).toDecimalPlaces(4).toNumber(),
    usd:    new Decimal(row.nusd).mul(points).toDecimalPlaces(4).toNumber(),
  };
}

function nativeFloat(row) {
  const d = DEDUCT_VALUES[row.folder] ?? 0;
  const points = row.sbp + row.sep + d;
  return {
    points,
    krw: parseFloat((row.nkrw * points).toFixed(4)),
    usd: parseFloat((row.nusd * points).toFixed(4)),
  };
}

async function main() {
  const tmp = path.join(os.tmpdir(), 'spotcheck-' + Date.now() + '.sqlite');
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    const monthlyDataRepo = createMonthlyDataRepository({ db });
    const svc = makeService(monthlyDataRepo);
    await svc.run({ workspaceKey: WS });

    const dbRows = db.prepare(
      'SELECT receipt_no, mode_folder, customer_points, customer_rebate_krw, customer_rebate_usd, customer_rebate, merge_config_version, is_unmatched FROM monthly_data WHERE workspace_key = ? ORDER BY daily_receipt_id NULLS LAST'
    ).all(WS);

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║    B2 Phase 2 真实数据对账 — 5 行 spot check               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    let allPass = true;

    for (const row of FIXTURE_ROWS) {
      const exp = expected(row);
      const nat = nativeFloat(row);
      const dbr = dbRows.find(r => r.receipt_no === 'R' + String(row.id).padStart(3, '0'));

      const ptOk     = dbr.customer_points     === exp.points;
      const krwOk    = dbr.customer_rebate_krw === exp.krw;
      const usdOk    = dbr.customer_rebate_usd === exp.usd;
      const mirrorOk = dbr.customer_rebate     === dbr.customer_rebate_krw;
      const ok = ptOk && krwOk && usdOk && mirrorOk;
      if (!ok) allPass = false;

      const floatDiff = nat.krw !== exp.krw || nat.points !== exp.points || nat.usd !== exp.usd;

      console.log('[' + (ok ? '✔' : '✖') + '] Row ' + row.id + ' ' + row.folder);
      console.log('     输入: sbp=' + row.sbp + ' sep=' + row.sep + ' dv=' + DEDUCT_VALUES[row.folder] + ' netKrw=' + row.nkrw + ' netUsd=' + row.nusd);
      console.log('     期望: points=' + exp.points + '  krw=' + exp.krw + '  usd=' + exp.usd);
      console.log('     DB值: points=' + dbr.customer_points + '  krw=' + dbr.customer_rebate_krw + '  usd=' + dbr.customer_rebate_usd + '  mirror_ok=' + mirrorOk);
      if (floatDiff) {
        console.log('     ⚠  float原生: points=' + nat.points + '  krw=' + nat.krw + '  ← Decimal.js 修正了此差异');
      }
      console.log('     merge_config_version: ' + dbr.merge_config_version);
      console.log();
    }

    // unmatched bill
    const unmatchedDbRow = dbRows.find(r => r.is_unmatched === 1);
    const uKrwNull     = unmatchedDbRow && unmatchedDbRow.customer_rebate_krw === null;
    const uUsdNull     = unmatchedDbRow && unmatchedDbRow.customer_rebate_usd === null;
    const uRebateFb    = unmatchedDbRow && unmatchedDbRow.customer_rebate === UNMATCHED_BILL.rebateAmount;
    const unmatchedOk  = uKrwNull && uUsdNull && uRebateFb;
    if (!unmatchedOk) allPass = false;

    console.log('[' + (unmatchedOk ? '✔' : '✖') + '] Row 5 — unmatched bill (' + UNMATCHED_BILL.mode + ')');
    console.log('     预期: customer_rebate_krw=null  customer_rebate_usd=null  customer_rebate=' + UNMATCHED_BILL.rebateAmount + '(bill.rebateAmount 兜底)');
    console.log('     DB值: krw=' + (unmatchedDbRow ? unmatchedDbRow.customer_rebate_krw : 'ROW_NOT_FOUND') +
                             '  usd=' + (unmatchedDbRow ? unmatchedDbRow.customer_rebate_usd : '?') +
                             '  customer_rebate=' + (unmatchedDbRow ? unmatchedDbRow.customer_rebate : '?'));
    console.log();
    console.log('──────────────────────────────────────────────────────────────');
    console.log('总计: ' + (allPass ? '✔ 全部通过 (5/5)' : '✖ 存在失败项'));
    if (!allPass) process.exit(1);
  } finally {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.unlinkSync(tmp); } catch {
      // intentional: best-effort cleanup
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
