'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMergeStreamingService } = require('../../services/monthly/merge_streaming_service');

test('merge streaming uses light merge iterators instead of full raw scans', async () => {
  const inserted = [];
  let dailyIteratorUsed = false;
  let billIteratorUsed = false;

  const svc = createMergeStreamingService({
    dailyReceiptRepo: {
      countByMode() {
        return [{ folder: 'A', n: 1 }];
      },
      *_iterateMergeCandidates() {
        dailyIteratorUsed = true;
        yield {
          id: 11,
          modeFolder: 'A',
          receiptNo: 'R-001',
          name: 'LEE TEST',
          passportNo: 'M12345678',
          purchaseDate: '2026-01-02',
        };
      },
      _listAll() {
        throw new Error('full daily scan should not be used');
      },
    },
    billMatchLogRepo: {
      list({ status, offset = 0 }) {
        if (offset > 0) return [];
        if (status === 'matched') {
          return [{ dailyReceiptId: 11, storeBillId: 22, matchStatus: 'matched' }];
        }
        return [];
      },
    },
    monthlyDataRepo: {
      deleteByWorkspace() {
        return 0;
      },
      insertMany(rows) {
        inserted.push(...rows);
        return { inserted: rows.length, skipped: 0 };
      },
    },
    storeBillRepo: {
      *iterateMergeCandidates() {
        billIteratorUsed = true;
        yield {
          id: 22,
          mode: 'mode-a',
          storeFamily: 'A',
          storeBranch: 'A-branch',
          receiptNo: 'R-001',
          name: 'LEE TEST',
          passportNo: 'M12345678',
          purchaseDate: '2026-01-02',
          netKrw: 10000,
          netUsd: 7,
          storeBasePoints: 0.01,
          storeExtraPoints: 0,
          transactionType: 'sale',
        };
      },
      iterateDetail() {
        throw new Error('full bill scan should not be used');
      },
    },
  });

  const result = await svc.run({ workspaceKey: '2026-01' });

  assert.equal(dailyIteratorUsed, true);
  assert.equal(billIteratorUsed, true);
  assert.equal(result.matched, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].dailyReceiptId, 11);
  assert.equal(inserted[0].storeBillId, 22);
});

test('merge streaming: 退货行账单无返点时按公式自算负返点(不再 null)', async () => {
  const inserted = [];
  const svc = createMergeStreamingService({
    dailyReceiptRepo: {
      countByMode() { return []; },
      *_iterateMergeCandidates() { /* 无匹配台账 */ },
      _listAll() { return []; },
    },
    billMatchLogRepo: {
      list() { return []; }, // 退货不进匹配日志
    },
    monthlyDataRepo: {
      deleteByWorkspace() { return 0; },
      insertMany(rows) { inserted.push(...rows); return { inserted: rows.length, skipped: 0 }; },
    },
    storeBillRepo: {
      *iterateMergeCandidates() {
        yield {
          id: 99, mode: 'mode-r', storeFamily: 'LOTTE', storeBranch: 'SEOUL',
          receiptNo: 'R-REF', name: 'PARK', passportNo: 'P999',
          purchaseDate: '2026-01-05',
          netKrw: -10000, netUsd: -7,
          storeBasePoints: 0.01, storeExtraPoints: 0,
          rebateAmount: null,            // 账单没预填客人返点金额
          transactionType: 'refund',     // 退货行
        };
      },
      iterateDetail() { return []; },
    },
    modeDeductConfigRepo: {
      listByWorkspace() { return [{ modeFolder: '乐天首尔', deductValue: -0.005 }]; },
    },
    modeFolderMappingRepo: {
      listByWorkspace() { return [{ modeRaw: 'mode-r', modeFolder: '乐天首尔' }]; },
    },
  });

  const result = await svc.run({ workspaceKey: '2026-01' });

  assert.equal(result.refund, 1, '应处理 1 行退货');
  assert.equal(inserted.length, 1);
  const row = inserted[0];
  // 客人返点 = netKrw(-10000) ×(0.01 + 0 + (-0.005)) = -10000 × 0.005 = -50
  assert.equal(row.customerRebateKrw, -50, '退货返点应为负(冲减),不再 null');
  assert.equal(row.customerRebateUsd, -7 * 0.005, '退货 USD 返点也应算出(负)');
  assert.equal(row.modeFolder, '乐天首尔');
});

test('merge streaming: 退货行小票号命中 matched 台账时归属该客户冲减(BAO CHAO 场景)', async () => {
  // 业务:客户买小票32(matched)后全额退掉。退货行在账单上没护照,旧逻辑写成
  // bill-only 被交付 eligible 排除 → 冲减丢失、客户返点虚高一倍。
  // 修复后:退货行带台账客户身份(daily_receipt_id/姓名/护照/出境日)进交付。
  const inserted = [];
  const svc = createMergeStreamingService({
    dailyReceiptRepo: {
      countByMode() { return [{ folder: 'A', n: 1 }]; },
      *_iterateMergeCandidates() {
        yield {
          id: 15, modeFolder: 'A', receiptNo: '0326146600032', name: 'BAO CHAO',
          passportNo: 'EL3677217', departureDate: '2026-02-02', tourNo: '71990',
          purchaseDate: '2026-01-31',
        };
      },
      _listAll() { throw new Error('full daily scan should not be used'); },
    },
    billMatchLogRepo: {
      list({ status, offset = 0 }) {
        if (offset > 0) return [];
        if (status === 'matched') return [{ dailyReceiptId: 15, storeBillId: 706, matchStatus: 'matched' }];
        return [];
      },
    },
    monthlyDataRepo: {
      deleteByWorkspace() { return 0; },
      insertMany(rows) { inserted.push(...rows); return { inserted: rows.length, skipped: 0 }; },
    },
    storeBillRepo: {
      *iterateMergeCandidates() {
        // 销售行(被匹配)
        yield {
          id: 706, mode: 'mode-a', storeFamily: 'SHILLA', storeBranch: '新罗济州',
          receiptNo: '0326146600032', name: 'BAO C', purchaseDate: '2026-01-31',
          netKrw: 5351250, netUsd: 3750, storeBasePoints: 0.135, storeExtraPoints: 0,
          transactionType: null,
        };
        // 退货行(同小票号,无匹配日志,账单上没护照)
        yield {
          id: 707, mode: 'mode-a', storeFamily: 'SHILLA', storeBranch: '新罗济州',
          receiptNo: '0326146600032', name: 'BAO C', purchaseDate: '2026-01-31',
          netKrw: -5351250, netUsd: -3750, storeBasePoints: 0.135, storeExtraPoints: 0,
          rebateAmount: null,
          transactionType: 'refund',
        };
      },
      iterateDetail() { return []; },
    },
    modeDeductConfigRepo: {
      listByWorkspace() { return [{ modeFolder: '济州新罗V团', deductValue: 0 }]; },
    },
    modeFolderMappingRepo: {
      listByWorkspace() { return [{ modeRaw: 'mode-a', modeFolder: '济州新罗V团' }]; },
    },
  });

  const result = await svc.run({ workspaceKey: '2026-01' });

  assert.equal(result.matched, 1);
  assert.equal(result.refund, 1);
  assert.equal(result.refundLinked, 1, '同小票号退货行应归属到 matched 台账客户');
  assert.equal(inserted.length, 2, 'matched 销售行 + 归属退货行');
  const refundRow = inserted.find((r) => Number(r.netKrw) < 0);
  assert.ok(refundRow, '应有退货冲减行');
  assert.equal(refundRow.dailyReceiptId, 15, '退货行应带台账 daily_receipt_id(进交付 eligible)');
  assert.equal(refundRow.passportNo, 'EL3677217', '客户身份用台账护照号(客户汇总分组才归对人)');
  assert.equal(refundRow.name, 'BAO CHAO', '客户名用台账名而非账单缩写名');
  assert.equal(refundRow.isUnmatched, false);
  assert.ok(Number(refundRow.customerRebateKrw) < 0, '退货返点应为负(冲减)');
  // 客户净返点 = 销售 + 退货 ≈ 0(全额退)
  const total = inserted.reduce((s, r) => s + Number(r.customerRebateKrw || 0), 0);
  assert.equal(Math.round(total), 0, '买退同票净返点应抵消为 0');
});

test('merge streaming: 负净额账单行被匹配上时只写一行(不被 refund 路径重复计)', async () => {
  // C1 回归:transaction_type=null && netKrw<0 的行既满足 isRefundBill,又可能被
  // P4/P5 匹配上(进 matchedLogs/billIdsNeeded)。修复前会被 matched 路径写一行、
  // refund 路径再写一行 → monthly_data 双计。修复后只走 matched 路径,refund=0。
  const inserted = [];
  const svc = createMergeStreamingService({
    dailyReceiptRepo: {
      countByMode() { return [{ folder: 'A', n: 1 }]; },
      *_iterateMergeCandidates() {
        yield { id: 11, modeFolder: 'A', receiptNo: 'R-NEG', name: 'KIM', passportNo: 'M77', purchaseDate: '2026-01-03' };
      },
      _listAll() { throw new Error('full daily scan should not be used'); },
    },
    billMatchLogRepo: {
      list({ status, offset = 0 }) {
        if (offset > 0) return [];
        if (status === 'matched') return [{ dailyReceiptId: 11, storeBillId: 22, matchStatus: 'matched' }];
        return [];
      },
    },
    monthlyDataRepo: {
      deleteByWorkspace() { return 0; },
      insertMany(rows) { inserted.push(...rows); return { inserted: rows.length, skipped: 0 }; },
    },
    storeBillRepo: {
      *iterateMergeCandidates() {
        yield {
          id: 22, mode: 'mode-a', storeFamily: 'A', storeBranch: 'A-branch',
          receiptNo: 'R-NEG', name: 'KIM', passportNo: 'M77', purchaseDate: '2026-01-03',
          netKrw: -10000, netUsd: -7, storeBasePoints: 0.01, storeExtraPoints: 0,
          transactionType: null, // 历史数据缺字段,默认当 sale → 可被匹配
        };
      },
      iterateDetail() { return []; },
    },
  });

  const result = await svc.run({ workspaceKey: '2026-01' });

  assert.equal(inserted.length, 1, '负净额匹配行只应写 1 行,不被 refund 路径重复');
  assert.equal(result.matched, 1);
  assert.equal(result.refund ?? 0, 0, '已匹配的负净额行不应再计入 refund 路径');
  assert.equal(inserted[0].storeBillId, 22);
});
