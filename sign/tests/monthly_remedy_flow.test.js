const test = require('node:test');
const assert = require('node:assert/strict');

const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createMergeService } = require('../services/monthly/merge_service');

test('tour-match records unmatched issues without mutating ledger status', async () => {
  const statusCalls = [];
  const tourUpdates = [];
  const dailyReceiptRepo = {
    listPendingTourMatch() {
      return [{
        id: 1,
        tour_no: '71993',
        receipt_no: 'R1',
        purchase_date: '2026-05-20',
        agent: 'AGENT-A',
      }];
    },
    _fetchFullById() {
      return {
        id: 1,
        sourceType: 'workbench',
        ledgerStatus: 'in_review',
        receiptNo: 'R1',
        tourNo: '71993',
        purchaseDate: '2026-05-20',
        agent: 'AGENT-A',
        shop: 'THE SHILLA',
        branch: '',
        name: 'LI MING',
        passportNo: 'P1',
      };
    },
    updateTourMatch(payload) {
      tourUpdates.push(payload);
    },
    setLedgerStatus(payload) {
      statusCalls.push(payload);
      return 1;
    },
  };
  const service = createTourMatchService({
    dailyReceiptRepo,
    groupCodeRepo: { findByTour: () => [] },
    pendingReviewRepo: { insertMany() {} },
    errorRecordRepo: { insertMany() {} },
  });

  const result = await service.run({ workspaceKey: '2026-05' });

  assert.equal(result.tourNotFound, 1);
  assert.equal(tourUpdates.at(-1).tourMatchStatus, 'tour_not_found');
  assert.equal(statusCalls.length, 0);
});

test('bill matching ignores ledger rows that are not confirmed into month', async () => {
  const logs = [];
  const service = createBillMatchService({
    storeBillRepo: {
      iterateDetail() {
        return [{
          id: 10,
          isDetailSheet: true,
          receiptNo: 'R100',
          tourNo: '71993',
          name: 'LI MING',
          passportNo: 'P1',
          purchaseDate: '2026-05-10',
          shop: 'THE SHILLA',
        }];
      },
    },
    dailyReceiptRepo: {
      _listAll() {
        return [{
          id: 1,
          ledgerStatus: 'remedy',
          receiptNo: 'R100',
          tourNo: '71993',
          name: 'LI MING',
          passportNo: 'P1',
          purchaseDate: '2026-05-10',
          shop: 'THE SHILLA',
        }];
      },
      updateBillMatch() {},
    },
    billMatchLogRepo: {
      insertMany(rows) {
        logs.push(...rows);
        return { inserted: rows.length };
      },
    },
    pendingReviewRepo: { insertMany() {} },
  });

  const result = await service.run({ workspaceKey: '2026-05' });

  assert.equal(result.matched, 0);
  assert.equal(result.unmatched, 1);
  assert.equal(logs[0].matchStatus, 'unmatched');
});

test('merge writes all ledger rows regardless of legacy ledger status', async () => {
  const inserted = [];
  const service = createMergeService({
    dailyReceiptRepo: {
      countByMode() {
        return [{ folder: 'lotte_sg', count: 2 }];
      },
      listByMode() {
        return [
          {
            id: 1,
            ledgerStatus: 'posted',
            receiptNo: 'R-POSTED',
            name: 'POSTED',
            passportNo: 'P1',
            purchaseDate: '2026-05-10',
          },
          {
            id: 2,
            ledgerStatus: 'ready_to_post',
            receiptNo: 'R-READY',
            name: 'READY',
            passportNo: 'P2',
            purchaseDate: '2026-05-10',
          },
        ];
      },
    },
    billMatchLogRepo: {
      list() {
        return [];
      },
    },
    monthlyDataRepo: {
      insertMany(rows) {
        inserted.push(...rows);
        return { inserted: rows.length, skipped: 0 };
      },
    },
  });

  const result = await service.run({ workspaceKey: '2026-05' });

  assert.equal(result.inserted, 2);
  assert.deepEqual(inserted.map((row) => row.dailyReceiptId), [1, 2]);
});
