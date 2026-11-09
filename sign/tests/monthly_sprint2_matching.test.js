'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyModeFolder,
  isRequiredMode,
  allRequiredModes,
  FOLDER,
} = require('../lib/monthly_pipeline/mode_folder_classifier');
const { diffDailyVsBill, isEmptyValue, normalizeDate } = require('../lib/monthly_pipeline/matching/field_diff');
const { planMerge } = require('../lib/monthly_pipeline/matching/conflict_policy');
const { matchBillAgainstDaily, KEY_BUILDERS } = require('../lib/monthly_pipeline/matching');

test('classifyModeFolder — maps the 7 required modes', () => {
  assert.equal(classifyModeFolder({ modeRaw: '爱宝客pkg-本司' }), FOLDER.HDC);
  assert.equal(classifyModeFolder({ modeRaw: '爱宝客SG-本司' }), FOLDER.HDC);
  assert.equal(classifyModeFolder({ modeRaw: '乐天SG-本司' }), FOLDER.LOTTE_SEOUL);
  assert.equal(classifyModeFolder({ modeRaw: '乐天H团-本司' }), FOLDER.LOTTE_SEOUL);
  assert.equal(classifyModeFolder({ modeRaw: '乐天釜山P特殊-本司' }), FOLDER.LOTTE_BUSAN);
  assert.equal(classifyModeFolder({ modeRaw: '乐天釜山SG-本司' }), FOLDER.LOTTE_BUSAN);
  assert.equal(classifyModeFolder({ modeRaw: '济州新罗V团-本司' }), FOLDER.SHILLA_JEJU_V);
});

test('classifyModeFolder — modes without -本司 suffix return null', () => {
  // Pre-v2 modes (without suffix) now always return null — they get
  // filtered out in tour_match with status skipped_mode_not_required
  assert.equal(classifyModeFolder({ modeRaw: '乐天SG' }), null);
  assert.equal(classifyModeFolder({ modeRaw: '爱宝客SG' }), null);
  assert.equal(classifyModeFolder({ modeRaw: '济州新罗V团' }), null);
});

test('classifyModeFolder — unknown mode strings return null', () => {
  assert.equal(classifyModeFolder({ modeRaw: 'Other-本司' }), null);
  assert.equal(classifyModeFolder({ modeRaw: '' }), null);
  assert.equal(classifyModeFolder({}), null);
  assert.equal(classifyModeFolder({ modeRaw: null }), null);
});

test('classifyModeFolder — tolerates whitespace', () => {
  assert.equal(classifyModeFolder({ modeRaw: '  乐天SG-本司  ' }), FOLDER.LOTTE_SEOUL);
  assert.equal(classifyModeFolder({ modeRaw: '乐天 SG-本司' }), FOLDER.LOTTE_SEOUL);
});

test('isRequiredMode — only the 7 enum strings pass', () => {
  assert.equal(isRequiredMode('乐天SG-本司'), true);
  assert.equal(isRequiredMode('乐天SG'), false);
  assert.equal(isRequiredMode('爱宝客pkg-本司'), true);
  assert.equal(isRequiredMode('random-本司'), false);
  assert.equal(isRequiredMode(''), false);
  assert.equal(isRequiredMode(null), false);
});

test('allRequiredModes — returns 7 modes', () => {
  const modes = allRequiredModes();
  assert.equal(modes.length, 7);
  assert.ok(modes.every((m) => m.endsWith('-本司')));
});

test('isEmptyValue — handles null/-/--', () => {
  assert.equal(isEmptyValue(null), true);
  assert.equal(isEmptyValue(''), true);
  assert.equal(isEmptyValue(' '), true);
  assert.equal(isEmptyValue('-'), true);
  assert.equal(isEmptyValue('--'), true);
  assert.equal(isEmptyValue('null'), true);
  assert.equal(isEmptyValue('X'), false);
  assert.equal(isEmptyValue(0), false);
});

test('normalizeDate — handles ISO and slash variants', () => {
  assert.equal(normalizeDate('2026-01-15'), '2026-01-15');
  assert.equal(normalizeDate('2026/01/15'), '2026-01-15');
  assert.equal(normalizeDate('2026.01.15'), '2026-01-15');
  assert.equal(normalizeDate(''), '');
  assert.equal(normalizeDate(null), '');
});

test('diffDailyVsBill — picks up receipt_no mismatch', () => {
  const daily = { receiptNo: 'R001', tourNo: 'T1', name: 'A', passportNo: 'P1', purchaseDate: '2026-01-15' };
  const bill = { receiptNo: 'R002', tourNo: 'T1', name: 'A', passportNo: 'P1', purchaseDate: '2026-01-15' };
  const diffs = diffDailyVsBill(daily, bill);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, 'receiptNo');
});

test('diffDailyVsBill — date normalization hides formatting', () => {
  const daily = { receiptNo: 'R001', purchaseDate: '2026-01-15' };
  const bill = { receiptNo: 'R001', purchaseDate: '2026/01/15' };
  const diffs = diffDailyVsBill(daily, bill);
  assert.equal(diffs.length, 0);
});

test('diffDailyVsBill — empty values are not a conflict', () => {
  const daily = { receiptNo: 'R001', tourNo: '' };
  const bill = { receiptNo: 'R001', tourNo: 'T1' };
  const diffs = diffDailyVsBill(daily, bill);
  assert.equal(diffs.length, 0);
});

test('planMerge — daily empty → bill wins', () => {
  const plan = planMerge(
    { receiptNo: '' },
    { receiptNo: 'R001' },
    [{ field: 'receiptNo', dailyValue: '', billValue: 'R001' }]
  );
  assert.equal(plan.autoOverwriteFields.length, 1);
  assert.equal(plan.pendingConflicts.length, 0);
});

test('planMerge — both non-empty → pending', () => {
  const plan = planMerge(
    { receiptNo: 'R001' },
    { receiptNo: 'R002' },
    [{ field: 'receiptNo', dailyValue: 'R001', billValue: 'R002' }]
  );
  assert.equal(plan.autoOverwriteFields.length, 0);
  assert.equal(plan.pendingConflicts.length, 1);
});

test('KEY_BUILDERS — P1 builds receipt_no=... key', () => {
  const key = KEY_BUILDERS[1]({ receiptNo: 'R001' });
  assert.equal(key, 'receipt_no=r001');
});

test('matchBillAgainstDaily — P1 matches via receipt_no', () => {
  const bill = { receiptNo: 'R001', purchaseDate: '2026-01-15' };
  const index = {
    findDailyByReceipt: () => [{ id: 1, receiptNo: 'R001' }],
    findDailyByReceiptDate: () => [],
    findDailyByReceiptTour: () => [],
    findDailyByPassportDateShop: () => [],
    findDailyByNameDateShop: () => [],
    findDailyFuzzy: () => [],
  };
  const outcome = matchBillAgainstDaily(bill, index);
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.priority, 1);
});

test('matchBillAgainstDaily — ambiguous when P1 returns multiple', () => {
  const bill = { receiptNo: 'R001', name: 'LI MING' };
  const index = {
    findDailyByReceipt: () => [
      { id: 1, receiptNo: 'R001', name: 'A' },
      { id: 2, receiptNo: 'R001', name: 'B' },
    ],
    findDailyByReceiptDate: () => [],
    findDailyByReceiptTour: () => [],
    findDailyByPassportDateShop: () => [],
    findDailyByNameDateShop: () => [],
    findDailyFuzzy: () => [],
  };
  const outcome = matchBillAgainstDaily(bill, index);
  assert.equal(outcome.status, 'ambiguous');
});

test('matchBillAgainstDaily - collapses same-receipt product rows into one received group', () => {
  const bill = { receiptNo: 'R001', name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-15' };
  const index = {
    findDailyByReceipt: () => [
      { id: 1, receiptNo: 'R001', name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-15', sku: 'A' },
      { id: 2, receiptNo: 'R001', name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-15', sku: 'B' },
    ],
    findDailyByReceiptDate: () => [],
    findDailyByReceiptTour: () => [],
    findDailyByPassportDateShop: () => [],
    findDailyByNameDateShop: () => [],
    findDailyFuzzy: () => [],
  };
  const outcome = matchBillAgainstDaily(bill, index);
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.priority, 1);
  assert.equal(outcome.candidates[0].id, 1);
});

test('matchBillAgainstDaily - collapses same customer/date/shop product rows when bill has no receipt number', () => {
  const bill = { name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-15', shop: 'LOTTE' };
  const index = {
    findDailyByReceipt: () => [],
    findDailyByReceiptDate: () => [],
    findDailyByReceiptTour: () => [],
    findDailyByPassportDateShop: () => [
      { id: 1, receiptNo: 'R001', name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-15', shop: 'LOTTE', sku: 'A' },
      { id: 2, receiptNo: 'R001', name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-15', shop: 'LOTTE', sku: 'B' },
    ],
    findDailyByNameDateShop: () => [],
    findDailyFuzzy: () => [],
  };
  const outcome = matchBillAgainstDaily(bill, index);
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.priority, 4);
});

test('matchBillAgainstDaily — unmatched when index is empty', () => {
  const bill = { receiptNo: 'R999' };
  const index = {
    findDailyByReceipt: () => [],
    findDailyByReceiptDate: () => [],
    findDailyByReceiptTour: () => [],
    findDailyByPassportDateShop: () => [],
    findDailyByNameDateShop: () => [],
    findDailyFuzzy: () => [],
  };
  const outcome = matchBillAgainstDaily(bill, index);
  assert.equal(outcome.status, 'unmatched');
});
