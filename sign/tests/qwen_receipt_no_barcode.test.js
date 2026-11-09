'use strict';

// 票号条码本地解码(三批"不翻倍"层):写码→解码回环 + 候选筛选 + 适配器零 API 采纳。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { decodeReceiptNoBarcodes, pickBarcodeReceiptNo } = require('../lib/qwen_ocr/receipt_no_barcode');
const { createQwenOcrBackend } = require('../lib/qwen_ocr/qwen_ocr_adapter');

// 生成一张含真 Code39 的票样图(白底 + 条码,模拟票面上部)
async function makeBarcodePng(payload, name) {
  const { writeBarcode } = require('zxing-wasm/writer');
  const { svg } = await writeBarcode(payload, { format: 'Code39', width: 900, height: 140 });
  const barcode = await sharp(Buffer.from(svg)).png().toBuffer();
  const p = path.join(os.tmpdir(), `${name}_${Date.now()}.png`);
  await sharp({ create: { width: 1100, height: 500, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: barcode, top: 60, left: 100 }])
    .png().toFile(p);
  return p;
}

test('barcode: 写码→解码回环(Code39,含2x放大兜底)', async () => {
  const p = await makeBarcodePng('0126300701581', 'bc_roundtrip');
  try {
    const hits = await decodeReceiptNoBarcodes(p);
    assert.ok(hits.length >= 1, '生成的条码必须能解回来');
    assert.ok(hits.some((h) => h.text.replace(/[^0-9]/g, '') === '0126300701581'));
  } finally {
    fs.unlinkSync(p);
  }
});

test('barcode: pick 只认过店锚点的载荷;多候选歧义放弃;与一遍一致优先', () => {
  const ctx = { storeFamily: 'THE SHILLA', purchaseDate: '2026-06-30' };
  // 合格载荷(13位/01前缀/年份段26)
  let r = pickBarcodeReceiptNo({ ...ctx, hits: [{ fmt: 'Code39', text: '0126300701581' }], firstPass: '' });
  assert.equal(r.value, '0126300701581');
  assert.equal(r.agreesWithFirstPass, false);
  // 不过锚点的载荷(乱串/授权号形态)→ null
  r = pickBarcodeReceiptNo({ ...ctx, hits: [{ fmt: 'Code128', text: '4200003149202606285860' }], firstPass: '' });
  assert.equal(r, null);
  // 两个合格候选、都与一遍不一致(同框两票)→ 分不清,放弃
  r = pickBarcodeReceiptNo({ ...ctx, hits: [
    { fmt: 'Code39', text: '0126300701581' }, { fmt: 'Code39', text: '0326347101427' },
  ], firstPass: '' });
  assert.equal(r, null);
  // 与一遍一致的候选优先(互证)
  r = pickBarcodeReceiptNo({ ...ctx, hits: [
    { fmt: 'Code39', text: '0126300701581' }, { fmt: 'Code39', text: '0326347101427' },
  ], firstPass: '03-263-471-0142-7' });
  assert.equal(r.value, '0326347101427');
  assert.equal(r.agreesWithFirstPass, true);
});

test('barcode 跨票污染防护(深度审计HIGH):同图多票时孤条码不与本票一遍一致→放弃,绝不采别票号', () => {
  const ctx = { storeFamily: 'THE SHILLA', purchaseDate: '2026-06-30' };
  const loneBarcode = [{ fmt: 'Code39', text: '0126300701581' }]; // 只解出#1的条码
  // 单票图(receiptCount=1):孤条码必然是本票的 → 采(默认行为不变)
  let r = pickBarcodeReceiptNo({ ...ctx, hits: loneBarcode, firstPass: '', receiptCount: 1 });
  assert.equal(r.value, '0126300701581');
  assert.equal(r.agreesWithFirstPass, false);
  // 同图两票(receiptCount=2)、本票一遍读的是别的号(#2=B)、只解出#1条码(A)→
  // A 不与 B 一致且无法归属 → 放弃,不把#2 覆盖成#1的号(否则把对的读错)
  r = pickBarcodeReceiptNo({ ...ctx, hits: loneBarcode, firstPass: '03-263-471-0142-7', receiptCount: 2 });
  assert.equal(r, null, '同图多票孤条码不归属本票→放弃');
  // 同图两票但条码确与本票一遍一致 → 仍采(互证,是本票的)
  r = pickBarcodeReceiptNo({ ...ctx, hits: loneBarcode, firstPass: '01-263-007-0158-1', receiptCount: 2 });
  assert.equal(r.value, '0126300701581');
  assert.equal(r.agreesWithFirstPass, true);
});

test('adapter: 弱值命中条码 → 零 API 二遍,采条码值+红标,锚点旗撤除', async () => {
  const tmp = await makeBarcodePng('0126300701581', 'bc_adopt');
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return { ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ documents: [
        { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
          storeFamily: 'THE SHILLA', receiptNo: '9126300701581', groupNo: 'G : 52863',
          purchaseDate: '2026-06-30', departureDate: '2026-07-02',
        } },
      ] }) } }],
      usage: { prompt_tokens: 500, completion_tokens: 50 },
    }) };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(call, 1, '条码定夺后绝不追加 API 二遍');
    assert.equal(a.receiptNoAuto, '0126300701581', '91 前缀误读被条码值纠正');
    assert.ok(a.reviewReasons.includes('receipt_no_barcode_adopted'));
    assert.ok(!a.reviewReasons.includes('qwen_receipt_no_shape_suspect'), '锚点旗被条码定夺撤除');
    assert.equal(a.modelMeta.receiptNoBarcode.agreed, false);
    assert.equal(a.needsReview, true);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('adapter: 图上无条码 → 照旧走 API 二遍(条码是白捡不是闸门)', async () => {
  const tmp = path.join(os.tmpdir(), `bc_none_${Date.now()}.png`);
  await sharp({ create: { width: 60, height: 120, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(tmp);
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ documents: [
        { type: 'receipt', confidence: 0.92, bbox: [0, 0, 1, 1], fields: {
          storeFamily: 'LOTTE', receiptNo: '906138-26-002197', groupNo: '',
          purchaseDate: '2026-07-08', departureDate: '2026-07-09',
        } },
      ] }) } }],
      usage: { prompt_tokens: 500, completion_tokens: 50 },
    }) };
    return { ok: true, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ receiptNo: '90G138-26-002197', confidence: 0.95 }) } }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }) };
  };
  const backend = createQwenOcrBackend({ apiKey: 'x', baseUrl: 'http://x', model: 'qwen-vl-max', fetchImpl });
  try {
    const [a] = await backend.extractAnalyses(tmp);
    assert.equal(call, 2, '无条码回退 API 二遍');
    assert.equal(a.receiptNoAuto, '90G138-26-002197');
    assert.ok(a.reviewReasons.includes('receipt_no_second_pass_fixed'));
  } finally {
    fs.unlinkSync(tmp);
  }
});
