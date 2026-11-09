'use strict';

/**
 * P3a 审核配置三通道:零变化机器证明 + 覆盖行为 + 时序墙 + SLIM 收编。
 * 通过真实 workbench_task_flow 挂钩测(不是测 resolver 孤岛)——消费方行为才是承诺。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createModeConfigRepository } = require('../repositories/mode_config_repository');
const { createReviewConfigResolver, validateModeReviewOverlay } = require('../services/review_config_resolver');
const { seedFactoryConfig } = require('../scripts/seed_factory_config');
const {
  getTaskRequiredFieldChecks,
  setReviewConfigResolver,
} = require('../lib/workbench_task_flow');

function fieldKeys(task) {
  return getTaskRequiredFieldChecks(task).checks.map((c) => c.finalKey);
}

const RECEIPT_TASK = Object.freeze({
  docTypeFinal: 'receipt', classificationConfirmed: true,
  receiptStoreFinal: 'THE SHILLA', receiptNoFinal: '0325652400439',
  groupNoFinal: '71992', purchaseDateFinal: '2026-07-01', departureDateFinal: '2026-07-05',
});
const PASSPORT_TASK = Object.freeze({ docTypeFinal: 'passport', classificationConfirmed: true });
const DEPT_TASK = Object.freeze({
  docTypeFinal: 'receipt', classificationConfirmed: true,
  receiptStoreFinal: 'HYUNDAI_DEPT', receiptNoFinal: '1622-0011',
  receiptAmountFinal: '100', upstreamFinal: '东方', purchaseDateFinal: '2026-07-01',
});

function makeHarness(t, { seed = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'));
  const db = new DatabaseSync(path.join(dir, 'monthly.sqlite'));
  const repository = createModeConfigRepository({ db });
  if (seed) seedFactoryConfig({ repository });
  const resolver = createReviewConfigResolver({
    modeConfigRepository: repository,
    logger: { warn: () => {}, info: () => {} },
  });
  t.after(() => {
    setReviewConfigResolver(null); // 全局钩子必复位
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { repository, resolver };
}

test('⭐零变化:未挂钩 ≡ 挂钩+空库 ≡ 挂钩+seed(出厂基线)——三形态逐字段一致', (t) => {
  const factoryReceipt = fieldKeys(RECEIPT_TASK);
  const factoryPassport = fieldKeys(PASSPORT_TASK);
  const factoryDept = fieldKeys(DEPT_TASK);
  assert.deepEqual(factoryReceipt, ['receiptStoreFinal', 'receiptNoFinal', 'groupNoFinal', 'purchaseDateFinal', 'departureDateFinal']);

  const empty = makeHarness(t);
  setReviewConfigResolver(empty.resolver);
  assert.deepEqual(fieldKeys(RECEIPT_TASK), factoryReceipt);
  assert.deepEqual(fieldKeys(PASSPORT_TASK), factoryPassport);
  assert.deepEqual(fieldKeys(DEPT_TASK), factoryDept);
  setReviewConfigResolver(null);

  const seeded = makeHarness(t, { seed: true });
  setReviewConfigResolver(seeded.resolver);
  assert.deepEqual(fieldKeys(RECEIPT_TASK), factoryReceipt);
  assert.deepEqual(fieldKeys(PASSPORT_TASK), factoryPassport);
  assert.deepEqual(fieldKeys(DEPT_TASK), factoryDept);
  // 复核LOW:seed 形态必须真读 DB(configVersion 非空)——防"resolver 静默回落出厂也全绿"的假绿
  assert.ok(seeded.resolver.getBaseRuleSet('receipt')?.configVersion, 'seed 后 review_base 需真命中 DB 配置');
});

test('①基线通道:改 receipt 基线去掉出境日期 → 全部免税店小票即刻生效;坏配置回落出厂', (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);

  repository.saveNewVersion({ kind: 'review_base', name: 'receipt', payload: {
    fields: ['receiptStoreFinal', 'receiptNoFinal', 'groupNoFinal', 'purchaseDateFinal'],
  } });
  assert.deepEqual(fieldKeys(RECEIPT_TASK), ['receiptStoreFinal', 'receiptNoFinal', 'groupNoFinal', 'purchaseDateFinal']);
  // 护照不受小票基线影响
  assert.deepEqual(fieldKeys(PASSPORT_TASK), ['extractedNameFinal', 'passportNoFinal']);

  // 坏配置(未知字段)→ 整条回落出厂
  repository.saveNewVersion({ kind: 'review_base', name: 'receipt', payload: { fields: ['野字段Final'] } });
  assert.deepEqual(fieldKeys(RECEIPT_TASK), ['receiptStoreFinal', 'receiptNoFinal', 'groupNoFinal', 'purchaseDateFinal', 'departureDateFinal']);
});

// 审计H5:基线通道不可摘除路由/身份锚字段(此前只有模式微调通道 400 硬拒,基线通道静默放行)
test('validateReviewBase 锚字段护栏:小票必含免税店、护照必含护照号+姓名', () => {
  const { validateReviewBase } = require('../services/review_config_resolver');
  // 小票去掉 receiptStoreFinal → 拒
  const noStore = validateReviewBase({ fields: ['receiptNoFinal', 'groupNoFinal', 'purchaseDateFinal'] }, 'receipt');
  assert.equal(noStore.ok, false);
  assert.match(noStore.reason, /免税店|锚字段/);
  // 含 receiptStoreFinal → 过(可以放宽其它)
  assert.equal(validateReviewBase({ fields: ['receiptStoreFinal', 'receiptNoFinal'] }, 'receipt').ok, true);
  // 护照去掉护照号 → 拒
  assert.equal(validateReviewBase({ fields: ['extractedNameFinal'] }, 'passport').ok, false);
  // 护照去掉姓名 → 拒
  assert.equal(validateReviewBase({ fields: ['passportNoFinal'] }, 'passport').ok, false);
  // 护照两锚都在 → 过
  assert.equal(validateReviewBase({ fields: ['passportNoFinal', 'extractedNameFinal'] }, 'passport').ok, true);
});

test('前端契约:toggleBaselineField 对锚字段有守卫且复选框禁用(与 toggleRelax 对称)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const view = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/views/ConfigConsoleView.vue'), 'utf8');
  assert.ok(/BASE_ANCHOR_FIELDS/.test(view), '需定义锚字段集');
  assert.ok(/isBaseAnchor\(docType, key\)\)\s*return/.test(view), 'toggleBaselineField 需锚字段 return 守卫');
  assert.ok(/:disabled="isBaseAnchor\(base\.docType, key\)"/.test(view), '锚字段复选框需禁用');
});

test('②店家档案通道:现代百货档案去掉上家 → 百货面板即刻少一格;字段定义仍出厂单源', (t) => {
  const { repository, resolver } = makeHarness(t, { seed: true });
  setReviewConfigResolver(resolver);

  const row = repository.getActive('store', 'HYUNDAI_DEPT');
  repository.saveNewVersion({ kind: 'store', name: 'HYUNDAI_DEPT', payload: {
    ...row.payload,
    fields: row.payload.fields.filter((f) => f !== 'upstream'),
  } });
  const keys = fieldKeys(DEPT_TASK);
  assert.ok(!keys.includes('upstreamFinal'), '档案去掉上家后必填集应无上家');
  assert.ok(keys.includes('receiptAmountFinal'));
  // 乐天百货不受现代档案影响
  const lotte = fieldKeys({ ...DEPT_TASK, receiptStoreFinal: 'LOTTE_DEPT' });
  assert.ok(lotte.includes('branchFinal'));
});

test('③模式微调:relax 出境日期仅 matched 后生效(时序墙);require 可补回;护照/百货不走微调', (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);

  repository.saveNewVersion({ kind: 'mode', name: '乐天SG-本司', payload: {
    columns: { recordDate: true, agent: true, purchaseDate: true, receiptNo: true, groupNo: true, name: true, passportNo: true, departureDate: true },
    review: { relax: ['departureDateFinal'] },
  } });

  const matched = { ...RECEIPT_TASK, modeRawPre: '乐天SG-本司', groupNoMatchStatus: 'matched' };
  const notFound = { ...RECEIPT_TASK, modeRawPre: '乐天SG-本司', groupNoMatchStatus: 'not_found' };
  assert.ok(!fieldKeys(matched).includes('departureDateFinal'), 'matched 后微调生效');
  assert.ok(fieldKeys(notFound).includes('departureDateFinal'), '未命中=纯基线全查(时序墙)');
  // 百货票不吃模式微调(档案通道管)
  assert.deepEqual(fieldKeys(DEPT_TASK), fieldKeys({ ...DEPT_TASK, modeRawPre: '乐天SG-本司', groupNoMatchStatus: 'matched' }));
});

test('无 DB 行的出厂 SLIM 模式 matched 后也派生免审——与导出抹列同源(审计MEDIUM T3)', (t) => {
  const { resolver } = makeHarness(t); // 空库:任一出厂模式都无 config_entries 行(=被「回到默认」或 seed 未跑)
  setReviewConfigResolver(resolver);

  // 新罗SG-新琪 = 出厂 SLIM(只记 收票日期/代理/团号)。此前无 DB 行 → overlay 返 null → 审核全审,
  // 而导出层照出厂矩阵抹 receiptNo/purchaseDate/departureDate 列 → 「上面不记、下面全审」打架。
  const slimMatched = { ...RECEIPT_TASK, modeRawPre: '新罗SG-新琪', groupNoMatchStatus: 'matched' };
  assert.deepEqual(fieldKeys(slimMatched), ['receiptStoreFinal', 'groupNoFinal'],
    'SLIM 出厂模式无 DB 行也免 receiptNo/purchaseDate/departureDate(与出厂抹列一致)');

  // 时序墙不破:未命中团号 → 纯基线全查
  const notMatched = { ...RECEIPT_TASK, modeRawPre: '新罗SG-新琪', groupNoMatchStatus: 'not_found' };
  assert.ok(fieldKeys(notMatched).includes('receiptNoFinal'), '未命中团号=纯基线全查(时序墙)');

  // ALL 出厂模式(乐天SG-本司)无 DB 行 → 列派生为空 → 仍全审(回落不误放宽)
  const allMatched = { ...RECEIPT_TASK, modeRawPre: '乐天SG-本司', groupNoMatchStatus: 'matched' };
  assert.deepEqual(fieldKeys(allMatched),
    ['receiptStoreFinal', 'receiptNoFinal', 'groupNoFinal', 'purchaseDateFinal', 'departureDateFinal'],
    'ALL 出厂模式无 DB 行照常全审');

  // 前端折叠/豁免映射也须覆盖无 DB 行的出厂 SLIM 模式(否则服务端放宽、客户端本地必填仍拦)
  const relaxMap = resolver.listModeRelaxMap();
  assert.ok(Array.isArray(relaxMap['新罗SG-新琪']) && relaxMap['新罗SG-新琪'].includes('receiptNoFinal'),
    'listModeRelaxMap 覆盖无 DB 行的出厂 SLIM 模式');
  assert.ok(!('乐天SG-本司' in relaxMap), 'ALL 出厂模式不进 relax 映射(无可免)');
});

test('SLIM 收编:配置 slim=true + matched + 表态 → 免逐字段;三条件缺一不可;ENV 通道仍在', (t) => {
  const { repository, resolver } = makeHarness(t);
  setReviewConfigResolver(resolver);

  repository.saveNewVersion({ kind: 'mode', name: '新罗SG-新琪', payload: {
    columns: { recordDate: true, agent: true, purchaseDate: false, receiptNo: false, groupNo: true, name: false, passportNo: false, departureDate: false },
    review: { slim: true },
  } });

  const slimReady = { ...RECEIPT_TASK, modeRawPre: '新罗SG-新琪', groupNoMatchStatus: 'matched', tourStance: 'matched' };
  assert.equal(getTaskRequiredFieldChecks(slimReady).checks.length, 0, '配置 slim 车道=免逐字段');
  const noStance = { ...RECEIPT_TASK, modeRawPre: '新罗SG-新琪', groupNoMatchStatus: 'matched' };
  assert.ok(getTaskRequiredFieldChecks(noStance).checks.length > 0, '没表态不入车道');
  const noMatch = { ...RECEIPT_TASK, modeRawPre: '新罗SG-新琪', groupNoMatchStatus: 'not_found', tourStance: 'matched' };
  assert.ok(getTaskRequiredFieldChecks(noMatch).checks.length > 0, '没命中表不入车道');
});

test('validateModeReviewOverlay:词汇表外字段/坏类型拒;空 review 放行', () => {
  assert.equal(validateModeReviewOverlay(undefined).ok, true);
  assert.equal(validateModeReviewOverlay({ relax: ['departureDateFinal'] }).ok, true);
  assert.equal(validateModeReviewOverlay({ relax: ['receiptAmountFinal'] }).ok, false); // 百货字段不在微调词汇
  assert.equal(validateModeReviewOverlay({ relax: ['receiptStoreFinal'] }).ok, false); // ⭐店家=路由锚字段,不可放宽(复核HIGH-2)
  assert.equal(validateModeReviewOverlay({ require: ['receiptStoreFinal'] }).ok, false); // require 同禁(词汇表单源)
  assert.equal(validateModeReviewOverlay({ slim: 'yes' }).ok, false);
  assert.equal(validateModeReviewOverlay({ require: 'departureDateFinal' }).ok, false);
});
