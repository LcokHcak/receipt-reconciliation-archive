'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runRules, RULE_ID } = require('../lib/monthly_pipeline/rule_engine');

function detailRow(overrides = {}) {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1e9),
    isDetailSheet: true,
    storeFamily: '乐天',
    mode: 'H团',
    modeNormalized: 'H',
    tourNo: '25186291',
    purchaseDate: '2026-01-05',
    departureDate: '2026-01-06',
    name: 'ZHANG SAN',
    passportNo: 'EA1234567',
    receiptNo: '90100326000001',
    sourceFile: '乐天.xlsx',
    sourceSheet: '明细',
    ...overrides,
  };
}

test('runRules flags cross-buy departure date conflicts and syncs to latest', () => {
  const rows = [
    detailRow({ id: 1, receiptNo: 'R1', purchaseDate: '2026-01-02', departureDate: '2026-01-05' }),
    detailRow({ id: 2, receiptNo: 'R2', purchaseDate: '2026-01-03', departureDate: '2026-01-08' }),
  ];
  const { errors, rewrites, summary } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  const depErrors = errors.filter((e) => e.errorType === RULE_ID.CC_DEPARTURE_SYNC);
  assert.equal(depErrors.length, 1);
  assert.equal(depErrors[0].expectedValue, '2026-01-08');
  assert.equal(depErrors[0].actualValue, '2026-01-05');
  assert.equal(summary[RULE_ID.CC_DEPARTURE_SYNC], 1);
  // rewrites carry the store_bill_id so the service can UPDATE it
  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0].storeBillId, 1);
  assert.equal(rewrites[0].beforeValue, '2026-01-05');
  assert.equal(rewrites[0].afterValue, '2026-01-08');
});

test('runRules flags receipt-number -> passport/name conflicts', () => {
  const rows = [
    detailRow({ receiptNo: 'SAME', passportNo: 'PASSA', name: 'ZHANG' }),
    detailRow({ receiptNo: 'SAME', passportNo: 'PASSB', name: 'LI' }),
  ];
  const { errors } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  const conflicts = errors.filter((e) => e.errorType === RULE_ID.CC_NAME_PASSPORT);
  assert.equal(conflicts.length, 2, 'both rows should be flagged');
});

test('runRules flags unknown mode as BILL_MODE_ENUM', () => {
  const rows = [
    detailRow({ mode: '未知模式', modeNormalized: 'UNKNOWN' }),
  ];
  const { errors } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  const modeErrs = errors.filter((e) => e.errorType === RULE_ID.BILL_MODE_ENUM);
  assert.equal(modeErrs.length, 1);
  assert.equal(modeErrs[0].severity, 'medium');
});

test('runRules flags non-whitelisted store family as BILL_SHOP_ENUM', () => {
  const rows = [
    detailRow({ storeFamily: 'UNKNOWN_SHOP', tourNo: '12345678', receiptNo: '90100326000001' }),
  ];
  const { errors } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  const shopErrs = errors.filter((e) => e.errorType === RULE_ID.BILL_SHOP_ENUM);
  assert.equal(shopErrs.length, 1);
  assert.equal(shopErrs[0].expectedValue, '乐天|新罗|爱宝客');
});

test('runRules flags wrong receipt length by family; alpha placeholders pass', () => {
  const rows = [
    detailRow({ storeFamily: '乐天', receiptNo: '1234567890' }),      // 10, expect 14 → fail
    detailRow({ storeFamily: '乐天', receiptNo: 'ZZZZZZZZZZZZZZ' }),  // alpha → pass
    detailRow({ storeFamily: '新罗', receiptNo: '1111222233334' }),    // 13 → pass
    detailRow({ storeFamily: '新罗', receiptNo: '111122223333' }),     // 12 → fail
  ];
  const { errors } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  const recErrs = errors.filter((e) => e.errorType === RULE_ID.GC_RECEIPT_LEN);
  assert.equal(recErrs.length, 2);
});

test('runRules flags wrong tour_no length but allows alpha placeholders', () => {
  const rows = [
    detailRow({ storeFamily: '乐天', tourNo: '12345' }),
    detailRow({ storeFamily: '乐天', tourNo: 'ZZZZZZZZ' }),
    detailRow({ storeFamily: '新罗', tourNo: '71990' }),
    detailRow({ storeFamily: '新罗', tourNo: '7199' }),
  ];
  const { errors } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  const tourErrs = errors.filter((e) => e.errorType === RULE_ID.GC_TOUR_LEN);
  // 乐天 row1 (5 chars, not placeholder) and 新罗 row4 (4 chars) should fail
  // 乐天 row2 is alpha placeholder; 新罗 row3 is 5 chars = ok
  assert.equal(tourErrs.length, 2);
  assert.ok(tourErrs.some((e) => e.tourNo === '12345'));
  assert.ok(tourErrs.some((e) => e.tourNo === '7199'));
});

test('runRules flags purchase date outside [apply, end] window', () => {
  const groupCodeByTour = new Map([
    ['25186291', { applyDate: '2026-01-03', endDate: '2026-01-10' }],
    ['25186292', { applyDate: null,          endDate: '2026-01-10' }], // only upper
    ['25186293', { applyDate: '2026-01-03', endDate: null }],          // only lower
    ['25186294', { applyDate: null,          endDate: null }],         // auto-pass
  ]);
  const rows = [
    detailRow({ id: 11, tourNo: '25186291', purchaseDate: '2026-01-01' }),  // below
    detailRow({ id: 12, tourNo: '25186291', purchaseDate: '2026-01-05' }),  // inside
    detailRow({ id: 13, tourNo: '25186291', purchaseDate: '2026-01-15' }),  // above
    detailRow({ id: 14, tourNo: '25186292', purchaseDate: '2026-01-01' }),  // no lower → pass
    detailRow({ id: 15, tourNo: '25186292', purchaseDate: '2026-01-15' }),  // above → fail
    detailRow({ id: 16, tourNo: '25186293', purchaseDate: '2026-01-01' }),  // below → fail
    detailRow({ id: 17, tourNo: '25186294', purchaseDate: '2026-01-15' }),  // auto-pass
  ];
  const { errors } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    groupCodeByTour,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  const dateErrs = errors.filter((e) => e.errorType === RULE_ID.GC_DATE_WINDOW);
  // 11 (below) + 13 (above) + 15 (above 01-10) + 16 (below 01-03) = 4
  assert.equal(dateErrs.length, 4);
  assert.ok(dateErrs.every((e) => e.rawPayload?.storeBillId));
});

test('runRules ignores non-detail sheets', () => {
  const rows = [
    detailRow({ isDetailSheet: false, modeNormalized: 'UNKNOWN' }),
  ];
  const { errors } = runRules({
    workspaceKey: '2026-01',
    detailBillRows: rows,
    detectedAt: '2026-05-10T00:00:00Z',
  });
  assert.equal(errors.length, 0);
});
