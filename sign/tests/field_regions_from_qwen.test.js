'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildFieldModelMeta, toNormalizedBox, toCropRelative, plausibleFieldBox,
} = require('../lib/qwen_ocr/field_regions_from_qwen');
const { buildTaskFieldRegions } = require('../lib/review_field_regions');

test('⭐整图坐标要换算成切片内坐标 —— 不换算会静默画到左上角', () => {
  // qwen 说票号在整图的 (0.70~0.85, 0.30~0.34);这张切片是整图右半 (0.6~1.0, 0.2~0.8)
  // 换算后应落在切片的 (0.25~0.625, 0.167~0.233)
  const rel = toCropRelative([0.70, 0.30, 0.85, 0.34], [0.6, 0.2, 1.0, 0.8]);
  assert.ok(Math.abs(rel[0] - 0.25) < 1e-9, `left 应为 0.25,实为 ${rel[0]}`);
  assert.ok(Math.abs(rel[2] - 0.625) < 1e-9);
  assert.ok(Math.abs(rel[1] - (0.1 / 0.6)) < 1e-9);
});

test('⭐字段完全落在切片外 → 丢弃(那是隔壁票的字段)', () => {
  // 多票同图时模型可能把隔壁票的字段也报进来
  assert.equal(toCropRelative([0.05, 0.3, 0.2, 0.34], [0.6, 0.2, 1.0, 0.8]), null);
});

test('部分越界 → 钳到切片边界,不丢', () => {
  const rel = toCropRelative([0.55, 0.3, 0.7, 0.34], [0.6, 0.2, 1.0, 0.8]);
  assert.equal(rel[0], 0, '左边越界钳到 0');
  assert.ok(rel[2] > 0);
});

test('没裁过的图(整图直通)原样返回', () => {
  const box = [0.1, 0.2, 0.3, 0.4];
  assert.deepEqual(toCropRelative(box, null), box);
});

test('坐标容错:0~1000 或 0~100 的写法折回 0~1;倒序归位', () => {
  assert.deepEqual(toNormalizedBox([100, 200, 300, 400]), [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(toNormalizedBox([10, 20, 30, 40]), [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(toNormalizedBox([0.3, 0.4, 0.1, 0.2]), [0.1, 0.2, 0.3, 0.4], '倒序也要能用');
  assert.equal(toNormalizedBox([0.1, 0.2, 0.1, 0.4]), null, '零宽丢弃');
  assert.equal(toNormalizedBox('x'), null);
});

test('⭐面积闸:点大小的框和占大半张票的框都不画', () => {
  assert.equal(plausibleFieldBox([0, 0, 0.005, 0.005]), false, '太小 = 没定位到');
  assert.equal(plausibleFieldBox([0, 0, 0.9, 0.9]), false, '太大 = 等于没框');
  assert.equal(plausibleFieldBox([0.2, 0.3, 0.6, 0.34]), true);
});

test('⭐产出的形状要能被审核台现成的读取器直接吃下', () => {
  // 判据:新数据必须能被**已有的** buildTaskFieldRegions 读出来,
  // 否则就是又造了一套没人用的结构(字段框死掉正是因为两边形状对不上)。
  const meta = buildFieldModelMeta({
    docType: 'receipt',
    cropBox: [0.6, 0.2, 1.0, 0.8],
    fields: { receiptNo: '1042-4829', purchaseDate: '2026-07-25' },
    fieldBoxes: {
      receiptNo: [0.70, 0.30, 0.85, 0.34],
      purchaseDate: [0.70, 0.40, 0.88, 0.44],
      groupNo: [0.05, 0.30, 0.20, 0.34], // 隔壁票的,应被丢弃
    },
  });
  assert.equal(meta.source, 'qwen');
  const regions = buildTaskFieldRegions({ docTypeFinal: 'receipt', receiptFieldModelMeta: meta });
  const keys = regions.map((r) => r.key);
  assert.ok(keys.includes('receiptNoFinal'), '票号框要能读出来');
  assert.ok(keys.includes('purchaseDateFinal'));
  assert.ok(!keys.includes('groupNoFinal'), '切片外的字段不能出现');
  const receiptNo = regions.find((r) => r.key === 'receiptNoFinal');
  assert.equal(receiptNo.value, '1042-4829', '值要跟着框一起给,悬停才有内容');
  assert.ok(receiptNo.box.width > 0 && receiptNo.box.width <= 1, '归一化宽度');
});

test('护照走另一套字段名', () => {
  const meta = buildFieldModelMeta({
    docType: 'passport',
    fields: { passportNo: 'EK7086592' },
    fieldBoxes: { passportNo: [0.1, 0.7, 0.5, 0.76], englishName: [0.1, 0.5, 0.6, 0.56] },
  });
  const regions = buildTaskFieldRegions({ docTypeFinal: 'passport', passportFieldModelMeta: meta });
  assert.deepEqual(regions.map((r) => r.key).sort(), ['extractedNameFinal', 'passportNoFinal']);
});

test('一个可用框都没有 → 返回 null,不产生空壳 meta', () => {
  assert.equal(buildFieldModelMeta({ fieldBoxes: {} }), null);
  assert.equal(buildFieldModelMeta({ fieldBoxes: null }), null);
  assert.equal(buildFieldModelMeta({ fieldBoxes: { receiptNo: [0, 0, 0.002, 0.002] } }), null, '全被面积闸拦掉也算没有');
});

// ── 金标实拍验证后加的闸(2026-07-29)──────────────────────────────
// 拿 dept_gold_stage 真图跑了真实 qwen 调用,把框画回图上逐张看:
//   免税店单张票(整图 1 个文档)→ receiptNo/purchaseDate/englishName/departureDate
//                                精确落在值所在的行,**可用**
//   百货多单据合影(3~5 个文档)→ 短字段乱铺:passportNo 画到签证页中间、
//                                MRZ 框画到护照外面、Global Blue 单上六个框沿左边缘
//                                等距竖排(是在铺,不是在定位),**不可用**
// 0730 拍板:百货不需要字段框 → 直接按店家族把闸(免税店/护照照给)。画错位置比不画更坏。

test('⭐接线契约:百货不采纳字段框(用户拍板 + 实拍最差场景)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../lib/qwen_ocr/qwen_ocr_adapter.js'), 'utf8');
  // 判据 10:断言里带半角括号一律用 includes,别用正则 —— ( ) 会被当捕获组,静默不匹配
  assert.ok(src.includes('const deptFamily = base.docTypeFinal === DOC_TYPES.RECEIPT'), '闸要在');
  assert.ok(src.includes('getStoreProfile(base.receiptStoreAuto).family === FAMILY.DEPT'), '按店家族判,不靠猜');
  assert.ok(src.includes('const fieldMeta = deptFamily ? null : buildFieldModelMeta('), '百货直接不算');
});
