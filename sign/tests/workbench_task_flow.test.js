const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const {
  PROCESS_RESULTS,
  clearEditableFieldsForDocTypeSwitch,
  deriveTaskState,
  getTaskRequiredFieldChecks,
} = require('../lib/workbench_task_flow');

function createTask(overrides = {}) {
  return {
    docTypeFinal: DOC_TYPES.PASSPORT,
    classificationConfirmed: false,
    reviewed: false,
    reviewedAt: '',
    rephotoRequested: false,
    extractedNameAuto: '',
    extractedNameFinal: '',
    chineseNameAuto: '',
    chineseNameFinal: '',
    passportNoAuto: '',
    passportNoFinal: '',
    receiptStoreAuto: '',
    receiptStoreFinal: '',
    receiptNoAuto: '',
    receiptNoFinal: '',
    groupNoAuto: '',
    groupNoFinal: '',
    purchaseDateAuto: '',
    purchaseDateFinal: '',
    departureDateAuto: '',
    departureDateFinal: '',
    finalSignaturePath: '',
    finalSignatureSource: '',
    ...overrides,
  };
}

test('passport task stays in classification review before classification is confirmed', () => {
  const result = deriveTaskState(createTask());
  assert.equal(result.processResult, PROCESS_RESULTS.CLASSIFY);
});

test('passport task becomes field review when key passport fields are missing', () => {
  const result = deriveTaskState(createTask({
    classificationConfirmed: true,
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.FIELDS);
});

test('passport task skips signature step (2026-06-12 \u4e0b\u7ebf): fields complete goes straight to final review', () => {
  const result = deriveTaskState(createTask({
    classificationConfirmed: true,
    extractedNameFinal: 'ZHANG SAN',
    passportNoFinal: 'E12345678',
    chineseNameFinal: '\u5f20\u4e09',
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.FINAL_REVIEW);
});

test('passport task becomes final review when fields and final signature are ready', () => {
  const result = deriveTaskState(createTask({
    classificationConfirmed: true,
    extractedNameFinal: 'ZHANG SAN',
    passportNoFinal: 'E12345678',
    chineseNameFinal: '\u5f20\u4e09',
    finalSignaturePath: 'final_signatures/task_1.png',
    finalSignatureSource: 'website_generated',
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.FINAL_REVIEW);
});

test('passport task becomes approved only after final review passes', () => {
  const result = deriveTaskState(createTask({
    classificationConfirmed: true,
    extractedNameFinal: 'ZHANG SAN',
    passportNoFinal: 'E12345678',
    chineseNameFinal: '\u5f20\u4e09',
    finalSignaturePath: 'final_signatures/task_1.png',
    finalSignatureSource: 'website_generated',
    reviewed: true,
    reviewedAt: '2026-04-13T10:00:00.000Z',
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.APPROVED);
});

test('receipt task skips signature and stays in field review until required fields are complete', () => {
  const result = deriveTaskState(createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.FIELDS);
});

test('receipt task goes directly to final review after required fields are complete', () => {
  const result = deriveTaskState(createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '90182325003077',
    groupNoFinal: '25184998',
    purchaseDateFinal: '2026-04-12',
    departureDateFinal: '2026-04-20',
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.FINAL_REVIEW);
});

test('passport fields must match the configured field rules before signature generation', () => {
  const task = createTask({
    classificationConfirmed: true,
    extractedNameFinal: '\u5f20\u4e09',
    passportNoFinal: 'E123',
    chineseNameFinal: 'ZHANG SAN',
  });

  const summary = getTaskRequiredFieldChecks(task);
  const result = deriveTaskState(task);

  assert.equal(result.processResult, PROCESS_RESULTS.FIELDS);
  // 2026-07-02 中文名移出必填(前端 6-30 已下线该字段,后端规则同步退役):不再出现在 invalid 列表
  assert.deepEqual(summary.invalidFields.map((field) => field.finalKey), [
    'extractedNameFinal',
    'passportNoFinal',
  ]);
});

test('receipt fields: 小票号解禁(长度不卡),团号/日期仍按规则卡', () => {
  const task = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '9018232500307', // 13位(LOTTE旧规则要14)→ 解禁后不再标invalid
    groupNoFinal: '25184', // LOTTE 团号要 8 位 → 仍 invalid(团号未解禁)
    purchaseDateFinal: '2026-04-21',
    departureDateFinal: '2026-04-20',
  });

  const summary = getTaskRequiredFieldChecks(task);
  const result = deriveTaskState(task);

  assert.equal(result.processResult, PROCESS_RESULTS.FIELDS);
  assert.deepEqual(summary.invalidFields.map((field) => field.finalKey), [
    'groupNoFinal',
    'purchaseDateFinal',
    'departureDateFinal',
  ]);
});

test('团号:字母数字放宽(乐天R团)+ 预匹配命中跳过格式检查', () => {
  const base = {
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '90182325003077',
    purchaseDateFinal: '2026-07-01',
    departureDateFinal: '2026-07-08',
  };
  // 字母团号(乐天R团/首尔V团):未命中团号表时 → 字母合法,但纯数字长度规则不适用 → 不标invalid
  const letters = getTaskRequiredFieldChecks(createTask({ ...base, groupNoFinal: 'R2614785' }));
  assert.ok(!letters.invalidFields.some((f) => f.finalKey === 'groupNoFinal'), '字母团号不应invalid');

  // 特殊符号仍拦
  const bad = getTaskRequiredFieldChecks(createTask({ ...base, groupNoFinal: '26-147' }));
  assert.ok(bad.invalidFields.some((f) => f.finalKey === 'groupNoFinal'), '带横线团号应invalid');

  // 纯数字仍按店长度卡(LOTTE 8位)
  const shortDigits = getTaskRequiredFieldChecks(createTask({ ...base, groupNoFinal: '123' }));
  assert.ok(shortDigits.invalidFields.some((f) => f.finalKey === 'groupNoFinal'), '3位纯数字应invalid');

  // 预匹配命中 → 即使长度不合旧规则也直接通过(命中团号表=格式正确的最强证明)
  const matched = getTaskRequiredFieldChecks(createTask({
    ...base, groupNoFinal: '123', groupNoMatchStatus: 'matched', modeRawPre: '乐天SG-本司',
  }));
  assert.ok(!matched.invalidFields.some((f) => f.finalKey === 'groupNoFinal'), '命中团号表应免格式检查');

  // 团号"无"(新世界机场票的合法值):放行,不再卡必填/格式
  const noGroup = getTaskRequiredFieldChecks(createTask({ ...base, groupNoFinal: '无' }));
  assert.ok(!noGroup.invalidFields.some((f) => f.finalKey === 'groupNoFinal'), '团号"无"应放行(机场票)');
  assert.ok(!noGroup.missingFields.some((f) => f.finalKey === 'groupNoFinal'), '团号"无"非空,不算缺失');

  // 团号长度表以 field_rules 为唯一真相源(本地副本已删):SHINSEGAE 5 位在这里同步生效
  // ——之前 field_rules 加了 SHINSEGAE:5 而本地副本没跟上,又是"改规则漏副本"事故同款。
  const sgOk = getTaskRequiredFieldChecks(createTask({
    ...base, receiptStoreFinal: 'SHINSEGAE', groupNoFinal: '79611',
  }));
  assert.ok(!sgOk.invalidFields.some((f) => f.finalKey === 'groupNoFinal'), '新世界 5 位团号应通过');
  const sgBad = getTaskRequiredFieldChecks(createTask({
    ...base, receiptStoreFinal: 'SHINSEGAE', groupNoFinal: '12345678',
  }));
  assert.ok(sgBad.invalidFields.some((f) => f.finalKey === 'groupNoFinal'), '新世界 8 位纯数字应按 field_rules 卡住');
});

test('结算闸回归:16位小票号+新店(SHINSEGAE)不再打回(生产 Internal error 场景)', () => {
  // 2026-07-02 生产事故:结算时 workbench_task_flow 旧副本卡"13位纯数字"+只认3店,
  // 抛 GROUP_APPROVAL_INVALID 落进兜底500。此测试锁死解禁后的行为。
  const task = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'SHILLA IPARK',
    receiptNoFinal: '0526062618500009', // 16位(旧规则要13)→ 解禁后合法
    groupNoFinal: '25184',
    purchaseDateFinal: '2026-06-26',
    departureDateFinal: '2026-07-03',
  });
  const summary = getTaskRequiredFieldChecks(task);
  assert.ok(!summary.invalidFields.some((f) => f.finalKey === 'receiptNoFinal'), '16位小票号不应invalid');

  // 新店(免税店5家白名单)不再被"只认3店"打回
  const shinsegae = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'SHINSEGAE',
    receiptNoFinal: '05-260626-033-00036', // 带横线也放行(解禁)
    groupNoFinal: '79588',
    purchaseDateFinal: '2026-06-26',
    departureDateFinal: '2026-07-03',
  });
  const summary2 = getTaskRequiredFieldChecks(shinsegae);
  assert.ok(!summary2.invalidFields.some((f) => f.finalKey === 'receiptStoreFinal'), 'SHINSEGAE 店不应invalid');
  assert.ok(!summary2.invalidFields.some((f) => f.finalKey === 'receiptNoFinal'), '带横线小票号不应invalid');
});

test('百货必填集(P2):乐天百货=身份/交易编号/金额/门店/品牌,无团号/出境日期;免税店不受影响', () => {
  // 乐天百货:字段齐 → 不缺不红,直通终审(团号/出境日期不在必填集里)。
  // 身份两键(断点②,2026-07-20):同框票档案声明 → 后端必填,与前端富定义对齐
  // (此前编译器静默丢弃=配置台绿灯谎言,前端必填后端放行)。
  const lotteDept = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE_DEPT',
    extractedNameFinal: 'HOANG NGOC BAO',
    passportNoFinal: 'EJ9626615',
    receiptNoFinal: '12345678',
    receiptAmountFinal: '3500000',
    branchFinal: '0394', // 2026-07-12 拍板:票面4位码原样
    brandFinal: '루이비통',
    purchaseDateFinal: '2026-07-01',
    // 团号/出境日期空:百货票面上就没有
    groupNoFinal: '',
    departureDateFinal: '',
  });
  const summary = getTaskRequiredFieldChecks(lotteDept);
  assert.equal(summary.missingFields.length, 0, `百货不该缺:${summary.missingFields.map((f) => f.label).join('、')}`);
  assert.equal(summary.invalidFields.length, 0);
  assert.ok(!summary.checks.some((f) => f.finalKey === 'groupNoFinal'), '百货必填集不含团号');
  assert.ok(!summary.checks.some((f) => f.finalKey === 'departureDateFinal'), '百货必填集不含出境日期');
  assert.equal(deriveTaskState(lotteDept).processResult, PROCESS_RESULTS.FINAL_REVIEW);

  // 乐天同框票缺身份 → 卡"待补字段"(与前端必填格同口径,不再放行到组级闸才拦)
  const lotteNoIdentity = createTask({ ...lotteDept, extractedNameFinal: '', passportNoFinal: '' });
  const lotteMissing = getTaskRequiredFieldChecks(lotteNoIdentity).missingFields.map((f) => f.finalKey);
  assert.ok(lotteMissing.includes('extractedNameFinal') && lotteMissing.includes('passportNoFinal'),
    '乐天百货身份必填(断点②接线)');

  // 缺金额 → 卡"待补字段";金额带逗号 → invalid
  const missingAmount = createTask({ ...lotteDept, receiptAmountFinal: '' });
  assert.ok(getTaskRequiredFieldChecks(missingAmount).missingFields.some((f) => f.finalKey === 'receiptAmountFinal'));
  const badAmount = createTask({ ...lotteDept, receiptAmountFinal: '3,500,000' });
  assert.ok(getTaskRequiredFieldChecks(badAmount).invalidFields.some((f) => f.finalKey === 'receiptAmountFinal'));

  // 现代百货(2026-07-12 实票纠正):金额补进必填集;上家必填
  const hyundaiDept = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'HYUNDAI_DEPT',
    receiptNoFinal: '1622-0011',
    upstreamFinal: '',
    purchaseDateFinal: '2026-07-01',
  });
  const hSummary = getTaskRequiredFieldChecks(hyundaiDept);
  assert.ok(hSummary.checks.some((f) => f.finalKey === 'receiptAmountFinal'), '现代百货有金额字段(实票有합계)');
  assert.ok(hSummary.missingFields.some((f) => f.finalKey === 'upstreamFinal'), '现代百货上家必填');

  // 免税店零回归:团号/出境日期照旧必填
  const dutyFree = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '12345678901234',
    groupNoFinal: '',
    purchaseDateFinal: '2026-07-01',
    departureDateFinal: '',
  });
  const dSummary = getTaskRequiredFieldChecks(dutyFree);
  assert.ok(dSummary.missingFields.some((f) => f.finalKey === 'groupNoFinal'), '免税店团号仍必填');
  assert.ok(dSummary.missingFields.some((f) => f.finalKey === 'departureDateFinal'), '免税店出境日期仍必填');
});

test('other task goes directly to final review after classification is confirmed', () => {
  const result = deriveTaskState(createTask({
    docTypeFinal: DOC_TYPES.OTHER,
    classificationConfirmed: true,
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.FINAL_REVIEW);
});

test('ticket task is treated as other for workflow requirements', () => {
  const result = deriveTaskState(createTask({
    docTypeFinal: 'ticket',
    classificationConfirmed: true,
  }));
  assert.equal(result.processResult, PROCESS_RESULTS.FINAL_REVIEW);
});

test('clearEditableFieldsForDocTypeSwitch clears prior editable values and resets review flags', () => {
  const cleared = clearEditableFieldsForDocTypeSwitch(createTask({
    docTypeFinal: DOC_TYPES.PASSPORT,
    classificationConfirmed: false,
    reviewed: true,
    reviewedAt: '2026-04-13T10:00:00.000Z',
    rephotoRequested: true,
    extractedNameAuto: 'ZHANG SAN',
    extractedNameFinal: 'ZHANG SAN',
    chineseNameAuto: 'ZHANG SAN',
    chineseNameFinal: 'ZHANG SAN',
    passportNoAuto: 'E12345678',
    passportNoFinal: 'E12345678',
    receiptStoreAuto: 'LOTTE',
    receiptStoreFinal: 'LOTTE',
    receiptNoAuto: 'R-1001',
    receiptNoFinal: 'R-1001',
    groupNoAuto: 'G-22',
    groupNoFinal: 'G-22',
    purchaseDateAuto: '2026-04-12',
    purchaseDateFinal: '2026-04-12',
    departureDateAuto: '2026-04-20',
    departureDateFinal: '2026-04-20',
  }), DOC_TYPES.RECEIPT);

  assert.equal(cleared.docTypeFinal, DOC_TYPES.RECEIPT);
  assert.equal(cleared.classificationConfirmed, true);
  assert.equal(cleared.reviewed, false);
  assert.equal(cleared.reviewedAt, '');
  assert.equal(cleared.rephotoRequested, false);
  assert.equal(cleared.extractedNameAuto, '');
  assert.equal(cleared.extractedNameFinal, '');
  assert.equal(cleared.chineseNameAuto, '');
  assert.equal(cleared.chineseNameFinal, '');
  assert.equal(cleared.passportNoAuto, '');
  assert.equal(cleared.passportNoFinal, '');
  assert.equal(cleared.receiptStoreAuto, '');
  assert.equal(cleared.receiptStoreFinal, '');
  assert.equal(cleared.receiptNoAuto, '');
  assert.equal(cleared.receiptNoFinal, '');
  assert.equal(cleared.groupNoAuto, '');
  assert.equal(cleared.groupNoFinal, '');
  assert.equal(cleared.purchaseDateAuto, '');
  assert.equal(cleared.purchaseDateFinal, '');
  assert.equal(cleared.departureDateAuto, '');
  assert.equal(cleared.departureDateFinal, '');
});

test('百货校验per档案(P3):交易编号位数/门店白名单/品牌白名单/上家枚举,规则全从档案读', () => {
  const lotteDeptBase = {
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE_DEPT',
    receiptNoFinal: '12345678',
    receiptAmountFinal: '3500000',
    branchFinal: '0394', // 2026-07-12 拍板:票面4位码原样
    brandFinal: '루이비통',
    purchaseDateFinal: '2026-07-01',
  };
  // 基线:全对 → 零红
  assert.equal(getTaskRequiredFieldChecks(createTask(lotteDeptBase)).invalidFields.length, 0);

  // 乐天百货交易编号:数字核8位;0727#13-4 起档案 dash:true,带杠 4-4 合法(与现代同口径)
  for (const bad of ['1234567', '123456789', '1234567a']) {
    const summary = getTaskRequiredFieldChecks(createTask({ ...lotteDeptBase, receiptNoFinal: bad }));
    assert.ok(summary.invalidFields.some((f) => f.finalKey === 'receiptNoFinal'),
      `乐天百货交易编号「${bad}」应标红`);
  }
  assert.equal(
    getTaskRequiredFieldChecks(createTask({ ...lotteDeptBase, receiptNoFinal: '1234-5678' })).invalidFields.length, 0,
    '带杠 4-4 合法(0727拍板:按票面带杠;旧「不打杠标红」作废)',
  );

  // 门店=票面4位编号原样(2026-07-12 拍板):4位纯数字即绿(新码宽容),门店名/杂串标红
  for (const bad of ['明洞', '江南', '039', '03941', 'A394']) {
    const badBranch = getTaskRequiredFieldChecks(createTask({ ...lotteDeptBase, branchFinal: bad }));
    assert.ok(badBranch.invalidFields.some((f) => f.finalKey === 'branchFinal'), `门店「${bad}」应标红(要4位码)`);
  }
  for (const ok of ['0394', '0001', '0348', '9999']) {
    assert.equal(
      getTaskRequiredFieldChecks(createTask({ ...lotteDeptBase, branchFinal: ok })).invalidFields.length, 0,
      `门店码「${ok}」应通过`);
  }

  // 品牌韩文白名单(루이비통/반클리프 아펠/티파니)
  const badBrand = getTaskRequiredFieldChecks(createTask({ ...lotteDeptBase, brandFinal: '샤넬' }));
  assert.ok(badBrand.invalidFields.some((f) => f.finalKey === 'brandFinal'), '非白名单品牌应标红');
  assert.equal(
    getTaskRequiredFieldChecks(createTask({ ...lotteDeptBase, brandFinal: '반클리프 아펠' })).invalidFields.length, 0);

  // 现代百货(2026-07-12 实票纠正):交易编号 8位 4-4 带杠(数字核8位,杠位不强求);
  // 原"16位2-6-3-5"是现代免税店 BILL NO 误借口径,长号现在必须标红。上家枚举 金浦奥莱/东方。
  const hyundaiBase = {
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'HYUNDAI_DEPT',
    receiptNoFinal: '1622-0011',
    receiptAmountFinal: '1020000',
    upstreamFinal: '东方',
    purchaseDateFinal: '2026-07-01',
  };
  assert.equal(getTaskRequiredFieldChecks(createTask(hyundaiBase)).invalidFields.length, 0, '8位带杠通过');
  assert.equal(getTaskRequiredFieldChecks(createTask({ ...hyundaiBase, receiptNoFinal: '16220011' }))
    .invalidFields.length, 0, '去杠8位纯数字也通过(杠位不强求)');
  assert.ok(getTaskRequiredFieldChecks(createTask({ ...hyundaiBase, receiptNoFinal: '20-260701-123-45678' }))
    .invalidFields.some((f) => f.finalKey === 'receiptNoFinal'), '免税店BILL NO 16位长号必须标红(错口径绝迹)');
  assert.ok(getTaskRequiredFieldChecks(createTask({ ...hyundaiBase, receiptNoFinal: '12345' }))
    .invalidFields.some((f) => f.finalKey === 'receiptNoFinal'), '现代票号非8位数字应标红');
  assert.ok(getTaskRequiredFieldChecks(createTask({ ...hyundaiBase, upstreamFinal: '别家' }))
    .invalidFields.some((f) => f.finalKey === 'upstreamFinal'), '现代上家非枚举应标红');
  assert.equal(getTaskRequiredFieldChecks(createTask({ ...hyundaiBase, upstreamFinal: '金浦奥莱' }))
    .invalidFields.length, 0);

  // 新世界百货:上家固定=梁总;票号带杠容忍(位数未知,只查字符集)
  const ssgBase = {
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'SHINSEGAE_DEPT',
    receiptNoFinal: '123-456789',
    receiptAmountFinal: '99000',
    upstreamFinal: '梁总',
    purchaseDateFinal: '2026-07-01',
  };
  assert.equal(getTaskRequiredFieldChecks(createTask(ssgBase)).invalidFields.length, 0);
  assert.ok(getTaskRequiredFieldChecks(createTask({ ...ssgBase, upstreamFinal: '别人' }))
    .invalidFields.some((f) => f.finalKey === 'upstreamFinal'), '新世界上家非梁总应标红');
  assert.ok(getTaskRequiredFieldChecks(createTask({ ...ssgBase, receiptNoFinal: 'abc-123' }))
    .invalidFields.some((f) => f.finalKey === 'receiptNoFinal'), '票号含字母应标红');

  // 免税店零回归:小票号解禁口径不变(字母/横线都不卡)
  const dutyFree = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: 'AB12345678',
    groupNoFinal: '12345678',
    purchaseDateFinal: '2026-07-01',
    departureDateFinal: '2026-07-05',
  });
  assert.ok(!getTaskRequiredFieldChecks(dutyFree).invalidFields.some((f) => f.finalKey === 'receiptNoFinal'),
    '免税店小票号解禁行为不得回归');
});

// ── 2026-07-13 登机牌病例:改类型必须连票级表态一起清,防"其他→小票"往返回放旧表态 ──
test('clearEditableFieldsForDocTypeSwitch:表态三件套/S标记/人选模式随类型切换清场', () => {
  const { clearEditableFieldsForDocTypeSwitch } = require('../lib/workbench_task_flow');
  const misjudged = createTask({
    docTypeFinal: DOC_TYPES.RECEIPT,
    groupNoFinal: '',
    tourStance: 'none',            // 操作员被表态锁逼着点了"无团号"
    tourStancedAt: '2026-07-13T01:00:00.000Z',
    tourStancedBy: 'op1',
    sActivityFlag: true,
    modeManualPick: '乐天SG-本司',
    modeManualPickTour: '26140098',
  });
  const toOther = clearEditableFieldsForDocTypeSwitch(misjudged, DOC_TYPES.OTHER);
  assert.equal(toOther.tourStance, '', '表态必须清(回执不再把登机牌计成无团号小票)');
  assert.equal(toOther.tourStancedAt, '');
  assert.equal(toOther.tourStancedBy, '');
  assert.equal(toOther.sActivityFlag, false);
  assert.equal(toOther.modeManualPick, '');
  assert.equal(toOther.modeManualPickTour, '');
  // 往返守卫:其他 → 改回小票,必须重新走两步流(旧表态不许回放)
  const backToReceipt = clearEditableFieldsForDocTypeSwitch(toOther, DOC_TYPES.RECEIPT);
  assert.equal(backToReceipt.tourStance, '', '改回小票后仍无表态=表态锁重新生效');
});

test('断点②护栏:免护照店档案带身份勾不进必填集(存量v1配置不卡审);乐天声明即必填', () => {
  const { buildDeptReceiptFieldRuleSet } = require('../lib/workbench_definition');
  const { getStoreProfile } = require('../lib/store_profiles');
  // 新世界(passportFree):模拟存量 v1 配置带身份勾 → 编译器按 passportFree 闸跳过
  const sg = getStoreProfile('SHINSEGAE_DEPT');
  const sgSet = buildDeptReceiptFieldRuleSet({ ...sg, fields: [...sg.fields, 'passportNo', 'extractedName'] });
  const sgKeys = sgSet.fields.map((f) => f.finalKey);
  assert.ok(!sgKeys.includes('passportNoFinal') && !sgKeys.includes('extractedNameFinal'),
    '免护照店身份勾选只等于面板选填格,绝不进必填集');
  // 乐天(同框票,非免护照):出厂档案声明身份 → 必填集有身份两键
  const lotteSet = buildDeptReceiptFieldRuleSet(getStoreProfile('LOTTE_DEPT'));
  const lotteKeys = lotteSet.fields.map((f) => f.finalKey);
  assert.ok(lotteKeys.includes('passportNoFinal') && lotteKeys.includes('extractedNameFinal'),
    '乐天同框票身份必填(与前端富定义对齐)');
});
