'use strict';

// 百货两段式补救(2026-07-12 金标重放立项)单测:
// 信号检测的精确度(免税店一段输出零误触发)与召回(金标漏检形态全命中)、
// 补救结果收口(店名归一不到 *_DEPT 就不采纳)、文档合并策略(护照保留/小票并一)。

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectDeptRescueSignals, parseDeptRescue, applyDeptRescue } = require('../lib/qwen_ocr/dept_rescue');

const doc = (type, fields = {}, extra = {}) => ({ type, bbox: [0, 0, 1, 1], confidence: 0.9, fields, ...extra });

// ── 信号召回:金标重放实测的 9 种漏检形态,信号层必须全部接住 ──
test('信号:Global Blue 单被当独立小票 → global_blue_doc', () => {
  const r = detectDeptRescueSignals([
    doc('receipt', { storeFamily: 'THE SHILLA', receiptNo: '' }),
    doc('receipt', { storeFamily: 'GLOBAL BLUE', receiptNo: '' }),
  ]);
  assert.ok(r.hit);
  assert.ok(r.signals.includes('global_blue_doc'));
});

test('信号:品牌当店名(实测 LOUIS VUITTON 原样出现)→ brand_as_store', () => {
  const r = detectDeptRescueSignals([doc('receipt', { storeFamily: 'LOUIS VUITTON', receiptNo: '' })]);
  assert.ok(r.hit);
  assert.ok(r.signals.includes('brand_as_store'));
});

test('信号:거래번호 4位-4位 形态 → trans_no_shape', () => {
  const r = detectDeptRescueSignals([doc('receipt', { storeFamily: 'SHINSEGAE', receiptNo: '2921-7193' })]);
  assert.ok(r.hit);
  assert.ok(r.signals.includes('trans_no_shape'));
});

test('信号:底部条码整串被当票号(≥20位)→ barcode_length_no', () => {
  const r = detectDeptRescueSignals([
    doc('receipt', { storeFamily: 'LOTTE', receiptNo: '0394202607109584002502910000' }),
  ]);
  assert.ok(r.hit);
  assert.ok(r.signals.includes('barcode_length_no'));
});

test('信号:护照+小票同框(百货拍法)→ passport_receipt_combined', () => {
  const r = detectDeptRescueSignals([
    doc('passport', { passportNo: 'EG0435161' }),
    doc('receipt', { storeFamily: 'SHINSEGAE', receiptNo: '' }),
  ]);
  assert.ok(r.hit);
  assert.ok(r.signals.includes('passport_receipt_combined'));
});

test('信号:一段已判百货 → dept_store_direct(第二段做字段升级)', () => {
  const r = detectDeptRescueSignals([doc('receipt', { storeFamily: '乐天百货', receiptNo: '' })]);
  assert.ok(r.hit);
  assert.ok(r.signals.includes('dept_store_direct'));
});

// ── 信号精确度:免税店常规一段输出绝不触发(46 张反例实测口径)──
test('信号:免税店纯小票(无同框护照/常规票号)不触发', () => {
  for (const [store, no] of [
    ['THE SHILLA', '2100109466359'],
    ['LOTTE', '26051910108001'],
    ['SHINSEGAE', '02-260619-045-00921'],
    ['SHILLA IPARK', '1250619016493'],
    ['HYUNDAI', '12-345678-901-23456'],
  ]) {
    const r = detectDeptRescueSignals([
      doc('receipt', { storeFamily: store, receiptNo: no }),
      doc('receipt', { storeFamily: store, receiptNo: no }),
    ]);
    assert.equal(r.hit, false, `${store} 误触发: ${r.signals.join(',')}`);
  }
});

test('信号:纯护照页(无小票)不触发', () => {
  const r = detectDeptRescueSignals([doc('passport', { passportNo: 'EA1234567' })]);
  assert.equal(r.hit, false);
});

test('信号:空文档/other 不触发也不炸', () => {
  assert.equal(detectDeptRescueSignals([]).hit, false);
  assert.equal(detectDeptRescueSignals([doc('other', {})]).hit, false);
  assert.equal(detectDeptRescueSignals([null, undefined]).hit, false);
});

// ── 第二段结果收口 ──
test('parse:店名归一不到 *_DEPT 就不采纳(防强答)', () => {
  assert.equal(parseDeptRescue({ isDept: true, store: 'LOTTE' }).isDept, false, '免税店名强答成百货必须拒');
  assert.equal(parseDeptRescue({ isDept: true, store: '' }).isDept, false);
  assert.equal(parseDeptRescue({ isDept: false, store: '乐天百货' }).isDept, false);
  assert.equal(parseDeptRescue({}).isDept, false);
  assert.equal(parseDeptRescue(null).isDept, false);
});

test('parse:合法百货结果全字段收口', () => {
  const r = parseDeptRescue({
    isDept: true, store: '乐天百货', receiptNo: ' 9584-0025 ', amount: '2910000',
    purchaseDate: '2026-07-10', branch: '0394', brand: '루이비통',
    englishName: 'LIU HAO', passportNo: 'ER9696265', confidence: 0.93,
  });
  assert.equal(r.isDept, true);
  assert.equal(r.store, '乐天百货');
  assert.equal(r.receiptNo, '9584-0025');
  assert.equal(r.branch, '0394');
  assert.equal(r.confidence, 0.93);
});

test('parse:新世界/现代百货店名也认', () => {
  assert.equal(parseDeptRescue({ isDept: true, store: '新世界百货' }).isDept, true);
  assert.equal(parseDeptRescue({ isDept: true, store: '现代百货' }).isDept, true);
});

// ── 合并策略 ──
test('apply:护照保留、GB单/品牌碎片小票全并成 1 个百货文档', () => {
  const pass1 = [
    doc('passport', { passportNo: 'ER9696265', englishName: 'LIU HAO' }),
    doc('receipt', { storeFamily: 'THE SHILLA', receiptNo: 'N260423129829' }),
    doc('receipt', { storeFamily: 'GLOBAL BLUE', receiptNo: '' }),
  ];
  const rescue = parseDeptRescue({
    isDept: true, store: '乐天百货', receiptNo: '9584-0025', amount: '2910000',
    purchaseDate: '2026-07-10', branch: '0394', brand: '루이비통', confidence: 0.9,
  });
  const merged = applyDeptRescue(pass1, rescue);
  assert.equal(merged.length, 2, '护照1 + 百货小票1');
  assert.equal(merged[0].type, 'passport');
  const receipt = merged[1];
  assert.equal(receipt.type, 'receipt');
  assert.equal(receipt.fields.storeFamily, '乐天百货');
  assert.equal(receipt.fields.receiptNo, '9584-0025');
  assert.equal(receipt.fields.branch, '0394');
  assert.equal(receipt.fields.groupNo, '', '百货无团号恒空');
});

test('apply:补救字段留空时回填一段百货文档同名字段', () => {
  const pass1 = [doc('receipt', { storeFamily: '乐天百货', receiptNo: '9564-0021', amount: '610000', brand: '루이비통', branch: '' })];
  const rescue = parseDeptRescue({ isDept: true, store: '乐天百货', receiptNo: '', amount: '', branch: '0394', brand: '' });
  const [receipt] = applyDeptRescue(pass1, rescue);
  assert.equal(receipt.fields.receiptNo, '9564-0021', '一段已有值不丢');
  assert.equal(receipt.fields.amount, '610000');
  assert.equal(receipt.fields.brand, '루이비통');
  assert.equal(receipt.fields.branch, '0394', '补救新值生效');
});

test('apply:isDept=false 原样返回不动', () => {
  const pass1 = [doc('receipt', { storeFamily: 'THE SHILLA', receiptNo: '123' })];
  assert.equal(applyDeptRescue(pass1, parseDeptRescue({ isDept: false })), pass1);
});

// ── 条码日期锚推导(乐天=店码4+YYYYMMDD+交易号8+金额8;新世界=YYMMDD+交易号8+金额8)──
const { deriveDeptReceiptFields } = require('../lib/qwen_ocr/dept_rescue');

test('derive:乐天完整条码 → 店码/交易号/金额全出', () => {
  const r = deriveDeptReceiptFields({ barcodeDigits: '0394202607109584002502910000', purchaseDate: '2026-07-10' });
  assert.deepEqual(r, { branch: '0394', receiptNo: '95840025', amount: '2910000' });
});

test('derive:锚前误读裁短 → 店码放弃,交易号/金额不受传染(锚的核心价值)', () => {
  // 二轮实测病例:模型把开头 0394 误读丢位 → 034…,日期锚后的字段依然可靠
  const r = deriveDeptReceiptFields({ barcodeDigits: '034202607109584002502910000', purchaseDate: '2026-07-10' });
  assert.equal(r.branch, '', '锚前不足4位绝不硬凑');
  assert.equal(r.receiptNo, '95840025');
  assert.equal(r.amount, '2910000');
});

test('derive:新世界 YYMMDD 锚 → 无店码,交易号/金额出', () => {
  const r = deriveDeptReceiptFields({ barcodeDigits: '2607092921719303800000', purchaseDate: '2026-07-09' });
  assert.equal(r.branch, '', 'YYMMDD 锚不取店码(新世界条码无店码段)');
  assert.equal(r.receiptNo, '29217193');
  assert.equal(r.amount, '3800000');
});

test('derive:金额段前导零剥掉', () => {
  const r = deriveDeptReceiptFields({ barcodeDigits: '0001202607031001007600940000', purchaseDate: '2026-07-03' });
  assert.equal(r.branch, '0001');
  assert.equal(r.receiptNo, '10010076');
  assert.equal(r.amount, '940000');
});

test('derive:条码尾部被裁(金额不足8位)→ 金额放弃,交易号仍出', () => {
  const r = deriveDeptReceiptFields({ barcodeDigits: '039420260710958400250291', purchaseDate: '2026-07-10' });
  assert.equal(r.receiptNo, '95840025');
  assert.equal(r.amount, '', '金额段不完整绝不猜');
});

test('derive:日期锚找不到/入参缺失 → 全空不猜', () => {
  assert.deepEqual(deriveDeptReceiptFields({ barcodeDigits: '0394209912319584002502910000', purchaseDate: '2026-07-10' }), { branch: '', receiptNo: '', amount: '' });
  assert.deepEqual(deriveDeptReceiptFields({ barcodeDigits: '', purchaseDate: '2026-07-10' }), { branch: '', receiptNo: '', amount: '' });
  assert.deepEqual(deriveDeptReceiptFields({ barcodeDigits: '0394202607109584002502910000', purchaseDate: '' }), { branch: '', receiptNo: '', amount: '' });
  assert.deepEqual(deriveDeptReceiptFields({}), { branch: '', receiptNo: '', amount: '' });
});

test('derive:日期锚重复出现(短锚撞进金额段)→ 消歧失败全空,绝不猜', () => {
  // 260709 出现两次:开头(真锚)+ 尾部金额段凑巧
  const r = deriveDeptReceiptFields({ barcodeDigits: '2607092921719300260709', purchaseDate: '2026-07-09' });
  assert.deepEqual(r, { branch: '', receiptNo: '', amount: '' });
});
