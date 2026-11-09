'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { storeFamilyOfMode, filterRowsByStore } = require('../lib/validation/mode_store');

// 词表来自 2026-07 真实团号表(2.6万行、21种模式)——前缀→店家必须 100% 判对
test('storeFamilyOfMode:21种真实模式全判对;认不出返回空', () => {
  const cases = [
    ['乐天H团-本司（原乐天V-本司）', 'LOTTE'],
    ['乐天SG-本司', 'LOTTE'],
    ['乐天B团-joy（发12号）', 'LOTTE'],
    ['乐天PKG-新琪', 'LOTTE'],
    ['济州乐天SG-道辉（单独整理）', 'LOTTE'],
    ['乐天釜山P特殊-本司', 'LOTTE'],
    ['乐天釜山SG-本司', 'LOTTE'],
    ['济州乐天V团特殊-道辉（发18号）', 'LOTTE'],
    ['新罗V团-本司', 'THE SHILLA'],
    ['济州新罗SG-道辉 不用记', 'THE SHILLA'],
    ['新罗V团-新琪', 'THE SHILLA'],
    ['新罗SG-新琪 不用记', 'THE SHILLA'],
    ['新罗SG-新琪', 'THE SHILLA'],
    ['济州新罗V团-本司', 'THE SHILLA'],
    ['济州新罗SG-宋总', 'THE SHILLA'],
    ['爱宝客SG-本司', 'SHILLA IPARK'],
    ['爱宝客pkg-本司', 'SHILLA IPARK'],
    ['新世界SG-振华 不用记', 'SHINSEGAE'],
    ['新世界SG-荣晨国际 不用记', 'SHINSEGAE'],
    ['新世界PKG-宋总', 'SHINSEGAE'],
    ['现代-JEOCU', 'HYUNDAI'],
  ];
  for (const [mode, expected] of cases) {
    assert.equal(storeFamilyOfMode(mode), expected, `模式「${mode}」应判为 ${expected}`);
  }
  // 百货模式(P4 常量)走撞名防线口径,不被 /^乐天/ 咬进免税店
  assert.equal(storeFamilyOfMode('乐天百货'), 'LOTTE_DEPT');
  assert.equal(storeFamilyOfMode('新世界百货'), 'SHINSEGAE_DEPT');
  assert.equal(storeFamilyOfMode('现代百货'), 'HYUNDAI_DEPT');
  // 认不出 → 空(不参与消歧)
  assert.equal(storeFamilyOfMode('神秘渠道X'), '');
  assert.equal(storeFamilyOfMode(''), '');
  assert.equal(storeFamilyOfMode(null), '');
});

// 70299 病例:同团号两行(新世界+现代),必须按票店选行
test('filterRowsByStore:70299病例——票店选行/全别店=mismatch/保守边界', () => {
  const rows70299 = [
    { mode: '新世界SG-振华 不用记' },
    { mode: '现代-JEOCU' },
  ];
  // 新世界小票 → 只留振华行
  const sinsegae = filterRowsByStore(rows70299, 'SHINSEGAE');
  assert.equal(sinsegae.storeMismatch, false);
  assert.deepEqual(sinsegae.rows.map((r) => r.mode), ['新世界SG-振华 不用记']);
  // 现代小票 → 只留 JEOCU 行
  const hyundai = filterRowsByStore(rows70299, 'HYUNDAI');
  assert.deepEqual(hyundai.rows.map((r) => r.mode), ['现代-JEOCU']);
  // 乐天小票 + 该团号 → 候选全属别家店 → mismatch(不猜,转人工)
  const lotte = filterRowsByStore(rows70299, 'LOTTE');
  assert.equal(lotte.storeMismatch, true);
  assert.equal(lotte.rows.length, 0);
  assert.equal(lotte.candidates.length, 2);

  // 保守边界①:票店未知 → 不消歧,原样返回(交给歧义闸)
  const unknownTicket = filterRowsByStore(rows70299, '');
  assert.equal(unknownTicket.storeMismatch, false);
  assert.equal(unknownTicket.rows.length, 2);
  // 保守边界⓪:单行命中不消歧(票店≠模式店的单行匹配是既有接受行为,不翻案)
  const singleRow = filterRowsByStore([{ mode: '新世界SG-振华 不用记' }], 'HYUNDAI');
  assert.equal(singleRow.storeMismatch, false);
  assert.equal(singleRow.rows.length, 1);
  // 保守边界②:候选里有认不出店的模式 → 不宣告 mismatch(不做半吊子推断)
  const partial = filterRowsByStore([{ mode: '神秘渠道X' }, { mode: '现代-JEOCU' }], 'LOTTE');
  assert.equal(partial.storeMismatch, false);
  assert.equal(partial.rows.length, 2);
  // 保守边界③:候选模式全认不出 → 原样返回
  const noneClassified = filterRowsByStore([{ mode: 'aaa' }, { mode: 'bbb' }], 'LOTTE');
  assert.equal(noneClassified.storeMismatch, false);
  assert.equal(noneClassified.rows.length, 2);

  // 同店多模式:过滤后仍多行(留给歧义闸,不误伤真歧义)
  const sameStore = filterRowsByStore(
    [{ mode: '新罗SG-新琪' }, { mode: '新罗SG-新琪 不用记' }, { mode: '现代-JEOCU' }],
    'THE SHILLA'
  );
  assert.equal(sameStore.storeMismatch, false);
  assert.equal(sameStore.rows.length, 2);
});
