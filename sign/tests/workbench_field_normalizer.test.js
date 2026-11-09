const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEditableFieldsForDocType,
  normalizeOcrFieldsForDocType,
} = require('../lib/workbench_field_normalizer');

test('normalizeOcrFieldsForDocType formats receipt OCR fields for review inputs', () => {
  const result = normalizeOcrFieldsForDocType('receipt', {
    receiptStoreAuto: 'lotte duty free',
    receiptNoAuto: '123456-78-901234',
    groupNoAuto: 'G 25184',
    purchaseDateAuto: '2026.04.20 13:22',
    departureDateAuto: '26/04/22',
    passportNoAuto: ' eg 8761171 ',
  });

  assert.deepEqual(result, {
    receiptStoreAuto: 'LOTTE',
    receiptNoAuto: '123456-78-901234', // 保横线(输入什么存什么,2026-07-03 口径)
    receiptNoRawAuto: '123456-78-901234',
    groupNoAuto: '25184',
    purchaseDateAuto: '2026-04-20',
    departureDateAuto: '2026-04-22',
    passportNoAuto: 'EG8761171',
  });
});

test('小票号保留字母和横线(济州乐天90G331…/新世界BILL NO带杠),只去空格点号;raw 留底原串', () => {
  const result = normalizeOcrFieldsForDocType('receipt', {
    receiptNoAuto: ' 90g331-26-001768 ',
  });
  assert.equal(result.receiptNoAuto, '90G331-26-001768');
  assert.equal(result.receiptNoRawAuto, '90g331-26-001768');
  // 手动输入同口径:改什么存什么(生产反馈"手动改不过来"=旧口径存时剥杠)
  assert.equal(
    normalizeEditableFieldsForDocType('receipt', { receiptNoFinal: '05-260701-263-00079' }).receiptNoFinal,
    '05-260701-263-00079'
  );
  // 连杠折叠、首尾杠剥掉,别存出畸形值
  assert.equal(
    normalizeEditableFieldsForDocType('receipt', { receiptNoFinal: '--123--456-' }).receiptNoFinal,
    '123-456'
  );
});

test('团号"无"是机场票合法值,原样保留不剥空', () => {
  assert.equal(normalizeOcrFieldsForDocType('receipt', { groupNoAuto: '无' }).groupNoAuto, '无');
  assert.equal(normalizeEditableFieldsForDocType('receipt', { groupNoFinal: ' 无 ' }).groupNoFinal, '无');
  assert.equal(normalizeEditableFieldsForDocType('receipt', { groupNoFinal: '无团号' }).groupNoFinal, '无');
});

test('normalizeOcrFieldsForDocType formats passport OCR fields and leaves receipt dates empty', () => {
  const result = normalizeOcrFieldsForDocType('passport', {
    extractedNameAuto: ' zhang   liya ',
    passportNoAuto: ' eg 8761171 ',
    chineseNameAuto: ' 张丽雅 / CHN ',
    departureDateAuto: '2026-04-22',
  });

  assert.deepEqual(result, {
    extractedNameAuto: 'ZHANG LIYA',
    passportNoAuto: 'EG8761171',
    chineseNameAuto: '张丽雅',
    departureDateAuto: '',
  });
});

test('normalizeOcrFieldsForDocType removes receipt separators and store spacing variants', () => {
  const result = normalizeOcrFieldsForDocType('receipt', {
    receiptStoreAuto: 'theshilla',
    receiptNoAuto: '0.03-261-540-0008-0',
    groupNoAuto: 'G-12345',
  });

  assert.deepEqual(result, {
    receiptStoreAuto: 'THE SHILLA',
    receiptNoAuto: '03-261-540-0008-0', // "0."识别噪音剥掉,横线保留
    receiptNoRawAuto: '0.03-261-540-0008-0',
    groupNoAuto: '12345',
  });

  assert.equal(normalizeOcrFieldsForDocType('receipt', {
    receiptStoreAuto: 'shillaipark',
  }).receiptStoreAuto, 'SHILLA IPARK');
});

test('normalizeOcrFieldsForDocType strips passport English-name region helper prefixes', () => {
  assert.equal(normalizeOcrFieldsForDocType('passport', {
    extractedNameAuto: 'POCHNXUE YUCHEN',
  }).extractedNameAuto, 'XUE YUCHEN');

  assert.equal(normalizeOcrFieldsForDocType('passport', {
    extractedNameAuto: 'MSL1 POCHN XUE YUCHEN',
  }).extractedNameAuto, 'XUE YUCHEN');

  assert.equal(normalizeOcrFieldsForDocType('passport', {
    extractedNameAuto: 'MLZ1 POCHN XUE YUCHEN',
  }).extractedNameAuto, 'XUE YUCHEN');
});

test('normalizeEditableFieldsForDocType applies the same cleanup before saving manual edits', () => {
  const result = normalizeEditableFieldsForDocType('receipt', {
    receiptStoreFinal: 'SHILLAIPARK',
    receiptNoFinal: '0.03-261-540-0008-0',
    groupNoFinal: 'G-12345',
    purchaseDateFinal: '26/04/20',
    departureDateFinal: '2026.04.22',
  });

  assert.deepEqual(result, {
    receiptStoreFinal: 'SHILLA IPARK',
    receiptNoFinal: '03-261-540-0008-0', // 手改同口径:横线保留
    groupNoFinal: '12345',
    purchaseDateFinal: '2026-04-20',
    departureDateFinal: '2026-04-22',
    // 改店清残留(2026-07-14):PATCH 带店(免税店)→ 百货四件产清空指令
    receiptAmountFinal: '',
    branchFinal: '',
    brandFinal: '',
    upstreamFinal: '',
  });
});

test('百货身份字段(2026-07-12 报障#2):receipt 编辑白名单放行姓名/护照号,护照口径归一', () => {
  const { normalizeEditableFieldsForDocType } = require('../lib/workbench_field_normalizer');
  const next = normalizeEditableFieldsForDocType('receipt', {
    receiptStoreFinal: 'LOTTE_DEPT', // 按店收窄:百货才放行(复审 MEDIUM)
    extractedNameFinal: ' hoang ngoc bao ',
    passportNoFinal: ' ej 9626615 ',
  });
  // 0727反馈#9 起姓名标准=姓␣名段合并(HOANG NGOC BAO → HOANG NGOCBAO)
  assert.equal(next.extractedNameFinal, 'HOANG NGOCBAO');
  assert.equal(next.passportNoFinal, 'EJ9626615');
  // 不传就不动(setIfPresent 语义,别把别人清空)
  const untouched = normalizeEditableFieldsForDocType('receipt', { receiptNoFinal: '12345678' });
  assert.ok(!('extractedNameFinal' in untouched));
  assert.ok(!('passportNoFinal' in untouched));

  // 非百货免税店:非空值丢弃(身份真相在护照任务,不开口子);空串放行=切店清残留
  const dutyFree = normalizeEditableFieldsForDocType('receipt', {
    receiptStoreFinal: 'LOTTE', extractedNameFinal: 'SNEAKY', passportNoFinal: 'E12345678',
  });
  assert.ok(!('extractedNameFinal' in dutyFree));
  assert.ok(!('passportNoFinal' in dutyFree));
  const cleared = normalizeEditableFieldsForDocType('receipt', {
    receiptStoreFinal: 'LOTTE', extractedNameFinal: '', passportNoFinal: '',
  });
  assert.equal(cleared.extractedNameFinal, '');
  assert.equal(cleared.passportNoFinal, '');
  // 撞名防线镜像:原始文字「乐天百货」也认百货
  const rawDept = normalizeEditableFieldsForDocType('receipt', {
    receiptStoreFinal: '乐天百货', passportNoFinal: 'ej9626615',
  });
  assert.equal(rawDept.passportNoFinal, 'EJ9626615');
});

const { normalizeEditableFieldsForDocType: normEdit } = require('../lib/workbench_field_normalizer');

test('改店清残留(2026-07-14 审计中危):百货字段按目标店档案白名单清空', () => {
  // 乐天百货 → 新世界百货:branch/brand 不在新世界档案 → 清;金额/上家在 → 不清
  const toSsg = normEdit('receipt', { receiptStoreFinal: '新世界百货' });
  assert.equal(toSsg.branchFinal, '', '新世界档案无门店 → branch 清空');
  assert.equal(toSsg.brandFinal, '', '新世界档案无品牌 → brand 清空');
  assert.equal(toSsg.receiptAmountFinal ?? 'KEEP', 'KEEP', '金额在新世界档案里 → 不产生清空指令');
  assert.equal(toSsg.upstreamFinal ?? 'KEEP', 'KEEP', '上家在新世界档案里 → 不产生清空指令');

  // 百货 → 免税店:四件全清
  const toDuty = normEdit('receipt', { receiptStoreFinal: 'LOTTE' });
  for (const key of ['receiptAmountFinal', 'branchFinal', 'brandFinal', 'upstreamFinal']) {
    assert.equal(toDuty[key], '', `切回免税店 ${key} 必须清空`);
  }

  // 不带店的 PATCH:不触发清残留(单字段小改不误伤)
  const noStore = normEdit('receipt', { receiptNoFinal: '12345678' });
  for (const key of ['receiptAmountFinal', 'branchFinal', 'brandFinal', 'upstreamFinal']) {
    assert.ok(!(key in noStore), `未改店时不得产生 ${key} 清空指令`);
  }

  // ⚠️调用方真实形态:updateTask 传对象字面量,缺席键=undefined 但 hasOwn 为真——
  // 触发条件必须按"非空字符串"判,否则百货任务的单字段 PATCH(如只改金额)会被冲掉。
  const undefStore = normEdit('receipt', { receiptStoreFinal: undefined, receiptAmountFinal: '3500000' });
  assert.equal(undefStore.receiptAmountFinal, '3500000', 'store=undefined(键在值缺)绝不触发清残留');
  assert.ok(!('branchFinal' in undefStore));
  const emptyStore = normEdit('receipt', { receiptStoreFinal: '', receiptAmountFinal: '99000' });
  assert.equal(emptyStore.receiptAmountFinal, '99000', 'store=空串同样不触发');
});

test('百货身份护栏:非百货小票的非空身份值被丢弃(无键=拒收信号,调用方不得 ?? 回填)', () => {
  const out = normEdit('receipt', { receiptStoreFinal: 'LOTTE', passportNoFinal: 'EQ1234567', extractedNameFinal: 'ZHANG SAN' });
  assert.ok(!('passportNoFinal' in out), '免税店小票夹带护照号:拒收,不产键');
  assert.ok(!('extractedNameFinal' in out), '免税店小票夹带英文名:拒收,不产键');
  const dept = normEdit('receipt', { receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'eq1234567' });
  assert.equal(dept.passportNoFinal, 'EQ1234567', '百货放行并归一');
});
