'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseCellDate,
  fallbackYearFromWorkspace,
  isWithinWindow,
} = require('../lib/monthly_pipeline/date_parsers');

test('parseCellDate handles ISO strings', () => {
  assert.equal(parseCellDate('2026-01-15'), '2026-01-15');
  assert.equal(parseCellDate('2026-1-5'), '2026-01-05');
});

test('parseCellDate handles Date instances', () => {
  const d = new Date(Date.UTC(2026, 0, 31));
  assert.equal(parseCellDate(d), '2026-01-31');
});

test('parseCellDate handles Excel serial numbers', () => {
  // 46125 = 2026-04-13 in Excel's 1900 date system (observed in 团号汇总 samples)
  assert.equal(parseCellDate(46125), '2026-04-13');
});

test('parseCellDate handles slash dates with fallback year', () => {
  assert.equal(parseCellDate('4/29', { fallbackYear: 2026 }), '2026-04-29');
  assert.equal(parseCellDate('4/29~', { fallbackYear: 2026 }), '2026-04-29');
  assert.equal(parseCellDate('4/10~4/30', { fallbackYear: 2026 }), '2026-04-10');
});

test('parseCellDate handles Chinese dates and dots', () => {
  assert.equal(parseCellDate('2026年1月5日'), '2026-01-05');
  assert.equal(parseCellDate('2026.01.05'), '2026-01-05');
  assert.equal(parseCellDate('20260105'), '2026-01-05');
});

test('parseCellDate returns null for garbage', () => {
  assert.equal(parseCellDate(''), null);
  assert.equal(parseCellDate(null), null);
  assert.equal(parseCellDate('通知不能用时'), null);
  assert.equal(parseCellDate('2024-02-02 ~通知不能用时'), '2024-02-02');
});

test('fallbackYearFromWorkspace parses YYYY-MM', () => {
  assert.equal(fallbackYearFromWorkspace('2026-01'), 2026);
  assert.equal(fallbackYearFromWorkspace('2026-1'), 2026);
  assert.equal(fallbackYearFromWorkspace(''), null);
  assert.equal(fallbackYearFromWorkspace('2026'), null);
});

test('isWithinWindow handles open-ended windows', () => {
  assert.equal(isWithinWindow('2026-04-20', '2026-04-10', '2026-04-30'), true);
  assert.equal(isWithinWindow('2026-05-01', '2026-04-10', '2026-04-30'), false);
  assert.equal(isWithinWindow('2026-04-09', '2026-04-10', '2026-04-30'), false);
  assert.equal(isWithinWindow('2026-04-20', null, '2026-04-30'), true);
  assert.equal(isWithinWindow('2026-04-20', '2026-04-10', null), true);
  assert.equal(isWithinWindow(null, '2026-04-10', '2026-04-30'), true);
});
