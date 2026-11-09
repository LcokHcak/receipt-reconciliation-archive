const test = require('node:test');
const assert = require('node:assert/strict');

const { extractReceiptFieldsFromOcr } = require('../lib/paddle_receipt_parser');

function line(text) {
  return { text, box: { top: 10, left: 10 } };
}

test('extractReceiptFieldsFromOcr extracts store passport amount receipt and flight info', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('THE SHILLA DUTY FREE'),
      line('SHOPPING CARD'),
      line('NO.03-256-553-0013-8'),
      line('SALEDATE:2025-12-06 13:23'),
      line('Name: AN YUMENG'),
      line('Passport No.: EQ9196495'),
      line('FightNo:9C7206'),
      line('TOTAL $ 3,069.00'),
    ],
    joinedText: `
      THE SHILLA DUTY FREE
      SHOPPING CARD
      NO.03-256-553-0013-8
      SALEDATE:2025-12-06 13:23
      Name: AN YUMENG
      Passport No.: EQ9196495
      FightNo:9C7206
      TOTAL $ 3,069.00
    `,
  });

  assert.equal(result.storeName, 'THE SHILLA');
  assert.equal(result.receiptNo, '03-256-553-0013-8');
  assert.equal(result.saleDate, '2025-12-06 13:23');
  assert.equal(result.englishName, 'AN YUMENG');
  assert.equal(result.passportNo, 'EQ9196495');
  assert.equal(result.flightNo, '9C7206');
  assert.equal(result.amount, '3069');
});

test('extractReceiptFieldsFromOcr extracts lotte receipt group and departure fields', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('LOTTE'),
      line('901823-25-003077'),
      line('SaleDT:'),
      line('2025-12-2318:44'),
      line('GROUP'),
      line('25184998'),
      line('Date of Departure'),
      line('2025-12-26锛堥噾锛?4:50'),
    ],
    joinedText: `
      LOTTE
      901823-25-003077
      SaleDT:
      2025-12-2318:44
      GROUP
      25184998
      Date of Departure
      2025-12-26锛堥噾锛?4:50
    `,
  });

  assert.equal(result.storeName, 'LOTTE');
  assert.equal(result.receiptNo, '901823-25-003077');
  assert.equal(result.saleDate, '2025-12-23 18:44');
  assert.equal(result.groupNo, '25184998');
  assert.equal(result.departureDate, '2025-12-26');
});

test('extractReceiptFieldsFromOcr extracts shilla receipt fields from glued date lines', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('THE SHILLA'),
      line('0325652400439'),
      line('G:'),
      line('71992'),
      line('SALE DATE:'),
      line('2025-12-0217:20'),
      line('Date of Departure:'),
      line('2025/12/03锛堬級08锛?0'),
    ],
    joinedText: `
      THE SHILLA
      0325652400439
      G:
      71992
      SALE DATE:
      2025-12-0217:20
      Date of Departure:
      2025/12/03锛堬級08锛?0
    `,
  });

  assert.equal(result.storeName, 'THE SHILLA');
  assert.equal(result.receiptNo, '0325652400439');
  assert.equal(result.groupNo, '71992');
  assert.equal(result.saleDate, '2025-12-02 17:20');
  assert.equal(result.departureDate, '2025-12-03');
});

test('extractReceiptFieldsFromOcr normalizes shilla ipark receipts and keeps target fields', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('SHILLA IPARK'),
      line('2125632000315'),
      line('SALE DATE'),
      line('2025-12-0711:53'),
      line('G'),
      line('61166'),
      line('Date of Departure'),
      line('2025/12/10閿涘本OWED閿?6:15'),
    ],
    joinedText: `
      SHILLA IPARK
      2125632000315
      SALE DATE
      2025-12-0711:53
      G
      61166
      Date of Departure
      2025/12/10閿涘本OWED閿?6:15
    `,
  });

  assert.equal(result.storeName, 'SHILLA IPARK');
  assert.equal(result.receiptNo, '2125632000315');
  assert.equal(result.groupNo, '61166');
  assert.equal(result.saleDate, '2025-12-07 11:53');
  assert.equal(result.departureDate, '2025-12-10');
});

test('extractReceiptFieldsFromOcr extracts compact second-pass sale dates with two-digit year', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('LOTTE'),
      line('22125603202085'),
      line('SALEDATELLA25-12-1212:12'),
    ],
    joinedText: `
      LOTTE
      22125603202085
      SALEDATELLA25-12-1212:12
    `,
  });

  assert.equal(result.receiptNo, '22125603202085');
  assert.equal(result.saleDate, '2025-12-12 12:12');
});

test('extractReceiptFieldsFromOcr does not invent dates from unlabeled sparse second-pass OCR', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('THE SHILLA'),
      line('101256621101'),
    ],
    joinedText: `
      THE SHILLA
      101256621101
    `,
  });

  assert.equal(result.saleDate, '');
  assert.equal(result.departureDate, '');
});

test('extractReceiptFieldsFromOcr ignores unlabeled date-like sparse OCR lines', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('THESLLLLA'),
      line('101256621101'),
      line('2085-12-0172'),
    ],
    joinedText: `
      THESLLLLA
      101256621101
      2085-12-0172
    `,
  });

  assert.equal(result.storeName, 'THE SHILLA');
  assert.equal(result.saleDate, '');
  assert.equal(result.departureDate, '');
});

test('extractReceiptFieldsFromOcr keeps group number numeric-only', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('G:'),
      line('XUYI'),
    ],
    joinedText: `
      G:
      XUYI
    `,
  });

  assert.equal(result.groupNo, '');
});

test('extractReceiptFieldsFromOcr does not treat departure year as group number', () => {
  const result = extractReceiptFieldsFromOcr({
    lines: [
      line('G:'),
      line('2025-12-0217:20'),
    ],
    joinedText: `
      G:
      2025-12-0217:20
    `,
  });

  assert.equal(result.groupNo, '');
});
