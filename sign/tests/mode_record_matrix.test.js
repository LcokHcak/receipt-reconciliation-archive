const test = require('node:test');
const assert = require('node:assert/strict');

const { lookupModeRecordRule, normalizeModeName, MATRIX } = require('../lib/mode_record_matrix');

test('矩阵覆盖 Excel 24 模式 + 审计新收编 2 + 百货 3 常量模式,基名唯一', () => {
  assert.equal(MATRIX.length, 29); // 24 Excel + 新罗V团-本司/新世界PKG-宋总(2026-07-12 拍板) + 百货3常量
  const names = MATRIX.map((r) => normalizeModeName(r.mode));
  assert.equal(new Set(names).size, 29, '归一化后基名不得撞车');
});

test('全记录模式:乐天SG-本司 8 列全记,14位纯数字', () => {
  const rule = lookupModeRecordRule('乐天SG-本司');
  assert.equal(rule.known, true);
  assert.deepEqual(Object.values(rule.columns), [true, true, true, true, true, true, true, true]);
  assert.equal(rule.receiptNoForm, 'digits14');
  assert.equal(rule.noRecord, false);
});

test('简记模式:新罗SG-新琪 只记 收票日期/代理/团号', () => {
  const { columns } = lookupModeRecordRule('新罗SG-新琪');
  assert.equal(columns.recordDate, true);
  assert.equal(columns.agent, true);
  assert.equal(columns.groupNo, true);
  assert.equal(columns.purchaseDate, false);
  assert.equal(columns.receiptNo, false);
  assert.equal(columns.name, false);
  assert.equal(columns.passportNo, false);
  assert.equal(columns.departureDate, false);
});

test('尾巴归一:发小票17/18、单独整理 转 actions;括号全半角都认', () => {
  const r17 = lookupModeRecordRule('新罗PKG-孙恩子（发小票17）');
  assert.equal(r17.known, true);
  assert.ok(r17.actions.includes('及时发上家'));

  const r18 = lookupModeRecordRule('济州乐天V团特殊-道辉(发小票18)'); // 半角括号
  assert.equal(r18.known, true);
  assert.equal(r18.receiptNoForm, 'letters14');
  assert.ok(r18.actions.includes('及时发上家'));

  const sep = lookupModeRecordRule('济州乐天SG-道辉（单独整理）');
  assert.equal(sep.known, true);
  assert.ok(sep.actions.includes('按团号单独整理'));
});

test('名字中间的括号是本体,只剥尾部:乐天H团（原乐天V）-本司 能命中', () => {
  const rule = lookupModeRecordRule('乐天H团（原乐天V）-本司');
  assert.equal(rule.known, true);
  assert.equal(rule.receiptNoForm, 'digits14');
});

test('「不用记」尾巴:noRecord=true 且仍命中基名(审核照常,导出跳过)', () => {
  const rule = lookupModeRecordRule('乐天SG-本司不用记');
  assert.equal(rule.known, true);
  assert.equal(rule.noRecord, true);
});

test('未知模式=普通模式:全列照记、known=false、绝不 throw', () => {
  const rule = lookupModeRecordRule('从没见过的新模式-某代理');
  assert.equal(rule.known, false);
  assert.deepEqual(Object.values(rule.columns), [true, true, true, true, true, true, true, true]);
  assert.equal(rule.noRecord, false);
  // 空/null 也安全
  assert.equal(lookupModeRecordRule('').known, false);
  assert.equal(lookupModeRecordRule(null).known, false);
});

test('机场票:dashed19 + 团号字面值"无";现代-JEOCU 简记但带小票号', () => {
  const airport = lookupModeRecordRule('新世界机场-振华');
  assert.equal(airport.receiptNoForm, 'dashed19');
  assert.equal(airport.groupNoLiteral, '无');
  assert.equal(airport.columns.receiptNo, true);

  const hyundai = lookupModeRecordRule('现代-JEOCU');
  assert.equal(hyundai.receiptNoForm, 'dashed19');
  assert.equal(hyundai.columns.receiptNo, true);
  assert.equal(hyundai.columns.name, false);
});

test('S活动模式带红标签动作', () => {
  assert.ok(lookupModeRecordRule('乐天H团-S活动').actions.includes('S活动红标签'));
  assert.ok(lookupModeRecordRule('乐天SG-S活动').actions.includes('S活动红标签'));
});

test('百货模式(P4):known=true 全列照记,三家交易编号一律 dash44(0727拍板:按票面带杠)', () => {
  for (const mode of ['乐天百货', '新世界百货', '现代百货']) {
    const rule = lookupModeRecordRule(mode);
    assert.equal(rule.known, true, `${mode} 应为已知模式`);
    assert.deepEqual(Object.values(rule.columns), [true, true, true, true, true, true, true, true]);
    // 0727反馈#13/#14:交易编号导出按票面 4-4 带杠;乐天旧「8位不打-」在用户看过导出实件后作废
    assert.equal(rule.receiptNoForm, 'dash44', `${mode} 交易编号形态`);
  }
});

// ── 2026-07-12 生产团号表直方图实锤:拼写漂移必须命中矩阵,不许静默落默认 ──
test('拼写漂移:小写 pkg/sg 折叠大写后命中矩阵(爱宝客pkg-本司 ×251 病例)', () => {
  const r = lookupModeRecordRule('爱宝客pkg-本司');
  assert.equal(r.known, true);
  assert.equal(r.mode, '爱宝客PKG-本司');
  assert.equal(r.receiptNoForm, 'digits13', '形态提示不能因大小写丢失');
});

test('拼写别名:乐天H团-本司(表侧尾括号写法 ×10141)→ 乐天H团（原乐天V）-本司', () => {
  for (const raw of ['乐天H团-本司（原乐天V-本司）', '乐天H团-本司']) {
    const r = lookupModeRecordRule(raw);
    assert.equal(r.known, true, `${raw} 应命中矩阵`);
    assert.equal(r.mode, '乐天H团（原乐天V）-本司');
    assert.equal(r.receiptNoForm, 'digits14');
  }
});

test('拼写漂移:空格病例「新罗SG -新琪」照常命中', () => {
  const r = lookupModeRecordRule('新罗SG -新琪');
  assert.equal(r.known, true);
  assert.equal(r.mode, '新罗SG-新琪');
});
