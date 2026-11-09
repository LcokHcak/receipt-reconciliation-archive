'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBillMatchService } = require('../../services/monthly/bill_match_service');

const WS = 'demo-2026-01';

function makeBill(id) {
  return {
    id,
    workspaceKey: WS,
    isDetailSheet: true,
    transactionType: 'sale',
    receiptNo: `NO-HIT-${id}`,
    purchaseDate: '2026-01-10',
    name: `CUSTOMER ${id}`,
    passportNo: `P${id}`,
    storeFamily: 'LOTTE',
    sourceFile: 'bill.xlsx',
    sourceSheet: 'Sheet1',
  };
}

test('bill_match flushes unmatched/fuzzy/ambiguous branches before final flush', async () => {
  const bills = Array.from({ length: 5001 }, (_, index) => makeBill(index + 1));
  const logBatchSizes = [];
  const badcaseBatchSizes = [];

  const service = createBillMatchService({
    storeBillRepo: {
      iterateDetail: () => bills,
    },
    dailyReceiptRepo: {
      _listAll: () => [],
      setConflictFields: () => 0,
    },
    billMatchLogRepo: {
      insertMany: (rows) => {
        logBatchSizes.push(rows.length);
      },
    },
    pendingReviewRepo: {
      findByFingerprint: () => null,
      insertMany: () => {},
    },
    matchBadcaseRepo: {
      insertMany: (rows) => {
        badcaseBatchSizes.push(rows.length);
      },
    },
  });

  const result = await service.run({ workspaceKey: WS });

  assert.equal(result.unmatched, 5001);
  assert.deepEqual(logBatchSizes, [5000, 1]);
  assert.deepEqual(badcaseBatchSizes, [5000, 1]);
});

test('bill_match uses light candidate queries when repositories provide them', async () => {
  const service = createBillMatchService({
    storeBillRepo: {
      iterateDetail: () => {
        throw new Error('iterateDetail should not be used for bill_match candidates');
      },
      iterateMatchCandidates: () => [makeBill(1)],
    },
    dailyReceiptRepo: {
      _listAll: () => {
        throw new Error('_listAll should not be used for bill_match candidates');
      },
      _listMatchCandidates: () => [],
      _listConsistencyCandidates: () => [],
      setConflictFields: () => 0,
    },
    billMatchLogRepo: {
      insertMany: () => {},
    },
    pendingReviewRepo: {
      findByFingerprint: () => null,
      insertMany: () => {},
    },
    matchBadcaseRepo: {
      insertMany: () => {},
    },
  });

  const result = await service.run({ workspaceKey: WS });

  assert.equal(result.billsScanned, 1);
  assert.equal(result.unmatched, 1);
});
