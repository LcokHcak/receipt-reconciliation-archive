'use strict';

// 客户组护照数量规则单测(2026-07-13 百货同框护照 bug 的单一真相源)。
// 普通组=恰好1独立护照;百货组=护照可落在小票任务上(乐天百货 combined 同框)。

const test = require('node:test');
const assert = require('node:assert/strict');

const { groupPassportIssue, groupHasPassport, findDeptPassportDonor } = require('../lib/validation/group_passport_rule');

const passport = (over = {}) => ({ docTypeFinal: 'passport', passportNoFinal: 'EA1234567', ...over });
const receipt = (over = {}) => ({ docTypeFinal: 'receipt', receiptStoreFinal: 'THE SHILLA', ...over });

test('普通(免税店)组:恰好1独立护照=合格;0或2=不合格', () => {
  assert.equal(groupPassportIssue({ passportTasks: [passport()], receiptTasks: [receipt()] }), '');
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [receipt()] }), 'invalid_passport_count');
  assert.equal(groupPassportIssue({ passportTasks: [passport(), passport()], receiptTasks: [receipt()] }), 'invalid_passport_count');
});

test('乐天百货 combined 组:0独立护照 + 百货小票自带护照信息 → 合格(核心修复)', () => {
  const deptReceipt = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'EQ9753359', extractedNameFinal: 'JIANG XINHAN' });
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [deptReceipt] }), '');
  assert.equal(groupHasPassport({ passportTasks: [], receiptTasks: [deptReceipt] }), true);
  // 只有英文名也算(护照号可能未读出)
  const nameOnly = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: '', extractedNameFinal: 'ZHANG SAN' });
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [nameOnly] }), '');
});

test('纯百货组0护照:新世界/现代放行;乐天(同框票)仍要票上身份;2+护照仍拦', () => {
  for (const store of ['SHINSEGAE_DEPT', 'HYUNDAI_DEPT']) {
    const bare = receipt({ receiptStoreFinal: store, passportNoFinal: '', extractedNameFinal: '' });
    assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [bare] }), '', `${store} 纯组应放行`);
    assert.equal(groupHasPassport({ passportTasks: [], receiptTasks: [bare] }), true);
  }
  const lotteBare = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: '', extractedNameFinal: '' });
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [lotteBare] }), 'invalid_passport_count');
  // 乐天+现代混的纯百货组:乐天票带身份即可(donor 会向兄弟票传播)
  const lotteCarrier = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'EQ9753359' });
  const hyundaiBare = receipt({ receiptStoreFinal: 'HYUNDAI_DEPT', passportNoFinal: '', extractedNameFinal: '' });
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [lotteCarrier, hyundaiBare] }), '');
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [lotteBare, hyundaiBare] }), 'invalid_passport_count');
  // 2+ 独立护照仍拦(取错)
  assert.equal(groupPassportIssue({ passportTasks: [passport(), passport()], receiptTasks: [hyundaiBare] }), 'invalid_passport_count');
});

test('百货组:1独立护照=合格;2独立护照仍拦(取错)', () => {
  const deptReceipt = receipt({ receiptStoreFinal: 'SHINSEGAE_DEPT' });
  assert.equal(groupPassportIssue({ passportTasks: [passport()], receiptTasks: [deptReceipt] }), '');
  assert.equal(groupPassportIssue({ passportTasks: [passport(), passport()], receiptTasks: [deptReceipt] }), 'invalid_passport_count');
});

test('三种百货店名都认(_DEPT canonical)', () => {
  for (const store of ['LOTTE_DEPT', 'SHINSEGAE_DEPT', 'HYUNDAI_DEPT']) {
    const r = receipt({ receiptStoreFinal: store, passportNoFinal: 'EA1234567' });
    assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [r] }), '', `${store} 应豁免`);
  }
});

test('receiptStoreAuto 也认(Final 未落时)', () => {
  const r = { docTypeFinal: 'receipt', receiptStoreAuto: 'LOTTE_DEPT', passportNoAuto: 'EA1234567' };
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [r] }), '');
});

test('混合组(百货+免税同组):有百货带身份 → 整组按百货宽松口径放行(意图锁定,复审 MEDIUM)', () => {
  // 同一客户组:一张免税小票(无独立护照信息)+ 一张百货合影票(自带护照/英文名)。
  // 1客户组=1人:百货合影里的护照即该客户身份,整组按百货口径放行是有意的宽松,不是漏洞。
  const dutyFree = receipt({ receiptStoreFinal: 'LOTTE', passportNoFinal: '', extractedNameFinal: '' });
  const deptCarrier = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'EQ9753359', extractedNameFinal: 'JIANG XINHAN' });
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [dutyFree, deptCarrier] }), '');
  // 但混合组里连百货票也没带身份 → 仍拦(真缺护照)
  const deptBare = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: '', extractedNameFinal: '' });
  assert.equal(groupPassportIssue({ passportTasks: [], receiptTasks: [dutyFree, deptBare] }), 'invalid_passport_count');
});

test('findDeptPassportDonor:组内找带护照信息的另一张百货小票(排除自身)', () => {
  const carrier = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'EQ9753359', extractedNameFinal: 'JIANG XINHAN' });
  const blank = receipt({ receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: '', extractedNameFinal: '' });
  // blank 找捐赠者 → carrier
  assert.equal(findDeptPassportDonor([carrier, blank], blank), carrier);
  // carrier 找捐赠者(排除自身)→ 组内没别人带身份 → null
  assert.equal(findDeptPassportDonor([carrier, blank], carrier), null);
  // 护照任务不当捐赠者(无 receiptStore → 非百货)
  const passportTask = passport();
  assert.equal(findDeptPassportDonor([passportTask, blank], blank), null);
  // 免税店小票不当捐赠者(非百货)
  const dutyFree = receipt({ receiptStoreFinal: 'LOTTE', passportNoFinal: 'EP6233431' });
  assert.equal(findDeptPassportDonor([dutyFree, blank], blank), null);
  // 空/异常输入不炸
  assert.equal(findDeptPassportDonor(), null);
  assert.equal(findDeptPassportDonor(null, blank), null);
});

test('空输入不炸', () => {
  assert.equal(groupPassportIssue({}), 'invalid_passport_count'); // 无护照无小票 → 普通口径0本
  assert.equal(groupPassportIssue({ passportTasks: null, receiptTasks: null }), 'invalid_passport_count');
  assert.equal(groupHasPassport({}), false);
});
