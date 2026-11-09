'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeStoreFamily, STORE_FAMILIES } = require('../lib/validation/field_rules');
const { getStoreProfile, isDeptStore, FAMILY } = require('../lib/store_profiles');

// ⭐撞名防线(2026-07-06 P0 核心):百货串绝不能掉进同名免税店。
test('normalizeStoreFamily 撞名防线:百货关键词优先,不误吞进免税店', () => {
  // 新世界百货 ≠ 新世界免税店(SHINSEGAE)——这是第一天就串台的雷
  assert.equal(normalizeStoreFamily('新世界百货'), STORE_FAMILIES.SHINSEGAE_DEPT);
  assert.equal(normalizeStoreFamily('신세계백화점'), STORE_FAMILIES.SHINSEGAE_DEPT);
  assert.equal(normalizeStoreFamily('现代百货'), STORE_FAMILIES.HYUNDAI_DEPT);
  assert.equal(normalizeStoreFamily('현대백화점'), STORE_FAMILIES.HYUNDAI_DEPT);
  assert.equal(normalizeStoreFamily('乐天百货'), STORE_FAMILIES.LOTTE_DEPT);
  assert.equal(normalizeStoreFamily('롯데백화점'), STORE_FAMILIES.LOTTE_DEPT);
  assert.equal(normalizeStoreFamily('LOTTE DEPARTMENT'), STORE_FAMILIES.LOTTE_DEPT);

  // 免税店照旧,一个都不能被百货分支影响
  assert.equal(normalizeStoreFamily('SHINSEGAE'), STORE_FAMILIES.SHINSEGAE);
  assert.equal(normalizeStoreFamily('SHINSEGAE DUTY FREE'), STORE_FAMILIES.SHINSEGAE);
  assert.equal(normalizeStoreFamily('新世界'), STORE_FAMILIES.SHINSEGAE);
  assert.equal(normalizeStoreFamily('HYUNDAI'), STORE_FAMILIES.HYUNDAI);
  assert.equal(normalizeStoreFamily('LOTTE'), STORE_FAMILIES.LOTTE);
  assert.equal(normalizeStoreFamily('THE SHILLA'), STORE_FAMILIES.THE_SHILLA);
  assert.equal(normalizeStoreFamily('SHILLA IPARK'), STORE_FAMILIES.SHILLA_IPARK);

  // 认出百货但不知哪家 → 留空(审核员选),不猜、不掉进免税店
  assert.equal(normalizeStoreFamily('某某百货'), '');
});

test('store_profiles:免税店=默认档案(auto切/走团号);百货=不切/无团号/常量模式', () => {
  // 免税店走默认档案
  for (const s of ['LOTTE', 'THE SHILLA', 'SHILLA IPARK', 'SHINSEGAE', 'HYUNDAI']) {
    const p = getStoreProfile(normalizeStoreFamily(s));
    assert.equal(p.family, FAMILY.DUTY_FREE);
    assert.equal(p.split, 'auto');
    assert.equal(p.tourMatch, true);
    assert.equal(isDeptStore(normalizeStoreFamily(s)), false);
  }
  // 未知/空 → 保守回默认免税店档案(拿不准按免税店走)
  assert.equal(getStoreProfile('').family, FAMILY.DUTY_FREE);
  assert.equal(getStoreProfile('从没见过的店').family, FAMILY.DUTY_FREE);
});

test('store_profiles:三个百货档案的字段/规则符合上家规范', () => {
  const lotte = getStoreProfile(STORE_FAMILIES.LOTTE_DEPT);
  assert.equal(lotte.split, 'none');       // 不可裁图
  assert.equal(lotte.combined, true);      // 护照小票同框
  assert.equal(lotte.tourMatch, false);
  assert.equal(lotte.mode, '乐天百货');
  assert.equal(lotte.rules.receiptNo.digits, 8);      // 8位交易编号
  assert.equal(lotte.rules.receiptNo.dash, true);     // 0727#13-4:按票面 4-4 带杠(旧不打-作废)
  assert.deepEqual(lotte.rules.brand, ['루이비통', '반클리프 아펠', '티파니']);
  // 2026-07-12 用户拍板:门店=票面4位编号原样(0001就是0001),规则从 名→码映射 改为码清单
  assert.deepEqual(lotte.rules.branch, ['0001', '0394', '0002', '0348', '0005', '0344']);
  assert.equal(lotte.rules.amount, 'total');          // 只记总金额

  const sinsegae = getStoreProfile(STORE_FAMILIES.SHINSEGAE_DEPT);
  assert.equal(sinsegae.rules.receiptNo.dash, true);  // 票号带横线
  assert.equal(sinsegae.defaults.upstream, '梁总');   // 上家固定梁总
  assert.ok(sinsegae.fields.includes('receiptAmount')); // 有金额
  // 0731 拆借位:金额和上家在导出表里各有自己的列,档案不再声明 exportMap
  assert.equal(sinsegae.exportMap, undefined, '还声明着借位映射');

  const hyundai = getStoreProfile(STORE_FAMILIES.HYUNDAI_DEPT);
  // 2026-07-12 实票纠正:交易编号 8位 4-4 带杠(原16位2-6-3-5是现代免税店BILL NO误借);金额要记
  assert.equal(hyundai.rules.receiptNo.dash, true);
  assert.equal(hyundai.rules.receiptNo.digits, 8);
  assert.equal(hyundai.rules.receiptNo.transNo44, true);
  assert.ok(hyundai.fields.includes('receiptAmount'));
  assert.deepEqual(hyundai.rules.upstream, ['金浦奥莱', '东方']);
  assert.equal(hyundai.defaults.upstream, '东方');          // 无卡=东方是规则本体,默认它
  assert.equal(hyundai.rules.upstreamConfirm, true);        // 默认后仍标红人工看贴没贴卡
  assert.equal(hyundai.exportMap, undefined, '还声明着借位映射');
});
