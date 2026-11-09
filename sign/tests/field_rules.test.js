'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REASONS, STORE_FAMILIES,
  normalizeStoreFamily,
  validateChineseName, validateEnglishName, validatePassportNo,
  validateStoreFamily, validateReceiptNo, validateTourNo,
  validatePurchaseDate, validateDepartureDate, validateDateRange,
  validateAll,
} = require('../lib/validation/field_rules');

test('validateChineseName accepts 2-10 CJK, rejects others', () => {
  assert.equal(validateChineseName('张三').ok, true);
  assert.equal(validateChineseName('王小明').ok, true);
  assert.equal(validateChineseName('李').ok, false);
  assert.equal(validateChineseName('').ok, false);
  assert.equal(validateChineseName('LI MING').ok, false);
  assert.equal(validateChineseName('张三1').ok, false);
  assert.equal(validateChineseName('十一字名字就超过限制了哦').ok, false);
  assert.equal(validateChineseName('').reason, REASONS.CHINESE_NAME);
});

test('validateEnglishName accepts A-Z with spaces, case-insensitive', () => {
  assert.equal(validateEnglishName('LI MING').ok, true);
  assert.equal(validateEnglishName('li ming').ok, true);
  assert.equal(validateEnglishName('WANG XIAO MING').ok, true);
  assert.equal(validateEnglishName('').ok, false);
  assert.equal(validateEnglishName('A').ok, false);
  assert.equal(validateEnglishName('WANG123').ok, false);
  assert.equal(validateEnglishName('张 MING').ok, false);
});

test('validatePassportNo: 国际通用 6-12 位字母或数字(兼容外国护照)', () => {
  // 中国护照
  assert.equal(validatePassportNo('E12345678').ok, true);
  assert.equal(validatePassportNo('EA12345678').ok, true);
  assert.equal(validatePassportNo('e12345678').ok, true);
  assert.equal(validatePassportNo('EA1234567').ok, true);
  // 外国护照:阿根廷 3 字母+6 数字 / 多字母前缀 / 纯数字(部分国家)
  assert.equal(validatePassportNo('AAJ554634').ok, true);
  assert.equal(validatePassportNo('EAB12345678').ok, true);
  assert.equal(validatePassportNo('12345678').ok, true);
  // 仍拒:空 / 太短(<6) / 太长(>12) / 含非字母数字
  assert.equal(validatePassportNo('').ok, false);
  assert.equal(validatePassportNo('EA123').ok, false);
  assert.equal(validatePassportNo('ABCDE1234567890').ok, false);
  assert.equal(validatePassportNo('AAJ-55463').ok, false);
});

test('validateStoreFamily normalizes to enum values', () => {
  assert.equal(validateStoreFamily('LOTTE').ok, true);
  assert.equal(validateStoreFamily('LOTTE').canonical, 'LOTTE');
  assert.equal(validateStoreFamily('lotte').canonical, 'LOTTE');
  assert.equal(validateStoreFamily('SHILLA IPARK').canonical, 'SHILLA IPARK');
  assert.equal(validateStoreFamily('shillaipark').canonical, 'SHILLA IPARK');
  assert.equal(validateStoreFamily('THE SHILLA').canonical, 'THE SHILLA');
  assert.equal(validateStoreFamily('UNKNOWN').ok, false);
  assert.equal(validateStoreFamily('').ok, false);
});

test('validateReceiptNo 解禁(RECEIPT_NO_STRICT=false):非空即通过,不限长度/字母;空则 fail', () => {
  assert.equal(validateReceiptNo('LOTTE', '12345678901234').ok, true);
  assert.equal(validateReceiptNo('LOTTE', '1234567890123').ok, true);   // 长度短也放行
  assert.equal(validateReceiptNo('LOTTE', '1234567890ABCD').ok, true);  // 带字母也放行
  assert.equal(validateReceiptNo('THE SHILLA', '05-260626-033-00036').ok, true); // 带横线也放行
  assert.equal(validateReceiptNo('SHILLA IPARK', '12345678901234').ok, true);
  assert.equal(validateReceiptNo('', '12345678901234').ok, true);       // 未知店也放行
  // 空票号仍 fail(缺数据,不属于"长度/字母"限制)
  assert.equal(validateReceiptNo('LOTTE', '').ok, false);
});

test('validateTourNo: LOTTE=8, IPARK=5, THE SHILLA=5', () => {
  assert.equal(validateTourNo('LOTTE', '12345678').ok, true);
  assert.equal(validateTourNo('LOTTE', '1234567').ok, false);
  assert.equal(validateTourNo('SHILLA IPARK', '12345').ok, true);
  assert.equal(validateTourNo('SHILLA IPARK', '123456').ok, false);
  assert.equal(validateTourNo('THE SHILLA', '12345').ok, true);
  assert.equal(validateTourNo('LOTTE', '12A45678').ok, false);
});

test('validatePurchaseDate / validateDepartureDate: strict ISO YYYY-MM-DD', () => {
  assert.equal(validatePurchaseDate('2026-05-11').ok, true);
  assert.equal(validatePurchaseDate('2026-2-11').ok, false);
  assert.equal(validatePurchaseDate('2026-05-11T00:00:00Z').ok, false);
  assert.equal(validatePurchaseDate('2026/05/11').ok, false);
  // 假日期要被拒
  assert.equal(validatePurchaseDate('2026-02-31').ok, false);
  assert.equal(validateDepartureDate('').ok, false);
});

test('validateDateRange: purchase ≤ departure', () => {
  assert.equal(validateDateRange('2026-05-01', '2026-05-11').ok, true);
  assert.equal(validateDateRange('2026-05-11', '2026-05-11').ok, true);
  assert.equal(validateDateRange('2026-05-12', '2026-05-11').ok, false);
  // 任一缺失 → skip
  assert.equal(validateDateRange('', '2026-05-11').skipped, true);
  assert.equal(validateDateRange('2026-05-01', '').skipped, true);
  assert.equal(validateDateRange('bad-date', '2026-05-11').skipped, true);
});

test('validateAll: aggregates reasons + returns canonical storeFamily', () => {
  const result = validateAll({
    chineseName: '张三',
    englishName: 'LI MING',
    passportNo: 'EA12345678',
    storeFamily: 'lotte',
    receiptNo: '12345678901234',
    tourNo: '12345678',
    purchaseDate: '2026-05-01',
    departureDate: '2026-05-11',
  });
  assert.deepEqual(result.reasons, []);
  assert.equal(result.storeFamily, 'LOTTE');
});

test('新增店家 SHINSEGAE/HYUNDAI 被识别,票号/团号长度先放宽(不标红)', () => {
  const base = {
    chineseName: '张三', englishName: 'LI MING', passportNo: 'EA12345678',
    purchaseDate: '2026-06-26', departureDate: '2026-07-03',
  };
  for (const [store, canonical] of [
    ['SHINSEGAE DUTY FREE', 'SHINSEGAE'],
    ['新世界', 'SHINSEGAE'],
    ['HYUNDAI', 'HYUNDAI'],
    ['现代免税店', 'HYUNDAI'],
  ]) {
    // 票号带横线/任意长度都不该标红(长度未配 → skip)
    const r = validateAll({ ...base, storeFamily: store, receiptNo: '05-260626-033-00036', tourNo: '79588' });
    assert.equal(r.storeFamily, canonical, `${store} 应归一到 ${canonical}`);
    assert.ok(!r.reasons.includes('field_store_family_invalid'), `${store} store_family 不该标红`);
    assert.ok(!r.reasons.includes('field_receipt_no_invalid'), `${store} 票号应放宽`);
    assert.ok(!r.reasons.includes('field_tour_no_invalid'), `${store} 团号应放宽`);
  }
  // 回归:真·未知店仍标红
  const unk = validateAll({ ...base, storeFamily: 'SOME RANDOM SHOP', receiptNo: '123', tourNo: '1' });
  assert.ok(unk.reasons.includes('field_store_family_invalid'), '未知店仍应标红');
});

test('validateAll: bad storeFamily means receipt_no and tour_no checks skip', () => {
  const result = validateAll({
    storeFamily: 'UNKNOWN',
    receiptNo: '12345678901234',
    tourNo: '12345678',
    chineseName: '张三',
    englishName: 'LI MING',
    passportNo: 'EA12345678',
    purchaseDate: '2026-05-01',
    departureDate: '2026-05-11',
  });
  // 只应该含 store_family，不应额外含 receipt_no / tour_no
  assert.deepEqual(result.reasons, [REASONS.STORE_FAMILY]);
});

test('validateAll: bad date range also flags range + both date fields', () => {
  const result = validateAll({
    chineseName: '张三',
    englishName: 'LI MING',
    passportNo: 'EA12345678',
    storeFamily: 'LOTTE',
    receiptNo: '12345678901234',
    tourNo: '12345678',
    purchaseDate: '2026-05-15',
    departureDate: '2026-05-01',
  });
  assert.ok(result.reasons.includes(REASONS.DATE_RANGE));
});

test('normalizeStoreFamily handles edge whitespace', () => {
  assert.equal(normalizeStoreFamily(' LOTTE '), STORE_FAMILIES.LOTTE);
  assert.equal(normalizeStoreFamily('shilla  ipark'), STORE_FAMILIES.SHILLA_IPARK);
  assert.equal(normalizeStoreFamily(''), '');
});
