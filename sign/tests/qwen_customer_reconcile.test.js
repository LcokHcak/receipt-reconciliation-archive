'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeSidecar, readSidecar } = require('../lib/qwen_ocr/sidecar');
const { reconcileCustomerPassport } = require('../lib/qwen_ocr/customer_reconcile');

function sc(over) {
  return {
    docTypeFinal: 'passport', passportNoAuto: '', reviewReasons: [], needsReview: false,
    classificationSource: 'qwen', modelMeta: { backend: 'qwen' }, ...over,
  };
}
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon_'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('reconcile: MRZ 锚点 → 修复同客户其它图被截断的护照号', () => {
  withDir((dir) => {
    writeSidecar(path.join(dir, 'p.jpg'), sc({ docTypeFinal: 'passport', passportNoAuto: 'EQ9404549', modelMeta: { backend: 'qwen', mrzValid: true } }));
    writeSidecar(path.join(dir, 'r.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EQ94', reviewReasons: ['field_passport_no_invalid'], needsReview: true, modelMeta: { backend: 'qwen', mrzValid: false } }));
    const res = reconcileCustomerPassport(dir);
    assert.equal(res.updated, 1);
    assert.equal(res.source, 'mrz-valid');
    assert.equal(readSidecar(path.join(dir, 'r.jpg')).passportNoAuto, 'EQ9404549'); // 小票被修
    assert.equal(readSidecar(path.join(dir, 'p.jpg')).passportNoAuto, 'EQ9404549'); // 护照(MRZ验证过)不动
  });
});

test('reconcile: 无 MRZ 锚点且分歧 → 不猜、不回写(留人工)', () => {
  withDir((dir) => {
    writeSidecar(path.join(dir, 'p.jpg'), sc({ passportNoAuto: 'E09404549', reviewReasons: ['passport_no_unverified'], needsReview: true, modelMeta: { backend: 'qwen', mrzValid: false } }));
    writeSidecar(path.join(dir, 'r.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EQ9404549', modelMeta: { backend: 'qwen', mrzValid: false } }));
    const res = reconcileCustomerPassport(dir);
    assert.equal(res.updated, 0);
    assert.equal(readSidecar(path.join(dir, 'p.jpg')).passportNoAuto, 'E09404549'); // 保留原样,留人工定
  });
});

test('reconcile: 多数票(≥2 一致)→ 修复落单的未验证项', () => {
  withDir((dir) => {
    writeSidecar(path.join(dir, 'p.jpg'), sc({ passportNoAuto: 'EQ9404549', modelMeta: { backend: 'qwen', mrzValid: false } }));
    writeSidecar(path.join(dir, 'r1.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EQ9404549', modelMeta: { backend: 'qwen', mrzValid: false } }));
    writeSidecar(path.join(dir, 'r2.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EQ94', modelMeta: { backend: 'qwen', mrzValid: false } }));
    const res = reconcileCustomerPassport(dir);
    assert.equal(res.source, 'consensus');
    assert.equal(readSidecar(path.join(dir, 'r2.jpg')).passportNoAuto, 'EQ9404549');
  });
});

test('reconcile: 两源一致佐证 → 清 passport_no_unverified(值不变)', () => {
  withDir((dir) => {
    writeSidecar(path.join(dir, 'p.jpg'), sc({ passportNoAuto: 'EM9314578', reviewReasons: ['passport_no_unverified'], needsReview: true, modelMeta: { backend: 'qwen', mrzValid: false } }));
    writeSidecar(path.join(dir, 'r.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EM9314578', modelMeta: { backend: 'qwen', mrzValid: false } }));
    const res = reconcileCustomerPassport(dir);
    assert.equal(res.source, 'consensus');
    const p = readSidecar(path.join(dir, 'p.jpg'));
    assert.equal(p.passportNoAuto, 'EM9314578'); // 值不变
    assert.equal(p.needsReview, false);          // 被跨图佐证 → 清标
    assert.ok(!p.reviewReasons.includes('passport_no_unverified'));
  });
});

test('reconcile: 无 sidecar(paddle 模式)→ no-op', () => {
  withDir((dir) => {
    assert.equal(reconcileCustomerPassport(dir).updated, 0);
  });
});

test('reconcile: MRZ 锚点修复后清掉 passport_no_unverified 标记', () => {
  withDir((dir) => {
    writeSidecar(path.join(dir, 'p.jpg'), sc({ passportNoAuto: 'EQ9404549', modelMeta: { backend: 'qwen', mrzValid: true } }));
    writeSidecar(path.join(dir, 'p2.jpg'), sc({ passportNoAuto: 'E09404549', reviewReasons: ['passport_no_unverified'], needsReview: true, modelMeta: { backend: 'qwen', mrzValid: false } }));
    reconcileCustomerPassport(dir);
    const fixed = readSidecar(path.join(dir, 'p2.jpg'));
    assert.equal(fixed.passportNoAuto, 'EQ9404549');
    assert.equal(fixed.needsReview, false); // 唯一的 reason 被清,转为不需复核
    assert.ok(!fixed.reviewReasons.includes('passport_no_unverified'));
  });
});

// ── 0729 生产数据实测后加的两道闸 ─────────────────────────────────────────
// 全库扫描 3786 条纯共识改写:**2109 条写入的值根本不是护照号形态**
//   (实样:CHNE951 国籍码粘残号 / CHNEQ33 / 1422 / 7808 / 6473),
//   其中 739 条还被标成"不用复核";另有 388 条与审核确认后的夹名护照号直接冲突且不用复核。
// 成因:免税店小票上**印着**护照号,同一台 POS 同一字体,OCR 很可能把两张小票
//   **同样地读错** → 两票错读压过一票正读,还因为"有共识"被当成可信、清掉复核标记。

test('共识闸①:残串没有投票权 —— 两张小票同样读错也不得胜出', () => {
  withDir((dir) => {
    // 护照读出正确值(1 票),两张小票印刷体被同样读成残串(2 票)
    writeSidecar(path.join(dir, 'p.jpg'), sc({ docTypeFinal: 'passport', passportNoAuto: 'EK9330357' }));
    writeSidecar(path.join(dir, 'r1.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'CHNE951' }));
    writeSidecar(path.join(dir, 'r2.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'CHNE951' }));
    const res = reconcileCustomerPassport(dir);
    // 残串被形态闸挡在投票之外 → 只剩护照那 1 票,不够 2 票 → 不猜、不回写
    assert.equal(res.updated, 0, '残串多数票不得改写任何人');
    assert.equal(readSidecar(path.join(dir, 'p.jpg')).passportNoAuto, 'EK9330357', '正确值不得被残串覆盖');
  });
});

test('共识闸①:形态合法的多数票仍然照常生效(别把有用的跨图纠正一起关掉)', () => {
  withDir((dir) => {
    writeSidecar(path.join(dir, 'a.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EK9330357' }));
    writeSidecar(path.join(dir, 'b.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EK9330357' }));
    writeSidecar(path.join(dir, 'c.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EK933' })); // 单点抖动
    const res = reconcileCustomerPassport(dir);
    assert.equal(res.source, 'consensus');
    assert.equal(readSidecar(path.join(dir, 'c.jpg')).passportNoAuto, 'EK9330357', '单点抖动仍被纠正');
  });
});

test('共识闸②:纯共识改写要留在复核队列里,不得升格成"一眼过"', () => {
  withDir((dir) => {
    // 最危险的一类:本来没有任何复核标记,值却被弱证据改写(实样 CAO ZIYU_EK9330357)
    writeSidecar(path.join(dir, 'x.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'EJ0874059', reviewReasons: [], needsReview: false }));
    writeSidecar(path.join(dir, 'y.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'E58984433' }));
    writeSidecar(path.join(dir, 'z.jpg'), sc({ docTypeFinal: 'receipt', passportNoAuto: 'E58984433' }));
    const res = reconcileCustomerPassport(dir);
    assert.equal(res.source, 'consensus');
    const x = readSidecar(path.join(dir, 'x.jpg'));
    assert.equal(x.passportNoAuto, 'E58984433', '值仍然采纳(跨图纠正确实能修单点抖动)');
    assert.ok((x.reviewReasons || []).includes('passport_no_unverified'),
      '但必须**补上**待核实标记 —— 弱证据改写不能标成"不用看"');
    assert.equal(x.needsReview, true, '要留在复核队列里');
  });
});

test('共识闸②:MRZ 锚点是强证据,照旧可以清标', () => {
  withDir((dir) => {
    writeSidecar(path.join(dir, 'p.jpg'), sc({ docTypeFinal: 'passport', passportNoAuto: 'EQ9404549', modelMeta: { backend: 'qwen', mrzValid: true } }));
    writeSidecar(path.join(dir, 'r.jpg'), sc({
      docTypeFinal: 'receipt', passportNoAuto: 'EQ9404549',
      reviewReasons: ['passport_no_unverified'], needsReview: true,
    }));
    reconcileCustomerPassport(dir);
    const r = readSidecar(path.join(dir, 'r.jpg'));
    assert.ok(!(r.reviewReasons || []).includes('passport_no_unverified'), 'MRZ 佐证后可清标');
    assert.equal(r.needsReview, false);
  });
});

// ── 形态闸:按结构判定,不按国别写死 ────────────────────────────────────
// 第一版用 /^[A-Z]{1,2}\d{7,8}$/(大陆格式),拿生产数据一比就发现会误伤:
// 客人里有台湾(**9 位纯数字**,如 316264111,姓名 CHOU HSUEHHSIN 这种威妥玛拼音)
// 和港澳/其它国家格式(AW991951 / CD804681 / K4497728G / P299494ED)。
// 按国别追规则永远追不全,只会把合法客人挡在跨图纠正之外。
// 下面每一个值都来自**生产实测**,是这条闸的真实边界。
test('形态闸:各国合法护照号一律放行(别按国别写死规则)', () => {
  const { plausiblePassportNo } = require('../lib/qwen_ocr/customer_reconcile');
  for (const v of [
    'EK9330357', 'EQ9404549',        // 大陆:1-2 字母 + 7-8 数字
    '316264111', '361330892',        // 台湾:9 位纯数字
    'AW991951', 'CD804681',          // 港澳等
    'K4497728G', 'P299494ED',        // 其它国家(字母收尾)
    '22FF24200',
  ]) assert.equal(plausiblePassportNo(v), true, `不该挡下合法号:${v}`);
});

test('形态闸:OCR 残串一律挡下(全部取自生产实测)', () => {
  const { plausiblePassportNo } = require('../lib/qwen_ocr/customer_reconcile');
  for (const v of [
    'E', '494', '5565', '1422', '7808', '6473',   // 纯截断
    'E5323', 'E0890', 'E5851', 'E1084',            // 字母+短数字
    'CHNEQ72', 'CHNEFBO', 'CHNE951', 'CHNEQ33',    // MRZ 国籍码粘半截号
    'EK70865929CHN7904233F3306242MLM0L0LC0CPJA966', // 整段 MRZ 被当成号码
    '', null, undefined,
  ]) assert.equal(plausiblePassportNo(v), false, `该挡下的残串漏放了:${v}`);
});

test('形态闸:CHN 国籍码粘在合法号前面 → 剥掉后认', () => {
  const { plausiblePassportNo } = require('../lib/qwen_ocr/customer_reconcile');
  assert.equal(plausiblePassportNo('CHNEK9330357'), true, '剥掉 CHN 后成形 → 放行');
  assert.equal(plausiblePassportNo('CHNEQ72'), false, '剥掉 CHN 后仍不成形 → 照样挡');
});
