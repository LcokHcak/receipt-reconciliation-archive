'use strict';

/**
 * SLIM 车道资格 isSlimLaneTask 直测(域4 HIGH#1,免必填闸=安全面)。
 * 见 docs/边界测试设计.md「域4」:①三条件齐+ENV命中→空必填集 ②护照纵深防御
 * ③逐个抽条件→回落全审 ④tourConfirmedAt 兼容旧组级确认 ⑤配置 overlay slim=true
 * ⑥配置 resolver 抛异常→catch→全审。
 * 消费面走 getTaskRequiredFieldChecks(getRequiredFieldRules 未导出,行为经必填集验证)。
 * ⚠️ ENV WORKBENCH_SLIM_MODES 与 setReviewConfigResolver 都是进程级状态,必须每例保存/复位。
 */

const test = require('node:test');
const { beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  isSlimLaneTask,
  getTaskRequiredFieldChecks,
  setReviewConfigResolver,
} = require('../lib/workbench_task_flow');

const SLIM_MODE = '新世界SG-振华 不用记';

// 出厂免税店小票必填集(与 review_config_resolver.test.js 的零变化基线一致)
const FACTORY_RECEIPT_KEYS = Object.freeze([
  'receiptStoreFinal',
  'receiptNoFinal',
  'groupNoFinal',
  'purchaseDateFinal',
  'departureDateFinal',
]);

// 三条件齐备的小票(字段全空:入车道=免逐字段必填的最强证明;回落=missing 全亮)
function slimEligibleTask(overrides = {}) {
  return {
    docTypeAuto: 'receipt',
    docTypeFinal: 'receipt',
    tourStance: 'matched',
    groupNoMatchStatus: 'matched',
    modeRawPre: SLIM_MODE,
    ...overrides,
  };
}

function fieldKeys(task) {
  return getTaskRequiredFieldChecks(task).checks.map((c) => c.finalKey);
}

let savedSlimModes;
beforeEach(() => {
  savedSlimModes = process.env.WORKBENCH_SLIM_MODES;
  delete process.env.WORKBENCH_SLIM_MODES; // 每例从「车道不存在」的默认态出发
  setReviewConfigResolver(null);
});
afterEach(() => {
  if (savedSlimModes === undefined) {
    delete process.env.WORKBENCH_SLIM_MODES;
  } else {
    process.env.WORKBENCH_SLIM_MODES = savedSlimModes;
  }
  setReviewConfigResolver(null); // 全局钩子必复位(与 review_config_resolver.test.js 同约定)
});

test('①三条件齐 + ENV 白名单命中 → 入 SLIM 车道,必填集为空(免逐字段)', () => {
  process.env.WORKBENCH_SLIM_MODES = `乐天R团-别的模式, ${SLIM_MODE}`; // 逗号分隔+空白容错
  const task = slimEligibleTask();

  assert.equal(isSlimLaneTask(task), true);

  const summary = getTaskRequiredFieldChecks(task);
  assert.deepEqual(summary.checks, [], 'SLIM 规则集 fields 必须为空');
  assert.deepEqual(summary.missingFields, [], '字段全空也不缺——免必填的语义本体');
  assert.equal(summary.needsSignature, false);
});

test('①-对照 ENV 默认空 → 车道不存在,同一张票回落全审', () => {
  // beforeEach 已 delete ENV
  const task = slimEligibleTask();
  assert.equal(isSlimLaneTask(task), false);
  assert.deepEqual(fieldKeys(task), FACTORY_RECEIPT_KEYS);
});

test('②纵深防御:护照即便误写两个 matched + ENV 命中 → 永不进 slim,仍走护照必填', () => {
  process.env.WORKBENCH_SLIM_MODES = SLIM_MODE;
  const task = slimEligibleTask({ docTypeAuto: 'passport', docTypeFinal: 'passport' });

  assert.equal(isSlimLaneTask(task), false);

  const summary = getTaskRequiredFieldChecks(task);
  assert.deepEqual(
    summary.checks.map((c) => c.finalKey),
    ['extractedNameFinal', 'passportNoFinal'],
    '护照锚字段(英文名+护照号)必须照旧人审'
  );
  assert.equal(summary.missingFields.length, 2, '字段全空 → 两个锚字段都缺,不许被免掉');
});

test('③抽掉 tourStance(且无 tourConfirmedAt)→ 回落全审', () => {
  process.env.WORKBENCH_SLIM_MODES = SLIM_MODE;
  const task = slimEligibleTask({ tourStance: '' });

  assert.equal(isSlimLaneTask(task), false);
  const summary = getTaskRequiredFieldChecks(task);
  assert.deepEqual(summary.checks.map((c) => c.finalKey), FACTORY_RECEIPT_KEYS);
  assert.equal(summary.missingFields.length, FACTORY_RECEIPT_KEYS.length, '全字段回到必填');
});

test('③抽掉 groupNoMatchStatus → 回落全审(有表态没命中表也不行)', () => {
  process.env.WORKBENCH_SLIM_MODES = SLIM_MODE;
  const task = slimEligibleTask({ groupNoMatchStatus: '' });

  assert.equal(isSlimLaneTask(task), false);
  assert.deepEqual(fieldKeys(task), FACTORY_RECEIPT_KEYS);
});

test('④tourStance 空但 tourConfirmedAt 有值(旧组级确认站回执)→ 兼容入车道', () => {
  process.env.WORKBENCH_SLIM_MODES = SLIM_MODE;
  const task = slimEligibleTask({
    tourStance: '',
    tourConfirmedAt: '2026-07-10T08:00:00.000Z',
  });

  assert.equal(isSlimLaneTask(task), true);
  assert.deepEqual(getTaskRequiredFieldChecks(task).checks, []);
});

test('⑤ENV 不命中但配置 overlay slim=true → 入车道(P3a SLIM 收编通道)', () => {
  // ENV 空(默认);模式微调经 setReviewConfigResolver 注入(server 启动同款挂钩)
  const seenModes = [];
  setReviewConfigResolver({
    getModeReviewOverlay(mode) {
      seenModes.push(mode);
      return { slim: true, relax: [], require: [] };
    },
  });
  const task = slimEligibleTask();

  assert.equal(isSlimLaneTask(task), true);
  assert.deepEqual(getTaskRequiredFieldChecks(task).checks, []);
  assert.ok(seenModes.length > 0, '必须真的查过配置层');
  assert.ok(seenModes.every((m) => m === SLIM_MODE), '必须以任务的 modeRawPre 查配置');
});

test('⑤-对照 配置 slim=true 但三条件不齐(没表态)→ 配置也放不了行', () => {
  setReviewConfigResolver({
    getModeReviewOverlay() {
      return { slim: true, relax: [], require: [] };
    },
  });
  const task = slimEligibleTask({ tourStance: '', tourConfirmedAt: '' });
  assert.equal(isSlimLaneTask(task), false, '三条件在配置通道之前查,缺一不可');
});

test('⑥配置 resolver 抛异常 → catch → 全审(fail-safe,审核必填绝不因配置挂掉)', () => {
  setReviewConfigResolver({
    getModeReviewOverlay() {
      throw new Error('config backend down');
    },
    getBaseRuleSet() {
      throw new Error('config backend down');
    },
    getDeptFields() {
      throw new Error('config backend down');
    },
  });
  const task = slimEligibleTask();

  assert.equal(isSlimLaneTask(task), false, '异常必须被吞掉并按不入车道处理');

  let summary;
  assert.doesNotThrow(() => {
    summary = getTaskRequiredFieldChecks(task);
  }, '配置层异常不许穿透到审核热路径');
  assert.deepEqual(
    summary.checks.map((c) => c.finalKey),
    FACTORY_RECEIPT_KEYS,
    '回落出厂全审'
  );
});
