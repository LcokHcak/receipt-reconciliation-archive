'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBuildIndex } = require('../services/monthly/bill_match/common');

test('bill_match P6 receipt-prefix fuzzy also requires purchase date and customer agreement', () => {
  const dailyRows = [
    {
      id: 5,
      receiptNo: '0326152400244',
      purchaseDate: '2026-01-16',
      name: 'DAI L',
      passportNo: 'P5',
      ledgerStatus: 'posted',
      tourMatchStatus: 'matched',
      modeFolder: 'folder-a',
    },
  ];
  const buildIndex = createBuildIndex({
    _listMatchCandidates: () => dailyRows,
  });
  const index = buildIndex('2026-01', { folder: 'folder-a' });

  assert.deepEqual(
    index.findDailyFuzzy({
      receiptNo: '0326152400011',
      purchaseDate: '2026-01-01',
      name: 'FENG',
    }),
    [],
  );
  assert.deepEqual(
    index.findDailyFuzzy({
      receiptNo: '0326152400999',
      purchaseDate: '2026-01-16',
      name: 'OTHER',
    }).map((row) => row.id),
    [],
  );
  assert.deepEqual(
    index.findDailyFuzzy({
      receiptNo: '0326152400999',
      purchaseDate: '2026-01-16',
      name: 'DAI L',
    }).map((row) => row.id),
    [5],
  );
  assert.deepEqual(
    index.findDailyFuzzy({
      receiptNo: '0326152400999',
      purchaseDate: '2026-01-16',
      name: 'OTHER',
      passportNo: 'P5',
    }).map((row) => row.id),
    [5],
  );
  assert.deepEqual(
    index.findDailyFuzzy({
      receiptNo: 'NOPE',
      purchaseDate: '2026-01-16',
      name: 'DAI L',
    }).map((row) => row.id),
    [5],
  );
});
