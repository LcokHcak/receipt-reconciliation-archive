'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapReceivedReceiptRow,
  isReceiptWorkerSheet,
  parseWorkerSheetName,
} = require('../lib/monthly_pipeline/receipt_mapper');

const { mapDailyReceiptRow } = require('../lib/monthly_pipeline/daily_receipt_mapper');

test('isReceiptWorkerSheet — accepts 工人 / rejects summary', () => {
  assert.equal(isReceiptWorkerSheet('9号 侯丹妮'), true);
  assert.equal(isReceiptWorkerSheet('18号 刘禹含'), true);
  assert.equal(isReceiptWorkerSheet('19号'), true);
  assert.equal(isReceiptWorkerSheet('收票数统计'), false);
  assert.equal(isReceiptWorkerSheet('团号汇总'), false);
  assert.equal(isReceiptWorkerSheet('工作分配'), false);
  assert.equal(isReceiptWorkerSheet('备份'), false);
  assert.equal(isReceiptWorkerSheet('---'), false);
  assert.equal(isReceiptWorkerSheet(''), false);
  assert.equal(isReceiptWorkerSheet(null), false);
});

test('parseWorkerSheetName — extracts number and name', () => {
  assert.deepEqual(parseWorkerSheetName('9号 侯丹妮'), { workerNo: '9', workerName: '侯丹妮' });
  assert.deepEqual(parseWorkerSheetName('22号-姜明悦'), { workerNo: '22', workerName: '-姜明悦' });
  assert.deepEqual(parseWorkerSheetName('19号'), { workerNo: '19', workerName: null });
  assert.deepEqual(parseWorkerSheetName('收票数统计'), { workerNo: null, workerName: null });
});

test('mapReceivedReceiptRow — maps a standard-header row', () => {
  const row = mapReceivedReceiptRow({
    asObject: {
      '收票日期': '2026-01-15',
      '代理': '梓陌',
      '购买日期': '2026-01-14',
      '小票号': '0326152400282',
      '团号': '71993',
      '姓名': 'WANG LING',
      '护照号': 'EC0943782',
      '出境日期': '2026-01-18',
      '模式': '济州乐天V团',
      '负责人': '沈晓兰',
    },
    workspaceKey: '2026-01',
    sheetName: '9号 侯丹妮',
    sourceFile: '收票汇总.xlsx',
    sourceRow: 5,
    importedAt: '2026-05-11T00:00:00.000Z',
    importJobId: 1,
  });
  assert.ok(row);
  assert.equal(row.receiptNo, '0326152400282');
  assert.equal(row.passportNo, 'EC0943782');
  assert.equal(row.tourNo, '71993');
  assert.equal(row.workerNo, '9');
  assert.equal(row.workerName, '侯丹妮');
  assert.equal(row.agent, '梓陌');
  assert.equal(row.modeRaw, '济州乐天V团');
  assert.ok(row.rowHash);
});

test('mapReceivedReceiptRow — returns null when no identifier', () => {
  const row = mapReceivedReceiptRow({
    asObject: { '收票日期': '2026-01-15', '代理': '梓陌' },
    workspaceKey: '2026-01',
    sheetName: '9号 侯丹妮',
    sourceFile: 'x.xlsx',
    sourceRow: 2,
    importedAt: 't',
  });
  assert.equal(row, null);
});

test('mapDailyReceiptRow — maps all 42 columns into canonical shape', () => {
  const headers = [
    '日期', '出账日期', '付款模式', '返点模式', '免税店', '免税分店',
    '上家', '入店公司', '导游', '代理', '原日期', '购买日期',
    '团号', '姓名', '护照号', '出境日期', '小票号', '原小票号',
    '分类', '品牌', 'SKU', '产品名称', 'REF NO', '数量',
    '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)',
    'DC($)', 'DC(￦)', '折扣率', '商品券金额', '扣点商品券',
    '客人点数', '客人返点金额', '免税店点数', '免税店返点',
    '免税店追加点', '追加金额', '免税店最终返点',
    '分类', '备注',
  ];
  const values = [
    '2026-01-15', '2026-02-01', '现金', '乐天SG', '乐天免税店', '首尔本店',
    '大雄', '某公司', '李导', '梓陌', '2026-01-10', '2026-01-14',
    '71993', 'WANG LING', 'EC0943782', '2026-01-18', '90100926001271', null,
    '化妆品', 'SKII', 'SK001', '神仙水', 'REF-1', 1,
    100.5, 120000, 95, 115000,
    5, 5000, 0.05, 0, 0,
    0.08, 9200, 0.10, 11500,
    0.02, 2300, 0.10, '杂项', '备注',
  ];
  const asObject = {};
  headers.forEach((h, i) => {
    if (h && asObject[h] === undefined) asObject[h] = values[i];
  });
  const row = mapDailyReceiptRow({
    asObject,
    rawValues: values,
    headers,
    workspaceKey: '2026-01',
    sheetName: 'Sheet1',
    sourceFile: '每日收票表.xlsx',
    sourceRow: 2,
    importedAt: 't',
    importJobId: 9,
  });
  assert.ok(row);
  assert.equal(row.receiptNo, '90100926001271');
  assert.equal(row.passportNo, 'EC0943782');
  assert.equal(row.tourNo, '71993');
  assert.equal(row.agent, '梓陌');
  assert.equal(row.upstream, '大雄');
  assert.equal(row.category, '化妆品');
  assert.equal(row.categorySecondary, '杂项');
  assert.equal(row.qty, 1);
  assert.equal(row.grossUsd, 100.5);
  assert.equal(row.customerPoints, 0.08);
  assert.equal(row.storeFinalRebate, 0.10);
  assert.equal(row.remark, '备注');
  assert.equal(row.modeRaw, '乐天SG');
  assert.equal(row.billMatchStatus, 'unmatched');
  assert.equal(row.tourMatchStatus, 'pending');
  assert.ok(row.rowHash);
});

test('mapDailyReceiptRow — returns null when no identifying field', () => {
  const row = mapDailyReceiptRow({
    asObject: { '日期': '2026-01-15', '代理': '梓陌' },
    rawValues: [],
    headers: [],
    workspaceKey: '2026-01',
    sheetName: 'Sheet1',
    sourceFile: 'x.xlsx',
    sourceRow: 3,
    importedAt: 't',
  });
  assert.equal(row, null);
});
